/**
 * `EnokiClient` over Effect's `HttpClient`: the same endpoints, headers and
 * JSON bodies as `@mysten/enoki`'s `EnokiClient`.
 *
 *   EnokiHttp.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))
 */
import * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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

export const DEFAULT_URL = "https://api.enoki.mystenlabs.com"
/** How long a successful `getApp` (which names the sponsor addresses) is reused. Failures aren't cached. */
export const APP_CACHE_TTL = "5 minutes"
const VERSION = "v1"
const ZKLOGIN_HEADER = "zklogin-jwt"
/** Headers that carry credentials (`authorization` is redacted by Effect already). */
const REDACTED = [ZKLOGIN_HEADER, "authorization"]

export interface EnokiHttpOptions {
  readonly apiKey: string
  /**
   * Base URL of the Enoki API; `/v1/…` paths are appended to it, trailing slashes stripped.
   * Default {@link DEFAULT_URL} (`https://api.enoki.mystenlabs.com`).
   */
  readonly url?: string
  /**
   * Extra headers on every request (routing, a proxy's credentials). The API key, content type,
   * request id and the user's JWT are set by the layer and take precedence.
   */
  readonly headers?: Readonly<Record<string, string>>
  /** Default `additionalEpochs` for nonces. */
  readonly additionalEpochs?: number
  /**
   * Send `traceparent` / `b3` headers. Off by default: browsers preflight
   * them, and the Enoki API doesn't list them as allowed headers.
   */
  readonly tracerPropagation?: boolean
  /** Bound on each request; one without an answer in time is a retryable `EnokiError` (`status: 0`, `code: "timeout"`). Default 30 seconds. */
  readonly requestTimeout?: Duration.Input
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

/**
 * The failure to keep as an `EnokiError`'s `cause`. HTTP client errors hold
 * the request, whose headers carry the API key and the user's JWT, so only
 * their name and message are kept; a Schema error (about the response body)
 * is kept as is.
 */
const withoutRequest = (e: unknown): unknown => {
  if (Schema.isSchemaError(e)) return e
  const tag = Predicate.hasProperty(e, "reason") && Predicate.hasProperty(e.reason, "_tag") ? String(e.reason._tag) : undefined
  const error = new Error(Predicate.hasProperty(e, "message") ? String(e.message) : String(e))
  error.name = tag ?? "HttpClientError"
  return error
}

export const layer = (options: EnokiHttpOptions): Layer.Layer<EnokiClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    EnokiClient,
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const base = `${(options.url ?? DEFAULT_URL).replace(/\/+$/, "")}/${VERSION}`
      const timeout = Duration.fromInputUnsafe(options.requestTimeout ?? "30 seconds")

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
              ...options.headers,
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
            Effect.mapError((e) => new EnokiError({ status: 0, code: "request_failed", message: e.message, errors: [], cause: withoutRequest(e) }))
          )
          if (response.status < 200 || response.status >= 300) {
            const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
            return yield* errorFromResponse(response.status, text)
          }
          const body = yield* HttpClientResponse.schemaBodyJson(envelope)(response).pipe(
            Effect.mapError((e) =>
              new EnokiError({ status: response.status, code: "invalid_response", message: e.message, errors: [], cause: withoutRequest(e) })
            )
          )
          return (body as { readonly data: S["Type"] }).data
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(new EnokiError({ status: 0, code: "timeout", message: `${operation}: no answer within ${Duration.format(timeout)}`, errors: [] }))
          }),
          Effect.withSpan(`EnokiClient.${operation}`, { attributes: { "http.request.method": method, "enoki.path": path } })
        )
      }

      const jwtHeader = (jwt: string | undefined) => (jwt ? { [ZKLOGIN_HEADER]: jwt } : {})

      // `Sponsor` asks for the app (its sponsor addresses) with every transaction: answer it from a cache,
      // and drop the cache when Enoki says the sponsor or gas price changed, as `@mysten/enoki` does.
      const [getApp, invalidateApp] = yield* Effect.cachedInvalidateWithTTL(
        call("getApp", "GET", "app", E.App),
        (exit) => (Exit.isSuccess(exit) ? APP_CACHE_TTL : 0)
      )
      const dropAppWhenStale = <A>(effect: Effect.Effect<A, EnokiError>) =>
        Effect.tapError(effect, (e) => (e.requiresRebuild ? invalidateApp : Effect.void))

      return EnokiClient.of({
        getApp,
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
              maxEpoch: Number(input.maxEpoch),
              randomness: input.randomness
            }
          }),
        createSponsoredTransaction: (input) => {
          const bySender = "sender" in input ? input : undefined
          return dropAppWhenStale(call("createSponsoredTransaction", "POST", "transaction-blocks/sponsor", E.SponsoredTransaction, {
            headers: jwtHeader("jwt" in input ? input.jwt : undefined),
            body: {
              sender: bySender?.sender,
              network: input.network,
              transactionBlockKindBytes: toBase64(input.transactionKindBytes),
              allowedAddresses: bySender?.allowedAddresses,
              allowedMoveCallTargets: bySender?.allowedMoveCallTargets
            }
          }))
        },
        executeSponsoredTransaction: (input) =>
          dropAppWhenStale(call("executeSponsoredTransaction", "POST", `transaction-blocks/sponsor/${input.digest}`, E.ExecutedTransaction, {
            body: { signature: toBase64(input.signature) }
          })),
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
