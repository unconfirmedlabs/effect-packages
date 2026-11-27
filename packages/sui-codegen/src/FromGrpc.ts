/**
 * An on-chain package over gRPC (`MovePackageService/GetPackage`) -> `Model`.
 *
 * Loads the package, then every package its types and signatures refer to,
 * following the root's `linkage` so a dependency is read at the version the
 * root was built against. Bytecode has no parameter names or doc comments, so
 * neither does the result.
 */
import * as Effect from "effect/Effect"
import type * as P from "@unconfirmed/sui/grpc/generated/proto"
import * as Rpc from "@unconfirmed/sui/grpc/generated/rpc"
import { GrpcWeb } from "@unconfirmed/sui/grpc/GrpcWeb"
import type { RpcError } from "@unconfirmed/sui/RpcError"
import * as M from "./Model.ts"

const PRIMITIVES: Record<number, M.Primitive> = {
  1: "address",
  2: "bool",
  3: "u8",
  4: "u16",
  5: "u32",
  6: "u64",
  7: "u128",
  8: "u256"
}
const ABILITIES: Record<number, M.Ability> = { 1: "copy", 2: "drop", 3: "store", 4: "key" }
const VISIBILITY: Record<number, M.Visibility> = { 1: "private", 2: "public", 3: "package" }

const splitTypeName = (typeName: string) => {
  const [address, module, name] = typeName.split("::") as [string, string, string]
  return { address: M.normalizeAddress(address), module, name }
}

const bodyAddresses = (b: P.OpenSignatureBody | undefined, out: Set<string>): void => {
  if (b === undefined) return
  if (b.type === 10 && b.type_name) out.add(splitTypeName(b.type_name).address)
  for (const i of b.type_parameter_instantiation ?? []) bodyAddresses(i, out)
}

/** Addresses a package refers to: through its datatypes' fields, and (for the root) its function signatures. */
const referenced = (p: P.Package, withFunctions: boolean): Set<string> => {
  const out = new Set<string>()
  for (const m of p.modules ?? []) {
    for (const d of m.datatypes ?? []) {
      for (const f of d.fields ?? []) bodyAddresses(f.type, out)
      for (const v of d.variants ?? []) for (const f of v.fields ?? []) bodyAddresses(f.type, out)
    }
    if (withFunctions) {
      for (const f of m.functions ?? []) {
        for (const s of [...(f.parameters ?? []), ...(f.returns ?? [])]) bodyAddresses(s.body, out)
      }
    }
  }
  return out
}

export interface GrpcOptions {
  /** Directory name for the package (default: its short address). */
  readonly name?: string | undefined
}

/** Load a package and what it depends on. `packageId` is the version calls go to. */
export const load = (
  packageId: string,
  options: GrpcOptions = {}
): Effect.Effect<M.Model, M.CodegenError | RpcError, GrpcWeb> =>
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const fetch = (id: string) =>
      Effect.flatMap(grpc.unary(Rpc.MovePackageService_GetPackage, { package_id: id }), (r) =>
        r.package === undefined
          ? Effect.fail(new M.CodegenError({ message: `package ${id} not found` }))
          : Effect.succeed(r.package))

    const root = yield* fetch(M.normalizeAddress(packageId))
    const linkage = new Map((root.linkage ?? []).map((l) => [M.normalizeAddress(l.original_id!), M.normalizeAddress(l.upgraded_id!)]))
    const loaded = new Map<string, P.Package>() // by original id
    const aliases = new Map<string, string>() // any id of a package -> its original id
    const register = (p: P.Package) => {
      const original = M.normalizeAddress(p.original_id ?? p.storage_id!)
      loaded.set(original, p)
      for (const id of [p.storage_id, p.original_id, ...(p.type_origins ?? []).map((o) => o.package_id)]) {
        if (id) aliases.set(M.normalizeAddress(id), original)
      }
      for (const m of p.modules ?? []) for (const d of m.datatypes ?? []) if (d.defining_id) aliases.set(M.normalizeAddress(d.defining_id), original)
      return original
    }
    const rootAddress = register(root)

    let queue = [...referenced(root, true)]
    while (queue.length > 0) {
      const next: Array<string> = []
      // One level at a time, its packages fetched concurrently and registered in order.
      const level = [...new Set(queue.filter((address) => !aliases.has(address)))]
      const fetched = yield* Effect.forEach(level, (address) =>
        Effect.gen(function*() {
          const p = yield* fetch(linkage.get(address) ?? address)
          const original = M.normalizeAddress(p.original_id ?? p.storage_id!)
          const upgraded = linkage.get(original)
          return upgraded !== undefined && upgraded !== M.normalizeAddress(p.storage_id!) ? yield* fetch(upgraded) : p
        }), { concurrency: 8 })
      for (let i = 0; i < level.length; i++) {
        const address = level[i]!
        if (aliases.has(address)) continue
        const p = fetched[i]!
        const original = register(p)
        aliases.set(address, original)
        next.push(...referenced(p, false))
      }
      queue = next
    }

    const resolveAddress = (a: string) => aliases.get(a) ?? a
    const convertBody = (b: P.OpenSignatureBody | undefined): M.Type => {
      if (b === undefined) return { _tag: "Unsupported", description: "missing type" }
      const prim = PRIMITIVES[b.type ?? 0]
      if (prim !== undefined) return M.primitive(prim)
      switch (b.type) {
        case 9:
          return { _tag: "Vector", item: convertBody(b.type_parameter_instantiation?.[0]) }
        case 10: {
          const { address, module, name } = splitTypeName(b.type_name!)
          return {
            _tag: "Datatype",
            address: resolveAddress(address),
            module,
            name,
            typeArguments: (b.type_parameter_instantiation ?? []).map(convertBody)
          }
        }
        case 11:
          return { _tag: "TypeParameter", index: b.type_parameter ?? 0 }
        default:
          return { _tag: "Unsupported", description: `type ${b.type}` }
      }
    }
    const convertSignature = (s: P.OpenSignature): M.Type => {
      const t = convertBody(s.body)
      return s.reference === 1 || s.reference === 2 ? { _tag: "Reference", mutable: s.reference === 2, type: t } : t
    }
    const convertFields = (fs: ReadonlyArray<P.FieldDescriptor> | undefined): M.Fields => {
      const fields = [...(fs ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((f): M.Field => ({ name: f.name!, type: convertBody(f.type), doc: undefined }))
      return { positional: fields.length > 0 && fields.every((f, i) => f.name === `pos${i}`), fields }
    }
    const typeParameters = (ps: ReadonlyArray<P.TypeParameter> | undefined): Array<M.TypeParameter> =>
      (ps ?? []).map((p) => ({
        name: undefined,
        phantom: p.is_phantom ?? false,
        constraints: (p.constraints ?? []).flatMap((c) => ABILITIES[c] ?? [])
      }))

    const convertPackage = (p: P.Package, original: string): M.Package => {
      const origins = new Map((p.type_origins ?? []).map((o) => [`${o.module_name}::${o.datatype_name}`, M.normalizeAddress(o.package_id!)]))
      const isRoot = original === rootAddress
      return {
        address: original,
        storageId: M.normalizeAddress(p.storage_id!),
        name: isRoot && options.name !== undefined ? options.name : M.shortAddress(original),
        modules: [...(p.modules ?? [])].sort((a, b) => a.name!.localeCompare(b.name!)).map((m): M.Module => ({
          name: m.name!,
          doc: undefined,
          datatypes: (m.datatypes ?? []).map((d): M.Datatype => ({
            name: d.name!,
            abilities: (d.abilities ?? []).flatMap((a) => ABILITIES[a] ?? []),
            typeParameters: typeParameters(d.type_parameters),
            origin: origins.get(`${m.name}::${d.name}`) ?? (d.defining_id ? M.normalizeAddress(d.defining_id) : original),
            doc: undefined,
            kind: d.kind === 2
              ? {
                _tag: "Enum",
                variants: [...(d.variants ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                  .map((v) => ({ name: v.name!, ...convertFields(v.fields) }))
              }
              : { _tag: "Struct", ...convertFields(d.fields) }
          })),
          functions: (m.functions ?? []).map((f): M.MoveFunction => ({
            name: f.name!,
            visibility: VISIBILITY[f.visibility ?? 1] ?? "private",
            entry: f.is_entry ?? false,
            typeParameters: typeParameters(f.type_parameters),
            parameters: (f.parameters ?? []).map((s) => ({ name: undefined, type: convertSignature(s) })),
            returns: (f.returns ?? []).map(convertSignature),
            doc: undefined
          }))
        }))
      }
    }

    return {
      root: rootAddress,
      packages: [...loaded.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([original, p]) => convertPackage(p, original))
    }
  })
