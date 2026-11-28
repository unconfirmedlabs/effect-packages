/**
 * Checkpoint contents for indexers: each checkpoint with its transactions,
 * their effects and events. `follow` reads history from a start checkpoint and
 * continues live, gap-free and without duplicates.
 */
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Event } from "./Events.ts"
import type { RpcError } from "./RpcError.ts"
import type { ChangedObject, GasUsed, Status } from "./Transactions.ts"

export interface CheckpointTransaction {
  readonly digest: string
  /** Position within the checkpoint. */
  readonly index: bigint
  readonly status: Status
  readonly gasUsed: GasUsed
  readonly changedObjects: ReadonlyArray<ChangedObject>
  readonly events: ReadonlyArray<Event>
}

export interface Checkpoint {
  readonly sequenceNumber: bigint
  readonly digest: string
  readonly epoch: bigint
  readonly timestampMs: bigint
  readonly transactions: ReadonlyArray<CheckpointTransaction>
}

export class CheckpointNotFound extends /* @__PURE__ */ Schema.TaggedError<CheckpointNotFound>()("CheckpointNotFound", {
  sequenceNumber: Schema.BigInt
}) {
  override get message(): string {
    return `checkpoint ${this.sequenceNumber} not found`
  }
}

/** `follow` could not list a gap between history and the live subscription in time. */
export class CheckpointGap extends /* @__PURE__ */ Schema.TaggedError<CheckpointGap>()("CheckpointGap", {
  from: Schema.BigInt,
  to: Schema.BigInt
}) {
  override get message(): string {
    return `could not fill checkpoints ${this.from} to ${this.to}`
  }
}

export class CheckpointData extends /* @__PURE__ */ Context.Service<CheckpointData, {
  readonly get: (sequenceNumber: bigint) => Effect.Effect<Checkpoint, CheckpointNotFound | RpcError>
  /** History in order, `start` inclusive to `end` exclusive (default: the tip at the time of the call, pinned for the whole scan). */
  readonly list: (options?: { readonly start?: bigint; readonly end?: bigint }) => Stream.Stream<Checkpoint, RpcError>
  /** New checkpoints as they are executed. Ends cleanly if the server closes the stream (use `follow` to reconnect and fill gaps); a cut-off stream fails. */
  readonly subscribe: Stream.Stream<Checkpoint, RpcError>
}>()("@unconfirmed/effect-sui/CheckpointData") {}

export interface FollowOptions {
  /**
   * When to re-list a gap the list index hasn't reached yet; once the schedule ends, the gap is a
   * `CheckpointGap`. It restarts whenever a re-list makes progress. Default every 250 ms, 120 times (30 s).
   */
  readonly gapRetry?: Schedule.Schedule<unknown>
  /** Wait before reopening a subscription the server closed. Default 1 second. */
  readonly reconnectDelay?: Duration.Input
}

const defaultGapRetry: Schedule.Schedule<unknown> = /* @__PURE__ */ Schedule.spaced("250 millis").pipe(
  /* @__PURE__ */ Schedule.upTo({ times: 120 })
)

/**
 * Every checkpoint from `start`, in order, forever: `list` until the tip, then
 * `subscribe`, re-listing any gap between the two and dropping overlap. A
 * subscription the server closes is reopened (its gap re-listed); it only ends
 * with a failure.
 */
export const follow = (start: bigint, options?: FollowOptions): Stream.Stream<Checkpoint, RpcError | CheckpointGap, CheckpointData> =>
  Stream.unwrap(Effect.map(Effect.service(CheckpointData), (data) =>
    Stream.suspend(() => {
      const gapRetry = options?.gapRetry ?? defaultGapRetry
      const reconnect = options?.reconnectDelay ?? "1 second"
      let next = start
      const emit = <E>(s: Stream.Stream<Checkpoint, E>) =>
        s.pipe(
          Stream.filter((c) => c.sequenceNumber >= next),
          Stream.tap((c) => Effect.sync(() => (next = c.sequenceNumber + 1n)))
        )
      // The list index may trail the subscription: re-list from `next`, boundedly, until the gap is closed.
      // Only `CheckpointGap` is retried; an `RpcError` from `list` ends the stream at once.
      const fill = (end: bigint): Stream.Stream<Checkpoint, RpcError | CheckpointGap> =>
        Stream.suspend(() =>
          next >= end ? Stream.empty : Stream.concat(
            emit(data.list({ start: next, end })),
            Stream.suspend(() => (next >= end ? Stream.empty : Stream.fail(new CheckpointGap({ from: next, to: end }))))
          )
        ).pipe(Stream.retry(Schedule.while(gapRetry, ({ input }) => input instanceof CheckpointGap)))
      const live = (): Stream.Stream<Checkpoint, RpcError | CheckpointGap> =>
        Stream.concat(
          data.subscribe.pipe(Stream.flatMap((c) => Stream.concat(fill(c.sequenceNumber), emit(Stream.make(c))))),
          Stream.suspend(() => Stream.concat(Stream.fromEffectDrain(Effect.sleep(reconnect)), live()))
        )
      return Stream.concat(emit(data.list({ start })), live())
    })))
