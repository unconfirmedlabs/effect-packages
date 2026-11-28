import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import type { Address } from "../Address.ts"
import { type Balance, Coins, fromObjects } from "../Coins.ts"
import { Objects } from "../Objects.ts"
import * as TypeTag from "../TypeTag.ts"
import { convert } from "./convert.ts"
import type * as P from "./generated/proto.ts"
import * as Rpc from "./generated/lean.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

const balance = (b: P.Balance | undefined, coinType: string): Balance => ({
  coinType: b?.coin_type ?? coinType,
  total: b?.balance ?? 0n,
  addressBalance: b?.address_balance ?? 0n,
  coinBalance: b?.coin_balance ?? 0n
})

/** `Coins` over gRPC. Coin listing goes through `Objects.listOwned`. */
export const layer: Layer.Layer<Coins, never, GrpcWeb | Objects> = /* @__PURE__ */ Layer.effect(
  Coins,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const objects = yield* Objects
    return Coins.of({
      getBalance: (owner: Address, coinType = TypeTag.SUI) =>
        grpc.unary(Rpc.StateService_GetBalance, { owner, coin_type: coinType }).pipe(
          Effect.map((r) => balance(r.balance, coinType))
        ),
      listBalances: (owner) =>
        Stream.paginate(undefined as Uint8Array | undefined, (page_token) =>
          grpc.unary(Rpc.StateService_ListBalances, { owner, page_size: 1000, ...(page_token && { page_token }) }).pipe(
            Effect.flatMap((r) =>
              convert(Rpc.StateService_ListBalances.path, () =>
                [
                  (r.balances ?? []).map((b) => {
                    if (!b.coin_type) throw new Error("a balance without coin_type")
                    return balance(b, b.coin_type)
                  }),
                  Option.fromNullishOr(r.next_page_token?.length ? r.next_page_token : undefined)
                ] as const)
            )
          )),
      list: (owner: Address, coinType?: string) =>
        fromObjects(Rpc.StateService_ListOwnedObjects.path, coinType, (type) => objects.listOwned(owner, { type }))
    })
  })
)
