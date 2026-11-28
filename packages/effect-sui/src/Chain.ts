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
}

export class Chain extends /* @__PURE__ */ Context.Service<Chain, {
  readonly info: Effect.Effect<ChainInfo, RpcError>
  readonly referenceGasPrice: Effect.Effect<bigint, RpcError>
}>()("@unconfirmed/sui/Chain") {}
