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
  /** The id calls go to (default: the root's published address). */
  readonly packageId?: string | undefined
}

const tryPromise = <A>(f: () => Promise<A>, message: string) =>
  Effect.tryPromise({ try: f, catch: (e) => new M.CodegenError({ message: `${message}: ${String(e)}` }) })

const readJson = <A>(path: string) => tryPromise(async () => JSON.parse(await readFile(path, "utf-8")) as A, `reading ${path}`)

/** The `[package] name` of a `Move.toml`, without a TOML parser. */
const moveTomlName = (toml: string): string | undefined => {
  const section = /^\s*\[package\]([\s\S]*?)(^\s*\[|$(?![\s\S]))/m.exec(toml)
  const m = section && /^\s*name\s*=\s*"([^"]+)"/m.exec(section[1]!)
  return m?.[1]
}

/**
 * Load a summary directory: either a Move package (`<path>/package_summaries`)
 * or the summary directory itself.
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
    for (const e of entries) {
      if ((yield* tryPromise(() => stat(join(dir, e)), `reading ${dir}`)).isDirectory()) labels.push(e)
    }

    const resolve = (label: string) => M.normalizeAddress(mapping[label] ?? label)
    let rootLabel = options.package
    if (rootLabel === undefined && metadata.root_package_id !== undefined) {
      const id = M.normalizeAddress(metadata.root_package_original_id ?? metadata.root_package_id)
      rootLabel = labels.find((l) => resolve(l) === id)
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

    const seen = new Map<string, string>()
    const packages: Array<M.Package> = []
    for (const label of labels.sort()) {
      const address = resolve(label)
      const clash = seen.get(address)
      if (clash !== undefined) {
        return yield* new M.CodegenError({ message: `packages ${clash} and ${label} both resolve to ${address}` })
      }
      seen.set(address, label)
      const origins = metadata.type_origins?.[label]
      const byModule = new Map<string, Record<string, string>>()
      for (const o of origins ?? []) {
        const m = byModule.get(o.module_name) ?? {}
        m[o.datatype_name] = M.normalizeAddress(o.package)
        byModule.set(o.module_name, m)
      }
      const files = (yield* tryPromise(() => readdir(join(dir, label)), `reading ${label}`)).filter((f) => f.endsWith(".json")).sort()
      const modules: Array<M.Module> = []
      for (const f of files) {
        const s = yield* readJson<SModule>(join(dir, label, f))
        modules.push(convertModule(s, resolve, byModule.get(basename(f, ".json")), address))
      }
      const isRoot = label === rootLabel
      packages.push({
        address,
        storageId: isRoot && options.packageId !== undefined
          ? M.normalizeAddress(options.packageId)
          : isRoot && metadata.root_package_id !== undefined
          ? M.normalizeAddress(metadata.root_package_id)
          : address,
        name: isRoot && options.name !== undefined ? options.name : /^0x[0-9a-f]+$/i.test(label) ? M.shortAddress(address) : label,
        modules
      })
    }
    return { root: resolve(rootLabel), packages }
  })
