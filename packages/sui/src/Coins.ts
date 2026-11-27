/**
 * Balances and coin objects.
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { Address } from "./Address.ts"
import type { RpcError } from "./RpcError.ts"
import type { ObjectRef } from "./TransactionData.ts"

export interface Balance {
  readonly coinType: string
  /** Address balance plus coin objects. */
  readonly total: bigint
  readonly addressBalance: bigint
  readonly coinBalance: bigint
}

export interface Coin {
  readonly ref: ObjectRef
  readonly coinType: string
  readonly balance: bigint
}

export class Coins extends Context.Service<Coins, {
  readonly getBalance: (owner: Address, coinType?: string) => Effect.Effect<Balance, RpcError>
  readonly list: (owner: Address, coinType?: string) => Stream.Stream<Coin, RpcError>
}>()("@unconfirmed/sui/Coins") {}
