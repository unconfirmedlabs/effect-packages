/**
 * `@unconfirmed/sui/grpc`: every capability over gRPC-web.
 *
 * Take everything with `layer({ baseUrl })`, or compose only what you use:
 *
 *   Layer.mergeAll(ObjectsGrpc.layer, TransactionsGrpc.layer).pipe(Layer.provide(GrpcWeb.layer({ baseUrl })))
 */
import * as Layer from "effect/Layer"
import type * as HttpClient from "effect/http/HttpClient"
import type { Chain } from "../Chain.ts"
import type { CheckpointData } from "../CheckpointData.ts"
import type { Checkpoints } from "../Checkpoints.ts"
import type { Coins } from "../Coins.ts"
import type { DynamicFields } from "../DynamicFields.ts"
import type { Events } from "../Events.ts"
import type { Objects } from "../Objects.ts"
import type { Packages } from "../Packages.ts"
import type { Transactions } from "../Transactions.ts"
import * as ChainGrpc from "./ChainGrpc.ts"
import * as CheckpointDataGrpc from "./CheckpointDataGrpc.ts"
import * as CheckpointsGrpc from "./CheckpointsGrpc.ts"
import * as CoinsGrpc from "./CoinsGrpc.ts"
import * as DynamicFieldsGrpc from "./DynamicFieldsGrpc.ts"
import * as EventsGrpc from "./EventsGrpc.ts"
import { GrpcWeb, type GrpcWebOptions } from "./GrpcWeb.ts"
import * as ObjectsGrpc from "./ObjectsGrpc.ts"
import * as PackagesGrpc from "./PackagesGrpc.ts"
import * as TransactionsGrpc from "./TransactionsGrpc.ts"

export {
  ChainGrpc,
  CheckpointDataGrpc,
  CheckpointsGrpc,
  CoinsGrpc,
  DynamicFieldsGrpc,
  EventsGrpc,
  GrpcWeb,
  ObjectsGrpc,
  PackagesGrpc,
  TransactionsGrpc
}
export type { GrpcWebOptions }
export type * as Proto from "./generated/proto.ts"
/** Every RPC as a typed handle, for calls the capability services don't cover: `grpc.unary(Rpc.NameService_LookupName, { name })`. */
export * as Rpc from "./generated/rpc.ts"

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

/** All capability services over one gRPC-web endpoint. Needs an `HttpClient`. */
export const layer = (options: GrpcWebOptions): Layer.Layer<Services, never, HttpClient.HttpClient> =>
  Layer.mergeAll(
    ChainGrpc.layer,
    PackagesGrpc.layer,
    TransactionsGrpc.layer,
    CheckpointsGrpc.layer,
    CheckpointDataGrpc.layer,
    EventsGrpc.layer,
    Layer.mergeAll(CoinsGrpc.layer, DynamicFieldsGrpc.layer).pipe(Layer.provideMerge(ObjectsGrpc.layer))
  ).pipe(Layer.provide(GrpcWeb.layer(options)))
