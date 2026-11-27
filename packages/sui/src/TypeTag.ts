/**
 * Move type tags: the BCS schema plus the `0x2::coin::Coin<0x2::sui::SUI>` string form.
 */
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { type Address, normalize } from "./Address.ts"

export interface StructTag {
  readonly address: Address
  readonly module: string
  readonly name: string
  readonly typeParams: ReadonlyArray<TypeTag>
}

export type TypeTag =
  | { readonly _tag: "bool" | "u8" | "u16" | "u32" | "u64" | "u128" | "u256" | "address" | "signer" }
  | { readonly _tag: "vector"; readonly value: TypeTag }
  | ({ readonly _tag: "struct" } & StructTag)

export const StructTag: Bcs.BcsSchema<StructTag, any> = /* @__PURE__ */ Bcs.struct({
  address: Bcs.Address,
  module: Bcs.string,
  name: Bcs.string,
  typeParams: Bcs.vector(Bcs.lazy((): Bcs.BcsSchema<TypeTag, any> => TypeTag))
}) as any

/** Variant order is Rust's `TypeTag` (u16/u32/u256 were appended later). */
export const TypeTag: Bcs.BcsSchema<TypeTag, any> = /* @__PURE__ */ Bcs.enum({
  bool: null,
  u8: null,
  u64: null,
  u128: null,
  address: null,
  signer: null,
  vector: Bcs.lazy((): Bcs.BcsSchema<TypeTag, any> => TypeTag),
  struct: StructTag as any,
  u16: null,
  u32: null,
  u256: null
}) as any

const PRIMITIVES = /* @__PURE__ */ new Set(["bool", "u8", "u16", "u32", "u64", "u128", "u256", "address", "signer"])

/** Parse `vector<0x2::coin::Coin<0x2::sui::SUI>>`. Throws on malformed input. */
export const parse = (input: string): TypeTag => {
  const s = input.replace(/\s+/g, "")
  let i = 0
  const expect = (c: string) => {
    if (s.slice(i, i + c.length) !== c) throw new Error(`invalid type tag "${input}": expected "${c}" at ${i}`)
    i += c.length
  }
  const ident = () => {
    const m = /^[A-Za-z0-9_]+/.exec(s.slice(i))
    if (!m) throw new Error(`invalid type tag "${input}" at ${i}`)
    i += m[0].length
    return m[0]
  }
  const tag = (): TypeTag => {
    const head = ident()
    if (PRIMITIVES.has(head)) return { _tag: head as "bool" }
    if (head === "vector") {
      expect("<")
      const value = tag()
      expect(">")
      return { _tag: "vector", value }
    }
    expect("::")
    const module = ident()
    expect("::")
    const name = ident()
    const typeParams: Array<TypeTag> = []
    if (s[i] === "<") {
      i++
      do typeParams.push(tag())
      while (s[i] === "," && ++i)
      expect(">")
    }
    return { _tag: "struct", address: normalize(head), module, name, typeParams }
  }
  const result = tag()
  if (i !== s.length) throw new Error(`invalid type tag "${input}": trailing input at ${i}`)
  return result
}

export const format = (t: TypeTag): string =>
  t._tag === "vector"
    ? `vector<${format(t.value)}>`
    : t._tag === "struct"
    ? `${t.address}::${t.module}::${t.name}${t.typeParams.length ? `<${t.typeParams.map(format).join(", ")}>` : ""}`
    : t._tag

/** Canonical string form (fully padded addresses). */
export const normalizeString = (s: string) => format(parse(s))

/** `0x2::sui::SUI`, padded. */
export const SUI = /* @__PURE__ */ normalizeString("0x2::sui::SUI")

/**
 * Pad the addresses of a type or a type prefix used as a filter,
 * `0xaddr[::module[::Name[<T>]]]` (nodes reject `0x2`). Input that doesn't
 * parse is returned as is.
 */
export const normalizePath = (path: string): string => {
  try {
    if (path.includes("<") || path.split("::").length === 3) return normalizeString(path)
    const [address, ...rest] = path.split("::")
    return [normalize(address!), ...rest].join("::")
  } catch {
    return path
  }
}

/**
 * Does `type` match a filter path at its level of specificity: `0xaddr`,
 * `0xaddr::module`, `0xaddr::module::Name` (any instantiation), an exact
 * instantiation, or an exact non-struct type.
 */
export const matchesPath = (path: string, type: string): boolean => {
  const p = normalizePath(path)
  const t = normalizePath(type)
  if (p.includes("<") || !p.startsWith("0x")) return p === t
  const segments = p.split("::").length
  return segments === 3 ? t === p || t.startsWith(p + "<") : t.startsWith(p + "::")
}
