/**
 * Evidence of absence: the one thing `reconcile` needs beyond the core
 * capability services, and only for the expiry rule (`NotApplied{expired}`).
 *
 * "Its window closed and it is not there" is only sound when one backend
 * vouches for the whole observation: the epoch it has reached, that *it* does
 * not serve the transaction, and that its history still reaches back to the
 * window. Joining the epoch from one service (`Chain`) with a miss from another
 * (`Transactions`, perhaps an indexer seconds behind) can judge a transaction
 * that landed at the end of its window as never applied. So `observe` returns
 * all three from one backend, read in an order that makes them consistent:
 * the epoch first, then the lookup (a backend only moves forward, so anything
 * landed before that epoch is already served), then the retention floor (a
 * backend only prunes forward, so the floor read after the miss covers it).
 *
 * The lifecycle also requires a `Transactions.get` miss at both rounds, so
 * when `Transactions` and `Evidence` are different backends both must agree.
 *
 * A `Context.Reference` whose default answers "cannot tell", so it never
 * enters an `R`: **without an `Evidence` layer the expiry rule is off** and a
 * transaction that never reached the network stays `SubmissionUnknown` (and
 * `Signed`/`Unknown` in the journal) until `resubmit` sends it or
 * `Journal.remove` drops it. Provide `EvidenceGrpc.layer` or
 * `EvidenceGraphQL.layer` (pointed at the same backend as `Transactions`),
 * or your own.
 */
import type { RpcError } from "@unconfirmed/sui/RpcError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

/** One backend's view of a digest, read in the order described above. */
export interface Observation {
  /** The epoch the backend has reached, read before the lookup. */
  readonly epoch: bigint
  /** Whether the same backend serves the transaction. */
  readonly found: boolean
  /**
   * Whether its history, read after the lookup, reaches the first checkpoint
   * of the window's first epoch: none when it does, otherwise why a miss
   * proves nothing (pruned, or not reported: "cannot tell", never "full history").
   */
  readonly gap: Option.Option<string>
}

export interface EvidenceService {
  /**
   * Observe `digest` on one backend; `fromEpoch` is the first epoch of its
   * validity window. None: this service cannot tell (the expiry rule is off).
   */
  readonly observe: (digest: string, fromEpoch: bigint) => Effect.Effect<Option.Option<Observation>, RpcError>
}

/** Answers "cannot tell" to every question. */
export const unreported: EvidenceService = {
  observe: () => Effect.succeedNone
}

export const Evidence = Context.Reference<EvidenceService>("@unconfirmed/sui-lifecycle/Evidence", {
  defaultValue: () => unreported
})

export const layer = (service: EvidenceService): Layer.Layer<never> => Layer.succeed(Evidence, service)

/**
 * The history-gap check shared by the implementations: `lowest` is the
 * backend's lowest available checkpoint read after the lookup, `first` reads
 * the first checkpoint of `fromEpoch` on the same backend.
 */
export const historyGap = <E>(
  lowest: Option.Option<bigint>,
  fromEpoch: bigint,
  first: (epoch: bigint) => Effect.Effect<Option.Option<bigint>, E>
): Effect.Effect<Option.Option<string>, E> => {
  if (Option.isNone(lowest)) return Effect.succeedSome("the node does not report how much history it holds")
  if (lowest.value === 0n) return Effect.succeedNone
  const floor = lowest.value
  return Effect.map(first(fromEpoch), (start) =>
    Option.isNone(start)
      ? Option.some(`the node has pruned to checkpoint ${floor} and does not say where epoch ${fromEpoch} starts`)
      : floor <= start.value
      ? Option.none()
      : Option.some(`the node has pruned to checkpoint ${floor}, after checkpoint ${start.value} where epoch ${fromEpoch} starts`))
}
