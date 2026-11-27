/**
 * Live endpoints for `SUI_LIVE=1` runs: the switch, the full nodes, an
 * all-services gRPC layer that records request paths, and the devnet faucet.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import type { Address } from "@unconfirmed/sui/Address"
import * as Objects from "@unconfirmed/sui/Objects"
import * as SuiGrpc from "@unconfirmed/sui/grpc"

export const live = process.env.SUI_LIVE === "1"
export const TESTNET = process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443"
export const DEVNET = process.env.SUI_DEVNET_URL ?? "https://fullnode.devnet.sui.io:443"

/** All gRPC services (and `GrpcWeb`), with every HTTP request's method name recorded (to prove batching). */
export const grpcLayer = (url: string) => {
  const requests: Array<string> = []
  const http = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(Effect.service(HttpClient.HttpClient), HttpClient.tapRequest((req) => Effect.sync(() => requests.push(req.url.split("/").pop()!))))
  ).pipe(Layer.provide(FetchHttpClient.layer))
  return { layer: SuiGrpc.layer({ url }).pipe(Layer.provideMerge(http)), requests }
}

const FaucetResponse = Schema.Struct({
  status: Schema.Literal("Success"),
  coins_sent: Schema.Array(Schema.Struct({ id: Schema.String, amount: Schema.Number }))
})

/** A faucet answer worth asking again: no answer, a rate limit, or a server error. */
const transient = (e: unknown) =>
  typeof e === "object" && e !== null && "_tag" in e &&
  (e._tag === "TimeoutError" || e._tag === "HttpClientError" &&
    (!("response" in e) || e.response === undefined ||
      ((e.response as { status: number }).status === 429 || (e.response as { status: number }).status >= 500)))

/**
 * Fund an address from the devnet faucet and wait until the coin is readable.
 * Each request is bounded (30 s) and a transient failure (no answer, 429,
 * 5xx) is retried with backoff, since one live run asks it about 17 times
 * from one IP.
 */
export const faucet = (recipient: Address) =>
  Effect.gen(function*() {
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    const res = yield* HttpClientRequest.post("https://faucet.devnet.sui.io/v2/gas").pipe(
      HttpClientRequest.bodyJsonUnsafe({ FixedAmountRequest: { recipient } }),
      http.execute,
      Effect.timeout("30 seconds"),
      Effect.retry({ while: transient, schedule: Schedule.exponential("2 seconds"), times: 4 }),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(FaucetResponse))
    )
    const objects = yield* Objects.Objects
    // Retry exactly the typed "not yet visible" case.
    return yield* objects.get(res.coins_sent[0]!.id as Address).pipe(
      Effect.retry({ while: (e) => e._tag === "ObjectNotFound", schedule: Schedule.spaced("500 millis"), times: 30 })
    )
  })
