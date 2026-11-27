/**
 * How much history the node holds: the one thing `reconcile` needs beyond the
 * core capability services.
 *
 * `expired` rests on a `Transactions.get` miss, which is only evidence of
 * absence on a node whose history still covers the transaction's validity
 * window. The answer must be read fresh, *after* the misses (a node only
 * prunes forward) — which the cached `Chain.info` cannot promise — so it has
 * its own service.
 *
 * A `Context.Reference` whose default answers "cannot tell", so it never enters
 * an `R`: the lifecycle then never concludes `expired` (it stays
 * `SubmissionUnknown`, and `resubmit` remains the way out). Provide
 * `EvidenceGrpc.layer`, or your own, for the expiry rule.
 */
import type { RpcError } from "@unconfirmed/sui/RpcError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

export interface EvidenceService {
  /**
   * The lowest checkpoint the node still serves, read fresh (never cached).
   * None when the node does not report it: "cannot tell", never "full history".
   */
  readonly lowestAvailableCheckpoint: Effect.Effect<Option.Option<bigint>, RpcError>
  /** The first checkpoint of `epoch`; none if unreported or pruned. */
  readonly epochFirstCheckpoint: (epoch: bigint) => Effect.Effect<Option.Option<bigint>, RpcError>
}

/** Answers "cannot tell" to every question. */
export const unreported: EvidenceService = {
  lowestAvailableCheckpoint: Effect.succeed(Option.none()),
  epochFirstCheckpoint: () => Effect.succeed(Option.none())
}

export const Evidence = Context.Reference<EvidenceService>("@unconfirmed/sui-lifecycle/Evidence", {
  defaultValue: () => unreported
})

export const layer = (service: EvidenceService): Layer.Layer<never> => Layer.succeed(Evidence, service)
