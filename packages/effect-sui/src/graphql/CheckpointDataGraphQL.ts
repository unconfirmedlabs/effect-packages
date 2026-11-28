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
import * as CheckpointData from "../CheckpointData.ts"
import { RpcError } from "../RpcError.ts"
import { call, effects, effectsFields, EffectsNode, event, U64 } from "./convert.ts"
import { EVENTS_PAGE, EVENTS_PAGE_FIELDS, EventsPage, GetObjectChanges, GetTransactionEvents, rest } from "./paging.ts"
import { noClientRetry, resubscribe } from "./subscription.ts"
import { rangeOf, Tip } from "./tip.ts"

/** Transactions per page (the server's maximum for `Checkpoint.transactions`). */
const TX_PAGE = 50
/**
 * Object changes read with each transaction. The server bounds the product of
 * nested page sizes, so this is kept small; a transaction with more is
 * completed by digest.
 */
const NESTED_CHANGES = 50
/**
 * Checkpoints fetched ahead, concurrently and delivered in order, by `list` and
 * `subscribe`. One `GetCheckpoint` takes longer than a checkpoint interval
 * (~0.25 s) on busy networks, so one at a time falls behind the chain.
 */
const CONCURRENCY = 16
/** Checkpoint numbers enumerated per step of `list` (they are consecutive; nothing is read for them). */
const NUMBERS_STEP = 64n

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

export const SubscribeCheckpointNumbers = GraphQL.subscription("SubscribeCheckpointNumbers", {
  document: "subscription SubscribeCheckpointNumbers($after:String){checkpoints(after:$after){cursor node{sequenceNumber}}}",
  variables: { after: Schema.NullOr(Schema.String) },
  result: Schema.Struct({ checkpoints: Schema.Struct({ cursor: Schema.String, node: Schema.Struct({ sequenceNumber: U64 }) }) })
})

export const group = GraphQLGroup.make(
  GetCheckpoint,
  GetCheckpointTransactions,
  Tip,
  SubscribeCheckpointNumbers,
  GetObjectChanges,
  GetTransactionEvents
)

/**
 * `CheckpointData` over GraphQL. `get` reads a checkpoint with its first 50
 * transactions (each with its first 50 object changes and events) in one
 * request, and completes whatever didn't fit by paging. `list` pins its open
 * ends to the indexer's served range (tip as of the call, retention floor) and
 * `get`s each checkpoint number in it; `subscribe` follows the checkpoint
 * subscription (cursor-resumed, bounded reconnects) and `get`s each new
 * checkpoint, waiting briefly if the indexer trails the subscription. Both
 * fetch up to 16 checkpoints ahead concurrently and deliver them in order, so
 * they keep up with the chain.
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
        const dataLoss = (message: string) => new RpcError({ method: "GetCheckpoint", code: "DATA_LOSS", message })
        if (c.epoch === null) return yield* dataLoss(`checkpoint ${sequenceNumber} without an epoch`)
        const epoch = c.epoch.epochId
        const timestampMs = Date.parse(c.timestamp)
        if (!Number.isFinite(timestampMs)) {
          return yield* dataLoss(`checkpoint ${sequenceNumber} has an unreadable timestamp ${JSON.stringify(c.timestamp)}`)
        }
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
          epoch,
          timestampMs: BigInt(timestampMs),
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
        const start = options?.start
        const end = options?.end
        if (start !== undefined && end !== undefined && start >= end) return Stream.empty
        // Pin the open ends before the first read, like gRPC: the end at the tip
        // as of the call, an absent start at the indexer's retention floor.
        const range = start !== undefined && end !== undefined
          ? Effect.succeed({ first: start, end })
          : client.Tip().pipe(call, Effect.flatMap(rangeOf))
        return Stream.unwrap(Effect.map(range, (served) => {
          const from = start ?? served.first
          const until = end ?? served.end
          if (from >= until) return Stream.empty
          // Checkpoint numbers are consecutive: enumerate them, nothing to list.
          return Stream.paginate(from, (n) => {
            const to = n + NUMBERS_STEP < until ? n + NUMBERS_STEP : until
            const numbers: Array<bigint> = []
            for (let i = n; i < to; i++) numbers.push(i)
            return Effect.succeed([numbers, to < until ? Option.some(to) : Option.none()] as const)
          }).pipe(Stream.mapEffect(getIndexed, { concurrency: CONCURRENCY }))
        }))
      },
      subscribe: resubscribe((after) =>
        client.SubscribeCheckpointNumbers({ after }).pipe(Stream.map(({ checkpoints }) => checkpoints))
      ).pipe(Stream.mapEffect((edge) => getIndexed(edge.node.sequenceNumber), { concurrency: CONCURRENCY }))
    })
  })
)
