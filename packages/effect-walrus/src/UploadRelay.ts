/**
 * The Walrus upload relay (§1.6, R1–R4, §4.8) over Effect's `HttpClient`: a
 * server that takes the raw blob, encodes it, stores it on the nodes and
 * answers with a certificate, in exchange for a tip in SUI.
 *
 *   UploadRelay.layer({ url: UploadRelay.TESTNET_URL, maxTip: 10_000_000n })
 *     .pipe(Layer.provide(FetchHttpClient.layer))
 *
 * The relay is trusted with availability only: `verifyCertificate` checks
 * what it returns (signers, weight, message, aggregate signature) before a
 * certify transaction is built (item 16). The tip is the one thing the relay
 * decides that costs money, so it is bounded by the caller: `maxTip` is
 * required, and `tipAddress` can pin where it goes. `Write.run` with `via: "relay"`
 * does all of this; the pieces are exported for flows that need them apart.
 *
 * Requests match `@mysten/walrus`'s `UploadRelayClient.writeBlob` (URL and
 * body; `test/relay.test.ts`). Every outcome is a typed `RelayError`,
 * including timeouts and anything an `HttpClient` implementation throws.
 */
import { sha256 } from "@noble/hashes/sha2.js"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Base64Url from "effect/encoding/Base64Url"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Bft from "./Bft.ts"
import * as BlobId from "./BlobId.ts"
import * as Certificate from "./Certificate.ts"
import type { Committee } from "./Committee.ts"
import { Encoder } from "./Encoder.ts"
import * as Encoding from "./Encoding.ts"
import { type BlobTooLarge, CertificateInvalid, RelayError, TipTooHigh } from "./Errors.ts"
import { DEFAULT_MIN_UPLOAD_RATE, scaledTimeout } from "./StorageNode.ts"
import { System, type SystemError } from "./System.ts"

// -----------------------------------------------------------------------------
// Tip configuration (R1)
// -----------------------------------------------------------------------------

export type TipKind =
  | { readonly _tag: "Const"; readonly amount: bigint }
  | { readonly _tag: "Linear"; readonly base: bigint; readonly perEncodedKib: bigint }

export type TipConfig =
  | { readonly _tag: "NoTip" }
  | { readonly _tag: "SendTip"; readonly address: Address.Address; readonly kind: TipKind }

/**
 * The tip in MIST for a blob of `unencodedLength` bytes (R1): a constant, or
 * `base + ⌈encodedLength / 1024⌉ × perEncodedKib`. Throws `RangeError` above
 * `Encoding.maxBlobSize` (check `Encoding.symbolSize` first).
 */
export const tipAmount = (config: TipConfig, unencodedLength: number, nShards: number): bigint => {
  if (config._tag === "NoTip") return 0n
  const kind = config.kind
  if (kind._tag === "Const") return kind.amount
  const kib = (BigInt(Encoding.encodedLength(unencodedLength, nShards)) + 1023n) / 1024n
  return kind.base + kib * kind.perEncodedKib
}

const U64 = /* @__PURE__ */ Schema.Union([Schema.Number, Schema.String])
const TipConfigJson = /* @__PURE__ */ Schema.Union([
  /* @__PURE__ */ Schema.Literal("no_tip"),
  /* @__PURE__ */ Schema.Struct({
    send_tip: Schema.Struct({
      address: Schema.String,
      kind: Schema.Union([
        Schema.Struct({ const: U64 }),
        Schema.Struct({ linear: Schema.Struct({ base: U64, encoded_size_mul_per_kib: U64 }) })
      ])
    })
  })
])
const decodeTipConfigJson = /* @__PURE__ */ Schema.decodeUnknownResult(TipConfigJson)

const toU64 = (v: number | string): bigint | undefined => {
  try {
    const n = BigInt(v)
    return n >= 0n && n < 1n << 64n ? n : undefined
  } catch {
    return undefined
  }
}

/** The `/v1/tip-config` answer (R1), or why it is not one. */
export const parseTipConfig = (json: unknown): Result.Result<TipConfig, string> => {
  const decoded = decodeTipConfigJson(json)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure.message)
  const value = decoded.success
  if (value === "no_tip") return Result.succeed({ _tag: "NoTip" })
  const { address, kind } = value.send_tip
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) return Result.fail(`invalid tip address ${address}`)
  let parsed: TipKind | undefined
  if ("const" in kind) {
    const amount = toU64(kind.const)
    if (amount !== undefined) parsed = { _tag: "Const", amount }
  } else {
    const base = toU64(kind.linear.base)
    const perEncodedKib = toU64(kind.linear.encoded_size_mul_per_kib)
    if (base !== undefined && perEncodedKib !== undefined) parsed = { _tag: "Linear", base, perEncodedKib }
  }
  if (parsed === undefined) return Result.fail("tip amounts are not u64 values")
  return Result.succeed({ _tag: "SendTip", address: Address.normalize(address), kind: parsed })
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface UploadOptions {
  readonly blob: Uint8Array
  readonly blobId: BlobId.BlobId
  /** The 32-byte nonce whose SHA-256 is in the auth input (R3). Required when the relay wants a tip. */
  readonly nonce?: Uint8Array
  /** The transaction that carries the auth input and the tip. Required when the relay wants a tip. */
  readonly txDigest?: string
  /** For a deletable blob: its `Blob` object (the confirmation names it, M1). */
  readonly deletableBlobObject?: Address.Address
}

export interface UploadRelayService {
  /** `GET /v1/tip-config`, cached for the layer's life once it succeeds. */
  readonly tipConfig: Effect.Effect<TipConfig, RelayError>
  /** `authAndTip` refuses tips above this (MIST). */
  readonly maxTip: bigint
  /** When set, `authAndTip` refuses a tip config that names another address. */
  readonly tipAddress?: Address.Address | undefined
  /** `POST /v1/blob-upload-relay` (R2, R4): the relay's certificate, **unverified** (use `verifyCertificate`). */
  readonly upload: (o: UploadOptions) => Effect.Effect<Certificate.Certificate, RelayError>
}

export class UploadRelay extends Context.Service<UploadRelay, UploadRelayService>()("@unconfirmed/effect-walrus/UploadRelay") {}

export interface UploadRelayOptions {
  /**
   * The relay's base URL, e.g. {@link TESTNET_URL}. Request paths (`/v1/…`) are appended to it;
   * trailing slashes are stripped.
   */
  readonly url: string
  /**
   * The most the client will tip per blob, in MIST; above it `authAndTip` fails with `TipTooHigh` before
   * anything is signed. Required: the amount comes from the relay's `/v1/tip-config` answer, so without a
   * bound the relay (or whoever answers at its URL) would choose what the signer pays (`@mysten/walrus`
   * likewise needs `sendTip: { max }`). `0n` accepts only relays that want no tip.
   */
  readonly maxTip: bigint
  /**
   * The address the tip must go to. When set, a tip config naming any other address is a `RelayError`
   * before anything is signed. Default: whatever the relay's tip config says.
   */
  readonly tipAddress?: string
  /**
   * Per request. Default 60 seconds (the relay stores the blob on the nodes before it answers). The upload
   * gets this plus the time the blob takes at `minUploadRate` (`StorageNode.scaledTimeout`).
   */
  readonly requestTimeout?: Duration.Input
  /** The slowest uplink an upload is expected to tolerate, in bytes per second. Default 125,000 (1 Mbit/s). */
  readonly minUploadRate?: number
  /** Sent with every request, e.g. `{ authorization: "Bearer …" }` for a relay behind auth. */
  readonly headers?: Readonly<Record<string, string>>
  /** Default `false`, as for storage nodes: trace headers would make browsers preflight. */
  readonly tracerPropagation?: boolean
}

export const TESTNET_URL = "https://upload-relay.testnet.walrus.space"
export const MAINNET_URL = "https://upload-relay.mainnet.walrus.space"

/** `blob_id` is serde's form of `BlobId([u8; 32])`: an array of 32 numbers (live); the text form is accepted too. */
const UploadResponse = /* @__PURE__ */ Schema.Struct({
  blob_id: Schema.Union([Schema.String, Schema.Array(Schema.Number)]),
  confirmation_certificate: Schema.Struct({
    signers: Schema.Array(Schema.Number),
    serialized_message: Schema.Array(Schema.Number),
    signature: Schema.String
  })
})
const decodeUploadResponse = /* @__PURE__ */ Schema.decodeUnknownResult(UploadResponse)

/** The relay sends URL-safe base64 (`walrus/dist/upload-relay/client.mjs:53`); standard base64 is accepted too. */
const decodeSignature = (s: string): Uint8Array | undefined => {
  const url = Base64Url.decode(s)
  if (Result.isSuccess(url)) return url.success
  const std = Base64.decode(s)
  return Result.isSuccess(std) ? std.success : undefined
}

/** The R4 response body as a certificate (not verified), or why it is not one. */
export const parseUploadResponse = (json: unknown, blobId: BlobId.BlobId): Result.Result<Certificate.Certificate, string> => {
  const decoded = decodeUploadResponse(json)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure.message)
  const { blob_id, confirmation_certificate: c } = decoded.success
  const answered = typeof blob_id === "string"
    ? blob_id
    : blob_id.length === 32 && blob_id.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
    ? Result.getOrUndefined(BlobId.fromBytes(Uint8Array.from(blob_id)))
    : undefined
  if (answered !== blobId) return Result.fail(`answered for blob ${String(answered ?? blob_id)}, expected ${blobId}`)
  if (!c.serialized_message.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return Result.fail("serialized_message is not a byte array")
  }
  const signature = decodeSignature(c.signature)
  if (signature === undefined) return Result.fail("signature is not base64")
  const certificate = Certificate.fromParts({ signers: c.signers, serializedMessage: Uint8Array.from(c.serialized_message), signature })
  return Result.isSuccess(certificate) ? Result.succeed(certificate.success) : Result.fail(certificate.failure.reason)
}

/** The upload query in `UploadRelayClient.writeBlob`'s order (R2). */
export const uploadPath = (o: Omit<UploadOptions, "blob">): string => {
  const query = new URLSearchParams({ blob_id: o.blobId })
  if (o.nonce !== undefined) query.set("nonce", Base64Url.encode(o.nonce))
  if (o.txDigest !== undefined) query.set("tx_id", o.txDigest)
  if (o.deletableBlobObject !== undefined) query.set("deletable_blob_object", Address.normalize(o.deletableBlobObject))
  query.set("encoding_type", "RS2")
  return `/v1/blob-upload-relay?${query.toString()}`
}

export const layer = (options: UploadRelayOptions): Layer.Layer<UploadRelay, never, HttpClient.HttpClient> =>
  Layer.effect(
    UploadRelay,
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const base = options.url.replace(/\/+$/, "")
      const headers = options.headers ?? {}
      const baseTimeout = Duration.fromInputUnsafe(options.requestTimeout ?? Duration.seconds(60))
      const minUploadRate = options.minUploadRate ?? DEFAULT_MIN_UPLOAD_RATE
      const tracerPropagation = options.tracerPropagation ?? false

      /** One request; a 2xx body parsed as JSON, everything else a `RelayError`. */
      const call = (
        operation: string,
        request: HttpClientRequest.HttpClientRequest,
        timeout: Duration.Duration = baseTimeout
      ): Effect.Effect<unknown, RelayError> => {
        const fail = (message: string, status?: number) =>
          new RelayError({ ...(status !== undefined && { status }), message: `${operation}: ${message}` })
        return http.execute(HttpClientRequest.setHeaders(HttpClientRequest.prependUrl(request, base), headers)).pipe(
          Effect.mapError((e) => fail(e.message)),
          Effect.flatMap((res) =>
            Effect.flatMap(
              Effect.mapError(res.text, (e) => fail(e.message, res.status)),
              (text): Effect.Effect<unknown, RelayError> => {
                if (res.status < 200 || res.status >= 300) {
                  return Effect.fail(fail(text.trim().slice(0, 500) || `HTTP ${res.status}`, res.status))
                }
                try {
                  return Effect.succeed(JSON.parse(text))
                } catch {
                  return Effect.fail(fail("response is not JSON", res.status))
                }
              }
            )
          ),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(fail(`no answer within ${Duration.format(timeout)}`))
          }),
          Effect.catchDefect((defect) => Effect.fail(fail(`transport defect: ${String(defect)}`))),
          Effect.provideService(HttpClient.TracerPropagationEnabled, tracerPropagation),
          Effect.withSpan(`UploadRelay.${operation}`, { attributes: { "walrus.relay": base, "http.request.method": request.method } })
        )
      }

      let cached: TipConfig | undefined
      const tipConfig = Effect.suspend(() =>
        cached !== undefined
          ? Effect.succeed(cached)
          : Effect.flatMap(call("tipConfig", HttpClientRequest.acceptJson(HttpClientRequest.get("/v1/tip-config"))), (json) => {
            const parsed = parseTipConfig(json)
            if (Result.isFailure(parsed)) return Effect.fail(new RelayError({ status: 200, message: `tipConfig: ${parsed.failure}` }))
            cached = parsed.success
            return Effect.succeed(parsed.success)
          })
      )

      const upload = (o: UploadOptions) =>
        Effect.flatMap(
          call(
            "upload",
            HttpClientRequest.post(uploadPath(o)).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bodyUint8Array(o.blob, "application/octet-stream")
            ),
            scaledTimeout(baseTimeout, o.blob.length, minUploadRate)
          ),
          (json) => {
            const parsed = parseUploadResponse(json, o.blobId)
            return Result.isSuccess(parsed)
              ? Effect.succeed(parsed.success)
              : Effect.fail(new RelayError({ status: 200, message: `upload: ${parsed.failure}` }))
          }
        )

      // An untyped caller without `maxTip` gets no tip at all rather than an unbounded one.
      const maxTip = typeof options.maxTip === "bigint" && options.maxTip >= 0n ? options.maxTip : 0n
      const tipAddress = options.tipAddress === undefined ? undefined : Address.normalize(options.tipAddress)
      return UploadRelay.of({ tipConfig, maxTip, tipAddress, upload })
    })
  )

// -----------------------------------------------------------------------------
// Auth input and tip (R3)
// -----------------------------------------------------------------------------

/** `HashedAuthPackage` (`upload_relay/params.rs`): 72 bytes, no length prefix. */
export const AuthPackage = /* @__PURE__ */ Bcs.struct({
  blobDigest: /* @__PURE__ */ Bcs.bytes(32),
  nonceDigest: /* @__PURE__ */ Bcs.bytes(32),
  unencodedLength: Bcs.u64
})

export const authPackage = (blob: Uint8Array, nonce: Uint8Array): typeof AuthPackage.Type => ({
  blobDigest: sha256(blob),
  nonceDigest: sha256(nonce),
  unencodedLength: BigInt(blob.length)
})

/** A fresh 32-byte nonce (`NONCE_LEN`) from the platform's CSPRNG: it is what keeps others from spending our tip transaction. */
export const makeNonce: Effect.Effect<Uint8Array> = /* @__PURE__ */ Effect.sync(() => crypto.getRandomValues(new Uint8Array(32)))

export type AuthError = RelayError | TipTooHigh | BlobTooLarge | SystemError | Ptb.InvalidPureValue

/** `authAndTip` with the relay service passed in (what `Write` uses, so that its own requirements stay honest). */
export const authAndTipWith = (
  relay: UploadRelayService,
  o: { readonly blob: Uint8Array; readonly nonce: Uint8Array }
): Effect.Effect<void, AuthError, Ptb.PtbBuilder | System> =>
  Effect.gen(function*() {
    const config = yield* relay.tipConfig
    if (config._tag === "NoTip") return
    const state = yield* Effect.flatMap(Effect.service(System), (s) => s.state)
    const size = Encoding.symbolSize(o.blob.length, state.nShards)
    if (Result.isFailure(size)) return yield* size.failure
    if (relay.tipAddress !== undefined && config.address !== relay.tipAddress) {
      return yield* new RelayError({
        message: `tipConfig: tip address ${config.address} differs from the configured ${relay.tipAddress}`
      })
    }
    const tip = tipAmount(config, o.blob.length, state.nShards)
    const max = typeof relay.maxTip === "bigint" ? relay.maxTip : 0n
    if (tip > max) return yield* new TipTooHigh({ tip, max })
    // Input 0 (R3): nothing may be added to the builder before this.
    yield* Ptb.pure(AuthPackage, authPackage(o.blob, o.nonce))
    const coin = yield* Ptb.coin({ amount: tip })
    yield* Ptb.transferObjects([coin], yield* Ptb.address(config.address))
  })

/**
 * Must be the first thing the register recipe does: the relay reads input 0
 * (R3). Then pays the tip in SUI (a coin sourced by `Resolve.balances`,
 * address balance first, transferred to the tip address, as
 * `@mysten/walrus` does). Adds nothing when the relay wants no tip.
 */
export const authAndTip = (o: { readonly blob: Uint8Array; readonly nonce: Uint8Array }): Effect.Effect<void, AuthError, Ptb.PtbBuilder | UploadRelay | System> =>
  Effect.flatMap(Effect.service(UploadRelay), (relay) => authAndTipWith(relay, o))

// -----------------------------------------------------------------------------
// Certificate verification
// -----------------------------------------------------------------------------

/**
 * Check a certificate against a committee before it goes on chain: signers
 * distinct and members of `committee` (by `index`), their shards weigh at
 * least `n − f` (T2), the message is byte-equal to `expectedMessage` (which
 * fixes epoch, blob id and persistence, M1), and the aggregate signature
 * verifies against the signers' keys. Pass a committee whose `publicKey`s are
 * the system object's BLS keys (what `certify_blob` aggregates); `Write` does.
 */
export const verifyCertificate = (
  certificate: Certificate.Certificate,
  expectedMessage: Uint8Array,
  committee: Committee
): Effect.Effect<void, CertificateInvalid, Encoder> =>
  Effect.gen(function*() {
    const invalid = (reason: string) => Effect.fail(new CertificateInvalid({ reason }))
    const byIndex = new Map(committee.nodes.map((n) => [n.index, n]))
    const seen = new Set<number>()
    let weight = 0
    const keys: Array<Uint8Array> = []
    for (const s of certificate.signers) {
      if (seen.has(s)) return yield* invalid(`duplicate signer ${s}`)
      seen.add(s)
      const node = byIndex.get(s)
      if (node === undefined) return yield* invalid(`signer ${s} is not a committee member`)
      weight += node.shards.length
      keys.push(node.publicKey)
    }
    const required = Bft.minCorrect(committee.nShards)
    if (weight < required) return yield* invalid(`signers hold ${weight} shards, need ${required}`)
    const m = certificate.serializedMessage
    if (m.length !== expectedMessage.length || !m.every((b, i) => b === expectedMessage[i])) {
      return yield* invalid("message differs from the expected confirmation")
    }
    if (certificate.signature.length !== 96) return yield* invalid(`signature is ${certificate.signature.length} bytes, expected 96`)
    const encoder = yield* Effect.service(Encoder)
    const valid = yield* encoder.blsVerifyAggregate(keys, m, certificate.signature).pipe(
      Effect.catchTag("EncoderError", (e) => invalid(`malformed signature: ${e.message}`))
    )
    if (!valid) return yield* invalid("aggregate signature does not verify")
  })
