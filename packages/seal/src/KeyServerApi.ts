/**
 * The key server HTTP API (§4.4, H1–H11): `POST /v1/fetch_key` and
 * `GET /v1/service`, over Effect's `HttpClient`, and the one place where HTTP
 * outcomes become typed `KeyServerError`s.
 *
 *   KeyServerApi.layer().pipe(Layer.provide(FetchHttpClient.layer))
 *
 * The service never retries: `Keys.fetch` does, per server, with
 * `while: KeyServerApi.retryable`. Every outcome is a typed `KeyServerError`,
 * including timeouts and anything an `HttpClient` implementation throws,
 * because the quorum treats defects as fatal.
 *
 * `KeyServerError` is defined in `Errors.ts` (a leaf module) and re-exported here.
 */
import { bytesToHex } from "@noble/hashes/utils.js"
import type { Address } from "@unconfirmed/sui/Address"
import { base64 } from "@scure/base"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Headers from "effect/http/Headers"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Entropy from "./Entropy.ts"
import { isDefinitiveKind, isRetryableKind, KeyServerError, KeyServerErrorKind } from "./Errors.ts"
import { isCanonical } from "./ids.ts"

export { KeyServerError, KeyServerErrorKind }

/** Asking again may help: `Unavailable | RateLimited | InvalidParameter`. A predicate for `Schedule` / `Quorum` `while`. */
export const retryable = (e: KeyServerError): boolean => isRetryableKind(e.kind)

/**
 * The request itself was judged; another honest server will say the same:
 * `NoAccess | InvalidPtb | InvalidPackage | InvalidSignature | InvalidSessionSignature | InvalidCertificate | InvalidMvrName`.
 */
export const definitive = (e: KeyServerError): boolean => isDefinitiveKind(e.kind)

/** Where to send a request: the server's object id, the URL to call, and its API key header if any. */
export interface Endpoint {
  readonly objectId: Address
  readonly url: string
  readonly apiKey?: { readonly name: string; readonly value: Redacted.Redacted<string> }
}

/** The session certificate (H5, R1). */
export interface Certificate {
  readonly user: Address
  /** The session's 32-byte Ed25519 public key. */
  readonly sessionVk: Uint8Array
  /** ms since the epoch. */
  readonly creationTime: number
  readonly ttlMin: number
  /** A serialized Sui signature over the personal message of R1. */
  readonly signature: Uint8Array
  readonly mvrName?: string
}

/** A `fetch_key` request (H5). */
export interface FetchKeyRequest {
  /** BCS `ProgrammableTransaction` (P2). */
  readonly ptb: Uint8Array
  /** `ElGamal.KeyPair.publicKey`, 48 bytes. */
  readonly encKey: Uint8Array
  /** `ElGamal.KeyPair.verificationKey`, 96 bytes. */
  readonly encVerificationKey: Uint8Array
  /** The session key's Ed25519 signature over R4, 64 bytes. */
  readonly requestSignature: Uint8Array
  readonly certificate: Certificate
}

/** One entry of a `fetch_key` response (H6): the full id and the ElGamal-encrypted derived key `(c0, c1)`. */
export interface EncryptedKey {
  readonly fullId: Uint8Array
  readonly ciphertext: readonly [Uint8Array, Uint8Array]
}

export interface KeyServerApiOptions {
  /** Default 10 seconds, body included. A timeout is `KeyServerError` `"Timeout"`. */
  readonly requestTimeout?: Duration.Input
  /** `Client-Sdk-Type`. Default `"typescript"`: the aggregator refuses any type but `typescript`, `rust` and `python` (H2). */
  readonly sdkType?: string
  /** `Client-Sdk-Version`. Default `"2.0.1"`, the `@mysten/seal` version whose wire protocol this matches. */
  readonly sdkVersion?: string
  /** Default `"0.4.1"`; a missing `X-KeyServer-Version` header is accepted (H4). Checked on 2xx answers only. */
  readonly minServerVersion?: string
  /** Default false: gateways allow only the headers of H3 for CORS. */
  readonly tracerPropagation?: boolean
  /**
   * Default 1 MiB. A 2xx body larger than this is `Malformed` without being parsed (a full answer for the protocol's 100
   * ids is a few tens of KB). Checked against `Content-Length` before reading, and against the body read.
   */
  readonly maxResponseBytes?: number
}

export interface ServiceInfo {
  readonly serviceId: Address
  /** The proof of possession, 48 bytes (C17); check it with `Ibe.verifyProofOfPossession`. */
  readonly pop: Uint8Array
  /** `X-KeyServer-Version`, when the answer carried it. */
  readonly version: string | undefined
}

export interface KeyServerApiService {
  /** One entry per command of the request's PTB, in order (H6). Never retries. */
  readonly fetchKey: (server: Endpoint, request: FetchKeyRequest) => Effect.Effect<ReadonlyArray<EncryptedKey>, KeyServerError>
  /** `GET /v1/service`: the server's object id and proof of possession (H10). */
  readonly service: (server: Endpoint) => Effect.Effect<ServiceInfo, KeyServerError>
}

export class KeyServerApi extends /* @__PURE__ */ Context.Service<KeyServerApi, KeyServerApiService>()(
  "@unconfirmed/seal/KeyServerApi"
) {}

// -----------------------------------------------------------------------------
// Request body (H5)
// -----------------------------------------------------------------------------

/** The exact JSON of H5, same field order as `@mysten/seal` 2.0.1, `mvr_name` omitted when absent. */
export const requestBody = (request: FetchKeyRequest): string => {
  const c = request.certificate
  return JSON.stringify({
    ptb: base64.encode(request.ptb),
    enc_key: base64.encode(request.encKey),
    enc_verification_key: base64.encode(request.encVerificationKey),
    request_signature: base64.encode(request.requestSignature),
    certificate: {
      user: c.user,
      session_vk: base64.encode(c.sessionVk),
      creation_time: c.creationTime,
      ttl_min: c.ttlMin,
      signature: base64.encode(c.signature),
      ...(c.mvrName !== undefined && { mvr_name: c.mvrName })
    }
  })
}

// -----------------------------------------------------------------------------
// The mapping (§4.4)
// -----------------------------------------------------------------------------

/** Seal's error names (H7, `errors.rs`) and the kind each maps to. */
const BY_NAME: Readonly<Record<string, KeyServerErrorKind>> = {
  NoAccess: "NoAccess",
  InvalidPTB: "InvalidPtb",
  InvalidPackage: "InvalidPackage",
  InvalidParameter: "InvalidParameter",
  InvalidSignature: "InvalidSignature",
  InvalidSessionSignature: "InvalidSessionSignature",
  InvalidCertificate: "InvalidCertificate",
  InvalidMVRName: "InvalidMvrName",
  InvalidServiceId: "InvalidServiceId",
  UnsupportedPackageId: "UnsupportedPackage",
  InvalidSDKType: "SdkRejected",
  InvalidSDKVersion: "SdkRejected",
  DeprecatedSDKVersion: "SdkRejected",
  MissingRequiredHeader: "SdkRejected",
  Failure: "Unavailable"
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** The start of a body that is not Seal's JSON, kept as `message`. */
const MAX_TEXT = 500
/** A JSON `message` (a Move abort is about 350 characters). */
const MAX_MESSAGE = 2000
/** A JSON `error` name kept verbatim. */
const MAX_ERROR = 100

/** Whatever of `{ error, message }` a body has, read leniently; not scrubbed nor truncated. */
const parseErrorBody = (body: string): { readonly error?: string; readonly message?: string } => {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return {}
  }
  if (!isRecord(json)) return {}
  return {
    ...(typeof json.error === "string" && { error: json.error }),
    ...(typeof json.message === "string" && { message: json.message })
  }
}

/**
 * Never let an API key reach an error, even if a gateway echoes it. Applied to whole texts, before any truncation, so
 * that a cut cannot leave part of a key behind.
 */
const scrub = (server: Endpoint, text: string): string => {
  const key = server.apiKey && Redacted.value(server.apiKey.value)
  return key ? text.split(key).join("<redacted>") : text
}

/** The longest `Retry-After` honoured, in ms. */
const MAX_RETRY_AFTER = 3_600_000

/** `Retry-After` (H11) as ms from `now`: delay-seconds or an HTTP date; `undefined` when absent or unreadable. */
export const parseRetryAfter = (value: string | undefined, now: number): number | undefined => {
  if (value === undefined) return undefined
  const v = value.trim()
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now
  return Number.isFinite(ms) ? Math.min(Math.max(0, ms), MAX_RETRY_AFTER) : undefined
}

const baseUrl = (server: Endpoint) => server.url.replace(/\/+$/, "")

/**
 * A non-2xx answer as a `KeyServerError`, decided once here (§4.4): `429` →
 * `RateLimited` whatever the body (H11); a JSON body whose `error` is one of
 * Seal's names (H7) → that name's kind (`Failure` → `Unavailable`, the four SDK
 * header complaints → `SdkRejected`); otherwise `401`/`403` → `Unauthorized`,
 * `5xx` → `Unavailable`, anything else → `Rejected`. `message` is the server's
 * `message` (first 2000 characters), else the start of the body (500), else
 * `HTTP <status>`; `error` is kept to 100 characters. Both are scrubbed of the
 * API key before they are cut. `retryAfter` (ms) is the parsed `Retry-After`.
 */
export const fromResponse = (
  server: Endpoint,
  status: number,
  body: string,
  requestId?: string,
  retryAfter?: number
): KeyServerError => {
  const parsed = parseErrorBody(body)
  const kind: KeyServerErrorKind = status === 429
    ? "RateLimited"
    : parsed.error !== undefined && Object.hasOwn(BY_NAME, parsed.error)
    ? BY_NAME[parsed.error]!
    : status === 401 || status === 403
    ? "Unauthorized"
    : status >= 500 && status <= 599
    ? "Unavailable"
    : "Rejected"
  const message = parsed.message !== undefined
    ? scrub(server, parsed.message).slice(0, MAX_MESSAGE)
    : scrub(server, body.trim()).slice(0, MAX_TEXT) || `HTTP ${status}`
  return new KeyServerError({
    server: server.objectId,
    url: baseUrl(server),
    kind,
    status,
    ...(parsed.error !== undefined && { error: scrub(server, parsed.error).slice(0, MAX_ERROR) }),
    ...(requestId !== undefined && { requestId }),
    ...(retryAfter !== undefined && { retryAfter }),
    message
  })
}

// -----------------------------------------------------------------------------
// Response bodies (H6, H10)
// -----------------------------------------------------------------------------

const decodeB64 = (u: unknown): Uint8Array | undefined => {
  if (typeof u !== "string") return undefined
  try {
    return base64.decode(u)
  } catch {
    return undefined
  }
}

const isByte = (u: unknown): u is number => typeof u === "number" && Number.isInteger(u) && u >= 0 && u <= 255

/** `{ decryption_keys: [{ id: number[], encrypted_key: [base64, base64] }] }`, or the reason it is not. */
export const decodeFetchKeyResponse = (json: unknown): ReadonlyArray<EncryptedKey> | string => {
  if (!isRecord(json) || !Array.isArray(json.decryption_keys)) return "expected { decryption_keys: [...] }"
  const out: Array<EncryptedKey> = []
  for (const [i, entry] of json.decryption_keys.entries()) {
    if (!isRecord(entry)) return `decryption_keys[${i}] is not an object`
    const id = entry.id
    if (!Array.isArray(id) || !id.every(isByte)) return `decryption_keys[${i}].id is not a byte array`
    const ek = entry.encrypted_key
    if (!Array.isArray(ek) || ek.length !== 2) return `decryption_keys[${i}].encrypted_key is not a pair`
    const c0 = decodeB64(ek[0])
    const c1 = decodeB64(ek[1])
    if (!c0 || !c1) return `decryption_keys[${i}].encrypted_key is not base64`
    out.push({ fullId: Uint8Array.from(id), ciphertext: [c0, c1] })
  }
  return out
}

/** `{ service_id, pop }` (H10), or the reason it is not. */
export const decodeServiceResponse = (json: unknown): { readonly serviceId: Address; readonly pop: Uint8Array } | string => {
  if (!isRecord(json)) return "expected { service_id, pop }"
  const id = typeof json.service_id === "string" ? json.service_id.toLowerCase() : undefined
  if (!isCanonical(id)) return "service_id is not an object id"
  const pop = decodeB64(json.pop)
  if (!pop || pop.length !== 48) return "pop is not 48 bytes of base64"
  return { serviceId: id, pop }
}

// -----------------------------------------------------------------------------
// Versions (H4)
// -----------------------------------------------------------------------------

/** `major.minor.patch` (pre-release and build suffixes ignored), or undefined. */
const parseVersion = (s: string): readonly [number, number, number] | undefined => {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(s)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

/** `a < b`, both parsed. */
const olderThan = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export const DEFAULT_SDK_TYPE = "typescript"
export const DEFAULT_SDK_VERSION = "2.0.1"
export const DEFAULT_MIN_SERVER_VERSION = "0.4.1"

type Operation = "fetchKey" | "service"

/** A version 4 UUID from 16 bytes of `Entropy` (works where `crypto.randomUUID` does not: insecure contexts). */
const requestIdFrom = (b: Uint8Array): string => {
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = bytesToHex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const DEFAULT_MAX_RESPONSE_BYTES = 1 << 20

export const layer = (options: KeyServerApiOptions = {}): Layer.Layer<KeyServerApi, never, HttpClient.HttpClient> =>
  Layer.effect(
    KeyServerApi,
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const timeout = Duration.fromInputUnsafe(options.requestTimeout ?? Duration.seconds(10))
      const sdkType = options.sdkType ?? DEFAULT_SDK_TYPE
      const sdkVersion = options.sdkVersion ?? DEFAULT_SDK_VERSION
      const minVersionText = options.minServerVersion ?? DEFAULT_MIN_SERVER_VERSION
      const minVersion = parseVersion(minVersionText)
      if (!minVersion) return yield* Effect.die(new Error(`KeyServerApi: minServerVersion is not a version: ${minVersionText}`))
      const tracerPropagation = options.tracerPropagation ?? false
      const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
      if (!(Number.isSafeInteger(maxBytes) && maxBytes > 0)) {
        return yield* Effect.die(new Error(`KeyServerApi: maxResponseBytes must be a positive integer, got ${maxBytes}`))
      }
      const redactedNames = (server: Endpoint) => (names: ReadonlyArray<string | RegExp>) =>
        server.apiKey ? [...names, server.apiKey.name.toLowerCase()] : names

      /**
       * One request; a 2xx JSON body through `decode` (a string is why it does not decode) and the server version, or a
       * `KeyServerError`. Everything, the `Request-Id` included, is drawn when the effect runs: retrying the returned
       * effect sends a new id.
       */
      const call = <A>(
        operation: Operation,
        server: Endpoint,
        request: HttpClientRequest.HttpClientRequest,
        decode: (json: unknown) => A | string
      ): Effect.Effect<{ readonly value: A; readonly version: string | undefined }, KeyServerError> =>
        Entropy.bytes(16).pipe(
          // A runtime without a random source (no `crypto.getRandomValues`) is a typed failure, not a defect.
          Effect.catchDefect((defect) =>
            Effect.fail(
              new KeyServerError({
                server: server.objectId,
                url: baseUrl(server),
                kind: "Unavailable",
                message: `${operation}: no random source for the Request-Id: ${String(defect)}`
              })
            )
          ),
          Effect.flatMap((bytes) => send(operation, server, request, decode, requestIdFrom(bytes)))
        )

      const send = <A>(
        operation: Operation,
        server: Endpoint,
        request: HttpClientRequest.HttpClientRequest,
        decode: (json: unknown) => A | string,
        requestId: string
      ): Effect.Effect<{ readonly value: A; readonly version: string | undefined }, KeyServerError> => {
        const url = baseUrl(server)
        const fail = (kind: KeyServerErrorKind, message: string, status?: number) =>
          new KeyServerError({
            server: server.objectId,
            url,
            kind,
            ...(status !== undefined && { status }),
            requestId,
            message: scrub(server, `${operation}: ${message}`)
          })
        const text = (res: HttpClientResponse.HttpClientResponse) =>
          Effect.mapError(res.text, (e) => fail("Unavailable", `reading the body: ${e.message}`, res.status))
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Request-Id": requestId,
          "Client-Sdk-Type": sdkType,
          "Client-Sdk-Version": sdkVersion,
          ...(server.apiKey && { [server.apiKey.name]: Redacted.value(server.apiKey.value) })
        }
        const execute = http.execute(HttpClientRequest.setHeaders(HttpClientRequest.prependUrl(request, url), headers)).pipe(
          // A tracer that records request headers must not record the API key, whatever its header is called.
          Effect.updateService(Headers.CurrentRedactedNames, redactedNames(server))
        )
        return execute.pipe(
          Effect.mapError((e) => fail("Unavailable", e.message)),
          Effect.flatMap((res) => {
            if (res.status < 200 || res.status > 299) {
              return Effect.flatMap(Clock.currentTimeMillis, (now) => {
                const retryAfter = res.status === 429 || res.status === 503
                  ? parseRetryAfter(res.headers["retry-after"], now)
                  : undefined
                return text(res).pipe(
                  Effect.orElseSucceed(() => ""),
                  Effect.flatMap((body) => Effect.fail(fromResponse(server, res.status, body, requestId, retryAfter)))
                )
              })
            }
            const version = res.headers["x-keyserver-version"]
            if (version !== undefined) {
              const parsed = parseVersion(version)
              if (!parsed || olderThan(parsed, minVersion)) {
                return Effect.fail(
                  fail("UnsupportedServerVersion", `key server version ${version} is older than ${minVersionText}`, res.status)
                )
              }
            }
            const declared = Number(res.headers["content-length"])
            if (Number.isFinite(declared) && declared > maxBytes) {
              return Effect.fail(fail("Malformed", `response of ${declared} bytes exceeds ${maxBytes}`, res.status))
            }
            return Effect.flatMap(text(res), (body) => {
              if (body.length > maxBytes) {
                return Effect.fail(fail("Malformed", `response exceeds ${maxBytes} bytes`, res.status))
              }
              let json: unknown
              try {
                json = JSON.parse(body)
              } catch {
                return Effect.fail(fail("Malformed", "response is not JSON", res.status))
              }
              const value = decode(json)
              return typeof value === "string" ? Effect.fail(fail("Malformed", value, res.status)) : Effect.succeed({ value, version })
            })
          }),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(fail("Timeout", `no answer within ${Duration.format(timeout)}`))
          }),
          // Nothing an HttpClient implementation throws may escape as a defect: the quorum would stop.
          Effect.catchDefect((defect) => Effect.fail(fail("Unavailable", `transport defect: ${String(defect)}`))),
          Effect.provideService(HttpClient.TracerPropagationEnabled, tracerPropagation),
          Effect.withSpan(`KeyServerApi.${operation}`, {
            attributes: { "seal.server": server.objectId, "url.full": url, "seal.request_id": requestId }
          })
        )
      }

      return KeyServerApi.of({
        fetchKey: (server, request) =>
          Effect.map(
            call(
              "fetchKey",
              server,
              HttpClientRequest.post("/v1/fetch_key").pipe(HttpClientRequest.bodyText(requestBody(request), "application/json")),
              decodeFetchKeyResponse
            ),
            (r) => r.value
          ),
        service: (server) =>
          Effect.map(
            call("service", server, HttpClientRequest.get(`/v1/service?service_id=${server.objectId}`), decodeServiceResponse),
            ({ value, version }) => ({ ...value, version })
          )
      })
    })
  )
