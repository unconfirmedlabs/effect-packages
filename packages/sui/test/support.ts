import { Bcs } from "@unconfirmed/bcs"
import { Option } from "effect"

/** Our `_tag` values -> @mysten/bcs `{ Variant: payload }` input, guided by the layout. */
export const toMysten = (l: Bcs.Layout, v: any): any => {
  switch (l._tag) {
    case "ubig":
      return v.toString()
    case "vector":
    case "fixedArray":
      return v.map((x: any) => toMysten(l.item(), x))
    case "option":
      return Option.isNone(v) ? null : toMysten(l.item(), v.value)
    case "tuple":
      return l.items.map((item, i) => toMysten(item(), v[i]))
    case "struct":
      if ("mutability" in v && "initialSharedVersion" in v) {
        return {
          objectId: v.objectId,
          initialSharedVersion: v.initialSharedVersion.toString(),
          mutable: v.mutability._tag === "Mutable",
          mutability: v.mutability._tag
        }
      }
      return Object.fromEntries(l.fields.map(([k, f]) => [k, toMysten(f(), v[k])]))
    case "enum": {
      const variant = l.variants.find((x) => x.name === v._tag)!
      if (variant.payload === "unit") return { [v._tag]: true }
      if (variant.payload === "value") return { [v._tag]: toMysten(variant.layout!(), v.value) }
      return { [v._tag]: toMysten(variant.layout!(), v) }
    }
    default:
      return v
  }
}

export const toB64 = (b: Uint8Array) => Buffer.from(b).toString("base64")

import { Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import * as SuiGrpc from "../src/grpc/index.ts"
import { Objects } from "../src/index.ts"
import type { Address } from "../src/Address.ts"

export const live = process.env.SUI_LIVE === "1"
export const TESTNET = process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443"
export const DEVNET = process.env.SUI_DEVNET_URL ?? "https://fullnode.devnet.sui.io:443"

/** All gRPC services, with every HTTP request URL recorded (to prove batching). */
export const grpcLayer = (baseUrl: string) => {
  const requests: Array<string> = []
  const http = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(Effect.service(HttpClient.HttpClient), HttpClient.tapRequest((req) => Effect.sync(() => requests.push(req.url.split("/").pop()!))))
  ).pipe(Layer.provide(FetchHttpClient.layer))
  return { layer: SuiGrpc.layer({ baseUrl }).pipe(Layer.provideMerge(http)), requests }
}

const FaucetResponse = Schema.Struct({
  status: Schema.Literal("Success"),
  coins_sent: Schema.Array(Schema.Struct({ id: Schema.String, amount: Schema.Number }))
})

/** Fund an address from the devnet faucet and wait until the coin is readable. */
export const faucet = (recipient: Address) =>
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const res = yield* HttpClientRequest.post("https://faucet.devnet.sui.io/v2/gas").pipe(
      HttpClientRequest.bodyJsonUnsafe({ FixedAmountRequest: { recipient } }),
      http.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(FaucetResponse))
    )
    const objects = yield* Objects.Objects
    // Retry exactly the typed "not yet visible" case.
    return yield* objects.get(res.coins_sent[0]!.id as Address).pipe(
      Effect.retry({ while: (e) => e._tag === "ObjectNotFound", schedule: Schedule.spaced("500 millis"), times: 30 })
    )
  })
