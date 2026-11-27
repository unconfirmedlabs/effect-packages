import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Address from "@unconfirmed/sui/Address"
import * as Events from "@unconfirmed/sui/Events"
import { RpcError } from "@unconfirmed/sui/RpcError"
import * as TypeTag from "@unconfirmed/sui/TypeTag"
import { call, event, EVENT_FIELDS, eventCursorPosition, EventNode, U64 } from "./convert.ts"
import { mergeSorted } from "./merge.ts"
import { noClientRetry, resubscribe } from "./subscription.ts"

/** The largest page the server allows for `Query.events`. */
const PAGE = 50

/** What one GraphQL `EventFilter` can say: one sender, and one emitting module or one event type (not both). */
export interface ServerFilter {
  readonly sender?: string
  readonly module?: string
  readonly type?: string
}

const FilterVariables = Schema.Struct({
  sender: Schema.optionalKey(Schema.String),
  module: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  afterCheckpoint: Schema.optionalKey(Schema.Number),
  beforeCheckpoint: Schema.optionalKey(Schema.Number)
})

const Edge = Schema.Struct({ cursor: Schema.String, node: EventNode })
const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
  hasPreviousPage: Schema.Boolean,
  startCursor: Schema.NullOr(Schema.String)
})

export const ListEvents = GraphQL.query("ListEvents", {
  document: "query ListEvents($first:Int,$after:String,$last:Int,$before:String,$filter:EventFilter){" +
    "events(first:$first,after:$after,last:$last,before:$before,filter:$filter){" +
    `pageInfo{hasNextPage endCursor hasPreviousPage startCursor} edges{cursor node{${EVENT_FIELDS}}}}}`,
  variables: {
    first: Schema.NullOr(Schema.Number),
    after: Schema.NullOr(Schema.String),
    last: Schema.NullOr(Schema.Number),
    before: Schema.NullOr(Schema.String),
    filter: FilterVariables
  },
  result: Schema.Struct({ events: Schema.Struct({ pageInfo: PageInfo, edges: Schema.Array(Edge) }) })
})

export const Tip = GraphQL.query("Tip", {
  document: "query Tip{checkpoint{sequenceNumber}}",
  result: Schema.Struct({ checkpoint: Schema.NullOr(Schema.Struct({ sequenceNumber: U64 })) })
})

/** Fallback for an event cursor that doesn't carry its transaction's position. */
export const CheckpointTransactionDigests = GraphQL.query("CheckpointTransactionDigests", {
  document: "query CheckpointTransactionDigests($checkpoint:UInt53!,$after:String){" +
    "checkpoint(sequenceNumber:$checkpoint){transactions(first:50,after:$after){pageInfo{hasNextPage endCursor}nodes{digest}}}}",
  variables: { checkpoint: Schema.Number, after: Schema.NullOr(Schema.String) },
  result: Schema.Struct({
    checkpoint: Schema.NullOr(Schema.Struct({
      transactions: Schema.NullOr(Schema.Struct({
        pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
        nodes: Schema.Array(Schema.Struct({ digest: Schema.String }))
      }))
    }))
  })
})

export const SubscribeEvents = GraphQL.subscription("SubscribeEvents", {
  document: `subscription SubscribeEvents($filter:EventFilter,$after:String){events(filter:$filter,after:$after){cursor node{${EVENT_FIELDS}}}}`,
  variables: { filter: FilterVariables, after: Schema.NullOr(Schema.String) },
  result: Schema.Struct({ events: Schema.Struct({ cursor: Schema.String, node: Schema.NullOr(EventNode) }) })
})

export const group = GraphQLGroup.make(ListEvents, Tip, CheckpointTransactionDigests, SubscribeEvents)

// -----------------------------------------------------------------------------
// Filters
// -----------------------------------------------------------------------------

/** One DNF term as a server filter plus the literals checked client-side. */
export interface Plan {
  readonly server: ServerFilter
  readonly residual: ReadonlyArray<Events.Literal>
}

/**
 * Lower a filter to one {@link Plan} per DNF term (`[]`: matches nothing).
 *
 * Per term, the server gets the first positive `Sender`, and the first
 * positive `EventType` or else the first positive `EmitModule` (GraphQL
 * rejects module and type together). Every other literal, including all
 * negations, is checked client-side on the events the server returns.
 * `StreamHead` can't be expressed or checked over GraphQL: a filter using it
 * fails with INVALID_ARGUMENT. Several terms run as separate queries merged in
 * ledger order, an event matching several terms emitted once.
 */
export const plan = (f: Events.EventFilter): Result.Result<ReadonlyArray<Plan>, string> => {
  const plans: Array<Plan> = []
  for (const term of Events.toDnf(f)) {
    if (term.some((l) => l.predicate._tag === "StreamHead")) {
      return Result.fail("StreamHead filters are not supported over GraphQL")
    }
    const positive = term.filter((l) => !l.negated)
    const sender = positive.find((l) => l.predicate._tag === "Sender")
    const typed = positive.find((l) => l.predicate._tag === "EventType") ?? positive.find((l) => l.predicate._tag === "EmitModule")
    const p = (l: Events.Literal | undefined) => l?.predicate
    const s = p(sender)
    const t = p(typed)
    plans.push({
      server: {
        ...(s?._tag === "Sender" && { sender: s.address }),
        ...(t?._tag === "EventType" && { type: t.type }),
        ...(t?._tag === "EmitModule" && { module: t.module })
      },
      residual: term.filter((l) => l !== sender && l !== typed)
    })
  }
  return Result.succeed(plans)
}

const emittedBy = (path: string, e: Events.Event) => {
  const p = TypeTag.normalizePath(path)
  return p.includes("::") ? p === `${e.packageId}::${e.module}` : p === e.packageId
}

const holds = (l: Events.Literal, e: Events.Event): boolean => {
  const p = l.predicate
  const v = p._tag === "Sender"
    ? Address.normalize(p.address) === e.sender
    : p._tag === "EmitModule"
    ? emittedBy(p.module, e)
    : p._tag === "EventType"
    ? TypeTag.matchesPath(p.type, e.type)
    : false
  return l.negated ? !v : v
}

export const matches = (residual: ReadonlyArray<Events.Literal>) => (e: Events.Event) => residual.every((l) => holds(l, e))

const order = (a: Events.Event, b: Events.Event) =>
  a.checkpoint !== b.checkpoint
    ? (a.checkpoint < b.checkpoint ? -1 : 1)
    : a.transactionIndex !== b.transactionIndex
    ? (a.transactionIndex < b.transactionIndex ? -1 : 1)
    : a.eventIndex - b.eventIndex

const invalid = (method: string, message: string) => new RpcError({ method, code: "INVALID_ARGUMENT", message })

// -----------------------------------------------------------------------------
// Layer
// -----------------------------------------------------------------------------

/**
 * `Events` over GraphQL: `list` pages `Query.events` (backwards with
 * `last`/`before` when descending), `subscribe` is the `events` subscription
 * over graphql-sse with the same cursor-resumed, bounded reconnects as
 * `Checkpoints.subscribe`. See {@link plan} for how filters are lowered.
 *
 * An event's position in its checkpoint comes from its cursor; if a server's
 * cursor doesn't carry it, it is looked up from the checkpoint's transactions.
 */
export const layer: Layer.Layer<Events.Events, never, GraphQLProtocol.GraphQLProtocol> = Layer.effect(
  Events.Events,
  Effect.gen(function*() {
    const client = yield* GraphQLClient.make(group, noClientRetry)

    const indexCache = new Map<bigint, Map<string, bigint>>()
    const transactionIndex = (checkpoint: bigint, digest: string): Effect.Effect<bigint, RpcError> =>
      Effect.gen(function*() {
        let byDigest = indexCache.get(checkpoint)
        if (!byDigest) {
          byDigest = new Map()
          let after: string | null = null
          let i = 0n
          while (true) {
            const r: GraphQL.Result<typeof CheckpointTransactionDigests> = yield* call(
              client.CheckpointTransactionDigests({ checkpoint: Number(checkpoint), after })
            )
            const page = r.checkpoint?.transactions
            for (const t of page?.nodes ?? []) byDigest.set(t.digest, i++)
            if (!page?.pageInfo.hasNextPage || page.pageInfo.endCursor === null) break
            after = page.pageInfo.endCursor
          }
          if (indexCache.size > 256) indexCache.delete(indexCache.keys().next().value!)
          indexCache.set(checkpoint, byDigest)
        }
        const index = byDigest.get(digest)
        return index !== undefined ? index : yield* Effect.fail(
          new RpcError({ method: "CheckpointTransactionDigests", code: "DATA_LOSS", message: `${digest} not in checkpoint ${checkpoint}` })
        )
      })

    const toEvent = (method: string) => (edge: { readonly cursor: string; readonly node: EventNode }) => {
      const n = edge.node
      const pos = eventCursorPosition(edge.cursor)
      const checkpoint = n.transaction.effects?.checkpoint?.sequenceNumber ?? pos?.checkpoint
      if (checkpoint === undefined) {
        return Effect.fail(new RpcError({ method, code: "DATA_LOSS", message: "event without a checkpoint" }))
      }
      const at = (transactionIndex: bigint) =>
        event(n, { checkpoint, transactionDigest: n.transaction.digest, transactionIndex })
      return pos !== undefined && pos.checkpoint === checkpoint && pos.eventIndex === n.sequenceNumber
        ? Effect.succeed(at(pos.transactionIndex))
        : Effect.map(transactionIndex(checkpoint, n.transaction.digest), at)
    }

    const scan = (p: Plan, range: { readonly start: bigint | undefined; readonly end: bigint }, descending: boolean) => {
      const filter = {
        ...p.server,
        ...(range.start !== undefined && range.start > 0n && { afterCheckpoint: Number(range.start - 1n) }),
        beforeCheckpoint: Number(range.end)
      }
      const keep = matches(p.residual)
      return Stream.paginate(null as string | null, (cursor) =>
        client
          .ListEvents(
            descending
              ? { first: null, after: null, last: PAGE, before: cursor, filter }
              : { first: PAGE, after: cursor, last: null, before: null, filter }
          )
          .pipe(
            call,
            Effect.flatMap(({ events: { edges, pageInfo } }) =>
              Effect.map(
                Effect.forEach(descending ? [...edges].reverse() : edges, toEvent("ListEvents")),
                (events) => {
                  const next = descending
                    ? (pageInfo.hasPreviousPage ? pageInfo.startCursor : null)
                    : (pageInfo.hasNextPage ? pageInfo.endCursor : null)
                  return [events.filter(keep), Option.fromNullishOr(next)] as const
                }
              )
            )
          ))
    }

    return Events.Events.of({
      list: (options) => {
        const plans = options?.filter ? plan(options.filter) : Result.succeed<ReadonlyArray<Plan>>([{ server: {}, residual: [] }])
        if (Result.isFailure(plans)) return Stream.fail(invalid("ListEvents", plans.failure))
        if (plans.success.length === 0) return Stream.empty
        const descending = options?.descending === true
        // Pin the open end to the tip as of the call, like gRPC.
        const end = options?.end !== undefined
          ? Effect.succeed(options.end)
          : client.Tip().pipe(call, Effect.map((r) => (r.checkpoint?.sequenceNumber ?? 0n) + 1n))
        return Stream.unwrap(Effect.map(end, (end) => {
          const range = { start: options?.start, end }
          if (range.start !== undefined && range.start >= end) return Stream.empty
          const compare = descending ? (a: Events.Event, b: Events.Event) => order(b, a) : order
          return mergeSorted(plans.success.map((p) => scan(p, range, descending)), compare)
        }))
      },
      subscribe: (filterBy) => {
        const plans = filterBy ? plan(filterBy) : Result.succeed<ReadonlyArray<Plan>>([{ server: {}, residual: [] }])
        if (Result.isFailure(plans)) return Stream.fail(invalid("SubscribeEvents", plans.failure))
        if (plans.success.length === 0) return Stream.never
        const one = (p: Plan) =>
          resubscribe((after) => client.SubscribeEvents({ filter: p.server, after }).pipe(Stream.map(({ events }) => events))).pipe(
            Stream.mapEffect(toEvent("SubscribeEvents")),
            Stream.filter(matches(p.residual))
          )
        if (plans.success.length === 1) return one(plans.success[0]!)
        // Several terms: one subscription each, an event matching several emitted once.
        const seen = new Set<string>()
        return Stream.mergeAll(plans.success.map(one), { concurrency: "unbounded" }).pipe(
          Stream.filter((e) => {
            const key = `${e.transactionDigest}:${e.eventIndex}`
            if (seen.has(key)) return false
            seen.add(key)
            if (seen.size > 10_000) seen.delete(seen.values().next().value!)
            return true
          })
        )
      }
    })
  })
)
