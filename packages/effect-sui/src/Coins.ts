/**
 * Balances and coin objects.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import { type Address, normalize } from "./Address.ts"
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
  /** Default coin type: SUI. */
  readonly getBalance: (owner: Address, coinType?: string) => Effect.Effect<Balance, RpcError>
  /** Every coin type the owner holds, in coins or only in its address balance. */
  readonly listBalances: (owner: Address) => Stream.Stream<Balance, RpcError>
  /** The owner's coin objects of `coinType`, or of every type when it is omitted. */
  readonly list: (owner: Address, coinType?: string) => Stream.Stream<Coin, RpcError>
}>()("@unconfirmed/effect-sui/Coins") {}

const decodeCoin = /* @__PURE__ */ Bcs.decode(/* @__PURE__ */ Bcs.struct({ id: Bcs.Address, balance: Bcs.u64 }))

const COIN = "0x2::coin::Coin"
const FRAMEWORK = /* @__PURE__ */ normalize("0x2")

/** `T` of a `0x2::coin::Coin<T>` object type, normalized; `undefined` for anything else. */
const coinTypeOf = (objectType: string): string | undefined => {
  try {
    const t = TypeTag.parse(objectType)
    return t._tag === "struct" && t.address === FRAMEWORK && t.module === "coin" && t.name === "Coin" && t.typeParams.length === 1
      ? TypeTag.format(t.typeParams[0]!)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Coins from an owned-object listing, for transports that list coins as
 * objects: `list(objectType)` gets the `0x2::coin::Coin<T>` filter, or the
 * uninstantiated `0x2::coin::Coin` (every coin) when `coinType` is omitted.
 * A coin type that doesn't parse is `INVALID_ARGUMENT` (before any request);
 * an object that isn't a coin is `DATA_LOSS`.
 */
export const fromObjects = (
  method: string,
  coinType: string | undefined,
  list: (objectType: string) => Stream.Stream<SuiObject, RpcError>
): Stream.Stream<Coin, RpcError> =>
  Stream.unwrap(Effect.map(
    Effect.try({
      try: () => (coinType === undefined ? undefined : TypeTag.normalizeString(coinType)),
      catch: (e) => new RpcError({ method, code: "INVALID_ARGUMENT", message: `invalid coin type ${coinType}: ${e instanceof Error ? e.message : String(e)}` })
    }),
    (type) =>
      list(type === undefined ? COIN : `${COIN}<${type}>`).pipe(
        Stream.mapEffect((o) => {
          const malformed = (issue: string) =>
            Effect.fail(new RpcError({ method, code: "DATA_LOSS", message: `malformed coin ${o.objectId}: ${issue}` }))
          const ofType = type ?? coinTypeOf(o.type)
          if (ofType === undefined) return malformed(`${o.type} is not a coin type`)
          return Result.match(decodeCoin(o.contents), {
            onFailure: (e) => malformed(e.message),
            onSuccess: (c): Effect.Effect<Coin> =>
              Effect.succeed({ ref: { objectId: o.objectId, version: o.version, digest: o.digest }, coinType: ofType, balance: c.balance })
          })
        })
      )
  ))
