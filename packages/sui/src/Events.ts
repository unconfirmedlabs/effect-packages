/**
 * Move events: history as a `Stream` (`list`) and live (`subscribe`), with a
 * closed filter algebra that every transport lowers to its own query form.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import type { Address } from "./Address.ts"
import type { RpcError } from "./RpcError.ts"
import * as TypeTag from "./TypeTag.ts"

export interface Event {
  /** The event struct's full type, e.g. `0x2::coin::CoinCreated<0x2::sui::SUI>`. */
  readonly type: string
  readonly sender: Address
  /** The package and module of the top-level Move call that emitted it. */
  readonly packageId: Address
  readonly module: string
  /** The event struct's BCS bytes. */
  readonly contents: Uint8Array
  readonly transactionDigest: string
  readonly checkpoint: bigint
  /** Position of the emitting transaction within its checkpoint. */
  readonly transactionIndex: bigint
  /** Position of the event within its transaction's events (the event sequence number). */
  readonly eventIndex: number
}

export class EventDecodeError extends /* @__PURE__ */ Schema.TaggedError<EventDecodeError>()("EventDecodeError", {
  transactionDigest: Schema.String,
  eventIndex: Schema.Number,
  type: Schema.String,
  issue: Schema.String
}) {
  override get message(): string {
    return `cannot decode event ${this.eventIndex} of ${this.transactionDigest} as ${this.type}: ${this.issue}`
  }
}

/** Decode an event's contents with a BCS schema. */
export const decode = <T, E>(schema: Schema.Codec<T, E>) => {
  const run = Bcs.decode(schema)
  return (e: Event): Effect.Effect<T, EventDecodeError> =>
    Result.match(run(e.contents), {
      onSuccess: Effect.succeed,
      onFailure: (x) =>
        Effect.fail(
          new EventDecodeError({ transactionDigest: e.transactionDigest, eventIndex: e.eventIndex, type: e.type, issue: x.message })
        )
    })
}

// -----------------------------------------------------------------------------
// Filters
// -----------------------------------------------------------------------------

export type Predicate =
  /** Every event of transactions sent by `address`. */
  | { readonly _tag: "Sender"; readonly address: Address }
  /** Events whose emitting Move call is in `0xpkg` or `0xpkg::module`. */
  | { readonly _tag: "EmitModule"; readonly module: string }
  /** Events whose type is at `0xaddr`, `0xaddr::module`, `0xaddr::module::Name` (any instantiation) or an exact `Name<T>`. */
  | { readonly _tag: "EventType"; readonly type: string }
  /** Events committed to an authenticated event stream. */
  | { readonly _tag: "StreamHead"; readonly streamId: Address }

export interface Literal {
  readonly _tag: "Literal"
  readonly negated: boolean
  readonly predicate: Predicate
}

export type EventFilter =
  | Literal
  | { readonly _tag: "All"; readonly filters: ReadonlyArray<EventFilter> }
  | { readonly _tag: "Any"; readonly filters: ReadonlyArray<EventFilter> }

const lit = (predicate: Predicate): Literal => ({ _tag: "Literal", negated: false, predicate })

export const sender = (address: Address): Literal => lit({ _tag: "Sender", address })
export const emitModule = (module: string): Literal => lit({ _tag: "EmitModule", module: TypeTag.normalizePath(module) })
export const eventType = (type: string): Literal => lit({ _tag: "EventType", type: TypeTag.normalizePath(type) })
export const streamHead = (streamId: Address): Literal => lit({ _tag: "StreamHead", streamId })
/** Negation applies to single predicates, as in the node's index. */
export const not = (l: Literal): Literal => ({ ...l, negated: !l.negated })
export const all = (...filters: ReadonlyArray<EventFilter>): EventFilter => ({ _tag: "All", filters })
export const any = (...filters: ReadonlyArray<EventFilter>): EventFilter => ({ _tag: "Any", filters })

/** Disjunctive normal form: OR of ANDs of literals, the shape the indexes take. */
export const toDnf = (f: EventFilter): ReadonlyArray<ReadonlyArray<Literal>> => {
  switch (f._tag) {
    case "Literal":
      return [[f]]
    case "Any":
      return f.filters.flatMap(toDnf)
    case "All":
      return f.filters.reduce<ReadonlyArray<ReadonlyArray<Literal>>>(
        (acc, g) => acc.flatMap((term) => toDnf(g).map((t) => [...term, ...t])),
        [[]]
      )
  }
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface ListOptions {
  readonly filter?: EventFilter
  /** First checkpoint, inclusive. Default: the oldest the node keeps (a descending scan ends there). */
  readonly start?: bigint
  /** Last checkpoint, exclusive. Default: the tip at the time of the call, pinned for the whole scan. */
  readonly end?: bigint
  /** Newest first. */
  readonly descending?: boolean
}

export class Events extends /* @__PURE__ */ Context.Service<Events, {
  /** Matching events in ledger order, across as many requests as it takes. An empty `any()` matches nothing. */
  readonly list: (options?: ListOptions) => Stream.Stream<Event, RpcError>
  /** Matching events as they are emitted, from the node's current tip. Ends cleanly if the server closes the stream (resubscribe to continue); a cut-off stream fails. */
  readonly subscribe: (filter?: EventFilter) => Stream.Stream<Event, RpcError>
}>()("@unconfirmed/sui/Events") {}
