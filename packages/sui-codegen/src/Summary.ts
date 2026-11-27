/**
 * `sui move summary` package summaries -> `Model`.
 *
 * A summary directory holds `address_mapping.json` (named address -> address),
 * `root_package_metadata.json` (ids and type origins, for summaries of
 * on-chain packages) and one directory of module JSON files per package.
 * Local summaries carry parameter names; bytecode-derived ones don't.
 */
import * as Effect from "effect/Effect"
import { existsSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import * as M from "./Model.ts"

// -----------------------------------------------------------------------------
// Summary format (see `sui move summary`)
// -----------------------------------------------------------------------------

type SAbility = "Copy" | "Drop" | "Store" | "Key"

type SType =
  | "bool"
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "u128"
  | "u256"
  | "address"
  | "signer"
  | "_"
  | { readonly Datatype: SDatatype }
  | { readonly vector: SType }
  | { readonly Reference: readonly [boolean, SType] }
  | { readonly TypeParameter: number }
  | { readonly NamedTypeParameter: string }
  | { readonly tuple: ReadonlyArray<SType> }
  | { readonly fun: unknown }

interface SDatatype {
  readonly module: { readonly address: string; readonly name: string }
  readonly name: string
  readonly type_arguments: ReadonlyArray<{ readonly phantom: boolean; readonly argument: SType }>
}

interface STypeParameter {
  readonly name?: string
  readonly phantom?: boolean
  readonly constraints: ReadonlyArray<SAbility>
}

interface SFields {
  readonly positional_fields: boolean
  readonly fields: Record<string, { readonly index: number; readonly doc?: string | null; readonly type_: SType }>
}

interface SModule {
  readonly id: { readonly address: string; readonly name: string }
  readonly doc?: string | null
  readonly functions: Record<string, {
    readonly index: number
    readonly doc?: string | null
    readonly visibility: "Public" | "Friend" | "Package" | "Private"
    readonly entry: boolean
    readonly macro_?: boolean
    readonly type_parameters: ReadonlyArray<STypeParameter>
    readonly parameters: ReadonlyArray<{ readonly name?: string; readonly type_: SType }>
    readonly return_: ReadonlyArray<SType>
  }>
  readonly structs: Record<string, {
    readonly index: number
    readonly doc?: string | null
    readonly abilities: ReadonlyArray<SAbility>
    readonly type_parameters: ReadonlyArray<STypeParameter>
    readonly fields: SFields
  }>
  readonly enums: Record<string, {
    readonly index: number
    readonly doc?: string | null
    readonly abilities: ReadonlyArray<SAbility>
    readonly type_parameters: ReadonlyArray<STypeParameter>
    readonly variants: Record<string, { readonly index: number; readonly doc?: string | null; readonly fields: SFields }>
  }>
}

interface SRootMetadata {
  readonly root_package_id?: string
  readonly root_package_original_id?: string
  readonly type_origins?: Record<string, ReadonlyArray<{ module_name: string; datatype_name: string; package: string }>>
}

// -----------------------------------------------------------------------------
// Conversion
// -----------------------------------------------------------------------------

const ABILITIES: Record<SAbility, M.Ability> = { Copy: "copy", Drop: "drop", Store: "store", Key: "key" }
const VISIBILITY = { Public: "public", Friend: "package", Package: "package", Private: "private" } as const

export const doc = (s: string | null | undefined): string | undefined => {
  if (s == null) return undefined
  const text = s.split("\n").map((l) => l.replace(/^ /, "").trimEnd()).join("\n").trim()
  return text === "" ? undefined : text
}

const typeParameters = (ps: ReadonlyArray<STypeParameter>): Array<M.TypeParameter> =>
  ps.map((p) => ({ name: p.name, phantom: p.phantom ?? false, constraints: p.constraints.map((c) => ABILITIES[c]) }))

const convertType = (
  t: SType,
  resolve: (label: string) => string,
  params: ReadonlyArray<STypeParameter>
): M.Type => {
  if (typeof t === "string") {
    return t === "_" ? { _tag: "Unsupported", description: "macro placeholder" } : M.primitive(t)
  }
  if ("Datatype" in t) {
    return {
      _tag: "Datatype",
      address: resolve(t.Datatype.module.address),
      module: t.Datatype.module.name,
      name: t.Datatype.name,
      typeArguments: t.Datatype.type_arguments.map((a) => convertType(a.argument, resolve, params))
    }
  }
  if ("vector" in t) return { _tag: "Vector", item: convertType(t.vector, resolve, params) }
  if ("Reference" in t) return { _tag: "Reference", mutable: t.Reference[0], type: convertType(t.Reference[1], resolve, params) }
  if ("TypeParameter" in t) return { _tag: "TypeParameter", index: t.TypeParameter }
  if ("NamedTypeParameter" in t) {
    const index = params.findIndex((p) => p.name === t.NamedTypeParameter)
    if (index < 0) return { _tag: "Unsupported", description: `unknown type parameter ${t.NamedTypeParameter}` }
    return { _tag: "TypeParameter", index }
  }
  return { _tag: "Unsupported", description: "tuple" in t ? "tuple" : "function" }
}

const convertFields = (f: SFields, resolve: (label: string) => string, params: ReadonlyArray<STypeParameter>): M.Fields => {
  const entries = Object.entries(f.fields).sort(([, a], [, b]) => a.index - b.index)
  return {
    positional: f.positional_fields || (entries.length > 0 && entries.every(([n], i) => n === `pos${i}`)),
    fields: entries.map(([name, field]) => ({ name, type: convertType(field.type_, resolve, params), doc: doc(field.doc) }))
  }
}

export const convertModule = (
  s: SModule,
  resolve: (label: string) => string,
  origins: Record<string, string> | undefined,
  defaultOrigin: string
): M.Module => {
  const datatypes: Array<M.Datatype> = [
    ...Object.entries(s.structs).map(([name, d]): M.Datatype => ({
      name,
      abilities: d.abilities.map((a) => ABILITIES[a]),
      typeParameters: typeParameters(d.type_parameters),
      origin: origins?.[name] ?? defaultOrigin,
      doc: doc(d.doc),
      kind: { _tag: "Struct", ...convertFields(d.fields, resolve, d.type_parameters) }
    })),
    ...Object.entries(s.enums).map(([name, d]): M.Datatype => ({
      name,
      abilities: d.abilities.map((a) => ABILITIES[a]),
      typeParameters: typeParameters(d.type_parameters),
      origin: origins?.[name] ?? defaultOrigin,
      doc: doc(d.doc),
      kind: {
        _tag: "Enum",
        variants: Object.entries(d.variants)
          .sort(([, a], [, b]) => a.index - b.index)
          .map(([vname, v]) => ({ name: vname, ...convertFields(v.fields, resolve, d.type_parameters) }))
      }
    }))
  ]
  const functions = Object.entries(s.functions)
    .filter(([, f]) => !f.macro_)
    .map(([name, f]): M.MoveFunction => ({
      name,
      visibility: VISIBILITY[f.visibility],
      entry: f.entry,
      typeParameters: typeParameters(f.type_parameters),
      parameters: f.parameters.map((p) => ({ name: p.name, type: convertType(p.type_, resolve, f.type_parameters) })),
      returns: f.return_.map((r) => convertType(r, resolve, f.type_parameters)),
      doc: doc(f.doc)
    }))
  return { name: s.id.name, doc: doc(s.doc), datatypes, functions }
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

export interface SummaryOptions {
  /** The summary directory's package to treat as the root (default: `Move.toml`'s name, or the on-chain root). */
  readonly package?: string | undefined
  /** Directory name for the root package (default: its label). */
  readonly name?: string | undefined
  /** The id calls go to (default: the root's published address, else `originalId`). */
  readonly packageId?: string | undefined
  /**
   * The root's original (first published) id, for a root the summaries list
   * as unpublished (`0x0`): types refer to the package by it and, unless
   * `typeOrigins` says otherwise, its datatypes' type strings use it.
   * Default: `packageId`, which is right until the package is upgraded.
   */
  readonly originalId?: string | undefined
  /**
   * Defining ids of the root's datatypes, `{ "module::Type": id }`, for types
   * added by an upgrade (local summaries carry no type origins). Others use
   * `originalId`.
   */
  readonly typeOrigins?: Readonly<Record<string, string>> | undefined
}

const tryPromise = <A>(f: () => Promise<A>, message: string) =>
  Effect.tryPromise({ try: f, catch: (e) => new M.CodegenError({ message: `${message}: ${String(e)}` }) })

const trySync = <A>(f: () => A, message: string) =>
  Effect.try({
    try: f,
    catch: (e) => e instanceof M.CodegenError ? e : new M.CodegenError({ message: `${message}: ${e instanceof Error ? e.message : String(e)}` })
  })

const readJson = <A>(path: string) => tryPromise(async () => JSON.parse(await readFile(path, "utf-8")) as A, `reading ${path}`)

/** The `[package] name` of a `Move.toml`, without a TOML parser. */
const moveTomlName = (toml: string): string | undefined => {
  const section = /^\s*\[package\]([\s\S]*?)(^\s*\[|$(?![\s\S]))/m.exec(toml)
  const m = section && /^\s*name\s*=\s*"([^"]+)"/m.exec(section[1]!)
  return m?.[1]
}

const isHexAddress = (s: string) => /^0x[0-9a-f]{1,64}$/i.test(s)

/**
 * Load a summary directory: either a Move package (`<path>/package_summaries`)
 * or the summary directory itself. Directories that are neither named in
 * `address_mapping.json` nor an address (a stray `.cache`) are ignored.
 *
 * A package the summaries list at `0x0` (unpublished) is identified by its
 * label (`M.unpublished`), so several can be loaded side by side, and renders
 * as `0x0`, except a root given `originalId` / `packageId`.
 */
export const load = (path: string, options: SummaryOptions = {}): Effect.Effect<M.Model, M.CodegenError> =>
  Effect.gen(function*() {
    const dir = existsSync(join(path, "package_summaries")) ? join(path, "package_summaries") : path
    if (!existsSync(join(dir, "address_mapping.json"))) {
      return yield* new M.CodegenError({ message: `no package summaries in ${path} (run \`sui move summary\`)` })
    }
    const mapping = yield* readJson<Record<string, string>>(join(dir, "address_mapping.json"))
    const metadata: SRootMetadata = existsSync(join(dir, "root_package_metadata.json"))
      ? yield* readJson<SRootMetadata>(join(dir, "root_package_metadata.json"))
      : {}
    const entries = yield* tryPromise(() => readdir(dir), `reading ${dir}`)
    const labels: Array<string> = []
    for (const e of entries.sort()) {
      if (mapping[e] === undefined && !isHexAddress(e)) continue
      if ((yield* tryPromise(() => stat(join(dir, e)), `reading ${dir}`)).isDirectory()) labels.push(e)
    }

    const published = (label: string) => M.normalizeAddress(mapping[label] ?? label)
    let rootLabel = options.package
    if (rootLabel === undefined && metadata.root_package_id !== undefined) {
      const id = yield* trySync(() => M.normalizeAddress(metadata.root_package_original_id ?? metadata.root_package_id!), "root_package_metadata.json")
      rootLabel = yield* trySync(() => labels.find((l) => published(l) === id), "address_mapping.json")
    }
    if (rootLabel === undefined && existsSync(join(path, "Move.toml"))) {
      const name = moveTomlName(yield* tryPromise(() => readFile(join(path, "Move.toml"), "utf-8"), "reading Move.toml"))
      rootLabel = labels.find((l) => l === name) ?? labels.find((l) => l.toLowerCase() === name?.toLowerCase())
    }
    if (rootLabel === undefined || !labels.includes(rootLabel)) {
      return yield* new M.CodegenError({
        message: `cannot tell which package in ${dir} is the root (found ${labels.join(", ")}); set \`package\``
      })
    }
    const root = rootLabel

    const sources = new Map<string, ReadonlyArray<readonly [string, SModule]>>()
    for (const label of labels) {
      const files = (yield* tryPromise(() => readdir(join(dir, label)), `reading ${label}`)).filter((f) => f.endsWith(".json")).sort()
      const modules: Array<readonly [string, SModule]> = []
      for (const f of files) modules.push([basename(f, ".json"), yield* readJson<SModule>(join(dir, label, f))])
      sources.set(label, modules)
    }

    return yield* trySync((): M.Model => {
      const rootPublished = published(root)
      const given = options.originalId ?? options.packageId
      if (options.originalId !== undefined && rootPublished !== M.ZERO && M.normalizeAddress(options.originalId) !== rootPublished) {
        throw new M.CodegenError({
          message: `originalId ${options.originalId} contradicts the summaries, which publish ${root} at ${rootPublished}`
        })
      }
      const rootOverride = rootPublished === M.ZERO && given !== undefined ? M.normalizeAddress(given) : undefined
      /** The identity a label is referred to by in the model. */
      const identity = (label: string) => {
        if (label === root && rootOverride !== undefined) return rootOverride
        const a = published(label)
        return a === M.ZERO && !isHexAddress(label) ? M.unpublished(label) : a
      }

      const seen = new Map<string, string>()
      const packages: Array<M.Package> = []
      for (const label of labels) {
        const address = identity(label)
        const clash = seen.get(address)
        if (clash !== undefined) throw new M.CodegenError({ message: `packages ${clash} and ${label} both resolve to ${address}` })
        seen.set(address, label)
        const isRoot = label === root
        const byModule = new Map<string, Record<string, string>>()
        const origin = (module: string, datatype: string, id: string) => {
          const m = byModule.get(module) ?? {}
          m[datatype] = M.normalizeAddress(id)
          byModule.set(module, m)
        }
        for (const o of metadata.type_origins?.[label] ?? []) origin(o.module_name, o.datatype_name, o.package)
        if (isRoot) {
          for (const [key, id] of Object.entries(options.typeOrigins ?? {})) {
            const [module, datatype] = key.split("::")
            if (module === undefined || datatype === undefined) throw new M.CodegenError({ message: `typeOrigins key ${key} is not module::Type` })
            origin(module, datatype, id)
          }
        }
        const rendered = M.renderedAddress(address)
        const modules = sources.get(label)!.map(([name, s]) => convertModule(s, identity, byModule.get(name), rendered))
        packages.push({
          address,
          storageId: isRoot && options.packageId !== undefined
            ? M.normalizeAddress(options.packageId)
            : isRoot && metadata.root_package_id !== undefined
            ? M.normalizeAddress(metadata.root_package_id)
            : rendered,
          name: isRoot && options.name !== undefined ? options.name : isHexAddress(label) ? M.shortAddress(address) : label,
          modules
        })
      }
      return { root: identity(root), packages }
    }, `loading ${dir}`)
  })
