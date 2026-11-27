/**
 * The programmatic API: config -> models -> files.
 *
 *   yield* Generate.run(config)              // load, render, write
 *   yield* Generate.files(config)            // load and render only
 *   Render.render(model.packages, roots)     // from a model you built
 */
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import { GrpcWeb } from "@unconfirmed/sui/grpc/GrpcWeb"
import type { RpcError } from "@unconfirmed/sui/RpcError"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import * as Config from "./Config.ts"
import * as FromGrpc from "./FromGrpc.ts"
import * as M from "./Model.ts"
import * as Render from "./Render.ts"
import * as Summary from "./Summary.ts"

/** Run `sui move summary` in a Move package. */
export const summarize = (path: string): Effect.Effect<void, M.CodegenError> =>
  Effect.suspend(() => {
    const r = spawnSync("sui", ["move", "summary"], { cwd: path, encoding: "utf-8" })
    return r.status === 0
      ? Effect.void
      : Effect.fail(new M.CodegenError({ message: `sui move summary failed in ${path}: ${r.error ?? r.stderr}` }))
  })

/** Load one configured package. */
export const loadPackage = (
  p: Config.PackageConfig,
  dir: string = process.cwd()
): Effect.Effect<M.Model, M.CodegenError | RpcError, HttpClient.HttpClient> => {
  if (Config.isOnChain(p)) {
    const baseUrl = p.url ?? Config.FULLNODES[p.network ?? "mainnet"]
    return FromGrpc.load(p.id, { name: p.name }).pipe(Effect.provide(GrpcWeb.layer({ baseUrl })))
  }
  const path = resolve(dir, p.path)
  const run = p.summarize ?? existsSync(join(path, "Move.toml"))
  return Effect.andThen(
    run ? summarize(path) : Effect.void,
    Summary.load(path, { package: p.package, name: p.name, packageId: p.packageId })
  )
}

/** Merge models: the first copy of a package wins. */
export const merge = (models: ReadonlyArray<M.Model>): ReadonlyArray<M.Package> => {
  const out = new Map<string, M.Package>()
  for (const m of models) for (const p of m.packages) if (!out.has(p.address)) out.set(p.address, p)
  return [...out.values()]
}

const renderOptions = (config: Config.Config): Render.RenderOptions => ({
  prune: config.prune,
  importExtension: config.importExtension,
  docs: config.docs
})

/** Load every configured package and render. */
export const files = (
  config: Config.Config,
  dir: string = process.cwd()
): Effect.Effect<ReadonlyArray<Render.File>, M.CodegenError | RpcError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const models = yield* Effect.forEach(config.packages, (p) => loadPackage(p, dir))
    const roots: Array<Render.Root> = []
    for (let i = 0; i < models.length; i++) {
      const root = models[i]!.root
      if (roots.some((r) => r.address === root)) {
        return yield* new M.CodegenError({ message: `two configured packages resolve to ${root}` })
      }
      roots.push({ address: root, modules: config.packages[i]!.modules })
    }
    const packages = merge(models)
    return yield* Effect.try({
      try: () => Render.render(packages, roots, renderOptions(config)),
      catch: (e) => e instanceof M.CodegenError ? e : new M.CodegenError({ message: String(e) })
    })
  })

/** Write rendered files under `output`, replacing the generated package directories and `deps`. */
export const write = (output: string, rendered: ReadonlyArray<Render.File>): Effect.Effect<ReadonlyArray<string>, M.CodegenError> =>
  Effect.tryPromise({
    try: async () => {
      const tops = new Set(rendered.map((f) => f.path.split("/")[0]!))
      for (const top of tops) await rm(join(output, top), { recursive: true, force: true })
      const written: Array<string> = []
      for (const f of rendered) {
        const path = join(output, f.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, f.contents)
        written.push(path)
      }
      return written
    },
    catch: (e) => new M.CodegenError({ message: `writing ${output}: ${String(e)}` })
  })

/** Load, render and write. Relative paths resolve against `dir` (the config file's directory). */
export const run = (config: Config.Config, dir: string = process.cwd()) =>
  Effect.flatMap(files(config, dir), (rendered) => write(resolve(dir, config.output), rendered))
