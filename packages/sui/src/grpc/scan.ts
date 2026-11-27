/**
 * Ledger scans (`ListCheckpoints`, `ListEvents`, ...) stop at a server-chosen
 * item or scan budget and say so in a final `QueryEnd` frame. `resumable` turns
 * one into a single stream by re-opening from the last watermark until the
 * scan reaches its real end (range bound, cursor bound or ledger tip).
 */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { RpcError } from "../RpcError.ts"
import { convert } from "./convert.ts"
import type * as P from "./generated/proto.ts"
import * as Rpc from "./generated/rpc.ts"
import type { GrpcWeb } from "./GrpcWeb.ts"

interface Frame<A> {
  readonly item: A | undefined
  readonly watermark: P.Watermark | undefined
  readonly end: P.QueryEnd | undefined
}

/** ITEM_LIMIT and SCAN_LIMIT: the server stopped early; resume from the watermark. */
const budgetExhausted = (end: P.QueryEnd) => end.reason === 1 || end.reason === 2

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

export { convert }

export interface Recovery {
  /**
   * Called when a request fails with `error` after the scan reached `last`
   * (`undefined` before any watermark): `"retry"` re-opens from `last`,
   * `"end"` ends the scan cleanly, a failure fails it.
   */
  readonly recover: (error: RpcError, last: P.Watermark | undefined) => Effect.Effect<"retry" | "end", RpcError>
  /** Consecutive recoveries without a new watermark before the error is raised instead (default 3). */
  readonly attempts?: number
}

export const resumable = <F, A>(
  method: string,
  open: (resume: P.Watermark | undefined) => Stream.Stream<F, RpcError>,
  read: (frame: F) => Frame<A>,
  recovery?: Recovery
): Stream.Stream<A, RpcError> => {
  const fail = (message: string) => Stream.fail(new RpcError({ method, code: "DATA_LOSS", message }))
  const maxAttempts = recovery?.attempts ?? 3
  const go = (resume: P.Watermark | undefined, attempts: number): Stream.Stream<A, RpcError> =>
    Stream.suspend(() => {
      let last = resume
      let stoppedEarly = false
      let sawEnd = false
      let recovered = false
      let items = 0
      const body = open(resume).pipe(
        Stream.mapEffect((f) =>
          convert(method, () => {
            const frame = read(f)
            if (frame.watermark?.cursor) last = frame.watermark
            if (frame.end) {
              sawEnd = true
              if (budgetExhausted(frame.end)) stoppedEarly = true
            }
            if (frame.item !== undefined) items++
            return frame.item
          })
        ),
        Stream.filter((a): a is A => a !== undefined)
      )
      const guarded = recovery === undefined ? body : body.pipe(
        Stream.catch((error) => {
          const progressed = last?.cursor !== undefined && !(resume?.cursor && sameBytes(resume.cursor, last.cursor))
          const tries = progressed ? 1 : attempts + 1
          if (tries > maxAttempts) return Stream.fail(error)
          recovered = true
          return Stream.unwrap(
            Effect.map(recovery.recover(error, last), (next) => (next === "end" ? Stream.empty : go(last, tries)))
          )
        })
      )
      return Stream.concat(
        guarded,
        Stream.suspend(() => {
          if (recovered) return Stream.empty
          // Every successful scan stream ends with exactly one `QueryEnd` frame;
          // a stream without one was cut short and has not delivered its range.
          if (!sawEnd) return fail("the scan stream ended without its QueryEnd frame")
          if (!stoppedEarly) return Stream.empty
          if (!last?.cursor) return fail("scan stopped at a budget without a resume cursor")
          if (items === 0 && resume?.cursor && sameBytes(resume.cursor, last.cursor)) {
            return fail("scan made no progress (the same resume cursor twice)")
          }
          return go(last, 0)
        })
      )
    })
  return go(undefined, 0)
}

/** The node's ledger window: `[lowest, tip + 1)`, read fresh. */
export const ledgerWindow = (grpc: GrpcWeb["Service"]) =>
  grpc.unary(Rpc.LedgerService_GetServiceInfo, {}).pipe(
    Effect.flatMap((i) =>
      i.checkpoint_height === undefined
        ? Effect.fail(new RpcError({ method: Rpc.LedgerService_GetServiceInfo.path, code: "DATA_LOSS", message: "malformed response: no checkpoint_height" }))
        : Effect.succeed({ lowest: i.lowest_available_checkpoint ?? 0n, end: i.checkpoint_height + 1n })
    )
  )

/**
 * Pin the open ends of a scan's range before the first request, so resumed
 * requests scan the same window: an ascending scan without `end` stops at the
 * tip as of the call (not a moving tip), and a descending scan without `start`
 * stops at the pruning floor (the node rejects a descending scan that runs into
 * it).
 */
export const pinned = <A>(
  grpc: GrpcWeb["Service"],
  range: { readonly start?: bigint | undefined; readonly end?: bigint | undefined },
  descending: boolean,
  f: (range: { readonly start: bigint | undefined; readonly end: bigint | undefined }) => Stream.Stream<A, RpcError>
): Stream.Stream<A, RpcError> => {
  const needs = descending ? range.start === undefined : range.end === undefined
  if (!needs) return f({ start: range.start, end: range.end })
  return Stream.unwrap(
    Effect.map(ledgerWindow(grpc), (w) =>
      descending ? f({ start: w.lowest, end: range.end }) : f({ start: range.start, end: w.end })
    )
  )
}

/**
 * Request bounds for an event scan resumed at `w` (see `Watermark` in
 * query_options.proto): ascending continues from its position with `after`,
 * descending ends at it with `before`.
 */
export const eventBounds = (
  w: P.Watermark | undefined,
  base: { readonly start?: bigint | undefined; readonly end?: bigint | undefined },
  descending: boolean
) => {
  const pos = w?.cursor_position
  const tx = pos?.transaction_index ?? 0n
  const ev = pos?.event_index ?? 0
  const indexed = tx !== 0n || ev !== 0
  if (!w) {
    return {
      ...(base.start !== undefined && { start_checkpoint: base.start }),
      ...(base.end !== undefined && { end_checkpoint: base.end })
    }
  }
  if (!descending) {
    return {
      ...(pos?.checkpoint !== undefined
        ? { start_checkpoint: pos.checkpoint, ...(indexed && { start_transaction_index: tx, start_event_index: ev }) }
        : base.start !== undefined && { start_checkpoint: base.start }),
      ...(base.end !== undefined && { end_checkpoint: base.end })
    }
  }
  return {
    ...(base.start !== undefined && { start_checkpoint: base.start }),
    ...(pos?.checkpoint !== undefined
      ? indexed
        ? { end_checkpoint: pos.checkpoint + 1n, end_transaction_index: tx, end_event_index: ev }
        : { end_checkpoint: pos.checkpoint }
      : base.end !== undefined && { end_checkpoint: base.end })
  }
}

/** Request bounds for an ascending checkpoint scan resumed at `w`. */
export const checkpointBounds = (
  w: P.Watermark | undefined,
  base: { readonly start?: bigint | undefined; readonly end?: bigint | undefined }
) => {
  const start = w?.cursor_position?.checkpoint ?? base.start
  return {
    ...(start !== undefined && { start_checkpoint: start }),
    ...(base.end !== undefined && { end_checkpoint: base.end })
  }
}

/** Per-request item limits (the node coerces larger values down to its maximum). */
export const EVENT_LIMIT = 1000
export const CHECKPOINT_LIMIT = 50
