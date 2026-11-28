/**
 * The storage node REST API (§1.3, N1–N7) over Effect's `HttpClient`, and the
 * one place where HTTP outcomes become typed `NodeError`s (§4.4).
 *
 *   StorageNode.layer().pipe(Layer.provide(FetchHttpClient.layer))
 *
 * The service never retries: callers do, per member, with a `Quorum`
 * schedule and `while: StorageNode.retryable`. Every outcome is a typed
 * `NodeError`, including timeouts and anything an `HttpClient` implementation
 * throws, because the quorum treats defects as fatal.
 */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import type { BlobId } from "./BlobId.ts"
import type { Persistence } from "./Messages.ts"
import { type BlobStatus, BlobStatus as BlobStatusSchema } from "./Status.ts"

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export const NodeErrorKind = /* @__PURE__ */ Schema.Literals([
  "Unavailable",
  "Timeout",
  "RateLimited",
  "NotFound",
  "NotRegistered",
  "Blocked",
  "ShardNotAssigned",
  "Rejected",
  "Malformed",
  "InvalidSignature"
])
export type NodeErrorKind = typeof NodeErrorKind.Type

/** Kinds worth asking the same node again: it may answer differently later. */
const RETRYABLE: ReadonlySet<NodeErrorKind> = /* @__PURE__ */ new Set<NodeErrorKind>(["Unavailable", "Timeout", "RateLimited", "NotRegistered"])

/** One node's failure. `status` is absent when no HTTP answer arrived; `reason` is the server's `ErrorInfo` reason (N7). */
export class NodeError extends /* @__PURE__ */ Schema.TaggedError<NodeError>()("NodeError", {
  /** The node's base URL. */
  node: Schema.String,
  kind: NodeErrorKind,
  status: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(Schema.String),
  message: Schema.String
}) {
  /** `Unavailable | Timeout | RateLimited | NotRegistered`. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind)
  }
}

/** The same as `error.retryable`, as a predicate for `Schedule` / `Quorum` `while` options. */
export const retryable = (error: NodeError): boolean => RETRYABLE.has(error.kind)

// -----------------------------------------------------------------------------
// The mapping (§4.4)
// -----------------------------------------------------------------------------

/** The endpoint a response came from; only `putSliver` changes the mapping (`METADATA_NOT_FOUND`). */
export type Operation =
  | "metadata"
  | "metadataStatus"
  | "putMetadata"
  | "sliver"
  | "sliverStatus"
  | "putSliver"
  | "status"
  | "confirmation"

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** The N7 error envelope, read leniently: whatever of `message` and the first `ErrorInfo.reason` is there. */
const parseErrorBody = (text: string): { readonly message?: string; readonly reason?: string } => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return {}
  }
  const error = isRecord(json) ? json.error : undefined
  if (!isRecord(error)) return {}
  const details = Array.isArray(error.details) ? error.details : []
  const info = details.find((d): d is Record<string, unknown> => isRecord(d) && typeof d.reason === "string")
  return {
    ...(typeof error.message === "string" && { message: error.message }),
    ...(info && { reason: info.reason as string })
  }
}

/**
 * A non-2xx answer as a `NodeError`, decided once here: `429` → `RateLimited`,
 * `5xx` → `Unavailable`, `404` → `NotFound`, `451` → `Blocked`, reason
 * `NOT_REGISTERED` (or `METADATA_NOT_FOUND` on a sliver `PUT`) → `NotRegistered`,
 * reason `SHARD_NOT_ASSIGNED` → `ShardNotAssigned`, other `4xx` → `Rejected`,
 * anything else (an unfollowed redirect, an unexpected 1xx/3xx) → `Malformed`.
 */
export const fromResponse = (node: string, operation: Operation, status: number, body: string): NodeError => {
  const parsed = parseErrorBody(body)
  const reason = parsed.reason
  const message = parsed.message ?? (body.trim().slice(0, 500) || `HTTP ${status}`)
  const make = (kind: NodeErrorKind) =>
    new NodeError({ node, kind, status, ...(reason !== undefined && { reason }), message: `${operation}: ${message}` })
  if (status === 429) return make("RateLimited")
  if (status >= 500 && status <= 599) return make("Unavailable")
  if (status === 404) return make("NotFound")
  if (status === 451) return make("Blocked")
  if (status >= 400 && status <= 499) {
    if (reason === "NOT_REGISTERED") return make("NotRegistered")
    if (reason === "METADATA_NOT_FOUND" && operation === "putSliver") return make("NotRegistered")
    if (reason === "SHARD_NOT_ASSIGNED") return make("ShardNotAssigned")
    return make("Rejected")
  }
  return make("Malformed")
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

/** What a call needs to know about a node: its base URL. `Committee.StorageNode` fits. */
export interface Node {
  readonly url: string
}

export type Axis = "primary" | "secondary"
export type StoredOnNode = "nonexistent" | "buffered" | "stored"
export type StoreResult = "stored" | "alreadyStored"
export interface SignedConfirmation {
  readonly serializedMessage: Uint8Array
  readonly signature: Uint8Array
}

export interface StorageNodesOptions {
  /**
   * Per request. Default 30 seconds; a timeout is `NodeError` `"Timeout"`. Uploads (`putMetadata`,
   * `putSliver`) get this plus the time their bytes take at `minUploadRate` (`scaledTimeout`).
   */
  readonly requestTimeout?: Duration.Input
  /**
   * The slowest uplink an upload is expected to tolerate, in bytes per second. Default 125,000
   * (1 Mbit/s). An upload's timeout grows by `bytes / minUploadRate`, where `bytes` is its body, or the
   * bytes it shares the link with when the caller says so (`Write` passes its in-flight window).
   */
  readonly minUploadRate?: number
  /** Default `false`: nodes do not list trace headers for CORS, so browsers would preflight and fail. */
  readonly tracerPropagation?: boolean
}

/** Per-call hints for uploads. */
export interface UploadHints {
  /**
   * Bytes in flight on the same uplink as this request, its own included (default: its body). The
   * request's timeout allows for all of them to drain at `minUploadRate`.
   */
  readonly sharedBytes?: number
}

/** Per-call limits for downloads. */
export interface DownloadLimits {
  /** Refuse a body larger than this (`Malformed`), checked against `content-length` and while reading. */
  readonly maxBytes?: number
}

/** 1 Mbit/s. */
export const DEFAULT_MIN_UPLOAD_RATE = 125_000

/**
 * The timeout of a request that sends `bytes`: `base + bytes / bytesPerSecond`. A slow uplink then
 * delays a large upload instead of timing it out and sending it again. Non-finite or non-positive
 * rates add nothing.
 */
export const scaledTimeout = (base: Duration.Input, bytes: number, bytesPerSecond: number): Duration.Duration => {
  const b = Duration.fromInputUnsafe(base)
  if (!(bytes > 0) || !(bytesPerSecond > 0) || !Number.isFinite(bytesPerSecond)) return b
  return Duration.sum(b, Duration.millis(Math.ceil((bytes / bytesPerSecond) * 1000)))
}

/** Body caps when the caller gives none: JSON answers are small; metadata at the largest `n` (65,535 shards) is ~4.2 MB. */
const MAX_JSON_BYTES = 1024 * 1024
const MAX_METADATA_BYTES = 8 * 1024 * 1024
const MAX_SLIVER_BYTES = 256 * 1024 * 1024

export class StorageNodes extends Context.Service<StorageNodes, {
  /** N1: raw BCS `BlobMetadataWithId`; check it with `Messages.verifyMetadata`. */
  readonly metadata: (node: Node, blobId: BlobId, limits?: DownloadLimits) => Effect.Effect<Uint8Array, NodeError>
  /** N4: whether the node holds the metadata. */
  readonly metadataStatus: (node: Node, blobId: BlobId) => Effect.Effect<StoredOnNode, NodeError>
  /** N3: raw BCS `SliverData`; check it with `Messages.checkSliver`. */
  readonly sliver: (node: Node, blobId: BlobId, pairIndex: number, axis: Axis, limits?: DownloadLimits) => Effect.Effect<Uint8Array, NodeError>
  /** N6: an unknown blob is `Nonexistent` (the node answers `200 "nonexistent"`). */
  readonly status: (node: Node, blobId: BlobId) => Effect.Effect<BlobStatus, NodeError>
  /** N2: the body is BCS `BlobMetadata` (no id), `VerifiedMetadata.bytes`. */
  readonly putMetadata: (node: Node, blobId: BlobId, metadata: Uint8Array, hints?: UploadHints) => Effect.Effect<StoreResult, NodeError>
  /** N3: the body is BCS `SliverData`. */
  readonly putSliver: (
    node: Node,
    blobId: BlobId,
    pairIndex: number,
    axis: Axis,
    sliver: Uint8Array,
    hints?: UploadHints
  ) => Effect.Effect<StoreResult, NodeError>
  /** N4. */
  readonly sliverStatus: (node: Node, blobId: BlobId, pairIndex: number, axis: Axis) => Effect.Effect<StoredOnNode, NodeError>
  /** N5: the raw signed confirmation; the caller checks the message and the signature. */
  readonly confirmation: (node: Node, blobId: BlobId, persistence: Persistence) => Effect.Effect<SignedConfirmation, NodeError>
}>()("@unconfirmed/walrus/StorageNodes") {}

const Success = <S extends Schema.Top>(data: S) => Schema.Struct({ success: Schema.Struct({ code: Schema.Number, data }) })

const StoredOnNodeSchema = /* @__PURE__ */ Schema.Literals(["nonexistent", "buffered", "stored"])
const decodeStored = /* @__PURE__ */ Schema.decodeUnknownResult(/* @__PURE__ */ Success(StoredOnNodeSchema))
const decodeStatus = /* @__PURE__ */ Schema.decodeUnknownResult(/* @__PURE__ */ Success(BlobStatusSchema))
const decodeConfirmation = /* @__PURE__ */ Schema.decodeUnknownResult(
  /* @__PURE__ */ Success(Schema.Struct({
    signed: Schema.Struct({ serializedMessage: Schema.Uint8ArrayFromBase64, signature: Schema.Uint8ArrayFromBase64 })
  }))
)

const OCTETS = "application/octet-stream"

export const layer = (options: StorageNodesOptions = {}): Layer.Layer<StorageNodes, never, HttpClient.HttpClient> =>
  Layer.effect(
    StorageNodes,
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const baseTimeout = Duration.fromInputUnsafe(options.requestTimeout ?? Duration.seconds(30))
      const minUploadRate = options.minUploadRate ?? DEFAULT_MIN_UPLOAD_RATE
      const tracerPropagation = options.tracerPropagation ?? false

      /** One request: 2xx bodies as bytes (at most `maxBytes`), everything else as a `NodeError`. */
      const call = (
        operation: Operation,
        node: Node,
        request: HttpClientRequest.HttpClientRequest,
        maxBytes: number,
        timeout: Duration.Duration = baseTimeout
      ): Effect.Effect<{ readonly status: number; readonly body: Uint8Array }, NodeError> => {
        const base = node.url.replace(/\/+$/, "")
        const fail = (kind: NodeErrorKind, message: string, status?: number) =>
          new NodeError({ node: base, kind, ...(status !== undefined && { status }), message: `${operation}: ${message}` })
        // A node cannot make us buffer more than the answer can be: `content-length` first, then while reading.
        const read = (res: HttpClientResponse.HttpClientResponse, limit: number) => {
          const tooLarge = (size: number | string) => fail("Malformed", `body of ${size} bytes exceeds ${limit}`, res.status)
          const declared = Number(res.headers["content-length"])
          if (Number.isFinite(declared) && declared > limit) return Effect.fail(tooLarge(declared))
          return Stream.runFoldEffect(
            Stream.mapError(res.stream, (e) => fail("Unavailable", e.message, res.status)),
            () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
            (acc, chunk) => {
              acc.size += chunk.length
              if (acc.size > limit) return Effect.fail(tooLarge(`more than ${limit}`))
              acc.chunks.push(chunk)
              return Effect.succeed(acc)
            }
          ).pipe(Effect.map(({ chunks, size }) => {
            if (chunks.length === 1) return chunks[0]!
            const out = new Uint8Array(size)
            let offset = 0
            for (const c of chunks) {
              out.set(c, offset)
              offset += c.length
            }
            return out
          }))
        }
        return http.execute(HttpClientRequest.prependUrl(request, base)).pipe(
          Effect.mapError((e) => fail("Unavailable", e.message)),
          Effect.flatMap((res) =>
            res.status >= 200 && res.status < 300
              ? Effect.map(read(res, maxBytes), (body) => ({ status: res.status, body }))
              : read(res, MAX_JSON_BYTES).pipe(
                Effect.orElseSucceed(() => new Uint8Array(0)),
                Effect.flatMap((buf) => Effect.fail(fromResponse(base, operation, res.status, new TextDecoder().decode(buf))))
              )
          ),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(fail("Timeout", `no answer within ${Duration.format(timeout)}`))
          }),
          // Nothing an HttpClient implementation throws may escape as a defect: the quorum would stop.
          Effect.catchDefect((defect) => Effect.fail(fail("Unavailable", `transport defect: ${String(defect)}`))),
          Effect.provideService(HttpClient.TracerPropagationEnabled, tracerPropagation),
          Effect.withSpan(`StorageNodes.${operation}`, { attributes: { "walrus.node": base, "http.request.method": request.method } })
        )
      }

      const json = <A>(
        operation: Operation,
        node: Node,
        request: HttpClientRequest.HttpClientRequest,
        decode: (u: unknown) => Result.Result<A, Schema.SchemaError>
      ): Effect.Effect<A, NodeError> =>
        Effect.flatMap(call(operation, node, HttpClientRequest.acceptJson(request), MAX_JSON_BYTES), ({ status, body }) => {
          const malformed = (message: string) =>
            Effect.fail(new NodeError({ node: node.url.replace(/\/+$/, ""), kind: "Malformed", status, message: `${operation}: ${message}` }))
          let parsed: unknown
          try {
            parsed = JSON.parse(new TextDecoder().decode(body))
          } catch {
            return malformed("response is not JSON")
          }
          const result = decode(parsed)
          return Result.isSuccess(result) ? Effect.succeed(result.success) : malformed(result.failure.message)
        })

      const store = (operation: Operation, node: Node, path: string, body: Uint8Array, hints?: UploadHints): Effect.Effect<StoreResult, NodeError> =>
        Effect.map(
          call(
            operation,
            node,
            HttpClientRequest.put(path).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bodyUint8Array(body, OCTETS)),
            MAX_JSON_BYTES,
            scaledTimeout(baseTimeout, Math.max(body.length, hints?.sharedBytes ?? 0), minUploadRate)
          ),
          // 201 stored, 202 buffered (only with `?pending=true`, which we never send), 200 already stored (N2).
          ({ status }) => (status === 200 ? "alreadyStored" : "stored")
        )

      const bytes = (operation: Operation, node: Node, path: string, maxBytes: number) =>
        Effect.map(call(operation, node, HttpClientRequest.get(path).pipe(HttpClientRequest.accept(OCTETS)), maxBytes), (r) => r.body)

      const blob = (blobId: BlobId) => `/v1/blobs/${blobId}`
      const sliverPath = (blobId: BlobId, pairIndex: number, axis: Axis) => `${blob(blobId)}/slivers/${pairIndex}/${axis}`

      return StorageNodes.of({
        metadata: (node, blobId, limits) => bytes("metadata", node, `${blob(blobId)}/metadata`, limits?.maxBytes ?? MAX_METADATA_BYTES),
        metadataStatus: (node, blobId) =>
          Effect.map(json("metadataStatus", node, HttpClientRequest.get(`${blob(blobId)}/metadata/status`), decodeStored), (r) => r.success.data),
        sliver: (node, blobId, pairIndex, axis, limits) =>
          bytes("sliver", node, sliverPath(blobId, pairIndex, axis), limits?.maxBytes ?? MAX_SLIVER_BYTES),
        status: (node, blobId) =>
          Effect.map(json("status", node, HttpClientRequest.get(`${blob(blobId)}/status`), decodeStatus), (r) => r.success.data),
        putMetadata: (node, blobId, metadata, hints) => store("putMetadata", node, `${blob(blobId)}/metadata`, metadata, hints),
        putSliver: (node, blobId, pairIndex, axis, sliver, hints) =>
          store("putSliver", node, sliverPath(blobId, pairIndex, axis), sliver, hints),
        sliverStatus: (node, blobId, pairIndex, axis) =>
          Effect.map(json("sliverStatus", node, HttpClientRequest.get(`${sliverPath(blobId, pairIndex, axis)}/status`), decodeStored), (r) => r.success.data),
        confirmation: (node, blobId, persistence) =>
          Effect.map(
            json(
              "confirmation",
              node,
              HttpClientRequest.get(
                persistence._tag === "Permanent"
                  ? `${blob(blobId)}/confirmation/permanent`
                  : `${blob(blobId)}/confirmation/deletable/${persistence.objectId}`
              ),
              decodeConfirmation
            ),
            (r) => r.success.data.signed
          )
      })
    })
  )
