import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Chain from "@unconfirmed/sui/Chain"
import { RpcError } from "@unconfirmed/sui/RpcError"
import type { ObjectDigest } from "@unconfirmed/sui/TransactionData"
import { call, U64 } from "./convert.ts"

/** Chain info and the reference gas price in one request (they read the same `epoch`). */
export const ChainInfo = GraphQL.query("ChainInfo", {
  document: "query ChainInfo{chainIdentifier epoch{epochId referenceGasPrice} checkpoint{sequenceNumber}}",
  result: Schema.Struct({
    chainIdentifier: Schema.String,
    epoch: Schema.NullOr(Schema.Struct({
      epochId: U64,
      referenceGasPrice: Schema.optionalKey(Schema.NullOr(U64))
    })),
    checkpoint: Schema.NullOr(Schema.Struct({ sequenceNumber: U64 }))
  })
})

export const group = GraphQLGroup.make(ChainInfo)

/**
 * GraphQL has no chain name, so it is read from the chain id like the gRPC
 * service reports it: `mainnet`, `testnet`, otherwise `unknown` (devnet's
 * genesis changes on every reset; gRPC also reports `unknown` there).
 */
const CHAINS: Record<string, string> = {
  "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S": "mainnet",
  "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD": "testnet"
}

/** A null the indexer answers where a value must exist is the service not ready, never a default. */
const unavailable = (what: string) =>
  new RpcError({ method: "ChainInfo", code: "UNAVAILABLE", message: `the indexer reports no ${what}` })

/**
 * `Chain` over GraphQL. One `ChainInfo` query feeds both members: chain info is
 * cached for 30 seconds, the gas price for a minute; failures are not cached.
 * An indexer that answers null for the current epoch, the latest checkpoint or
 * the gas price fails with UNAVAILABLE instead of inventing a value.
 */
export const layer: Layer.Layer<Chain.Chain, never, GraphQLProtocol.GraphQLProtocol> = Layer.effect(
  Chain.Chain,
  Effect.gen(function*() {
    const client = yield* GraphQLClient.make(group)
    const fetch = yield* client.ChainInfo().pipe(
      call,
      Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "30 seconds" : 0))
    )
    const info = Effect.flatMap(fetch, (r): Effect.Effect<Chain.ChainInfo, RpcError> => {
      if (r.epoch === null) return Effect.fail(unavailable("current epoch"))
      if (r.checkpoint === null) return Effect.fail(unavailable("latest checkpoint"))
      return Effect.succeed({
        chainId: r.chainIdentifier as ObjectDigest,
        chain: CHAINS[r.chainIdentifier] ?? "unknown",
        epoch: r.epoch.epochId,
        checkpointHeight: r.checkpoint.sequenceNumber
      })
    })
    const referenceGasPrice = yield* fetch.pipe(
      Effect.flatMap((r) => {
        const price = r.epoch?.referenceGasPrice
        return price === undefined || price === null ? Effect.fail(unavailable("reference gas price")) : Effect.succeed(price)
      }),
      Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "1 minute" : 0))
    )
    return Chain.Chain.of({ info, referenceGasPrice })
  })
)
