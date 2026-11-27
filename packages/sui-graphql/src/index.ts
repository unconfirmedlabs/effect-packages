/**
 * `@unconfirmed/sui-graphql`: every capability over Sui's GraphQL API.
 *
 * Take everything with `layer({ url })`, or compose only what you use, and mix
 * with other transports:
 *
 *   Layer.mergeAll(ObjectsGraphQL.layer, PackagesGraphQL.layer).pipe(Layer.provide(SuiGraphQL.protocol({ url })))
 */
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type { Chain } from "@unconfirmed/sui/Chain"
import type { CheckpointData } from "@unconfirmed/sui/CheckpointData"
import type { Checkpoints } from "@unconfirmed/sui/Checkpoints"
import type { Coins } from "@unconfirmed/sui/Coins"
import type { DynamicFields } from "@unconfirmed/sui/DynamicFields"
import type { Events } from "@unconfirmed/sui/Events"
import type { Objects } from "@unconfirmed/sui/Objects"
import type { Packages } from "@unconfirmed/sui/Packages"
import type { Transactions } from "@unconfirmed/sui/Transactions"
import * as ChainGraphQL from "./ChainGraphQL.ts"
import * as CheckpointDataGraphQL from "./CheckpointDataGraphQL.ts"
import * as CheckpointsGraphQL from "./CheckpointsGraphQL.ts"
import * as CoinsGraphQL from "./CoinsGraphQL.ts"
import * as DynamicFieldsGraphQL from "./DynamicFieldsGraphQL.ts"
import * as EventsGraphQL from "./EventsGraphQL.ts"
import * as ObjectsGraphQL from "./ObjectsGraphQL.ts"
import * as PackagesGraphQL from "./PackagesGraphQL.ts"
import * as SuiGraphQL from "./SuiGraphQL.ts"
import * as TransactionsGraphQL from "./TransactionsGraphQL.ts"

export {
  ChainGraphQL,
  CheckpointDataGraphQL,
  CheckpointsGraphQL,
  CoinsGraphQL,
  DynamicFieldsGraphQL,
  EventsGraphQL,
  ObjectsGraphQL,
  PackagesGraphQL,
  SuiGraphQL,
  TransactionsGraphQL
}
export type { SuiGraphQLOptions } from "./SuiGraphQL.ts"
export { DEVNET, MAINNET, TESTNET } from "./SuiGraphQL.ts"

export type Services =
  | Chain
  | Objects
  | Coins
  | Packages
  | Transactions
  | Checkpoints
  | DynamicFields
  | Events
  | CheckpointData

/** All capability services over one Sui GraphQL endpoint. Needs an `HttpClient`. */
export const layer = (options: SuiGraphQL.SuiGraphQLOptions): Layer.Layer<Services, never, HttpClient.HttpClient> =>
  Layer.mergeAll(
    ChainGraphQL.layer,
    PackagesGraphQL.layer,
    TransactionsGraphQL.layer,
    CheckpointsGraphQL.layer,
    EventsGraphQL.layer,
    CheckpointDataGraphQL.layer,
    Layer.mergeAll(CoinsGraphQL.layer, DynamicFieldsGraphQL.layer).pipe(Layer.provideMerge(ObjectsGraphQL.layer))
  ).pipe(Layer.provide(SuiGraphQL.protocol(options)))
