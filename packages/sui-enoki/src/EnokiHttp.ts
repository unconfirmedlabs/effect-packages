/**
 * `EnokiClient` over Effect's `HttpClient`: the same endpoints, headers and
 * JSON bodies as `@mysten/enoki`'s `EnokiClient`.
 *
 *   EnokiHttp.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))
 */
import * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Headers from "effect/http/Headers"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { EnokiClient, EnokiError, type EnokiErrorDetail } from "./EnokiClient.ts"
import * as E from "./EnokiClient.ts"

export const DEFAULT_API_URL = "https://api.enoki.mystenlabs.com"
const VERSION = "v1"
const ZKLOGIN_HEADER = "zklogin-jwt"
/** Headers that carry credentials (`authorization` is redacted by Effect already). */
const REDACTED = [ZKLOGIN_HEADER, "authorization"]

export interface EnokiHttpOptions {
  readonly apiKey: string
  /** Default `https://api.enoki.mystenlabs.com`. */
  readonly apiUrl?: string
  /** Default `additionalEpochs` for nonces. */
  readonly additionalEpochs?: number
  /**
   * Send `traceparent` / `b3` headers. Off by default: browsers preflight
   * them, and the Enoki API doesn't list them as allowed headers.
   */
  readonly tracerPropagation?: boolean
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** `flag || bytes` in base64, as `PublicKey.toSuiPublicKey()`. */
const suiPublicKey = (pk: SignatureScheme.PublicKey) => toBase64(SignatureScheme.toSuiBytes(pk))

const ErrorBody = Schema.fromJsonString(Schema.Struct({ errors: Schema.Array(Schema.Unknown) }))
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody)

/** One entry, keeping whichever of `code` / `message` / `data` are well-formed (as `@mysten/enoki` reads them raw). */
const detail = (entry: unknown): EnokiErrorDetail | undefined => {
  if (!Predicate.isObject(entry)) return undefined
  const e = entry as Record<string, unknown>
  return {
    ...(Predicate.isString(e.code) && { code: e.code }),
    ...(Predicate.isString(e.message) && { message: e.message }),
    ...("data" in e && { data: e.data })
  }
}

/** @internal An error response, decoded like `@mysten/enoki`'s `EnokiClientError`: leniently, per entry. */
export const errorFromResponse = (status: number, text: string): EnokiError => {
  const errors = Option.match(decodeErrorBody(text), {
    onNone: () => [],
    onSome: (b) => b.errors.flatMap((entry) => detail(entry) ?? [])
  })
  const first = errors[0]
  return new EnokiError({
    status,
    code: first?.code ?? "unknown_error",
    message: first?.message ?? `Request to Enoki API failed (status: ${status})`,
    errors
  })
}

export const layer = (options: EnokiHttpOptions): Layer.Layer<EnokiClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    EnokiClient,
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const base = `${options.apiUrl ?? DEFAULT_API_URL}/${VERSION}`

      const call = <S extends Schema.Top & { readonly DecodingServices: never }>(
        operation: string,
        method: "GET" | "POST",
        path: string,
        data: S,
        init: { readonly headers?: Record<string, string>; readonly body?: unknown } = {}
      ): Effect.Effect<S["Type"], EnokiError> => {
        const envelope = Schema.Struct({ data })
        return Effect.gen(function*() {
          let request = HttpClientRequest.make(method)(`${base}/${path}`).pipe(
            HttpClientRequest.setHeaders({
              ...init.headers,
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
              "Request-Id": crypto.randomUUID()
            })
          )
          if (init.body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, init.body)
          const redacted = yield* Headers.CurrentRedactedNames
          const response = yield* http.execute(request).pipe(
            Effect.provideService(HttpClient.TracerPropagationEnabled, options.tracerPropagation ?? false),
            // The JWT is a bearer credential for the user; keep it out of spans and logs like `Authorization`.
            Effect.provideService(Headers.CurrentRedactedNames, [...redacted, ...REDACTED]),
            Effect.mapError((e) => new EnokiError({ status: 0, code: "request_failed", message: e.message, errors: [] }))
          )
          if (response.status < 200 || response.status >= 300) {
            const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
            return yield* errorFromResponse(response.status, text)
          }
          const body = yield* HttpClientResponse.schemaBodyJson(envelope)(response).pipe(
            Effect.mapError((e) =>
              new EnokiError({ status: response.status, code: "invalid_response", message: e.message, errors: [] })
            )
          )
          return (body as { readonly data: S["Type"] }).data
        }).pipe(Effect.withSpan(`EnokiClient.${operation}`, { attributes: { "http.request.method": method, "enoki.path": path } }))
      }

      const jwtHeader = (jwt: string | undefined) => (jwt ? { [ZKLOGIN_HEADER]: jwt } : {})

      return EnokiClient.of({
        getApp: call("getApp", "GET", "app", E.App),
        getZkLogin: ({ jwt }) => call("getZkLogin", "GET", "zklogin", E.ZkLoginAccount, { headers: jwtHeader(jwt) }),
        getZkLoginAddresses: ({ jwt }) =>
          call("getZkLoginAddresses", "GET", "zklogin/addresses", E.ZkLoginAddresses, { headers: jwtHeader(jwt) }),
        createZkLoginNonce: (input) =>
          call("createZkLoginNonce", "POST", "zklogin/nonce", E.ZkLoginNonce, {
            body: {
              network: input.network,
              ephemeralPublicKey: suiPublicKey(input.ephemeralPublicKey),
              additionalEpochs: input.additionalEpochs ?? options.additionalEpochs
            }
          }),
        createZkLoginZkp: (input) =>
          call("createZkLoginZkp", "POST", "zklogin/zkp", E.ZkLoginZkp, {
            headers: jwtHeader(input.jwt),
            body: {
              network: input.network,
              ephemeralPublicKey: suiPublicKey(input.ephemeralPublicKey),
              maxEpoch: input.maxEpoch,
              randomness: input.randomness
            }
          }),
        createSponsoredTransaction: (input) => {
          const bySender = "sender" in input ? input : undefined
          return call("createSponsoredTransaction", "POST", "transaction-blocks/sponsor", E.SponsoredTransaction, {
            headers: jwtHeader("jwt" in input ? input.jwt : undefined),
            body: {
              sender: bySender?.sender,
              network: input.network,
              transactionBlockKindBytes: toBase64(input.transactionKindBytes),
              allowedAddresses: bySender?.allowedAddresses,
              allowedMoveCallTargets: bySender?.allowedMoveCallTargets
            }
          })
        },
        executeSponsoredTransaction: (input) =>
          call("executeSponsoredTransaction", "POST", `transaction-blocks/sponsor/${input.digest}`, E.ExecutedTransaction, {
            body: { signature: toBase64(input.signature) }
          }),
        sponsorAndExecuteTransaction: (input) =>
          call("sponsorAndExecuteTransaction", "POST", "transaction-blocks/sponsor/execute", E.ExecutedTransaction, {
            body: {
              network: input.network,
              transactionBytes: toBase64(input.transactionBytes),
              signature: toBase64(input.signature),
              allowedAddresses: input.allowedAddresses,
              allowedMoveCallTargets: input.allowedMoveCallTargets
            }
          })
      })
    })
  )
