/**
 * The indexer's tip and retention floor, for pinning the open ends of a
 * listing before its first request (as the gRPC scans do). Shared by the
 * Checkpoints, Events and CheckpointData layers; each includes `Tip` in its
 * own group.
 */
import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as Schema from "effect/Schema"
import { RpcError } from "@unconfirmed/sui/RpcError"
import { U64 } from "./convert.ts"

export const Tip = GraphQL.query("Tip", {
  document: "query Tip{checkpoint{sequenceNumber} " +
    "serviceConfig{availableRange(type:\"Query\",field:\"checkpoint\"){first{sequenceNumber}}}}",
  result: Schema.Struct({
    checkpoint: Schema.NullOr(Schema.Struct({ sequenceNumber: U64 })),
    serviceConfig: Schema.optionalKey(Schema.NullOr(Schema.Struct({
      availableRange: Schema.NullOr(Schema.Struct({ first: Schema.NullOr(Schema.Struct({ sequenceNumber: U64 })) }))
    })))
  })
})

export interface Range {
  /** The lowest checkpoint the indexer serves (0 when it does not say). */
  readonly first: bigint
  /** One past the latest indexed checkpoint. */
  readonly end: bigint
}

/** The served range from a `Tip` answer; an indexer with no checkpoint is UNAVAILABLE, never "empty chain". */
export const rangeOf = (r: GraphQL.Result<typeof Tip>): Effect.Effect<Range, RpcError> =>
  r.checkpoint === null
    ? Effect.fail(new RpcError({ method: "Tip", code: "UNAVAILABLE", message: "the indexer reports no latest checkpoint" }))
    : Effect.succeed({
      first: r.serviceConfig?.availableRange?.first?.sequenceNumber ?? 0n,
      end: r.checkpoint.sequenceNumber + 1n
    })
