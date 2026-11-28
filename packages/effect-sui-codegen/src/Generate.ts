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
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import * as Config from "./Config.ts"
import * as FromGrpc from "./FromGrpc.ts"
import * as M from "./Model.ts"
import * as Render from "./Render.ts"
import * as Summary from "./Summary.ts"

/** Run `sui move summary` in a Move package, for `environment` (`--build-env`) when given. */
export const summarize = (path: string, environment?: string): Effect.Effect<void, M.CodegenError> =>
  Effect.suspend(() => {
    const args = ["move", "summary", ...(environment === undefined ? [] : ["--build-env", environment])]
    const r = spawnSync("sui", args, { cwd: path, encoding: "utf-8" })
    return r.status === 0
      ? Effect.void
      : Effect.fail(
        new M.CodegenError({ message: `sui ${args.join(" ")} failed in ${path}: ${r.error ?? (r.stderr.trim() || r.stdout.trim())}` })
      )
  })

/** Whether a local entry runs `sui move summary` first. */
const summarizes = (p: Config.LocalPackage, path: string) => p.summarize ?? existsSync(join(path, "Move.toml"))

/** A local directory's environment and its publish record. */
interface Environment {
  readonly name: string | undefined
  readonly record: Summary.PublishRecord | undefined
}

/**
 * The environment to generate a directory for: the configured one, else the
 * only `Published.toml` record's. Several records and none chosen fail: the
 * ids would be whichever environment the CLI happens to resolve.
 */
const environmentOf = (
  path: string,
  configured: string | undefined
): Effect.Effect<Environment, M.CodegenError | M.AmbiguousEnvironment> =>
  Effect.flatMap(Summary.publishRecords(path), (records) => {
    if (configured === undefined && records.length > 1) {
      return Effect.fail(new M.AmbiguousEnvironment({ path, environments: records.map((r) => r.environment) }))
    }
    const name = configured ?? records[0]?.environment
    return Effect.succeed({ name, record: records.find((r) => r.environment === name) })
  })

const loadLocal = (p: Config.LocalPackage, path: string, env: Environment) =>
  Summary.load(path, {
    package: p.package,
    name: p.name,
    // The record describes the directory's own package, not framework modules read from its summaries.
    packageId: p.packageId ?? (p.package === undefined ? env.record?.publishedAt : undefined),
    originalId: p.originalId ?? (p.package === undefined ? env.record?.originalId : undefined),
    typeOrigins: p.typeOrigins
  })

const loadOnChain = (p: Config.OnChainPackage): Effect.Effect<M.Model, M.CodegenError | RpcError, HttpClient.HttpClient> =>
  FromGrpc.load(p.id, { name: p.name }).pipe(Effect.provide(GrpcWeb.layer({ url: p.url ?? Config.FULLNODES[p.network ?? "mainnet"] })))

/** Load one configured package. */
export const loadPackage = <P extends Config.PackageConfig>(
  p: P,
  dir: string = process.cwd()
): Effect.Effect<M.Model, M.CodegenError | M.AmbiguousEnvironment | RpcError, Config.Requirements<P>> => {
  if (Config.isOnChain(p)) return loadOnChain(p) as Effect.Effect<M.Model, M.CodegenError | RpcError, Config.Requirements<P>>
  const path = resolve(dir, p.path)
  return Effect.gen(function*() {
    const env = yield* environmentOf(path, p.environment)
    if (summarizes(p, path)) yield* summarize(path, env.name)
    return yield* loadLocal(p, path, env)
  })
}

const datatypeCount = (p: M.Package) => p.modules.reduce((n, m) => n + m.datatypes.length, 0)

/**
 * Merge models into one package per identity. A model's root copy wins over
 * any dependency copy (so a configured root keeps its `name` and `packageId`
 * whatever the entry order); between roots, the first. Between dependency
 * copies (two roots linking different versions), the one with the most
 * datatypes wins (a later version only adds types), then the first.
 */
export const merge = (models: ReadonlyArray<M.Model>): ReadonlyArray<M.Package> => {
  const out = new Map<string, M.Package>()
  for (const m of models) {
    const root = m.packages.find((p) => p.address === m.root)
    if (root !== undefined && !out.has(root.address)) out.set(root.address, root)
  }
  const roots = new Set(out.keys())
  for (const m of models) {
    for (const p of m.packages) {
      if (roots.has(p.address)) continue
      const have = out.get(p.address)
      if (have === undefined || datatypeCount(p) > datatypeCount(have)) out.set(p.address, p)
    }
  }
  return [...out.values()]
}

const renderOptions = (config: Config.Config): Render.RenderOptions => ({
  prune: config.prune,
  importExtension: config.importExtension,
  docs: config.docs
})

/** Configured packages loaded at once. */
const LOAD_CONCURRENCY = 4

/**
 * Load every configured package and render. `sui move summary` runs once per
 * directory, however many entries read it (they share its environment);
 * entries then load concurrently. An `HttpClient` is needed only for on-chain
 * packages.
 */
export const files = <P extends Config.PackageConfig>(
  config: Config.Config<P>,
  dir: string = process.cwd()
): Effect.Effect<ReadonlyArray<Render.File>, M.CodegenError | M.AmbiguousEnvironment | RpcError, Config.Requirements<P>> =>
  Effect.gen(function*() {
    const configured = new Map<string, string | undefined>()
    const toSummarize = new Set<string>()
    for (const p of config.packages) {
      if (Config.isOnChain(p)) continue
      const path = resolve(dir, p.path)
      const have = configured.get(path)
      if (have !== undefined && p.environment !== undefined && have !== p.environment) {
        return yield* new M.CodegenError({ message: `${path} is configured for both ${have} and ${p.environment}` })
      }
      configured.set(path, have ?? p.environment)
      if (summarizes(p, path)) toSummarize.add(path)
    }
    const environments = new Map<string, Environment>()
    for (const [path, name] of configured) environments.set(path, yield* environmentOf(path, name))
    for (const path of toSummarize) yield* summarize(path, environments.get(path)!.name)
    const models = yield* Effect.forEach(
      config.packages,
      (p): Effect.Effect<M.Model, M.CodegenError | RpcError, HttpClient.HttpClient> => {
        if (Config.isOnChain(p)) return loadOnChain(p)
        const path = resolve(dir, p.path)
        return loadLocal(p, path, environments.get(path)!)
      },
      { concurrency: LOAD_CONCURRENCY }
    )
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
  }) as Effect.Effect<ReadonlyArray<Render.File>, M.CodegenError | M.AmbiguousEnvironment | RpcError, Config.Requirements<P>>

/** Every file under `dir` that does not start with the generated header. */
const foreignFiles = async (dir: string): Promise<Array<string>> => {
  const out: Array<string> = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    if (e.isDirectory()) out.push(...await foreignFiles(path))
    else if (!e.isFile() || !(await readFile(path, "utf-8")).startsWith(Render.HEADER)) out.push(path)
  }
  return out
}

/**
 * Write rendered files under `output`, replacing the generated package
 * directories and `deps`. A directory about to be replaced must hold only
 * generated files (they start with `Render.HEADER`), otherwise nothing is
 * written; two files at one path fail too. Directories of packages no longer
 * configured are left alone.
 */
export const write = (output: string, rendered: ReadonlyArray<Render.File>): Effect.Effect<ReadonlyArray<string>, M.CodegenError> =>
  Effect.tryPromise({
    try: async () => {
      const paths = new Set<string>()
      for (const f of rendered) {
        if (paths.has(f.path)) throw new M.CodegenError({ message: `two generated files at ${f.path}` })
        paths.add(f.path)
      }
      const tops = [...new Set(rendered.map((f) => f.path.split("/")[0]!))]
      for (const top of tops) {
        const path = join(output, top)
        if (!existsSync(path)) continue
        const foreign = await foreignFiles(path)
        if (foreign.length > 0) {
          throw new M.CodegenError({
            message: `refusing to replace ${path}: ${foreign[0]} was not generated by sui-codegen (move it, or choose another output)`
          })
        }
      }
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
    catch: (e) => e instanceof M.CodegenError ? e : new M.CodegenError({ message: `writing ${output}: ${String(e)}` })
  })

/** Load, render and write. Relative paths resolve against `dir` (the config file's directory). */
export const run = <P extends Config.PackageConfig>(config: Config.Config<P>, dir: string = process.cwd()) =>
  Effect.flatMap(files(config, dir), (rendered) => write(resolve(dir, config.output), rendered))
