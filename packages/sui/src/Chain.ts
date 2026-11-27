/**
 * Chain identity and the current epoch's gas price.
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { RpcError } from "./RpcError.ts"
import type { ObjectDigest } from "./TransactionData.ts"

export interface ChainInfo {
  /** The genesis checkpoint digest; what `ValidDuring.chain` names. */
  readonly chainId: ObjectDigest
  /** `mainnet`, `testnet`, ... as the node reports it. */
  readonly chain: string
  readonly epoch: bigint
  readonly checkpointHeight: bigint
  /** The oldest checkpoint the node serves; `undefined` when the transport doesn't report it (not "full history"). */
  readonly lowestAvailableCheckpoint: bigint | undefined
  /** The first checkpoint of `epoch`; `undefined` when the transport doesn't report it. */
  readonly epochFirstCheckpoint: bigint | undefined
}

export class Chain extends /* @__PURE__ */ Context.Service<Chain, {
  readonly info: Effect.Effect<ChainInfo, RpcError>
  readonly referenceGasPrice: Effect.Effect<bigint, RpcError>
}>()("@unconfirmed/sui/Chain") {}
