/**
 * `Model` -> TypeScript files. Pure: no I/O.
 *
 * Output layout:
 *   <package>/$package.ts   `Package` (the id calls go to) and `Origins` (the
 *                           ids type strings use), as `Context.Reference`s
 *   <package>/<module>.ts   schemas, type strings and call builders (`calls`)
 *   deps/<name>/<module>.ts dependency types, pruned to what's reachable
 *   deps/<name>/$package.ts their `Origins` (framework packages have none)
 *
 * Generated files import only `effect`, `@unconfirmed/bcs` and
 * `@unconfirmed/sui` (as namespaces from subpaths) and each other.
 */
import { posix } from "node:path"
import * as M from "./Model.ts"

export interface Root {
  /** The package's `address` in the model. */
  readonly address: string
  /** Modules to generate functions for (default: all). Other modules still get the types others reach. */
  readonly modules?: ReadonlyArray<string> | undefined
}

export interface RenderOptions {
  /** Extension used in relative imports between generated files (default `.ts`). */
  readonly importExtension?: ".ts" | ".js" | "" | undefined
  /** Only generate dependency types reachable from the roots' types (default `true`). */
  readonly prune?: boolean | undefined
  /** Emit Move doc comments (default `true`). */
  readonly docs?: boolean | undefined
}

export interface File {
  readonly path: string
  readonly contents: string
}

// -----------------------------------------------------------------------------
// Well-known types
// -----------------------------------------------------------------------------

const A1 = M.normalizeAddress("0x1")
const A2 = M.normalizeAddress("0x2")
const A3 = M.normalizeAddress("0x3")

interface Builtin {
  /** Schema expression; `args` are the rendered schemas of the non-phantom type arguments. */
  readonly render: (args: ReadonlyArray<string>) => string
  /** Which type arguments shape the layout. */
  readonly args: ReadonlyArray<number>
}

const constant = (expr: string): Builtin => ({ render: () => expr, args: [] })
const BUILTINS: Record<string, Builtin> = {
  [`${A1}::string::String`]: constant("Bcs.string"),
  [`${A1}::ascii::String`]: constant("Bcs.string"),
  [`${A1}::option::Option`]: { render: ([t]) => `Bcs.option(${t})`, args: [0] },
  [`${A1}::type_name::TypeName`]: constant("Move.TypeName"),
  [`${A2}::object::UID`]: constant("Move.UID"),
  [`${A2}::object::ID`]: constant("Move.ID"),
  [`${A2}::url::Url`]: constant("Move.Url"),
  [`${A2}::balance::Balance`]: constant("Move.Balance"),
  [`${A2}::coin::Coin`]: constant("Move.Coin"),
  [`${A2}::table::Table`]: constant("Move.Table"),
  [`${A2}::bag::Bag`]: constant("Move.Bag"),
  [`${A2}::object_table::ObjectTable`]: constant("Move.ObjectTable"),
  [`${A2}::object_bag::ObjectBag`]: constant("Move.ObjectBag"),
  [`${A2}::table_vec::TableVec`]: constant("Move.TableVec"),
  [`${A2}::vec_map::VecMap`]: { render: ([k, v]) => `Move.VecMap(${k}, ${v})`, args: [0, 1] },
  [`${A2}::vec_set::VecSet`]: { render: ([k]) => `Move.VecSet(${k})`, args: [0] },
  [`${A2}::linked_table::LinkedTable`]: { render: ([k]) => `Move.LinkedTable(${k})`, args: [0] },
  [`${A2}::borrow::Referent`]: { render: ([t]) => `Move.Referent(${t})`, args: [0] },
  [`${A2}::dynamic_field::Field`]: { render: ([n, v]) => `Move.Field(${n}, ${v})`, args: [0, 1] }
}

const TX_CONTEXT = `${A2}::tx_context::TxContext`
const RECEIVING = `${A2}::transfer::Receiving`

/** System objects filled in automatically, as `@mysten/sui`'s generated code does. */
const AUTO: Record<string, { readonly name: string; readonly render: (input: string, mutable: boolean) => string; readonly doc: string }> = {
  [`${A2}::clock::Clock`]: { name: "clock", render: (i) => `Move.clock(${i})`, doc: "the shared `Clock` (`0x6`)" },
  [`${A2}::random::Random`]: { name: "random", render: (i) => `Move.random(${i})`, doc: "the shared `Random` (`0x8`)" },
  [`${A2}::deny_list::DenyList`]: { name: "denyList", render: (i) => `Move.denyList(${i})`, doc: "the shared `DenyList` (`0x403`)" },
  [`${A2}::accumulator::AccumulatorRoot`]: {
    name: "accumulatorRoot",
    render: (i) => `Move.accumulatorRoot(${i})`,
    doc: "the shared `AccumulatorRoot` (`0xacc`)"
  },
  [`${A3}::sui_system::SuiSystemState`]: {
    name: "system",
    render: (i, mutable) => `Move.system(${mutable}${i === "" ? "" : `, ${i}`})`,
    doc: "the shared `SuiSystemState` (`0x5`)"
  }
}

const RESERVED = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for function if " +
    "import in instanceof new null return super switch this throw true try typeof var void while with yield let static " +
    "implements interface package private protected public await arguments eval undefined NaN Infinity").split(" ")
)

/** Names generated modules bind at top level. */
const FIXED = new Set(["Bcs", "Move", "Schema", "Option", "Package", "Origins", "calls"])

export const camelCase = (s: string) => s.replace(/(?<=[A-Za-z0-9])_+([a-z0-9])/g, (_, c: string) => c.toUpperCase())

// -----------------------------------------------------------------------------
// Index
// -----------------------------------------------------------------------------

interface Located {
  readonly pkg: M.Package
  readonly module: M.Module
  readonly datatype: M.Datatype
}

class Index {
  readonly datatypes = new Map<string, Located>()
  readonly packages = new Map<string, M.Package>()
  constructor(packages: ReadonlyArray<M.Package>) {
    for (const pkg of packages) {
      if (this.packages.has(pkg.address)) continue
      this.packages.set(pkg.address, pkg)
      for (const module of pkg.modules) {
        for (const datatype of module.datatypes) {
          this.datatypes.set(M.datatypeKey(pkg.address, module.name, datatype.name), { pkg, module, datatype })
        }
      }
    }
  }
  get(t: { address: string; module: string; name: string }): Located {
    const found = this.datatypes.get(M.datatypeKey(t.address, t.module, t.name))
    if (found === undefined) throw new M.CodegenError({ message: `unknown type ${M.datatypeKey(t.address, t.module, t.name)}` })
    return found
  }
  abilities(t: { address: string; module: string; name: string }): ReadonlyArray<M.Ability> {
    return this.datatypes.get(M.datatypeKey(t.address, t.module, t.name))?.datatype.abilities ?? []
  }
}

// -----------------------------------------------------------------------------
// Files
// -----------------------------------------------------------------------------

interface ModuleFile {
  readonly pkg: M.Package
  readonly module: M.Module
  readonly path: string
  readonly datatypes: ReadonlyArray<M.Datatype>
  readonly functions: ReadonlyArray<M.MoveFunction>
}

const isGenerated = (f: M.MoveFunction) => f.visibility === "public" || f.entry

/** Why a function can't be called from a transaction builder, if it can't. */
const unsupportedReason = (f: M.MoveFunction): string | undefined => {
  for (const p of f.parameters) {
    const t = M.deref(p.type)
    if (t._tag === "Primitive" && t.name === "signer") return "a `signer` parameter can't be passed in a transaction"
    if (t._tag === "Unsupported") return `a parameter of unsupported type (${t.description})`
  }
  return undefined
}

/** Datatypes a type refers to (through builtins too), for pruning. */
const collect = (t: M.Type, out: Array<M.Type & { _tag: "Datatype" }>): void => {
  switch (t._tag) {
    case "Vector":
      return collect(t.item, out)
    case "Reference":
      return collect(t.type, out)
    case "Datatype":
      out.push(t)
      return t.typeArguments.forEach((a) => collect(a, out))
    default:
      return
  }
}

/** Datatypes that shape a type's layout: phantom type arguments don't. */
const layoutRefs = (t: M.Type, index: Index, f: (key: string) => void): void => {
  switch (t._tag) {
    case "Vector":
      return layoutRefs(t.item, index, f)
    case "Datatype": {
      const key = M.datatypeKey(t.address, t.module, t.name)
      f(key)
      const builtin = BUILTINS[key]
      const phantom = (i: number) => builtin !== undefined ? !builtin.args.includes(i) : index.get(t).datatype.typeParameters[i]?.phantom
      return t.typeArguments.forEach((a, i) => phantom(i) ? undefined : layoutRefs(a, index, f))
    }
    default:
      return
  }
}

const fieldsOf = (d: M.Datatype): ReadonlyArray<M.Field> =>
  d.kind._tag === "Struct" ? d.kind.fields : d.kind.variants.flatMap((v) => v.fields)

/** Render a set of packages. Every package a root's types or signatures refer to must be in `packages`. */
export const render = (
  packages: ReadonlyArray<M.Package>,
  roots: ReadonlyArray<Root>,
  options: RenderOptions = {}
): ReadonlyArray<File> => {
  const index = new Index(packages)
  const rootSet = new Map(roots.map((r) => [r.address, r]))
  const ext = options.importExtension ?? ".ts"

  // Which datatypes to generate.
  const included = new Set<string>()
  const queue: Array<string> = []
  const include = (key: string, direct = false) => {
    if (!index.datatypes.has(key)) throw new M.CodegenError({ message: `unknown type ${key}` })
    // A built-in is referenced as `Move.X`; it's only generated as part of a module you asked for.
    if (BUILTINS[key] !== undefined && !direct) return
    if (included.has(key)) return
    included.add(key)
    queue.push(key)
  }
  for (const root of roots) {
    const pkg = index.packages.get(root.address)
    if (pkg === undefined) throw new M.CodegenError({ message: `root package ${root.address} is not loaded` })
    for (const name of root.modules ?? []) {
      if (!pkg.modules.some((m) => m.name === name)) {
        throw new M.CodegenError({ message: `module ${name} not found in ${pkg.name}` })
      }
    }
    for (const module of pkg.modules) {
      if (root.modules !== undefined && !root.modules.includes(module.name)) continue
      for (const d of module.datatypes) include(M.datatypeKey(pkg.address, module.name, d.name), true)
    }
  }
  if (options.prune === false) {
    for (const key of index.datatypes.keys()) include(key, true)
  }
  while (queue.length > 0) {
    const { datatype } = index.datatypes.get(queue.pop()!)!
    for (const f of fieldsOf(datatype)) layoutRefs(f.type, index, include)
  }

  // Group into files.
  const files: Array<ModuleFile> = []
  const pathOf = new Map<string, string>() // `${address}::${module}` -> path
  const sorted = [...index.packages.values()].sort((a, b) => a.address.localeCompare(b.address))
  const dirOf = depDirs(sorted.filter((p) => !rootSet.has(p.address)))
  for (const pkg of sorted) {
    const root = rootSet.get(pkg.address)
    for (const module of [...pkg.modules].sort((a, b) => a.name.localeCompare(b.name))) {
      const datatypes = module.datatypes.filter((d) => included.has(M.datatypeKey(pkg.address, module.name, d.name)))
      const selected = root !== undefined && (root.modules === undefined || root.modules.includes(module.name))
      const functions = selected ? module.functions.filter(isGenerated) : []
      if (datatypes.length === 0 && functions.length === 0) continue
      const dir = root !== undefined ? pkg.name : `deps/${dirOf.get(pkg.address)!}`
      const path = `${dir}/${module.name}.ts`
      pathOf.set(`${pkg.address}::${module.name}`, path)
      files.push({ pkg, module, path, datatypes, functions })
    }
  }

  const out: Array<File> = []
  const rootNames = new Map<string, string>()
  for (const root of roots) {
    const pkg = index.packages.get(root.address)!
    if (!/^[\w$.-]+$/.test(pkg.name) || pkg.name === "." || pkg.name === ".." || pkg.name === "deps") {
      throw new M.CodegenError({ message: `${JSON.stringify(pkg.name)} can't be an output directory name; set \`name\`` })
    }
    const clash = rootNames.get(pkg.name)
    if (clash !== undefined && clash !== pkg.address) {
      throw new M.CodegenError({ message: `packages ${clash} and ${pkg.address} would both be written to ${pkg.name}/; set \`name\`` })
    }
    rootNames.set(pkg.name, pkg.address)
  }
  // `$package.ts`: the `Package` reference (packages with calls) and the
  // `Origins` reference (packages whose types are generated, framework aside).
  for (const pkg of sorted) {
    const own = files.filter((f) => f.pkg === pkg)
    if (own.length === 0) continue
    const calls = own.some((f) => f.functions.length > 0)
    const datatypes = own.flatMap((f) => f.datatypes.map((d) => ({ module: f.module.name, d })))
    const origins = !M.isSystem(pkg.address) && datatypes.length > 0
    if (!calls && !origins) continue
    const dir = own[0]!.path.slice(0, own[0]!.path.lastIndexOf("/"))
    out.push({ path: `${dir}/$package.ts`, contents: renderPackageFile(pkg, calls, origins ? datatypes : undefined) })
  }
  for (const file of files) {
    out.push({ path: file.path, contents: new ModuleRenderer(file, index, pathOf, ext, options.docs ?? true).render() })
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.path === out[i - 1]!.path) throw new M.CodegenError({ message: `two generated files at ${out[i]!.path}` })
  }
  return out
}

/** The first line of every generated file; `Generate.write` only replaces files that start with it. */
export const HEADER = "// Generated by @unconfirmed/sui-codegen. Do not edit.\n"

/**
 * Dependency directories under `deps/`, by package name (stable across
 * networks, unlike addresses); two packages of one name are told apart by
 * address.
 */
const depDirs = (packages: ReadonlyArray<M.Package>): ReadonlyMap<string, string> => {
  const count = new Map<string, number>()
  for (const p of packages) count.set(p.name, (count.get(p.name) ?? 0) + 1)
  return new Map(packages.map((p) => [p.address, count.get(p.name)! > 1 ? `${p.name}-${M.shortAddress(p.address)}` : p.name]))
}

const renderPackageFile = (
  pkg: M.Package,
  calls: boolean,
  datatypes: ReadonlyArray<{ readonly module: string; readonly d: M.Datatype }> | undefined
) => {
  const key = `@unconfirmed/sui-codegen/${pkg.name}/${M.renderedAddress(pkg.address)}`
  const head = [`import * as Context from "effect/Context"`]
  const body: Array<string> = []
  if (calls) {
    body.push(`/**
 * The id that calls to \`${pkg.name}\` go to. Defaults to the id these bindings were
 * generated from; point them at another deployment with
 * \`Layer.succeed(Package, id)\` or \`Effect.provideService(Package, id)\`.
 */
export const Package = /* @__PURE__ */ Context.Reference<string>(${JSON.stringify(key)}, {
  defaultValue: () => ${JSON.stringify(pkg.storageId)}
})
`)
  }
  if (datatypes !== undefined) {
    head.push(`import type * as Move from "@unconfirmed/sui/Move"`)
    const originalId = M.renderedAddress(pkg.address)
    const upgraded = datatypes.filter((x) => x.d.origin !== originalId)
      .map((x) => `      ${JSON.stringify(`${x.module}::${x.d.name}`)}: ${JSON.stringify(x.d.origin)}`)
      .sort()
    const value = upgraded.length === 0
      ? `{ originalId: ${JSON.stringify(originalId)} }`
      : `({\n    originalId: ${JSON.stringify(originalId)},\n    typeOrigins: {\n${upgraded.join(",\n")}\n    }\n  })`
    body.push(`/**
 * Where \`${pkg.name}\`'s types are defined: type strings (\`Thing.type()\`) and the
 * type check of \`Thing.get\` use it. Defaults to the ids these bindings were
 * generated from; for another deployment provide its original id (and the
 * defining ids of types its upgrades added), e.g.
 * \`Layer.succeed(Origins, { originalId })\`.
 */
export const Origins = /* @__PURE__ */ Context.Reference<Move.Origins>(${JSON.stringify(`${key}/origins`)}, {
  defaultValue: () => ${upgraded.length === 0 ? `(${value})` : value}
})
`)
  }
  return `${HEADER}${head.join("\n")}\n\n${body.join("\n")}`
}

// -----------------------------------------------------------------------------
// One module
// -----------------------------------------------------------------------------

const comment = (text: string | undefined, indent = "") => {
  if (text === undefined || text.trim() === "") return ""
  const lines = text.replaceAll("*/", "*\\/").split("\n")
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`
  return `${indent}/**\n${lines.map((l) => `${indent} *${l === "" ? "" : ` ${l}`}`).join("\n")}\n${indent} */\n`
}

type ParamKind =
  | { readonly _tag: "auto"; readonly name: string; readonly doc: string; readonly render: (input: string) => string }
  | { readonly _tag: "value"; readonly tsType: string; readonly render: (input: string) => string; readonly optional: boolean }

class ModuleRenderer {
  private readonly imports = new Map<string, string>() // path -> alias
  private readonly taken = new Set<string>(FIXED)
  private usesSchema = false
  private usesOption = false
  private usesBcs = false
  private usesMove = false
  /** `effect/Option` and `effect/Schema` (type-only), renamed if the module defines a type with that name. */
  private readonly optionAlias: string
  private readonly schemaAlias: string
  /** Functions that are generated (supported parameters), with their local and exported names. */
  private readonly functions: ReadonlyArray<{ readonly f: M.MoveFunction; readonly local: string; readonly exported: string }>
  /** Functions left out, with why. */
  private readonly skipped: ReadonlyArray<{ readonly f: M.MoveFunction; readonly reason: string }>
  /** Datatype name -> its local binding (`Move_` for a type named `Move`, exported as `Move`). */
  private readonly localType = new Map<string, string>()
  /** A datatype is exported as `Package`, so the module doesn't re-export the `Package` reference. */
  private readonly packageShadowed: boolean
  /** The module's type strings read the package's `Origins` reference (not a framework package). */
  private readonly usesOrigins: boolean
  /** Likewise for a datatype exported as `Origins`. */
  private readonly originsShadowed: boolean

  constructor(
    private readonly file: ModuleFile,
    private readonly index: Index,
    private readonly pathOf: ReadonlyMap<string, string>,
    private readonly ext: string,
    private readonly docs: boolean
  ) {
    const skipped: Array<{ readonly f: M.MoveFunction; readonly reason: string }> = []
    const supported = file.functions.filter((f) => {
      const reason = unsupportedReason(f)
      if (reason !== undefined) skipped.push({ f, reason })
      return reason === undefined
    })
    this.skipped = skipped
    this.usesOrigins = file.datatypes.length > 0 && !M.isSystem(file.pkg.address)
    // The runtime namespaces (`Bcs`, `Move`) and the imported `Package` and
    // `Origins` keep their names; a datatype named like one is bound as
    // `Move_` and exported under its own name.
    const shadows = (name: string) =>
      name === "Bcs" || name === "Move" || (name === "Package" && supported.length > 0) || (name === "Origins" && this.usesOrigins)
    for (const d of file.datatypes) if (!shadows(d.name)) this.taken.add(d.name)
    for (const d of file.datatypes) {
      let local = d.name
      if (shadows(d.name)) {
        local = `${d.name}_`
        while (this.taken.has(local) || file.datatypes.some((e) => e.name === local)) local = `${local}_`
      }
      this.localType.set(d.name, local)
      this.taken.add(local)
    }
    this.packageShadowed = supported.length > 0 && file.datatypes.some((d) => d.name === "Package")
    this.originsShadowed = this.usesOrigins && file.datatypes.some((d) => d.name === "Origins")
    this.optionAlias = file.datatypes.some((d) => d.name === "Option") ? "EffectOption" : "Option"
    this.schemaAlias = file.datatypes.some((d) => d.name === "Schema") ? "EffectSchema" : "Schema"
    this.taken.add(this.optionAlias).add(this.schemaAlias)

    // Exported names: functions already in camelCase claim theirs first; one
    // whose camelCase form is taken (`foo_bar` next to `fooBar`, or a type's
    // name) keeps its Move name, else gets a numeric suffix.
    const claimed = new Set<string>([...file.datatypes.map((d) => d.name), "Package", "Origins", "calls"])
    const byName = (a: M.MoveFunction, b: M.MoveFunction) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const order = [
      ...supported.filter((f) => camelCase(f.name) === f.name).sort(byName),
      ...supported.filter((f) => camelCase(f.name) !== f.name).sort(byName)
    ]
    const names = new Map<M.MoveFunction, { local: string; exported: string }>()
    for (const f of order) {
      const base = camelCase(f.name)
      let exported = !claimed.has(base) ? base : !claimed.has(f.name) ? f.name : ""
      for (let n = 2; exported === ""; n++) if (!claimed.has(`${base}${n}`)) exported = `${base}${n}`
      claimed.add(exported)
      let local = exported
      while (RESERVED.has(local) || this.taken.has(local)) local = `${local}_`
      this.taken.add(local)
      names.set(f, { local, exported })
    }
    this.functions = supported.map((f) => ({ f, ...names.get(f)! }))
  }

  private typeLocal(name: string) {
    return this.localType.get(name) ?? name
  }

  private doc(text: string | undefined, indent = "") {
    return this.docs ? comment(text, indent) : ""
  }

  // --- imports --------------------------------------------------------------

  private importModule(address: string, module: string): string {
    const target = this.pathOf.get(`${address}::${module}`)
    if (target === undefined) throw new M.CodegenError({ message: `no generated file for ${address}::${module}` })
    const existing = this.imports.get(target)
    if (existing !== undefined) return existing
    let alias = module
    for (let n = 1; this.taken.has(alias) || RESERVED.has(alias); n++) alias = `${module}_${n}`
    this.taken.add(alias)
    this.imports.set(target, alias)
    return alias
  }

  private relative(target: string) {
    let rel = posix.relative(posix.dirname(this.file.path), target)
    if (!rel.startsWith(".")) rel = `./${rel}`
    return rel.replace(/\.ts$/, this.ext)
  }

  // --- schemas --------------------------------------------------------------

  /** A datatype field's schema expression. `params` maps type parameter index -> schema name. */
  private schema(t: M.Type, params: ReadonlyArray<string | undefined>): string {
    switch (t._tag) {
      case "Primitive":
        if (t.name === "signer") throw new M.CodegenError({ message: "signer in a datatype" })
        this.usesBcs = true
        return t.name === "address" ? "Bcs.Address" : `Bcs.${t.name}`
      case "Vector":
        this.usesBcs = true
        return t.item._tag === "Primitive" && t.item.name === "u8" ? "Bcs.byteVector" : `Bcs.vector(${this.schema(t.item, params)})`
      case "TypeParameter": {
        const name = params[t.index]
        if (name === undefined) throw new M.CodegenError({ message: `phantom type parameter ${t.index} used in a layout` })
        return name
      }
      case "Datatype": {
        const key = M.datatypeKey(t.address, t.module, t.name)
        const builtin = BUILTINS[key]
        const here = t.address === this.file.pkg.address && t.module === this.file.module.name
        if (builtin !== undefined && !here) {
          const out = builtin.render(builtin.args.map((i) => this.schema(t.typeArguments[i]!, params)))
          if (out.startsWith("Bcs.")) this.usesBcs = true
          if (out.startsWith("Move.")) this.usesMove = true
          return out
        }
        const { datatype } = this.index.get(t)
        const args = datatype.typeParameters.flatMap((p, i) => (p.phantom ? [] : [this.schema(t.typeArguments[i]!, params)]))
        const ref = here ? this.typeLocal(t.name) : `${this.importModule(t.address, t.module)}.${t.name}`
        return args.length === 0 ? ref : `${ref}(${args.join(", ")})`
      }
      case "Reference":
      case "Unsupported":
        throw new M.CodegenError({ message: `unsupported field type in ${this.file.module.name}` })
    }
  }

  private fieldsSchema(fields: M.Fields, params: ReadonlyArray<string | undefined>, indent: string): string {
    this.usesBcs = true
    if (fields.positional) {
      return `Bcs.tuple([${fields.fields.map((f) => this.schema(f.type, params)).join(", ")}])`
    }
    if (fields.fields.length === 0) return "Bcs.struct({})"
    const inner = indent + "  "
    return `Bcs.struct({\n${
      fields.fields.map((f) => `${this.doc(f.doc, inner)}${inner}${safeKey(f.name)}: ${this.schema(f.type, params)}`).join(",\n")
    }\n${indent}})`
  }

  private typeParamNames(d: { readonly typeParameters: ReadonlyArray<M.TypeParameter> }) {
    const used = new Set<string>(["withGet"])
    return d.typeParameters.map((p, i) => {
      let name = p.name ?? `T${i}`
      while (this.taken.has(name) || RESERVED.has(name) || used.has(name)) name = `${name}_`
      used.add(name)
      return name
    })
  }

  private datatype(d: M.Datatype): string {
    const names = this.typeParamNames(d)
    const params = d.typeParameters.map((p, i) => (p.phantom ? undefined : names[i]!))
    const generics = names.filter((_, i) => !d.typeParameters[i]!.phantom)
    const defining = this.usesOrigins ? "Origins" : JSON.stringify(d.origin)
    const typeFn = `/* @__PURE__ */ Move.type${names.length === 0 ? "" : `<[${names.map((n) => `${n}: string`).join(", ")}]>`}(${defining}, ${
      JSON.stringify(`${this.file.module.name}::${d.name}`)
    })`
    const indent = "    "
    let body: string
    if (d.kind._tag === "Struct") {
      body = this.fieldsSchema(d.kind, params, indent)
    } else {
      const inner = indent + "  "
      body = `Bcs.enum({\n${
        d.kind.variants.map((v) => {
          const payload = v.fields.length === 0
            ? "null"
            : v.positional && v.fields.length === 1
            ? this.schema(v.fields[0]!.type, params)
            : this.fieldsSchema(v, params, inner)
          return `${inner}${safeKey(v.name)}: ${payload}`
        }).join(",\n")
      }\n${indent}})`
    }
    this.usesBcs = true
    this.usesMove = true
    const isKey = d.abilities.includes("key")
    const local = this.typeLocal(d.name)
    let out = this.doc(d.doc)
    if (generics.length === 0) {
      out += `export const ${local} = /* @__PURE__ */ Move.${isKey ? "object" : "datatype"}(\n  ${typeFn},\n  () =>\n    ${body}\n)\n`
      out += `export type ${local} = typeof ${local}.Type\n`
    } else {
      this.usesSchema = true
      const S = this.schemaAlias
      const sig = `<${generics.map((g) => `${g} extends ${S}.Top`).join(", ")}>(${generics.map((g) => `${g}: ${g}`).join(", ")})`
      out += isKey
        ? `export const ${local} = /* @__PURE__ */ Move.genericObject(\n  ${typeFn},\n  (withGet) => ${sig} =>\n    withGet(${body})\n)\n`
        : `export const ${local} = /* @__PURE__ */ Move.generic(\n  ${typeFn},\n  ${sig} =>\n    ${body}\n)\n`
      out += `export type ${local}<${generics.join(", ")}> = Move.TypeOf<typeof ${local}<${
        generics.map((g) => `${S}.Codec<${g}>`).join(", ")
      }>>\n`
    }
    if (local !== d.name) out += `export { ${local} as ${d.name} }\n`
    return out
  }

  /** Datatypes ordered so each comes after the same-module datatypes its fields use. */
  private ordered(): ReadonlyArray<M.Datatype> {
    const byName = new Map(this.file.datatypes.map((d) => [d.name, d]))
    const done = new Set<string>()
    const out: Array<M.Datatype> = []
    const visit = (d: M.Datatype) => {
      if (done.has(d.name)) return
      done.add(d.name)
      const refs: Array<M.Type & { _tag: "Datatype" }> = []
      for (const f of fieldsOf(d)) collect(f.type, refs)
      for (const r of refs) {
        if (r.address === this.file.pkg.address && r.module === this.file.module.name) {
          const dep = byName.get(r.name)
          if (dep !== undefined) visit(dep)
        }
      }
      out.push(d)
    }
    for (const d of [...this.file.datatypes].sort((a, b) => a.name.localeCompare(b.name))) visit(d)
    return out
  }

  // --- functions ------------------------------------------------------------

  private isPure(t: M.Type): boolean {
    switch (t._tag) {
      case "Primitive":
        return t.name !== "signer"
      case "Vector":
        return this.isPure(t.item)
      case "Reference":
        return this.isPure(t.type)
      case "Datatype": {
        const key = M.datatypeKey(t.address, t.module, t.name)
        if (key === `${A1}::string::String` || key === `${A1}::ascii::String` || key === `${A2}::object::ID`) return true
        if (key === `${A1}::option::Option`) return this.isPure(t.typeArguments[0]!)
        return false
      }
      default:
        return false
    }
  }

  /** The schema of a pure parameter (addresses are lenient: `"0x2"` works). */
  private pureSchema(t: M.Type): string {
    switch (t._tag) {
      case "Primitive":
        if (t.name === "address") {
          this.usesMove = true
          return "Move.address"
        }
        this.usesBcs = true
        return `Bcs.${t.name}`
      case "Vector":
        this.usesBcs = true
        return t.item._tag === "Primitive" && t.item.name === "u8" ? "Bcs.byteVector" : `Bcs.vector(${this.pureSchema(t.item)})`
      case "Reference":
        return this.pureSchema(t.type)
      case "Datatype": {
        const key = M.datatypeKey(t.address, t.module, t.name)
        if (key === `${A2}::object::ID`) {
          this.usesMove = true
          return "Move.address"
        }
        this.usesBcs = true
        if (key === `${A1}::option::Option`) return `Bcs.option(${this.pureSchema(t.typeArguments[0]!)})`
        return "Bcs.string"
      }
      default:
        throw new M.CodegenError({ message: "not a pure type" })
    }
  }

  /** The TS type of a pure value. */
  private pureType(t: M.Type): string {
    switch (t._tag) {
      case "Primitive":
        return t.name === "bool" ? "boolean" : t.name === "address" ? "string" : ["u8", "u16", "u32"].includes(t.name) ? "number" : "bigint"
      case "Vector":
        return t.item._tag === "Primitive" && t.item.name === "u8" ? "Uint8Array" : `ReadonlyArray<${this.pureType(t.item)}>`
      case "Reference":
        return this.pureType(t.type)
      case "Datatype":
        if (t.module === "option") {
          this.usesOption = true
          return `${this.optionAlias}.Option<${this.pureType(t.typeArguments[0]!)}>`
        }
        return "string"
      default:
        return "never"
    }
  }

  private paramKind(t: M.Type, f: M.MoveFunction): ParamKind | undefined {
    const inner = M.deref(t)
    if (inner._tag === "Datatype") {
      const key = M.datatypeKey(inner.address, inner.module, inner.name)
      if (key === TX_CONTEXT) return undefined
      const auto = AUTO[key]
      if (auto !== undefined) {
        const mutable = t._tag === "Reference" && t.mutable
        return { _tag: "auto", name: auto.name, doc: auto.doc, render: (input) => auto.render(input, mutable) }
      }
    }
    this.usesMove = true
    if (inner._tag === "Datatype" && M.datatypeKey(inner.address, inner.module, inner.name) === `${A1}::option::Option` && this.isPure(inner)) {
      const item = inner.typeArguments[0]!
      return {
        _tag: "value",
        tsType: `Move.OptionInput<${this.pureType(item)}>`,
        render: (input) => `Move.option(${this.pureSchema(item)}, ${input})`,
        optional: true
      }
    }
    if (this.isPure(t)) {
      return {
        _tag: "value",
        tsType: `Move.Input<${this.pureType(t)}>`,
        render: (input) => `Move.pure(${this.pureSchema(t)}, ${input})`,
        optional: false
      }
    }
    if (inner._tag === "TypeParameter") {
      return {
        _tag: "value",
        tsType: "Move.GenericInput",
        render: (input) => `Move.param(options.typeArguments[${inner.index}], ${input})`,
        optional: false
      }
    }
    if (inner._tag === "Datatype") {
      const key = M.datatypeKey(inner.address, inner.module, inner.name)
      if (key === RECEIVING || this.index.abilities(inner).includes("key")) {
        return { _tag: "value", tsType: "Move.ObjectInput", render: (input) => `Move.obj(${input})`, optional: false }
      }
    }
    if (inner._tag === "Unsupported" || (inner._tag === "Primitive" && inner.name === "signer")) {
      // Filtered out before rendering (`unsupportedReason`).
      throw new M.CodegenError({ message: `unsupported parameter type in ${this.file.module.name}::${f.name}` })
    }
    // A struct or enum value that is neither an object nor pure (`Data`,
    // `vector<Data>`, `Option<Data>`): Sui takes no such pure input, so it
    // comes from an earlier command.
    return { _tag: "value", tsType: "Move.Argument", render: (input) => `Move.arg(${input})`, optional: false }
  }

  /** `&mut Thing`, `vector<u64>`, `Option<String>`: for doc comments. */
  private moveType(t: M.Type, names: ReadonlyArray<string>): string {
    switch (t._tag) {
      case "Primitive":
        return t.name
      case "Vector":
        return `vector<${this.moveType(t.item, names)}>`
      case "Reference":
        return `&${t.mutable ? "mut " : ""}${this.moveType(t.type, names)}`
      case "TypeParameter":
        return names[t.index] ?? `T${t.index}`
      case "Datatype":
        return t.typeArguments.length === 0 ? t.name : `${t.name}<${t.typeArguments.map((a) => this.moveType(a, names)).join(", ")}>`
      case "Unsupported":
        return t.description
    }
  }

  private fn(f: M.MoveFunction, local: string, exported: string): string {
    const typeNames = this.typeParamNames(f)
    const kinds = f.parameters.map((p) => ({ param: p, kind: this.paramKind(p.type, f) }))
      .filter((x): x is { param: M.Parameter; kind: ParamKind } => x.kind !== undefined)
    const values = kinds.filter((k) => k.kind._tag === "value")
    const autos = kinds.filter((k) => k.kind._tag === "auto")
    const named = values.length === 0 || values.every((v, i) =>
      v.param.name !== undefined && v.param.name !== "_" &&
      values.findIndex((w) => w.param.name === v.param.name) === i
    )

    // Keys of the named form: the auto-filled objects keep their documented
    // names; a value whose camelCase key is taken (by one of them, or by an
    // earlier value: `foo_bar` and `fooBar`) keeps its Move name if that is
    // free, else gets a numeric suffix (`random2`).
    const keys = new Set<string>(autos.flatMap((a) => (a.kind._tag === "auto" ? [a.kind.name] : [])))
    const keyFor = (name: string) => {
      const base = camelCase(name)
      if (!keys.has(base)) return base
      if (!keys.has(name)) return name
      for (let n = 2;; n++) if (!keys.has(`${base}${n}`)) return `${base}${n}`
    }
    // Local names for destructured arguments.
    const used = new Set<string>(["options", "a", ...FIXED])
    const localOf = new Map<M.Parameter, string>()
    const keyOf = new Map<M.Parameter, string>()
    values.forEach((v, i) => {
      const key = named ? keyFor(v.param.name!) : `arg${i}`
      keys.add(key)
      let name = camelCase(key)
      while (used.has(name) || RESERVED.has(name)) name = `${name}_`
      used.add(name)
      localOf.set(v.param, name)
      keyOf.set(v.param, key)
    })

    const sigLine = `\`${this.file.module.name}::${f.name}${typeNames.length ? `<${typeNames.join(", ")}>` : ""}(${
      f.parameters.map((p) => `${p.name !== undefined ? `${p.name}: ` : ""}${this.moveType(p.type, typeNames)}`).join(", ")
    })${f.returns.length === 0 ? "" : `: ${f.returns.length === 1 ? this.moveType(f.returns[0]!, typeNames) : `(${f.returns.map((r) => this.moveType(r, typeNames)).join(", ")})`}`}\``
    const docText = [f.doc, sigLine].filter((x) => x !== undefined).join("\n\n")

    const tsOf = (k: ParamKind) => (k._tag === "value" ? k.tsType : "Move.ObjectInput")
    const tupleItems = values.map((v) => `${localOf.get(v.param)!}: ${tsOf(v.kind)}`)
    const namedFields = [
      ...values.map((v) =>
        `      readonly ${keyOf.get(v.param)}${v.kind._tag === "value" && v.kind.optional ? "?" : ""}: ${tsOf(v.kind)}`
      ),
      ...[...new Map(autos.flatMap((a) => (a.kind._tag === "auto" ? [[a.kind.name, a.kind.doc] as const] : [])))].map(
        ([name, doc]) => `      /** Default: ${doc}. */\n      readonly ${name}?: Move.ObjectInput`
      )
    ]

    const optionFields: Array<string> = []
    const argumentsRequired = values.length > 0
    if (values.length > 0 || (named && autos.length > 0)) {
      let type: string
      if (named) {
        const obj = `{\n${namedFields.join("\n")}\n    }`
        type = values.length > 0 ? `\n    | ${obj}\n    | readonly [${tupleItems.join(", ")}]` : ` ${obj}`
      } else {
        type = ` readonly [${tupleItems.join(", ")}]`
      }
      optionFields.push(`  readonly arguments${argumentsRequired ? "" : "?"}:${type}`)
    }
    if (typeNames.length > 0) {
      optionFields.push(`  readonly typeArguments: readonly [${typeNames.map((n) => `${n}: string`).join(", ")}]`)
    }
    const optionsRequired = argumentsRequired || typeNames.length > 0

    const lines: Array<string> = []
    if (values.length > 0 || autos.length > 0) {
      if (named && values.length > 0) {
        lines.push(`  const a = options.arguments`)
        lines.push(
          `  const [${values.map((v) => localOf.get(v.param)).join(", ")}] = Move.isTuple(a) ? a : [${
            values.map((v) => `a.${keyOf.get(v.param)}`).join(", ")
          }] as const`
        )
      } else if (values.length > 0) {
        lines.push(`  const [${values.map((v) => localOf.get(v.param)).join(", ")}] = options.arguments`)
      }
    }
    const autoInput = (name: string) =>
      !named ? "" : values.length > 0 ? `Move.isTuple(a) ? undefined : a.${name}` : `options.arguments?.${name}`
    const args = kinds.map((k) =>
      k.kind._tag === "auto" ? k.kind.render(autoInput(k.kind.name)) : k.kind.render(localOf.get(k.param)!)
    )
    const typeArgs = typeNames.length > 0 ? "options.typeArguments" : "[]"
    const callArgs = args.length === 0 ? "[]" : `[\n${args.map((a) => `    ${a}`).join(",\n")}\n  ]`
    lines.push(`  return Move.call(Package, ${JSON.stringify(`${this.file.module.name}::${f.name}`)}, ${typeArgs}, ${callArgs}, ${f.returns.length})`)

    const param = optionFields.length === 0
      ? "()"
      : `(options: {\n${optionFields.join("\n")}\n}${optionsRequired ? "" : " = {}"})`
    let out = this.doc(docText)
    out += `${local !== exported ? "const" : "export const"} ${local} = ${param} => {\n${lines.join("\n")}\n}\n`
    if (local !== exported) out += `export { ${local} as ${exported} }\n`
    return out
  }

  // --- file -----------------------------------------------------------------

  render(): string {
    const body: Array<string> = []
    for (const d of this.ordered()) body.push(this.datatype(d))
    const fns = [...this.functions].sort((a, b) => a.f.name.localeCompare(b.f.name))
    for (const { f, local, exported } of fns) body.push(this.fn(f, local, exported))
    for (const { f, reason } of [...this.skipped].sort((a, b) => a.f.name.localeCompare(b.f.name))) {
      body.push(`// \`${this.file.module.name}::${f.name}\` is not generated: ${reason}.\n`)
    }
    if (fns.length > 0) this.usesMove = true
    // The call builders by name, apart from the schemas (a datatype named `calls` wins).
    if (fns.length > 0 && !this.file.datatypes.some((d) => d.name === "calls")) {
      const byExported = [...fns].sort((a, b) => (a.exported < b.exported ? -1 : a.exported > b.exported ? 1 : 0))
      body.push(`/** The module's call builders, by name. */\nexport const calls = {\n${
        byExported.map(({ local, exported }) => `  ${local === exported ? local : `${safeKey(exported)}: ${local}`}`).join(",\n")
      }\n}\n`)
    }

    const head: Array<string> = []
    if (this.usesOption) head.push(`import type * as ${this.optionAlias} from "effect/Option"`)
    if (this.usesSchema) head.push(`import type * as ${this.schemaAlias} from "effect/Schema"`)
    if (this.usesBcs) head.push(`import * as Bcs from "@unconfirmed/bcs/Bcs"`)
    if (this.usesMove) head.push(`import * as Move from "@unconfirmed/sui/Move"`)
    const refs = [...(this.usesOrigins ? ["Origins"] : []), ...(fns.length > 0 ? ["Package"] : [])]
    if (refs.length > 0) {
      head.push(`import { ${refs.join(", ")} } from "${this.relative(`${posix.dirname(this.file.path)}/$package.ts`)}"`)
    }
    for (const [path, alias] of [...this.imports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      head.push(`import * as ${alias} from "${this.relative(path)}"`)
    }
    // A datatype exported as `Package` or `Origins` wins; the reference stays in `$package.ts`.
    const exported = refs.filter((r) => (r === "Package" ? !this.packageShadowed : !this.originsShadowed))
    if (exported.length > 0) head.push(`\nexport { ${exported.join(", ")} }`)

    const title = this.doc(
      [this.file.module.doc, `\`${M.shortAddress(this.file.pkg.address)}::${this.file.module.name}\``].filter((x) => x !== undefined).join("\n\n")
    )
    return `${HEADER}${title}${head.join("\n")}\n\n${body.join("\n")}`
  }
}

/** An object-literal key. `__proto__` (plain or quoted) would set the prototype, so it is computed. */
const safeKey = (name: string) =>
  name === "__proto__" ? `[${JSON.stringify(name)}]` : /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
