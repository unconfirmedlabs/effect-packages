import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { RpcError } from "../RpcError.ts"
import { needsGasSelection, toProto } from "../grpc/transaction.ts"
import * as Transactions from "../Transactions.ts"
import {
  balanceChange,
  base64,
  Bytes,
  call,
  EFFECTS_FIELDS,
  EffectsNode,
  effects,
  OBJECT_CHANGES_PAGE,
  transactionEvent,
  U64
} from "./convert.ts"
import {
  BALANCE_CHANGES_PAGE,
  BALANCE_CHANGES_PAGE_FIELDS,
  BalanceChangesPage,
  EVENTS_PAGE,
  EVENTS_PAGE_FIELDS,
  EventsPage,
  GetBalanceChanges,
  GetObjectChanges,
  GetTransactionEvents,
  rest
} from "./paging.ts"

const CommandOutput = Schema.Struct({ value: Schema.NullOr(Schema.Struct({ bcs: Schema.NullOr(Bytes) })) })

export const SimulateTransaction = GraphQL.query("SimulateTransaction", {
  document: "query SimulateTransaction($transaction:JSON!,$checksEnabled:Boolean){" +
    "simulateTransaction(transaction:$transaction,checksEnabled:$checksEnabled,doGasSelection:false){" +
    `effects{${EFFECTS_FIELDS}} outputs{returnValues{value{bcs}}}}}`,
  variables: {
    transaction: Schema.Struct({ bcs: Schema.Struct({ value: Schema.String }) }),
    checksEnabled: Schema.Boolean
  },
  result: Schema.Struct({
    simulateTransaction: Schema.Struct({
      effects: Schema.NullOr(EffectsNode),
      outputs: Schema.NullOr(Schema.Array(Schema.Struct({ returnValues: Schema.NullOr(Schema.Array(CommandOutput)) })))
    })
  })
})

/**
 * Server-side resolution, as `@mysten/sui`'s GraphQL client does it: the
 * unresolved transaction as a proto3-JSON `sui.rpc.v2.Transaction`, checks
 * and gas selection on; the completed transaction comes back as BCS.
 */
export const ResolveTransaction = GraphQL.query("ResolveTransaction", {
  document: "query ResolveTransaction($transaction:JSON!,$doGasSelection:Boolean){" +
    "simulateTransaction(transaction:$transaction,checksEnabled:true,doGasSelection:$doGasSelection){" +
    `effects{${EFFECTS_FIELDS} epoch{epochId} transaction{transactionBcs}}}}`,
  variables: { transaction: Schema.Unknown, doGasSelection: Schema.Boolean },
  result: Schema.Struct({
    simulateTransaction: Schema.Struct({
      effects: Schema.NullOr(Schema.Struct({
        ...EffectsNode.fields,
        epoch: Schema.NullOr(Schema.Struct({ epochId: Schema.Number })),
        transaction: Schema.NullOr(Schema.Struct({ transactionBcs: Schema.NullOr(Bytes) }))
      }))
    })
  })
})

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * A `sui.rpc.v2` message value (as the gRPC codec takes it) in proto3 JSON:
 * lowerCamelCase keys, a oneof's member under its own name, 64-bit integers
 * as strings, bytes as base64. Enums stay numbers, which proto3 JSON accepts.
 */
export const protoJson = (v: unknown): unknown => {
  if (typeof v === "bigint") return v.toString()
  if (v instanceof Uint8Array) return base64(v)
  if (Array.isArray(v)) return v.map(protoJson)
  if (typeof v !== "object" || v === null) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue
    if (typeof x === "object" && x !== null && "_tag" in x && "value" in x && Object.keys(x).length === 2) {
      out[camel((x as { _tag: string })._tag)] = protoJson((x as { value: unknown }).value)
    } else out[camel(k)] = protoJson(x)
  }
  return out
}

/** `include`, as `@include` directives: what isn't asked for isn't selected. */
const INCLUDED_FIELDS = `events(first:${EVENTS_PAGE})@include(if:$events){${EVENTS_PAGE_FIELDS}} ` +
  `balanceChanges(first:${BALANCE_CHANGES_PAGE})@include(if:$balanceChanges){${BALANCE_CHANGES_PAGE_FIELDS}}`

const IncludedNode = Schema.Struct({
  ...EffectsNode.fields,
  events: Schema.optionalKey(Schema.NullOr(EventsPage)),
  balanceChanges: Schema.optionalKey(Schema.NullOr(BalanceChangesPage))
})
type IncludedNode = typeof IncludedNode.Type

const Include = { events: Schema.Boolean, balanceChanges: Schema.Boolean }
const includeVariables = (include: ReadonlyArray<Transactions.Include> | undefined) => ({
  events: include?.includes("events") ?? false,
  balanceChanges: include?.includes("balanceChanges") ?? false
})

export const ExecuteTransaction = GraphQL.mutation("ExecuteTransaction", {
  document: "mutation ExecuteTransaction($transactionDataBcs:Base64!,$signatures:[Base64!]!,$events:Boolean!,$balanceChanges:Boolean!){" +
    `executeTransaction(transactionDataBcs:$transactionDataBcs,signatures:$signatures){effects{${EFFECTS_FIELDS} ${INCLUDED_FIELDS}}}}`,
  variables: { transactionDataBcs: Schema.String, signatures: Schema.Array(Schema.String), ...Include },
  result: Schema.Struct({ executeTransaction: Schema.Struct({ effects: Schema.NullOr(IncludedNode) }) })
})

export const GetTransactionEffects = GraphQL.query("GetTransactionEffects", {
  document: "query GetTransactionEffects($digest:String!,$events:Boolean!,$balanceChanges:Boolean!){transactionEffects(digest:$digest){" +
    `${EFFECTS_FIELDS} checkpoint{sequenceNumber} timestamp ${INCLUDED_FIELDS}}}`,
  variables: { digest: Schema.String, ...Include },
  result: Schema.Struct({
    transactionEffects: Schema.NullOr(Schema.Struct({
      ...IncludedNode.fields,
      checkpoint: Schema.NullOr(Schema.Struct({ sequenceNumber: U64 })),
      timestamp: Schema.NullOr(Schema.String)
    }))
  })
})

export const group = GraphQLGroup.make(
  SimulateTransaction,
  ResolveTransaction,
  ExecuteTransaction,
  GetTransactionEffects,
  GetObjectChanges,
  GetTransactionEvents,
  GetBalanceChanges
)

const incomplete = (method: string) =>
  Effect.fail(
    new RpcError({
      method,
      code: "OUT_OF_RANGE",
      message: `more than ${OBJECT_CHANGES_PAGE} object changes and the rest can't be read`
    })
  )

const noEffects = (method: string) =>
  Effect.fail(new RpcError({ method, code: "INTERNAL", message: "the response has no transaction effects" }))

/** `Transactions` over GraphQL. */
export const layer: Layer.Layer<Transactions.Transactions, never, GraphQLProtocol.GraphQLProtocol> = Layer.effect(
  Transactions.Transactions,
  Effect.gen(function*() {
    const client = yield* GraphQLClient.make(group)

    /**
     * Every object change (and event and balance change, when included): the
     * first page came with the effects, the rest are read by digest. After
     * `execute` the transaction may not be indexed yet, so a missing
     * transaction is retried for a while (`waitForIndex`).
     */
    const complete = (
      method: string,
      e: IncludedNode,
      include: ReadonlyArray<Transactions.Include> | undefined,
      waitForIndex: boolean
    ): Effect.Effect<Transactions.Effects, RpcError> => {
      const digest = e.digest
      const none = Effect.succeed(undefined)
      return Effect.map(
        Effect.all([
          rest(method, "object changes", e.objectChanges, (after) =>
            Effect.map(client.GetObjectChanges({ digest, after }), (r) => r.transactionEffects?.objectChanges ?? null), waitForIndex),
          include?.includes("events")
            ? rest(method, "events", e.events ?? null, (after) =>
              Effect.map(client.GetTransactionEvents({ digest, after }), (r) => r.transactionEffects?.events ?? null), waitForIndex)
            : none,
          include?.includes("balanceChanges")
            ? rest(method, "balance changes", e.balanceChanges ?? null, (after) =>
              Effect.map(client.GetBalanceChanges({ digest, after }), (r) => r.transactionEffects?.balanceChanges ?? null), waitForIndex)
            : none
        ], { concurrency: "unbounded" }),
        ([changes, events, balanceChanges]) => ({
          ...effects(e, changes),
          ...(events && { events: events.map((ev) => transactionEvent(ev, digest)) }),
          ...(balanceChanges && { balanceChanges: balanceChanges.map(balanceChange) })
        })
      )
    }

    return Transactions.Transactions.of({
      simulate: (txBytes, options) =>
        client
          .SimulateTransaction({
            transaction: { bcs: { value: base64(txBytes) } },
            checksEnabled: options?.checks !== false
          })
          .pipe(
            call,
            Effect.flatMap(({ simulateTransaction: r }) =>
              r.effects === null
                ? noEffects("SimulateTransaction")
                // A simulation has no digest to page by: more changes than one
                // page holds fail loudly rather than being truncated.
                : r.effects.objectChanges?.pageInfo.hasNextPage
                ? incomplete("SimulateTransaction")
                : Effect.succeed({
                  effects: effects(r.effects),
                  returnValues: (r.outputs ?? []).map((o) =>
                    (o.returnValues ?? []).map((v) => v.value?.bcs ?? new Uint8Array())
                  )
                })
            ),
            Effect.withSpan("Transactions.simulate")
          ),
      resolve: (transaction) =>
        client
          .ResolveTransaction({ transaction: protoJson(toProto(transaction)), doGasSelection: needsGasSelection(transaction) })
          .pipe(
            call,
            Effect.flatMap(({ simulateTransaction: r }): Effect.Effect<Transactions.Resolution, RpcError> => {
              const e = r.effects
              if (e === null) return noEffects("ResolveTransaction")
              const bytes = e.transaction?.transactionBcs
              if (bytes === null || bytes === undefined) {
                return Effect.fail(new RpcError({ method: "ResolveTransaction", code: "INTERNAL", message: "the response has no resolved transaction" }))
              }
              // A simulation has no digest to page by (as in `simulate`).
              if (e.objectChanges?.pageInfo.hasNextPage) return incomplete("ResolveTransaction")
              return Effect.succeed({
                transaction: bytes,
                effects: effects(e),
                epoch: e.epoch === null ? undefined : BigInt(e.epoch.epochId)
              })
            }),
            Effect.withSpan("Transactions.resolve")
          ),
      execute: (txBytes, signatures, options) =>
        client
          .ExecuteTransaction({ transactionDataBcs: base64(txBytes), signatures: signatures.map(base64), ...includeVariables(options?.include) })
          .pipe(
            call,
            Effect.flatMap(({ executeTransaction: r }) =>
              r.effects === null ? noEffects("ExecuteTransaction") : complete("ExecuteTransaction", r.effects, options?.include, true).pipe(
                // The transaction executed; only reading the rest of its object
                // changes (or events) failed. Say so, with the digest, so the
                // caller can reconcile instead of reading it as a failed submission.
                Effect.mapError((e) =>
                  new RpcError({
                    method: e.method,
                    code: e.code,
                    message: `transaction ${r.effects!.digest} executed, but its effects could not be read in full: ${e.message}`
                  })
                )
              )
            ),
            Effect.withSpan("Transactions.execute")
          ),
      // A well-formed digest the indexer doesn't know is `TransactionNotFound`
      // (`transactionEffects` is null). A malformed one (wrong length, not
      // base58) is rejected by the server's scalar parser and surfaces as
      // `RpcError` INVALID_ARGUMENT; gRPC reports that case as NOT_FOUND ->
      // `TransactionNotFound` instead.
      get: (digest, options) =>
        client.GetTransactionEffects({ digest, ...includeVariables(options?.include) }).pipe(
          call,
          Effect.flatMap((r): Effect.Effect<Transactions.Effects, RpcError | Transactions.TransactionNotFound> => {
            const e = r.transactionEffects
            if (e === null) return Effect.fail(new Transactions.TransactionNotFound({ digest }))
            const timestampMs = e.timestamp === null ? undefined : Date.parse(e.timestamp)
            if (timestampMs !== undefined && !Number.isFinite(timestampMs)) {
              return Effect.fail(
                new RpcError({ method: "GetTransactionEffects", code: "DATA_LOSS", message: `unreadable timestamp ${JSON.stringify(e.timestamp)}` })
              )
            }
            return Effect.map(complete("GetTransactionEffects", e, options?.include, false), (fx) => ({
              ...fx,
              ...(e.checkpoint !== null && { checkpoint: e.checkpoint.sequenceNumber }),
              ...(timestampMs !== undefined && { timestampMs: BigInt(timestampMs) })
            }))
          }),
          Effect.withSpan("Transactions.get", { attributes: { digest } })
        )
    })
  })
)
