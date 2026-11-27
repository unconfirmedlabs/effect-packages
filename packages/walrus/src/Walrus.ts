/**
 * The one-line layer (§4.11): everything `Read`, `Write` (through the nodes)
 * and `Aggregator.verified` need, for one network, given an `HttpClient` and
 * a Sui client (`Objects`, `Packages`).
 *
 *   const layer = Walrus.layer({ network: "testnet" }).pipe(
 *     Layer.provideMerge(SuiGrpc.layer({ baseUrl })),
 *     Layer.provideMerge(FetchHttpClient.layer)
 *   )
 *   const bytes = yield* Read.blob(blobId).pipe(Effect.provide(layer))
 *
 * Writes through the upload relay also need `UploadRelay.layer`; gateways
 * (`Aggregator`, `Publisher`) have their own layers and need none of this.
 * Building this layer loads the WASM (`Encoder`); see `Encoder.ts` for what
 * bundled apps must do (`wasmUrl` in browsers built with esbuild, Rolldown or
 * Bun).
 */
import type * as Objects from "@unconfirmed/sui/Objects"
import type * as Packages from "@unconfirmed/sui/Packages"
import type * as Duration from "effect/Duration"
import * as Layer from "effect/Layer"
import type * as HttpClient from "effect/http/HttpClient"
import * as Committee from "./Committee.ts"
import * as Config from "./Config.ts"
import * as Encoder from "./Encoder.ts"
import type { EncoderError } from "./Errors.ts"
import * as StorageNode from "./StorageNode.ts"
import * as System from "./System.ts"

interface CommonOptions {
  /** Where the web build's `walrus_wasm_bg.wasm` is served (browsers bundled with esbuild, Rolldown or Bun). Ignored on Bun and Node. */
  readonly wasmUrl?: string | URL
  /** Storage-node requests. `requestTimeout` defaults to 15 seconds here (`StorageNode.layer`'s own default is 30). */
  readonly nodes?: StorageNode.StorageNodesOptions
  readonly committees?: { readonly scheme?: "https" | "http"; readonly ttl?: Duration.Input }
}

/** A known network, or a deployment's system and staking objects: one of the two. */
export type WalrusOptions =
  | (CommonOptions & { readonly network: "testnet" | "mainnet"; readonly config?: never })
  | (CommonOptions & { readonly config: Config.WalrusConfigService; readonly network?: never })

export type WalrusServices = Config.WalrusConfig | System.System | Committee.Committees | StorageNode.StorageNodes | Encoder.Encoder

/** Storage-node request timeout in this layer: reads give up on a slow node sooner and ask another. */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Input = "15 seconds"

export const layer = (
  options: WalrusOptions
): Layer.Layer<WalrusServices, EncoderError, HttpClient.HttpClient | Objects.Objects | Packages.Packages> => {
  const config = options.config ?? (options.network === "mainnet" ? Config.mainnet : Config.testnet)
  return Layer.mergeAll(
    System.layer,
    Committee.layer(options.committees),
    StorageNode.layer({ ...options.nodes, requestTimeout: options.nodes?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT }),
    Encoder.layer(options.wasmUrl === undefined ? undefined : { wasmUrl: options.wasmUrl })
  ).pipe(Layer.provideMerge(Config.layer(config)))
}
