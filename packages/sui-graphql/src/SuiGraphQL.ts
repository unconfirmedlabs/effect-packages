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
import * as Effect from "effect/Effect"
import * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Headers from "effect/http/Headers"
import type * as HttpClient from "effect/http/HttpClient"
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
      if (extra === undefined) return http
      const withHeaders = (request: GraphQLProtocol.GraphQLRequest): GraphQLProtocol.GraphQLRequest => ({
        ...request,
        headers: Headers.merge(Headers.fromInput(extra), request.headers)
      })
      return GraphQLProtocol.GraphQLProtocol.of({
        execute: (request) => http.execute(withHeaders(request)),
        subscribe: (request) => Stream.suspend(() => http.subscribe(withHeaders(request))),
        url: http.url
      })
    })
  )
