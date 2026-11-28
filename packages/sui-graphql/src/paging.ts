/**
 * Reading the rest of a transaction's nested connections (object changes,
 * events, balance changes) by digest, after the first page came with the effects. Shared by
 * the Transactions and CheckpointData layers; each includes these operations
 * in its own group.
 */
import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import type * as GraphQLClientError from "effect/graphql/GraphQLClientError"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { RpcError } from "@unconfirmed/sui/RpcError"
import {
  BALANCE_CHANGE_FIELDS,
  BalanceChangeNode,
  call,
  EVENT_CONTENT_FIELDS,
  EventContentNode,
  OBJECT_CHANGES_FIELDS,
  OBJECT_CHANGES_PAGE,
  type ObjectChange,
  ObjectChangesPage
} from "./convert.ts"

/** The largest page the server allows for `TransactionEffects.events`. */
export const EVENTS_PAGE = 50

export const GetObjectChanges = GraphQL.query("GetObjectChanges", {
  document: "query GetObjectChanges($digest:String!,$after:String){transactionEffects(digest:$digest){" +
    `objectChanges(first:${OBJECT_CHANGES_PAGE},after:$after){${OBJECT_CHANGES_FIELDS}}}}`,
  variables: { digest: Schema.String, after: Schema.String },
  result: Schema.Struct({
    transactionEffects: Schema.NullOr(Schema.Struct({ objectChanges: Schema.NullOr(ObjectChangesPage) }))
  })
})

export const EventsPage = Schema.Struct({
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  nodes: Schema.Array(EventContentNode)
})
export const EVENTS_PAGE_FIELDS = `pageInfo{hasNextPage endCursor} nodes{${EVENT_CONTENT_FIELDS}}`

export const GetTransactionEvents = GraphQL.query("GetTransactionEvents", {
  document: "query GetTransactionEvents($digest:String!,$after:String){transactionEffects(digest:$digest){" +
    `events(first:${EVENTS_PAGE},after:$after){${EVENTS_PAGE_FIELDS}}}}`,
  variables: { digest: Schema.String, after: Schema.String },
  result: Schema.Struct({
    transactionEffects: Schema.NullOr(Schema.Struct({ events: Schema.NullOr(EventsPage) }))
  })
})

/** The largest page the server allows for `TransactionEffects.balanceChanges`. */
export const BALANCE_CHANGES_PAGE = 50

export const BalanceChangesPage = Schema.Struct({
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  nodes: Schema.Array(BalanceChangeNode)
})
export const BALANCE_CHANGES_PAGE_FIELDS = `pageInfo{hasNextPage endCursor} nodes{${BALANCE_CHANGE_FIELDS}}`

export const GetBalanceChanges = GraphQL.query("GetBalanceChanges", {
  document: "query GetBalanceChanges($digest:String!,$after:String){transactionEffects(digest:$digest){" +
    `balanceChanges(first:${BALANCE_CHANGES_PAGE},after:$after){${BALANCE_CHANGES_PAGE_FIELDS}}}}`,
  variables: { digest: Schema.String, after: Schema.String },
  result: Schema.Struct({
    transactionEffects: Schema.NullOr(Schema.Struct({ balanceChanges: Schema.NullOr(BalanceChangesPage) }))
  })
})

type PageInfo ={ readonly hasNextPage: boolean; readonly endCursor: string | null }

class NotIndexed {
  readonly _tag = "NotIndexed"
}

const incomplete = (method: string, what: string) =>
  Effect.fail(new RpcError({ method, code: "OUT_OF_RANGE", message: `the rest of the ${what} can't be read` }))

/**
 * All nodes of a connection whose first page is in hand, reading the rest
 * with `next(after)`. `next` yields `null` while the transaction isn't
 * indexed; with `waitForIndex` that is retried for ~20s (after `execute`),
 * otherwise it fails with OUT_OF_RANGE.
 */
export const rest = <N>(
  method: string,
  what: string,
  first: { readonly pageInfo: PageInfo; readonly nodes: ReadonlyArray<N> } | null,
  next: (after: string) => Effect.Effect<{ readonly pageInfo: PageInfo; readonly nodes: ReadonlyArray<N> } | null, GraphQLClientError.GraphQLClientError>,
  waitForIndex: boolean
): Effect.Effect<ReadonlyArray<N>, RpcError> =>
  Effect.gen(function*() {
    const nodes: Array<N> = [...(first?.nodes ?? [])]
    let page = first?.pageInfo
    while (page?.hasNextPage) {
      if (page.endCursor === null) return yield* incomplete(method, what)
      const after: string = page.endCursor
      const got = yield* next(after).pipe(
        call,
        Effect.flatMap((r) => (r === null ? Effect.fail(new NotIndexed()) : Effect.succeed(r))),
        Effect.retry({ while: (e) => e instanceof NotIndexed && waitForIndex, schedule: Schedule.spaced("500 millis"), times: 40 }),
        Effect.catchIf((e) => e instanceof NotIndexed, () => incomplete(method, what))
      )
      nodes.push(...got.nodes)
      page = got.pageInfo
    }
    return nodes
  })

export type { ObjectChange }
