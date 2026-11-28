/**
 * `sui-codegen.config.ts`:
 *
 *   import { defineConfig } from "@unconfirmed/sui-codegen/Config"
 *   export default defineConfig({
 *     output: "./src/generated",
 *     packages: [
 *       { path: "./move/counter", environment: "mainnet" },           // local, `sui move summary --build-env mainnet`
 *       { id: "0x…", network: "testnet", name: "deepbook" },          // on-chain, over gRPC
 *       { path: "./move/counter", package: "sui", modules: ["coin"] } // framework modules from the same summaries
 *     ]
 *   })
 */
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import { existsSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { CodegenError } from "./Model.ts"

/** A local Move package (or a summary directory), read from `sui move summary` output. */
export interface LocalPackage {
  /** A Move package directory (summaries in `package_summaries/`) or a summary directory. */
  readonly path: string
  /** Which package of the summaries to generate: default the Move package itself; `"sui"` / `"std"` for framework modules. */
  readonly package?: string
  /** Output directory name (default: the package's name). */
  readonly name?: string
  /**
   * The environment to generate for (`testnet`, `mainnet`, or one named in
   * `Move.toml`): passed to `sui move summary --build-env`, so dependencies
   * resolve to that network's ids, and its `Published.toml` record gives the
   * default `packageId` (`published-at`) and `originalId` (`original-id`).
   * Required when `Published.toml` has several records (else an
   * `AmbiguousEnvironment`); with one, that one. Entries reading one directory
   * share its environment.
   */
  readonly environment?: string
  /**
   * The id calls go to by default (default: the environment's `published-at`,
   * else the package's address in the summaries, else `originalId`).
   */
  readonly packageId?: string
  /**
   * The package's original (first published) id, when the summaries list it
   * as unpublished (`0x0`) and no `Published.toml` record says: type strings
   * (`Thing.type()`) use it. Default: `packageId`, which is right until the
   * package is upgraded. Without either, type strings say `0x0`.
   */
  readonly originalId?: string
  /** Defining ids of datatypes added by upgrades, `{ "module::Type": id }` (local summaries carry no type origins). */
  readonly typeOrigins?: Readonly<Record<string, string>>
  /** Modules to generate call builders for (default: all). */
  readonly modules?: ReadonlyArray<string>
  /** Run `sui move summary` first (default: when `path` has a `Move.toml`). */
  readonly summarize?: boolean
}

/** A published package, read over gRPC. */
export interface OnChainPackage {
  /** The package id; calls go to it by default. */
  readonly id: string
  readonly network?: "mainnet" | "testnet" | "devnet"
  /** A fullnode URL; overrides `network`. */
  readonly url?: string
  /** Output directory name (default: the short address). */
  readonly name?: string
  readonly modules?: ReadonlyArray<string>
}

export type PackageConfig = LocalPackage | OnChainPackage

export interface Config<P extends PackageConfig = PackageConfig> {
  /** Output directory: `<output>/<package>/<module>.ts` and `<output>/deps/...`. */
  readonly output: string
  readonly packages: ReadonlyArray<P>
  /** Only generate dependency types reachable from the packages' types (default `true`). */
  readonly prune?: boolean
  /** Extension in imports between generated files (default `.ts`). */
  readonly importExtension?: ".ts" | ".js" | ""
  /** Emit Move doc comments (default `true`). */
  readonly docs?: boolean
}

export const defineConfig = <const P extends PackageConfig>(config: Config<P>): Config<P> => config

/** Loading needs an `HttpClient` only when some package is on chain. */
export type Requirements<P extends PackageConfig> = [Extract<P, OnChainPackage>] extends [never] ? never : HttpClient.HttpClient

export const FULLNODES = {
  mainnet: "https://fullnode.mainnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443"
} as const

export const isOnChain = (p: PackageConfig): p is OnChainPackage => "id" in p

export const CONFIG_FILE = "sui-codegen.config.ts"

/** Load a config module's default export; relative paths in it resolve against its directory. */
export const load = (path: string = CONFIG_FILE): Effect.Effect<{ readonly config: Config; readonly dir: string }, CodegenError> =>
  Effect.gen(function*() {
    const file = isAbsolute(path) ? path : resolve(process.cwd(), path)
    if (!existsSync(file)) return yield* new CodegenError({ message: `config not found: ${file}` })
    const mod = yield* Effect.tryPromise({
      try: () => import(pathToFileURL(file).href) as Promise<{ default?: Config }>,
      catch: (e) => new CodegenError({ message: `loading ${file}: ${String(e)}` })
    })
    if (mod.default === undefined) return yield* new CodegenError({ message: `${file} has no default export` })
    return { config: mod.default, dir: dirname(file) }
  })
