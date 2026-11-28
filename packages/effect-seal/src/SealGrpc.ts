/**
 * `Seal.layer` over gRPC-web with only the chain reads Seal needs: `Objects`
 * (key servers, package versions, approval inputs) and `Packages`
 * (`Approval.fromRecipe` argument types).
 *
 *   SealGrpc.layer({ servers: [...], grpc: { url } }).pipe(Layer.provide(FetchHttpClient.layer))
 *
 * `@unconfirmed/effect-sui/grpc`'s `layer` provides every capability and so ships
 * every RPC's codec (about 90 KB minified more); a program that also builds
 * and executes transactions should provide that instead and use `Seal.layer`.
 */
import type * as Objects from "@unconfirmed/effect-sui/Objects"
import type * as Packages from "@unconfirmed/effect-sui/Packages"
import { GrpcWeb, type GrpcWebOptions } from "@unconfirmed/effect-sui/grpc/GrpcWeb"
import * as ObjectsGrpc from "@unconfirmed/effect-sui/grpc/ObjectsGrpc"
import * as PackagesGrpc from "@unconfirmed/effect-sui/grpc/PackagesGrpc"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type * as Config from "./Config.ts"
import type { InvalidConfig } from "./Errors.ts"
import type * as KeyServer from "./KeyServer.ts"
import type * as KeyServerApi from "./KeyServerApi.ts"
import * as Seal from "./Seal.ts"

/** `Objects` and `Packages` over gRPC-web, nothing else. */
export const chain = (options: GrpcWebOptions): Layer.Layer<Objects.Objects | Packages.Packages, never, HttpClient.HttpClient> =>
  Layer.mergeAll(ObjectsGrpc.layer, PackagesGrpc.layer).pipe(Layer.provide(GrpcWeb.layer(options)))

export interface SealGrpcOptions extends Seal.SealOptions {
  /** The full node, e.g. `{ url: "https://fullnode.testnet.sui.io:443" }`. */
  readonly grpc: GrpcWebOptions
}

/** `Seal.layer` with `chain`, both also provided to the program. Needs an `HttpClient`. */
export const layer = (
  options: SealGrpcOptions
): Layer.Layer<
  Config.SealConfig | KeyServer.KeyServers | KeyServerApi.KeyServerApi | Objects.Objects | Packages.Packages,
  InvalidConfig,
  HttpClient.HttpClient
> => Seal.layer(options).pipe(Layer.provideMerge(chain(options.grpc)))
