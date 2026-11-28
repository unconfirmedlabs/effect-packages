import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Checkpoints from "../Checkpoints.ts"
import { call, U64 } from "./convert.ts"
import { noClientRetry, resubscribe } from "./subscription.ts"
import { rangeOf, Tip } from "./tip.ts"

/** The largest page the server allows for `Query.checkpoints`. */
const PAGE = 50

const CheckpointNode = Schema.Struct({ sequenceNumber: U64, digest: Schema.String })

export const ListCheckpoints = GraphQL.query("ListCheckpoints", {
  document: "query ListCheckpoints($first:Int,$after:String,$filter:CheckpointFilter){" +
    "checkpoints(first:$first,after:$after,filter:$filter){pageInfo{hasNextPage endCursor}nodes{sequenceNumber digest}}}",
  variables: {
    first: Schema.Number,
    after: Schema.NullOr(Schema.String),
    filter: Schema.Struct({
      afterCheckpoint: Schema.optionalKey(Schema.Number),
      beforeCheckpoint: Schema.optionalKey(Schema.Number)
    })
  },
  result: Schema.Struct({
    checkpoints: Schema.Struct({
      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
      nodes: Schema.Array(CheckpointNode)
    })
  })
})

export const SubscribeCheckpoints = GraphQL.subscription("SubscribeCheckpoints", {
  document: "subscription SubscribeCheckpoints($after:String){checkpoints(after:$after){cursor node{sequenceNumber digest}}}",
  variables: { after: Schema.NullOr(Schema.String) },
  result: Schema.Struct({ checkpoints: Schema.Struct({ cursor: Schema.String, node: CheckpointNode }) })
})

export const group = GraphQLGroup.make(ListCheckpoints, SubscribeCheckpoints, Tip)

export { MAX_RECONNECTS } from "./subscription.ts"

/**
 * `Checkpoints` over GraphQL. `list` pages `Query.checkpoints`, an open end
 * pinned to the tip as of the call (`start >= end` is an empty stream; gRPC
 * fails `start > end` with INVALID_ARGUMENT).
 *
 * `subscribe` is the `checkpoints` subscription over graphql-sse. After a
 * retryable failure it reconnects with backoff (honouring `Retry-After`) and
 * resumes from the last cursor it delivered, so no checkpoint is skipped or
 * repeated. After {@link MAX_RECONNECTS} consecutive failures without a
 * checkpoint in between, or any non-retryable failure, the stream fails with
 * the last `RpcError`, so supervision and failover see it as over gRPC.
 */
export const layer: Layer.Layer<Checkpoints.Checkpoints, never, GraphQLProtocol.GraphQLProtocol> = Layer.effect(
  Checkpoints.Checkpoints,
  Effect.gen(function*() {
    // The client's own resubscription would restart from the live tip; this
    // layer reconnects itself, with the cursor.
    const client = yield* GraphQLClient.make(group, noClientRetry)
    return Checkpoints.Checkpoints.of({
      list: (options) => {
        const start = options?.start
        if (start !== undefined && options?.end !== undefined && start >= options.end) return Stream.empty
        // Pin the open end to the tip as of the call, like gRPC, so the listing
        // ends there instead of chasing a moving tip.
        const end = options?.end !== undefined
          ? Effect.succeed(options.end)
          : client.Tip().pipe(call, Effect.flatMap(rangeOf), Effect.map((r) => r.end))
        return Stream.unwrap(Effect.map(end, (end) => {
          if (start !== undefined && start >= end) return Stream.empty
          const filter = {
            ...(start !== undefined && start > 0n && { afterCheckpoint: Number(start - 1n) }),
            beforeCheckpoint: Number(end)
          }
          return Stream.paginate(null as string | null, (after) =>
            client.ListCheckpoints({ first: PAGE, after, filter }).pipe(
              call,
              Effect.map(({ checkpoints: c }) =>
                [c.nodes, Option.fromNullishOr(c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null)] as const
              )
            ))
        }))
      },
      subscribe: resubscribe((after) =>
        client.SubscribeCheckpoints({ after }).pipe(Stream.map(({ checkpoints }) => checkpoints))
      ).pipe(Stream.map((edge) => edge.node))
    })
  })
)
