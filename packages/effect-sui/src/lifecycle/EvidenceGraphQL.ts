/**
 * `Evidence` over GraphQL: one query, answered at one checkpoint by one
 * indexer, reads the epoch it has reached, whether it serves the digest, its
 * retention floor for transaction lookups and the first checkpoint of the
 * window's first epoch, so the observation is consistent by construction.
 * Nothing is cached. Its own subpath, so nothing else loads it.
 *
 *   EvidenceGraphQL.layer.pipe(Layer.provide(SuiGraphQL.protocol({ url })))
 *
 * Point it at the same endpoint as `Transactions`.
 */
import { call, U64 } from "../graphql/convert.ts"
import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Evidence, historyGap } from "./Evidence.ts"

const Sequence = Schema.NullOr(Schema.Struct({ sequenceNumber: U64 }))

export const ObserveTransaction = GraphQL.query("ObserveTransaction", {
  document: "query ObserveTransaction($digest:String!,$epoch:UInt53!){epoch{epochId} " +
    "transactionEffects(digest:$digest){digest} " +
    "serviceConfig{availableRange(type:\"Query\",field:\"transactionEffects\"){first{sequenceNumber}}} " +
    "start:epoch(epochId:$epoch){epochId checkpoints(first:1){nodes{sequenceNumber}}}}",
  variables: { digest: Schema.String, epoch: Schema.Number },
  result: Schema.Struct({
    epoch: Schema.NullOr(Schema.Struct({ epochId: U64 })),
    transactionEffects: Schema.NullOr(Schema.Struct({ digest: Schema.String })),
    serviceConfig: Schema.NullOr(Schema.Struct({ availableRange: Schema.NullOr(Schema.Struct({ first: Sequence })) })),
    start: Schema.NullOr(Schema.Struct({
      epochId: U64,
      checkpoints: Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.Struct({ sequenceNumber: U64 })) }))
    }))
  })
})

export const group = GraphQLGroup.make(ObserveTransaction)

export const layer: Layer.Layer<never, never, GraphQLProtocol.GraphQLProtocol> = Layer.effect(
  Evidence,
  Effect.gen(function*() {
    const client = yield* GraphQLClient.make(group)
    return {
      observe: (digest, fromEpoch) =>
        client.ObserveTransaction({ digest, epoch: Number(fromEpoch) }).pipe(
          call,
          Effect.flatMap((r) => {
            if (r.epoch === null) return Effect.succeedNone
            const lowest = Option.fromNullishOr(r.serviceConfig?.availableRange?.first?.sequenceNumber)
            const start = r.start !== null && r.start.epochId === fromEpoch
              ? Option.fromNullishOr(r.start.checkpoints?.nodes[0]?.sequenceNumber)
              : Option.none<bigint>()
            return Effect.map(
              historyGap(lowest, fromEpoch, () => Effect.succeed(start)),
              (gap) => Option.some({ epoch: r.epoch!.epochId, found: r.transactionEffects?.digest === digest, gap })
            )
          }),
          Effect.withSpan("Evidence.observe", { attributes: { digest } })
        )
    }
  })
)
