import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { type EventFilter, Events, type Literal, toDnf } from "../Events.ts"
import { event, EVENT_PATHS } from "./convert.ts"
import type * as P from "./generated/proto.ts"
import * as Rpc from "./generated/lean.ts"
import { GrpcWeb } from "./GrpcWeb.ts"
import { convert, EVENT_LIMIT, eventBounds, ledgerWindow, pinned, type Recovery, resumable } from "./scan.ts"

const literal = (l: Literal): P.EventLiteral => {
  const p = l.predicate
  return {
    negated: l.negated,
    predicate: p._tag === "Sender"
      ? { _tag: "sender", value: { address: p.address } }
      : p._tag === "EmitModule"
      ? { _tag: "emit_module", value: { module: p.module } }
      : p._tag === "EventType"
      ? { _tag: "event_type", value: { event_type: p.type } }
      : { _tag: "event_stream_head", value: { stream_id: p.streamId } }
  }
}

/**
 * The filter as the node's DNF `EventFilter`: `undefined` when it matches
 * everything (some term has no literals), `"none"` when it matches nothing
 * (no terms, e.g. an empty `any()`), which the node would reject.
 */
export const filter = (f: EventFilter): P.EventFilter | undefined | "none" => {
  const dnf = toDnf(f)
  if (dnf.length === 0) return "none"
  if (dnf.some((t) => t.length === 0)) return undefined
  return { terms: dnf.map((t) => ({ literals: t.map(literal) })) }
}

const MASK = { paths: EVENT_PATHS }

/** `Events` over gRPC: `ListEvents` resumed across server budgets, and `SubscribeEvents`. */
export const layer: Layer.Layer<Events, never, GrpcWeb> = Layer.effect(
  Events,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    return Events.of({
      list: (options) => {
        const descending = options?.descending === true
        const f = options?.filter && filter(options.filter)
        if (f === "none") return Stream.empty
        const method = Rpc.LedgerService_ListEvents.path
        const scan = (range: { start: bigint | undefined; readonly end: bigint | undefined }, recovery?: Recovery) =>
          resumable(
            method,
            (w) =>
              grpc.serverStream(Rpc.LedgerService_ListEvents, {
                read_mask: MASK,
                ...(f && { filter: f }),
                ...eventBounds(w, range, descending),
                options: {
                  limit: EVENT_LIMIT,
                  ...(descending && { ordering: 1 }),
                  ...(w?.cursor && (descending ? { before: w.cursor } : { after: w.cursor }))
                }
              }),
            (r) => ({ item: r.event && event(r.event), watermark: r.watermark, end: r.end }),
            recovery
          )
        if (!descending || options?.start !== undefined) {
          return pinned(grpc, { start: options?.start, end: options?.end }, descending, (range) => scan({ ...range }))
        }
        // A descending scan to the pruning floor: the floor moves while it runs,
        // and the node refuses (`OUT_OF_RANGE`) a request whose start it has passed.
        // Re-read the floor and continue from the last watermark; the scan is done
        // only when what is left of the range is below the new floor.
        return Stream.unwrap(Effect.map(ledgerWindow(grpc), (window) => {
          const range = { start: window.lowest as bigint | undefined, end: options?.end }
          return scan(range, {
            recover: (error, last) =>
              error.code !== "OUT_OF_RANGE" ? Effect.fail(error) : Effect.map(ledgerWindow(grpc), (w) => {
                const pos = last?.cursor_position
                const indexed = (pos?.transaction_index ?? 0n) !== 0n || (pos?.event_index ?? 0) !== 0
                const remainingEnd = pos?.checkpoint !== undefined ? pos.checkpoint + (indexed ? 1n : 0n) : range.end ?? w.end
                if (remainingEnd <= w.lowest) return "end" as const
                range.start = w.lowest
                return "retry" as const
              })
          })
        }))
      },
      subscribe: (filterBy) => {
        const f = filterBy && filter(filterBy)
        if (f === "none") return Stream.never
        return grpc
          .serverStream(Rpc.SubscriptionService_SubscribeEvents, { read_mask: MASK, ...(f && { filter: f }) })
          .pipe(
            Stream.filter((r): r is P.SubscribeEventsResponse & { event: P.Event } => r.event !== undefined),
            Stream.mapEffect((r) => convert(Rpc.SubscriptionService_SubscribeEvents.path, () => event(r.event)))
          )
      }
    })
  })
)
