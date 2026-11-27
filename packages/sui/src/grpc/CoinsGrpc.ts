import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import type { Address } from "../Address.ts"
import { Coins } from "../Coins.ts"
import { Objects } from "../Objects.ts"
import * as TypeTag from "../TypeTag.ts"
import { convert } from "./convert.ts"
import * as Rpc from "./generated/lean.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

const CoinStruct = Bcs.struct({ id: Bcs.Address, balance: Bcs.u64 })
const decodeCoin = Bcs.decodeSync(CoinStruct)

/** `Coins` over gRPC. Coin listing goes through `Objects.listOwned`. */
export const layer: Layer.Layer<Coins, never, GrpcWeb | Objects> = Layer.effect(
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
        objects.listOwned(owner, { type: `0x2::coin::Coin<${TypeTag.normalizeString(coinType)}>` }).pipe(
          Stream.mapEffect((o) =>
            convert(Rpc.StateService_ListOwnedObjects.path, () => ({
              ref: { objectId: o.objectId, version: o.version, digest: o.digest },
              coinType,
              balance: decodeCoin(o.contents).balance
            }))
          )
        )
    })
  })
)
