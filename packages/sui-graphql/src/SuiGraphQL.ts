/**
 * The transport every GraphQL capability service runs on: Effect's
 * `GraphQLProtocol` over `HttpClient`, pointed at a Sui GraphQL endpoint.
 *
 * Queries and mutations are `POST`ed to `url`; subscriptions use graphql-sse on
 * `url + "/subscriptions"` (where Sui serves them; the main endpoint answers
 * "Subscriptions are not supported on this transport").
 *
 * Everything else HTTP-shaped (proxies, logging, recording for tests) is
 * `HttpClient` middleware.
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as GraphQLClientError from "effect/graphql/GraphQLClientError"
import * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Headers from "effect/http/Headers"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

export const MAINNET = "https://graphql.mainnet.sui.io/graphql"
export const TESTNET = "https://graphql.testnet.sui.io/graphql"
export const DEVNET = "https://graphql.devnet.sui.io/graphql"

export interface SuiGraphQLOptions {
  /** A Sui GraphQL endpoint, e.g. {@link TESTNET}. */
  readonly url: string
  /** The graphql-sse endpoint. Defaults to `url` with `/subscriptions` appended. */
  readonly subscriptionUrl?: string
  /** Extra headers on every request (API keys, routing). */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Bound on each query or mutation; one without an answer in time fails with a
   * retryable `RpcError` (`UNAVAILABLE`). Subscriptions are not bounded. Default 30 seconds.
   */
  readonly requestTimeout?: Duration.Input
  /** Send `traceparent` / `b3` headers. Off by default (CORS preflights); spans are recorded either way. */
  readonly tracerPropagation?: boolean
}

export const subscriptionUrlFor = (url: string): string => {
  const u = new URL(url)
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/subscriptions`
  return u.toString()
}

/** The `GraphQLProtocol` for a Sui endpoint. Needs an `HttpClient`. */
export const protocol = (options: SuiGraphQLOptions): Layer.Layer<GraphQLProtocol.GraphQLProtocol, never, HttpClient.HttpClient> =>
  Layer.effect(
    GraphQLProtocol.GraphQLProtocol,
    Effect.gen(function*() {
      const subscriptionUrl = options.subscriptionUrl ?? subscriptionUrlFor(options.url)
      const http = yield* GraphQLProtocol.makeHttp({
        url: ({ kind }) => (kind === "subscription" ? subscriptionUrl : options.url)
      })
      const extra = options.headers
      const timeout = Duration.fromInputUnsafe(options.requestTimeout ?? "30 seconds")
      const tracerPropagation = options.tracerPropagation ?? false
      const withHeaders = (request: GraphQLProtocol.GraphQLRequest): GraphQLProtocol.GraphQLRequest =>
        extra === undefined ? request : { ...request, headers: Headers.merge(Headers.fromInput(extra), request.headers) }
      return GraphQLProtocol.GraphQLProtocol.of({
        execute: (request) =>
          http.execute(withHeaders(request)).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.fail(new GraphQLClientError.TransportError({ description: `no answer within ${Duration.format(timeout)}` }))
            }),
            Effect.provideService(HttpClient.TracerPropagationEnabled, tracerPropagation)
          ),
        subscribe: (request) =>
          Stream.suspend(() => http.subscribe(withHeaders(request))).pipe(
            Stream.provideService(HttpClient.TracerPropagationEnabled, tracerPropagation)
          ),
        url: http.url
      })
    })
  )
