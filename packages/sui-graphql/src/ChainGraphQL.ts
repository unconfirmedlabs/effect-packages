import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Chain from "@unconfirmed/sui/Chain"
import type { ObjectDigest } from "@unconfirmed/sui/TransactionData"
import { call, U64 } from "./convert.ts"

const Sequence = Schema.NullOr(Schema.Struct({ sequenceNumber: U64 }))

export const ChainInfo = GraphQL.query("ChainInfo", {
  document: "query ChainInfo{chainIdentifier epoch{epochId checkpoints(first:1){nodes{sequenceNumber}}} checkpoint{sequenceNumber} " +
    "serviceConfig{availableRange(type:\"Query\",field:\"checkpoint\"){first{sequenceNumber}}}}",
  result: Schema.Struct({
    chainIdentifier: Schema.String,
    epoch: Schema.NullOr(Schema.Struct({
      epochId: U64,
      checkpoints: Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.Struct({ sequenceNumber: U64 })) }))
    })),
    checkpoint: Sequence,
    serviceConfig: Schema.Struct({ availableRange: Schema.Struct({ first: Sequence }) })
  })
})

export const ReferenceGasPrice = GraphQL.query("ReferenceGasPrice", {
  document: "query ReferenceGasPrice{epoch{referenceGasPrice}}",
  result: Schema.Struct({ epoch: Schema.NullOr(Schema.Struct({ referenceGasPrice: Schema.NullOr(U64) })) })
})

export const group = GraphQLGroup.make(ChainInfo, ReferenceGasPrice)

/**
 * GraphQL has no chain name, so it is read from the chain id like the gRPC
 * service reports it: `mainnet`, `testnet`, otherwise `unknown` (devnet's
 * genesis changes on every reset; gRPC also reports `unknown` there).
 */
const CHAINS: Record<string, string> = {
  "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S": "mainnet",
  "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD": "testnet"
}

/** `Chain` over GraphQL. Chain info is cached for 30 seconds, the gas price for a minute; failures are not cached. */
export const layer: Layer.Layer<Chain.Chain, never, GraphQLProtocol.GraphQLProtocol> = Layer.effect(
  Chain.Chain,
  Effect.gen(function*() {
    const client = yield* GraphQLClient.make(group)
    const info = yield* client.ChainInfo().pipe(
      call,
      Effect.map((r): Chain.ChainInfo => ({
        chainId: r.chainIdentifier as ObjectDigest,
        chain: CHAINS[r.chainIdentifier] ?? "unknown",
        epoch: r.epoch?.epochId ?? 0n,
        checkpointHeight: r.checkpoint?.sequenceNumber ?? 0n,
        // The indexer's real retention floor (0 on Mysten's endpoints, which keep all history).
        lowestAvailableCheckpoint: r.serviceConfig.availableRange.first?.sequenceNumber,
        epochFirstCheckpoint: r.epoch?.checkpoints?.nodes[0]?.sequenceNumber
      })),
      Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "30 seconds" : 0))
    )
    const referenceGasPrice = yield* client.ReferenceGasPrice().pipe(
      call,
      Effect.map((r) => r.epoch?.referenceGasPrice ?? 1000n),
      Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "1 minute" : 0))
    )
    return Chain.Chain.of({ info, referenceGasPrice })
  })
)
