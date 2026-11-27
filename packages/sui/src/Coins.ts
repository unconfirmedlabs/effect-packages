/**
 * Balances and coin objects.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import type { Address } from "./Address.ts"
import type { SuiObject } from "./Objects.ts"
import { RpcError } from "./RpcError.ts"
import type { ObjectRef } from "./TransactionData.ts"
import * as TypeTag from "./TypeTag.ts"

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

export class Coins extends /* @__PURE__ */ Context.Service<Coins, {
  readonly getBalance: (owner: Address, coinType?: string) => Effect.Effect<Balance, RpcError>
  readonly list: (owner: Address, coinType?: string) => Stream.Stream<Coin, RpcError>
}>()("@unconfirmed/sui/Coins") {}

const decodeCoin = /* @__PURE__ */ Bcs.decode(/* @__PURE__ */ Bcs.struct({ id: Bcs.Address, balance: Bcs.u64 }))

/**
 * Coins of `coinType` from an owned-object listing, for transports that list
 * coins as objects: `list(objectType)` gets the `0x2::coin::Coin<T>` filter.
 * A coin type that doesn't parse is `INVALID_ARGUMENT` (before any request);
 * an object whose contents aren't a coin is `DATA_LOSS`.
 */
export const fromObjects = (
  method: string,
  coinType: string,
  list: (objectType: string) => Stream.Stream<SuiObject, RpcError>
): Stream.Stream<Coin, RpcError> =>
  Stream.unwrap(Effect.map(
    Effect.try({
      try: () => TypeTag.normalizeString(coinType),
      catch: (e) => new RpcError({ method, code: "INVALID_ARGUMENT", message: `invalid coin type ${coinType}: ${e instanceof Error ? e.message : String(e)}` })
    }),
    (type) =>
      list(`0x2::coin::Coin<${type}>`).pipe(
        Stream.mapEffect((o) =>
          Result.match(decodeCoin(o.contents), {
            onFailure: (e) =>
              Effect.fail(new RpcError({ method, code: "DATA_LOSS", message: `malformed coin ${o.objectId}: ${e.message}` })),
            onSuccess: (c): Effect.Effect<Coin> =>
              Effect.succeed({ ref: { objectId: o.objectId, version: o.version, digest: o.digest }, coinType: type, balance: c.balance })
          })
        )
      )
  ))
