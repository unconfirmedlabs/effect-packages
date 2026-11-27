import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import type { Address } from "@unconfirmed/sui/Address"
import * as Coins from "@unconfirmed/sui/Coins"
import * as Objects from "@unconfirmed/sui/Objects"
import * as TypeTag from "@unconfirmed/sui/TypeTag"
import { call, U64 } from "./convert.ts"

export const GetBalance = GraphQL.query("GetBalance", {
  document: "query GetBalance($owner:SuiAddress!,$coinType:String!){" +
    "address(address:$owner){balance(coinType:$coinType){coinType{repr} totalBalance addressBalance coinBalance}}}",
  variables: { owner: Schema.String, coinType: Schema.String },
  result: Schema.Struct({
    address: Schema.NullOr(Schema.Struct({
      balance: Schema.NullOr(Schema.Struct({
        coinType: Schema.NullOr(Schema.Struct({ repr: Schema.String })),
        totalBalance: Schema.NullOr(U64),
        addressBalance: Schema.NullOr(U64),
        coinBalance: Schema.NullOr(U64)
      }))
    }))
  })
})

export const group = GraphQLGroup.make(GetBalance)

const CoinStruct = Bcs.struct({ id: Bcs.Address, balance: Bcs.u64 })
const decodeCoin = Bcs.decodeSync(CoinStruct)

/** `Coins` over GraphQL. Coin listing goes through `Objects.listOwned`. */
export const layer: Layer.Layer<Coins.Coins, never, GraphQLProtocol.GraphQLProtocol | Objects.Objects> = Layer.effect(
  Coins.Coins,
  Effect.gen(function*() {
    const client = yield* GraphQLClient.make(group)
    const objects = yield* Objects.Objects
    return Coins.Coins.of({
      getBalance: (owner: Address, coinType = TypeTag.SUI) =>
        client.GetBalance({ owner, coinType }).pipe(
          call,
          Effect.map((r) => {
            const b = r.address?.balance
            return {
              coinType: b?.coinType?.repr ?? coinType,
              total: b?.totalBalance ?? 0n,
              addressBalance: b?.addressBalance ?? 0n,
              coinBalance: b?.coinBalance ?? 0n
            }
          })
        ),
      list: (owner: Address, coinType = TypeTag.SUI) =>
        objects.listOwned(owner, { type: `0x2::coin::Coin<${TypeTag.normalizeString(coinType)}>` }).pipe(
          Stream.map((o) => ({
            ref: Objects.refOf(o),
            coinType,
            balance: decodeCoin(o.contents).balance
          }))
        )
    })
  })
)
