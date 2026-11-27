import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as CheckpointData from "@unconfirmed/sui/CheckpointData"
import { RpcError } from "@unconfirmed/sui/RpcError"
import { call, effects, effectsFields, EffectsNode, event, U64 } from "./convert.ts"
import { EVENTS_PAGE, EVENTS_PAGE_FIELDS, EventsPage, GetObjectChanges, GetTransactionEvents, rest } from "./paging.ts"
import { noClientRetry, resubscribe } from "./subscription.ts"

/** Transactions per page (the server's maximum for `Checkpoint.transactions`). */
const TX_PAGE = 50
/**
 * Object changes read with each transaction. The server bounds the product of
 * nested page sizes, so this is kept small; a transaction with more is
 * completed by digest.
 */
const NESTED_CHANGES = 50
/** Checkpoints fetched concurrently by `list` (in order). */
const LIST_CONCURRENCY = 4

const TransactionNode = Schema.Struct({
  digest: Schema.String,
  effects: Schema.NullOr(Schema.Struct({ ...EffectsNode.fields, events: Schema.NullOr(EventsPage) }))
})
type TransactionNode = typeof TransactionNode.Type

const TransactionsPage = Schema.Struct({
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  nodes: Schema.Array(TransactionNode)
})

const TRANSACTIONS_FIELDS = `pageInfo{hasNextPage endCursor} nodes{digest effects{${effectsFields(NESTED_CHANGES)} ` +
  `events(first:${EVENTS_PAGE}){${EVENTS_PAGE_FIELDS}}}}`

export const GetCheckpoint = GraphQL.query("GetCheckpoint", {
  document: "query GetCheckpoint($sequenceNumber:UInt53!){checkpoint(sequenceNumber:$sequenceNumber){" +
    `sequenceNumber digest timestamp epoch{epochId} transactions(first:${TX_PAGE}){${TRANSACTIONS_FIELDS}}}}`,
  variables: { sequenceNumber: Schema.Number },
  result: Schema.Struct({
    checkpoint: Schema.NullOr(Schema.Struct({
      sequenceNumber: U64,
      digest: Schema.String,
      timestamp: Schema.String,
      epoch: Schema.NullOr(Schema.Struct({ epochId: U64 })),
      transactions: Schema.NullOr(TransactionsPage)
    }))
  })
})

export const GetCheckpointTransactions = GraphQL.query("GetCheckpointTransactions", {
  document: "query GetCheckpointTransactions($sequenceNumber:UInt53!,$after:String){checkpoint(sequenceNumber:$sequenceNumber){" +
    `transactions(first:${TX_PAGE},after:$after){${TRANSACTIONS_FIELDS}}}}`,
  variables: { sequenceNumber: Schema.Number, after: Schema.String },
  result: Schema.Struct({ checkpoint: Schema.NullOr(Schema.Struct({ transactions: Schema.NullOr(TransactionsPage) })) })
})

export const ListCheckpointNumbers = GraphQL.query("ListCheckpointNumbers", {
  document: "query ListCheckpointNumbers($first:Int,$after:String,$filter:CheckpointFilter){" +
    "checkpoints(first:$first,after:$after,filter:$filter){pageInfo{hasNextPage endCursor}nodes{sequenceNumber}}}",
  variables: {
    first: Schema.Number,
    after: Schema.NullOr(Schema.String),
    filter: Schema.Struct({ afterCheckpoint: Schema.optionalKey(Schema.Number), beforeCheckpoint: Schema.optionalKey(Schema.Number) })
  },
  result: Schema.Struct({
    checkpoints: Schema.Struct({
      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
      nodes: Schema.Array(Schema.Struct({ sequenceNumber: U64 }))
    })
  })
})

export const Tip = GraphQL.query("Tip", {
  document: "query Tip{checkpoint{sequenceNumber}}",
  result: Schema.Struct({ checkpoint: Schema.NullOr(Schema.Struct({ sequenceNumber: U64 })) })
})

export const SubscribeCheckpointNumbers = GraphQL.subscription("SubscribeCheckpointNumbers", {
  document: "subscription SubscribeCheckpointNumbers($after:String){checkpoints(after:$after){cursor node{sequenceNumber}}}",
  variables: { after: Schema.NullOr(Schema.String) },
  result: Schema.Struct({ checkpoints: Schema.Struct({ cursor: Schema.String, node: Schema.Struct({ sequenceNumber: U64 }) }) })
})

export const group = GraphQLGroup.make(
  GetCheckpoint,
  GetCheckpointTransactions,
  ListCheckpointNumbers,
  Tip,
  SubscribeCheckpointNumbers,
  GetObjectChanges,
  GetTransactionEvents
)

/**
 * `CheckpointData` over GraphQL. `get` reads a checkpoint with its first 50
 * transactions (each with its first 50 object changes and events) in one
 * request, and completes whatever didn't fit by paging. `list` pages the
 * checkpoint numbers and `get`s each (4 at a time, in order); `subscribe`
 * follows the checkpoint subscription (cursor-resumed, bounded reconnects)
 * and `get`s each new checkpoint, waiting briefly if the indexer trails the
 * subscription.
 */
export const layer: Layer.Layer<CheckpointData.CheckpointData, never, GraphQLProtocol.GraphQLProtocol> = Layer.effect(
  CheckpointData.CheckpointData,
  Effect.gen(function*() {
    const client = yield* GraphQLClient.make(group, noClientRetry)

    const transaction = (checkpoint: bigint, index: bigint, t: TransactionNode) =>
      Effect.gen(function*() {
        const fx = t.effects
        if (fx === null) {
          return yield* Effect.fail(new RpcError({ method: "GetCheckpoint", code: "DATA_LOSS", message: `transaction ${t.digest} without effects` }))
        }
        const [changes, events] = yield* Effect.all([
          rest("GetCheckpoint", "object changes", fx.objectChanges, (after) =>
            Effect.map(client.GetObjectChanges({ digest: t.digest, after }), (r) => r.transactionEffects?.objectChanges ?? null), false),
          rest("GetCheckpoint", "events", fx.events, (after) =>
            Effect.map(client.GetTransactionEvents({ digest: t.digest, after }), (r) => r.transactionEffects?.events ?? null), false)
        ])
        const e = effects(fx, changes)
        return {
          digest: t.digest,
          index,
          status: e.status,
          gasUsed: e.gasUsed,
          changedObjects: e.changedObjects,
          events: events.map((ev) => event(ev, { checkpoint, transactionDigest: t.digest, transactionIndex: index }))
        } satisfies CheckpointData.CheckpointTransaction
      })

    const get = (sequenceNumber: bigint): Effect.Effect<CheckpointData.Checkpoint, CheckpointData.CheckpointNotFound | RpcError> =>
      Effect.gen(function*() {
        const r = yield* call(client.GetCheckpoint({ sequenceNumber: Number(sequenceNumber) }))
        const c = r.checkpoint
        if (c === null) return yield* new CheckpointData.CheckpointNotFound({ sequenceNumber })
        const nodes = yield* rest("GetCheckpoint", "transactions", c.transactions, (after) =>
          Effect.map(
            client.GetCheckpointTransactions({ sequenceNumber: Number(sequenceNumber), after }),
            (r) => r.checkpoint?.transactions ?? null
          ), false)
        const transactions = yield* Effect.forEach(nodes, (t, i) => transaction(c.sequenceNumber, BigInt(i), t), {
          concurrency: 8
        })
        return {
          sequenceNumber: c.sequenceNumber,
          digest: c.digest,
          epoch: c.epoch?.epochId ?? 0n,
          timestampMs: BigInt(Date.parse(c.timestamp)),
          transactions
        }
      }).pipe(Effect.withSpan("CheckpointData.get", { attributes: { sequenceNumber: String(sequenceNumber) } }))

    /** In a list or a subscription a missing checkpoint is the indexer trailing: wait for it, then give up as UNAVAILABLE. */
    const getIndexed = (sequenceNumber: bigint) =>
      get(sequenceNumber).pipe(
        Effect.retry({ while: (e) => e._tag === "CheckpointNotFound", schedule: Schedule.spaced("250 millis"), times: 40 }),
        Effect.catchTag("CheckpointNotFound", () =>
          Effect.fail(new RpcError({ method: "GetCheckpoint", code: "UNAVAILABLE", message: `checkpoint ${sequenceNumber} is not indexed yet` })))
      )

    return CheckpointData.CheckpointData.of({
      get,
      list: (options) => {
        const end = options?.end !== undefined
          ? Effect.succeed(options.end)
          : client.Tip().pipe(call, Effect.map((r) => (r.checkpoint?.sequenceNumber ?? 0n) + 1n))
        return Stream.unwrap(Effect.map(end, (end) => {
          if (options?.start !== undefined && options.start >= end) return Stream.empty
          const filter = {
            ...(options?.start !== undefined && options.start > 0n && { afterCheckpoint: Number(options.start - 1n) }),
            beforeCheckpoint: Number(end)
          }
          return Stream.paginate(null as string | null, (after) =>
            client.ListCheckpointNumbers({ first: 50, after, filter }).pipe(
              call,
              Effect.map(({ checkpoints: c }) =>
                [c.nodes.map((n) => n.sequenceNumber), Option.fromNullishOr(c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null)] as const
              )
            )).pipe(Stream.mapEffect(getIndexed, { concurrency: LIST_CONCURRENCY }))
        }))
      },
      subscribe: resubscribe((after) =>
        client.SubscribeCheckpointNumbers({ after }).pipe(Stream.map(({ checkpoints }) => checkpoints))
      ).pipe(Stream.mapEffect((edge) => getIndexed(edge.node.sequenceNumber)))
    })
  })
)
