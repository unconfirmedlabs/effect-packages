/**
 * `@unconfirmed/effect-sui/graphql`: every capability over Sui's GraphQL API.
 *
 * Take everything with `layer({ url })`, or compose only what you use, and mix
 * with other transports:
 *
 *   Layer.mergeAll(ObjectsGraphQL.layer, PackagesGraphQL.layer).pipe(Layer.provide(SuiGraphQL.protocol({ url })))
 */
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type { Chain } from "../Chain.ts"
import type { CheckpointData } from "../CheckpointData.ts"
import type { Checkpoints } from "../Checkpoints.ts"
import type { Coins } from "../Coins.ts"
import type { DynamicFields } from "../DynamicFields.ts"
import type { Events } from "../Events.ts"
import type { Objects } from "../Objects.ts"
import type { Packages } from "../Packages.ts"
import type { Transactions } from "../Transactions.ts"
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

/**
 * All capability services over one Sui GraphQL endpoint, plus its
 * `GraphQLProtocol` (for `EvidenceGraphQL` or your own queries on the same
 * endpoint). Needs an `HttpClient`.
 */
export const layer = (
  options: SuiGraphQL.SuiGraphQLOptions
): Layer.Layer<Services | GraphQLProtocol.GraphQLProtocol, never, HttpClient.HttpClient> =>
  Layer.mergeAll(
    ChainGraphQL.layer,
    PackagesGraphQL.layer,
    TransactionsGraphQL.layer,
    CheckpointsGraphQL.layer,
    EventsGraphQL.layer,
    CheckpointDataGraphQL.layer,
    Layer.mergeAll(CoinsGraphQL.layer, DynamicFieldsGraphQL.layer).pipe(Layer.provideMerge(ObjectsGraphQL.layer))
  ).pipe(Layer.provideMerge(SuiGraphQL.protocol(options)))
