import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Address } from "../Address.ts"
import { Coins, fromObjects } from "../Coins.ts"
import { Objects } from "../Objects.ts"
import * as TypeTag from "../TypeTag.ts"
import * as Rpc from "./generated/lean.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

/** `Coins` over gRPC. Coin listing goes through `Objects.listOwned`. */
export const layer: Layer.Layer<Coins, never, GrpcWeb | Objects> = /* @__PURE__ */ Layer.effect(
  Coins,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const objects = yield* Objects
    return Coins.of({
      getBalance: (owner: Address, coinType = TypeTag.SUI) =>
        grpc.unary(Rpc.StateService_GetBalance, { owner, coin_type: coinType }).pipe(
          Effect.map((r) => ({
            coinType: r.balance?.coin_type ?? coinType,
            total: r.balance?.balance ?? 0n,
            addressBalance: r.balance?.address_balance ?? 0n,
            coinBalance: r.balance?.coin_balance ?? 0n
          }))
        ),
      list: (owner: Address, coinType = TypeTag.SUI) =>
        fromObjects(Rpc.StateService_ListOwnedObjects.path, coinType, (type) => objects.listOwned(owner, { type }))
    })
  })
)
