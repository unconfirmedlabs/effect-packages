/**
 * The key server HTTP API (§4.4): `POST /v1/fetch_key` and `GET /v1/service`.
 *
 * This module holds the shared declarations: the request and response types,
 * `KeyServerError` (defined in `Errors.ts`, re-exported here) with its
 * `retryable` / `definitive` predicates, and the `KeyServerApi` service class.
 * The HTTP implementation (`layer`), `requestBody` and the status mapping
 * (`fromResponse`) arrive with work package S4.
 */
import type { Address } from "@unconfirmed/sui/Address"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import { isDefinitiveKind, isRetryableKind, KeyServerError, KeyServerErrorKind } from "./Errors.ts"

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
  /** Default 10 seconds, body included. */
  readonly requestTimeout?: Duration.Input
  /** `Client-Sdk-Type`. Default `"typescript"` (H2). */
  readonly sdkType?: string
  /** `Client-Sdk-Version`. Default `"2.0.1"`. */
  readonly sdkVersion?: string
  /** Default `"0.4.1"`; a missing `X-KeyServer-Version` header is accepted (H4). */
  readonly minServerVersion?: string
  /** Default false (H3). */
  readonly tracerPropagation?: boolean
}

export interface KeyServerApiService {
  /** One entry per command of the request's PTB, in order (H6). Never retries. */
  readonly fetchKey: (server: Endpoint, request: FetchKeyRequest) => Effect.Effect<ReadonlyArray<EncryptedKey>, KeyServerError>
  /** `GET /v1/service`: the server's object id and proof of possession (H10). */
  readonly service: (
    server: Endpoint
  ) => Effect.Effect<
    { readonly serviceId: Address; readonly pop: Uint8Array; readonly version: string | undefined },
    KeyServerError
  >
}

export class KeyServerApi extends /* @__PURE__ */ Context.Service<KeyServerApi, KeyServerApiService>()(
  "@unconfirmed/seal/KeyServerApi"
) {}
