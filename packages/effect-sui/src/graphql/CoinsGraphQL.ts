import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Address } from "../Address.ts"
import * as Coins from "../Coins.ts"
import * as Objects from "../Objects.ts"
import * as TypeTag from "../TypeTag.ts"
import { call, U64 } from "./convert.ts"

const BALANCE_FIELDS = "coinType{repr} totalBalance addressBalance coinBalance"

const BalanceNode = Schema.Struct({
  coinType: Schema.NullOr(Schema.Struct({ repr: Schema.String })),
  totalBalance: Schema.NullOr(U64),
  addressBalance: Schema.NullOr(U64),
  coinBalance: Schema.NullOr(U64)
})

const balance = (b: typeof BalanceNode.Type | null, coinType: string): Coins.Balance => ({
  coinType: b?.coinType?.repr ?? coinType,
  total: b?.totalBalance ?? 0n,
  addressBalance: b?.addressBalance ?? 0n,
  coinBalance: b?.coinBalance ?? 0n
})

export const GetBalance = GraphQL.query("GetBalance", {
  document: "query GetBalance($owner:SuiAddress!,$coinType:String!){" +
    `address(address:$owner){balance(coinType:$coinType){${BALANCE_FIELDS}}}}`,
  variables: { owner: Schema.String, coinType: Schema.String },
  result: Schema.Struct({ address: Schema.NullOr(Schema.Struct({ balance: Schema.NullOr(BalanceNode) })) })
})

/** The largest page the server allows for `Address.balances`. */
const BALANCES_PAGE = 50

export const ListBalances = GraphQL.query("ListBalances", {
  document: "query ListBalances($owner:SuiAddress!,$after:String){" +
    `address(address:$owner){balances(first:${BALANCES_PAGE},after:$after){pageInfo{hasNextPage endCursor} nodes{${BALANCE_FIELDS}}}}}`,
  variables: { owner: Schema.String, after: Schema.NullOr(Schema.String) },
  result: Schema.Struct({
    address: Schema.NullOr(Schema.Struct({
      balances: Schema.NullOr(Schema.Struct({
        pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
        // A listed balance always names its coin type.
        nodes: Schema.Array(Schema.Struct({ ...BalanceNode.fields, coinType: Schema.Struct({ repr: Schema.String }) }))
      }))
    }))
  })
})

export const group = GraphQLGroup.make(GetBalance, ListBalances)

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
          Effect.map((r) => balance(r.address?.balance ?? null, coinType))
        ),
      listBalances: (owner) =>
        Stream.paginate(null as string | null, (after) =>
          client.ListBalances({ owner, after }).pipe(
            call,
            Effect.map((r) => {
              const page = r.address?.balances
              const next = page?.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
              return [(page?.nodes ?? []).map((b) => balance(b, b.coinType.repr)), Option.fromNullishOr(next)] as const
            })
          )),
      list: (owner: Address, coinType?: string) =>
        Coins.fromObjects("ListOwnedObjects", coinType, (type) => objects.listOwned(owner, { type }))
    })
  })
)
