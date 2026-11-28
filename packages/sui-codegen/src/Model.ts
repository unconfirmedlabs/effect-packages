/**
 * The intermediate model both inputs normalize into: `sui move summary`
 * package summaries (`Summary.ts`) and on-chain packages over gRPC
 * (`FromGrpc.ts`). The renderer only ever sees this.
 *
 * Addresses are normalized (`0x` + 64 hex). A package's `address` is the one
 * its modules are published under and that types refer to it by (the original
 * id, stable across upgrades). An unpublished package (address `0x0` in the
 * summaries) gets a synthetic identity instead, `unpublished:<label>` (see
 * {@link unpublished}), so several can be loaded together; it renders as `0x0`. `storageId` is the id calls go to (the latest
 * version that was loaded), and each datatype carries its own `origin`: the
 * package version that introduced it, which is what its type string uses.
 */
import * as Schema from "effect/Schema"

export type Ability = "copy" | "drop" | "store" | "key"

export type Primitive = "bool" | "u8" | "u16" | "u32" | "u64" | "u128" | "u256" | "address" | "signer"

export type Type =
  | { readonly _tag: "Primitive"; readonly name: Primitive }
  | { readonly _tag: "Vector"; readonly item: Type }
  | {
    readonly _tag: "Datatype"
    /** The address the type is referred to by (a package's `address`). */
    readonly address: string
    readonly module: string
    readonly name: string
    readonly typeArguments: ReadonlyArray<Type>
  }
  | { readonly _tag: "TypeParameter"; readonly index: number }
  | { readonly _tag: "Reference"; readonly mutable: boolean; readonly type: Type }
  | { readonly _tag: "Unsupported"; readonly description: string }

export interface TypeParameter {
  readonly name: string | undefined
  readonly phantom: boolean
  readonly constraints: ReadonlyArray<Ability>
}

export interface Field {
  readonly name: string
  readonly type: Type
  readonly doc: string | undefined
}

export interface Fields {
  /** `struct Point(u32, u32)` / `Variant(u32, bool)`: fields are `pos0`, `pos1`, ... */
  readonly positional: boolean
  readonly fields: ReadonlyArray<Field>
}

export interface Variant extends Fields {
  readonly name: string
}

export interface Datatype {
  readonly name: string
  readonly abilities: ReadonlyArray<Ability>
  readonly typeParameters: ReadonlyArray<TypeParameter>
  /** The package version that introduced the type: its type strings use this. */
  readonly origin: string
  readonly doc: string | undefined
  readonly kind:
    | ({ readonly _tag: "Struct" } & Fields)
    | { readonly _tag: "Enum"; readonly variants: ReadonlyArray<Variant> }
}

export type Visibility = "public" | "package" | "private"

export interface Parameter {
  readonly name: string | undefined
  readonly type: Type
}

export interface MoveFunction {
  readonly name: string
  readonly visibility: Visibility
  readonly entry: boolean
  readonly typeParameters: ReadonlyArray<TypeParameter>
  readonly parameters: ReadonlyArray<Parameter>
  readonly returns: ReadonlyArray<Type>
  readonly doc: string | undefined
}

export interface Module {
  readonly name: string
  readonly doc: string | undefined
  readonly datatypes: ReadonlyArray<Datatype>
  readonly functions: ReadonlyArray<MoveFunction>
}

export interface Package {
  /** The address types refer to the package by (its original id; `unpublished:<label>` when unpublished). */
  readonly address: string
  /** The id calls go to (the loaded version). */
  readonly storageId: string
  /** A label for directories and reference keys (`fixture`, `sui`). */
  readonly name: string
  readonly modules: ReadonlyArray<Module>
}

/** Everything one input produced: the root package and the packages it depends on. */
export interface Model {
  readonly root: string
  readonly packages: ReadonlyArray<Package>
}

export class CodegenError extends Schema.TaggedError<CodegenError>()("CodegenError", {
  message: Schema.String
}) {}

/**
 * A local package's `Published.toml` has publish records for several
 * environments and the config doesn't say which to generate for (`environment`).
 */
export class AmbiguousEnvironment extends Schema.TaggedError<AmbiguousEnvironment>()("AmbiguousEnvironment", {
  path: Schema.String,
  environments: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return `${this.path}/Published.toml has publish records for ${this.environments.join(", ")}: set \`environment\` to the one to generate for`
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export const normalizeAddress = (s: string): string => {
  const h = s.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{1,64}$/.test(h)) throw new Error(`invalid address: ${s}`)
  return "0x" + h.padStart(64, "0")
}

const UNPUBLISHED = "unpublished:"

/** The synthetic identity of an unpublished package (the summaries say `0x0`), by its label. */
export const unpublished = (label: string): string => `${UNPUBLISHED}${label}`

export const isUnpublished = (address: string): boolean => address.startsWith(UNPUBLISHED)

export const ZERO = "0x" + "0".repeat(64)

/** The address a package identity renders as: `0x0` for an unpublished package. */
export const renderedAddress = (address: string): string => isUnpublished(address) ? ZERO : address

/** `0x2` for small addresses, the full form otherwise. */
export const shortAddress = (address: string): string => {
  if (isUnpublished(address)) return "0x0"
  const h = address.replace(/^0x/, "").replace(/^0+/, "")
  return h.length <= 4 ? `0x${h || "0"}` : address
}

/** The framework packages, at the same address on every network, by their named address. */
export const SYSTEM: Readonly<Record<string, string>> = {
  [normalizeAddress("0x1")]: "std",
  [normalizeAddress("0x2")]: "sui",
  [normalizeAddress("0x3")]: "sui_system",
  [normalizeAddress("0xb")]: "bridge"
}

export const isSystem = (address: string): boolean => SYSTEM[address] !== undefined

export const primitive = (name: Primitive): Type => ({ _tag: "Primitive", name })

export const datatypeKey = (address: string, module: string, name: string) => `${address}::${module}::${name}`

/** Strip references. */
export const deref = (t: Type): Type => t._tag === "Reference" ? deref(t.type) : t
