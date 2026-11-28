/**
 * Checkpoints as streams.
 */
import * as Context from "effect/Context"
import type * as Stream from "effect/Stream"
import type { RpcError } from "./RpcError.ts"

export interface CheckpointSummary {
  readonly sequenceNumber: bigint
  readonly digest: string
}

export class Checkpoints extends /* @__PURE__ */ Context.Service<Checkpoints, {
  /** History from `start` (default: the oldest the node keeps), in order. */
  readonly list: (options?: { readonly start?: bigint; readonly end?: bigint }) => Stream.Stream<CheckpointSummary, RpcError>
  /** New checkpoints as they are certified. */
  readonly subscribe: Stream.Stream<CheckpointSummary, RpcError>
}>()("@unconfirmed/effect-sui/Checkpoints") {}
