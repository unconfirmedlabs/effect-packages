/**
 * BCS as Effect Schema.
 *
 * Every BCS type here *is* a `Schema` — it validates, has an Arbitrary, a JSON
 * encoding, equality, and composes with `Schema.decodeTo` into domain classes.
 * The byte layout rides along as a `bcs` annotation, compiled once into a
 * reader/writer pair. One declaration gives you the TypeScript type, runtime
 * validation, JSON, and the wire format; there is no second "BcsType" world.
 *
 * Representation choices:
 * - u8/u16/u32 are `number`; u64/u128/u256 are `bigint` (no string unions).
 * - `option(T)` is `Option<T>`.
 * - `enum` is a `_tag` union. A variant whose payload is a `struct` is
 *   flattened (`{ _tag: "MoveCall", package, module, ... }`); any other payload
 *   lives under `value`; a unit variant is just `{ _tag }`.
 */
import { base58 } from "@scure/base"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Bytes from "./Bytes.ts"

// -----------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------

export type Layout =
  | { readonly _tag: "bool" }
  | { readonly _tag: "uint"; readonly bytes: 1 | 2 | 4 }
  | { readonly _tag: "ubig"; readonly bytes: 8 | 16 | 32 }
  | { readonly _tag: "uleb128" }
  | { readonly _tag: "string" }
  | { readonly _tag: "bytes"; readonly length: number }
  | { readonly _tag: "byteVector" }
  | { readonly _tag: "address" }
  | { readonly _tag: "base58" } // vector<u8> shown as base58 (digests)
  | { readonly _tag: "vector"; readonly item: () => Layout }
  | { readonly _tag: "fixedArray"; readonly length: number; readonly item: () => Layout }
  | { readonly _tag: "option"; readonly item: () => Layout }
  | { readonly _tag: "tuple"; readonly items: ReadonlyArray<() => Layout> }
  | { readonly _tag: "struct"; readonly fields: ReadonlyArray<readonly [string, () => Layout]> }
  | {
    readonly _tag: "enum"
    readonly variants: ReadonlyArray<{
      readonly name: string
      readonly payload: "unit" | "flat" | "value"
      readonly layout: (() => Layout) | undefined
    }>
  }

const BCS = "bcs" as const

/** A Schema that knows its BCS layout. */
export interface BcsSchema<T, E = T> extends Schema.Codec<T, E> {}

export const layoutOf = (schema: Schema.Top): Layout => {
  const layout = SchemaAST.resolveAt<Layout>(BCS)(schema.ast)
  if (layout === undefined) {
    throw new Error(`Schema has no BCS layout: ${String(schema.ast)}`)
  }
  return layout
}

/**
 * The schemas built by this module, with the schemas they are made of. For
 * those (unmodified: a `.check` or `.annotate` makes a new AST) the reader's
 * output already is the decoded value, and a value the writer accepts is one
 * the schema accepts, so `decode`/`encode` skip the schema pass when every
 * schema in the tree is registered. `transform` and user-modified schemas are
 * not, and keep the schema pass.
 */
const nodes = /* @__PURE__ */ new WeakMap<SchemaAST.AST, () => ReadonlyArray<Schema.Top>>()
const LEAF = () => []

const withLayout = <S extends Schema.Top>(schema: S, layout: Layout, children?: () => ReadonlyArray<Schema.Top>): S => {
  const out = schema.annotate({ [BCS]: layout } as any) as S
  if (children) nodes.set(out.ast, children)
  return out
}

const trust = /* @__PURE__ */ new WeakMap<SchemaAST.AST, boolean>()

/** Is every schema in this tree one of ours? (Only whole-tree answers are cached: a cycle's inner answers are provisional.) */
const trusted = (schema: Schema.Top): boolean => {
  const known = trust.get(schema.ast)
  if (known !== undefined) return known
  const visiting = new Set<SchemaAST.AST>()
  const walk = (s: Schema.Top): boolean => {
    if (visiting.has(s.ast)) return true
    const children = nodes.get(s.ast)
    if (!children) return false
    visiting.add(s.ast)
    return children().every(walk)
  }
  const ok = walk(schema)
  trust.set(schema.ast, ok)
  return ok
}

/** `f`, evaluated once. */
const once = <A>(f: () => A): () => A => {
  let done = false
  let value: A
  return () => {
    if (!done) {
      value = f()
      done = true
    }
    return value
  }
}

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

const uint = (bytes: 1 | 2 | 4) =>
  withLayout(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** (bytes * 8) - 1 })),
    { _tag: "uint", bytes },
    LEAF
  )
const ubig = (bytes: 8 | 16 | 32) =>
  withLayout(
    Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: (1n << BigInt(bytes * 8)) - 1n })),
    { _tag: "ubig", bytes },
    LEAF
  )

/** A UTF-16 surrogate without its pair: not encodable as UTF-8 (`TextEncoder` would write U+FFFD). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export const bool = /* @__PURE__ */ withLayout(Schema.Boolean, { _tag: "bool" }, LEAF)
export const u8 = /* @__PURE__ */ uint(1)
export const u16 = /* @__PURE__ */ uint(2)
export const u32 = /* @__PURE__ */ uint(4)
export const u64 = /* @__PURE__ */ ubig(8)
export const u128 = /* @__PURE__ */ ubig(16)
export const u256 = /* @__PURE__ */ ubig(32)
export const uleb128 = /* @__PURE__ */ withLayout(
  /* @__PURE__ */ Schema.Int.check(/* @__PURE__ */ Schema.isBetween({ minimum: 0, maximum: 2 ** 32 - 1 })),
  { _tag: "uleb128" },
  LEAF
)
/** A UTF-8 string. A lone surrogate is refused (it has no UTF-8 encoding). */
export const string = /* @__PURE__ */ withLayout(
  /* @__PURE__ */ Schema.String.check(/* @__PURE__ */ Schema.makeFilter((s) => !LONE_SURROGATE.test(s) || "lone UTF-16 surrogate (not encodable as UTF-8)")),
  { _tag: "string" },
  LEAF
)
export const byteVector = /* @__PURE__ */ withLayout(Schema.Uint8Array, { _tag: "byteVector" }, LEAF)
export const bytes = (length: number) =>
  withLayout(
    Schema.Uint8Array.check(Schema.makeFilter((u) => u.length === length || `expected ${length} bytes`)),
    { _tag: "bytes", length },
    LEAF
  )

const ADDRESS = /^0x[0-9a-f]{64}$/

/** A 32-byte account address / object id, as normalized `0x` + 64 lowercase hex. */
export const Address = /* @__PURE__ */ withLayout(
  /* @__PURE__ */ Schema.String.check(/* @__PURE__ */ Schema.isPattern(ADDRESS)).pipe(/* @__PURE__ */ Schema.brand("SuiAddress")),
  { _tag: "address" },
  LEAF
)
export type Address = typeof Address.Type

const isDigest = (s: string) => {
  try {
    return base58.decode(s).length === 32 || "expected a 32-byte base58 digest"
  } catch {
    return "invalid base58"
  }
}

/** A 32-byte digest shown as base58 (object/transaction digests, chain ids). */
export const Digest = /* @__PURE__ */ withLayout(
  /* @__PURE__ */ Schema.String.check(/* @__PURE__ */ Schema.makeFilter(isDigest)).pipe(/* @__PURE__ */ Schema.brand("Digest")),
  { _tag: "base58" },
  LEAF
)
export type Digest = typeof Digest.Type

// -----------------------------------------------------------------------------
// Combinators
// -----------------------------------------------------------------------------

export const vector = <S extends Schema.Top>(item: S) =>
  withLayout(Schema.Array(item), { _tag: "vector", item: once(() => layoutOf(item)) }, () => [item])

export const fixedArray = <S extends Schema.Top>(length: number, item: S) =>
  withLayout(
    Schema.Array(item).check(Schema.makeFilter((a) => a.length === length || `expected ${length} items`)),
    { _tag: "fixedArray", length, item: once(() => layoutOf(item)) },
    () => [item]
  )

export const option = <S extends Schema.Top>(item: S) =>
  withLayout(Schema.Option(item), { _tag: "option", item: once(() => layoutOf(item)) }, () => [item])

export const tuple = <const Items extends ReadonlyArray<Schema.Top>>(items: Items) =>
  withLayout(Schema.Tuple(items), { _tag: "tuple", items: items.map((i) => once(() => layoutOf(i))) }, () => items)

export const struct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  withLayout(Schema.Struct(fields), {
    _tag: "struct",
    fields: Object.entries(fields).map(([k, s]) => [k, once(() => layoutOf(s as Schema.Top))] as const)
  }, () => Object.values(fields) as unknown as ReadonlyArray<Schema.Top>)

/** Recursive types: `Bcs.lazy(() => TypeTag)`. */
export const lazy = <S extends Schema.Top>(f: () => S) =>
  withLayout(Schema.suspend(f), lazyLayout(() => layoutOf(f())), () => [f()])
const lazyLayout = (f: () => Layout): Layout => {
  // A layout proxy that defers to the real layout on first access.
  let cached: Layout | undefined
  return new Proxy({} as Layout, {
    get: (_, key) => {
      cached ??= f()
      return (cached as any)[key]
    }
  })
}

type EnumVariants = Record<string, Schema.Top | null>

type VariantType<K extends string, V> = V extends null ? { readonly _tag: K }
  : V extends Schema.Struct<infer F> ? Schema.Struct.Type<F> & { readonly _tag: K }
  : V extends Schema.Top ? { readonly _tag: K; readonly value: V["Type"] }
  : never
type VariantEncoded<K extends string, V> = V extends null ? { readonly _tag: K }
  : V extends Schema.Struct<infer F> ? Schema.Struct.Encoded<F> & { readonly _tag: K }
  : V extends Schema.Top ? { readonly _tag: K; readonly value: V["Encoded"] }
  : never

export type EnumType<V extends EnumVariants> = { [K in keyof V & string]: VariantType<K, V[K]> }[keyof V & string]
export type EnumEncoded<V extends EnumVariants> = { [K in keyof V & string]: VariantEncoded<K, V[K]> }[
  keyof V & string
]

const isStructSchema = (s: Schema.Top): s is Schema.Struct<Schema.Struct.Fields> =>
  SchemaAST.isObjects(s.ast) && layoutOf(s)._tag === "struct"

/**
 * A Rust-style enum. Variant order is the declaration order (that is the BCS
 * index), so `Bcs.enum({ None: null, Some: T })` encodes None as 0.
 */
export const enum_ = <const V extends EnumVariants>(variants: V): BcsSchema<EnumType<V>, EnumEncoded<V>> => {
  const entries = Object.entries(variants)
  const kinds = entries.map(([name, payload]) => ({
    name,
    payload: payload === null ? "unit" as const : isStructSchema(payload) ? "flat" as const : "value" as const,
    schema: payload ?? undefined
  }))
  const members = kinds.map(({ name, payload, schema }) => {
    if (payload === "unit") return Schema.TaggedStruct(name, {})
    if (payload === "flat") return Schema.TaggedStruct(name, (schema as Schema.Struct<Schema.Struct.Fields>).fields)
    return Schema.TaggedStruct(name, { value: schema! })
  })
  const layout: Layout = {
    _tag: "enum",
    variants: kinds.map(({ name, payload, schema }) => ({ name, payload, layout: schema && once(() => layoutOf(schema)) }))
  }
  return withLayout(Schema.Union(members), layout, () => kinds.flatMap((k) => (k.schema ? [k.schema] : []))) as any
}
export { enum_ as enum }

/**
 * Re-type a BCS schema through a pure bijection, keeping its layout. Used for
 * things like `TypeTag` <-> `"0x2::coin::Coin<0x2::sui::SUI>"`.
 */
export const transform = <S extends Schema.Top, T>(
  from: S,
  to: Schema.Codec<T>,
  f: { readonly decode: (e: S["Type"]) => T; readonly encode: (t: T) => S["Type"] }
): BcsSchema<T, S["Encoded"]> =>
  withLayout(
    from.pipe(Schema.decodeTo(to as any, SchemaTransformation.transform(f as any))),
    layoutOf(from)
  ) as any

// -----------------------------------------------------------------------------
// Writer / Reader
// -----------------------------------------------------------------------------

class Writer {
  buf = new Uint8Array(256)
  view = new DataView(this.buf.buffer)
  pos = 0
  ensure(n: number) {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf)
    this.buf = next
    this.view = new DataView(next.buffer)
  }
  u8(v: number) {
    this.ensure(1)
    this.buf[this.pos++] = v
  }
  uleb(v: number) {
    do {
      let b = v & 0x7f
      v = Math.floor(v / 128)
      if (v > 0) b |= 0x80
      this.u8(b)
    } while (v > 0)
  }
  raw(b: Uint8Array) {
    this.ensure(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
  }
  uint(v: number, bytes: 1 | 2 | 4) {
    this.ensure(bytes)
    if (bytes === 1) this.view.setUint8(this.pos, v)
    else if (bytes === 2) this.view.setUint16(this.pos, v, true)
    else this.view.setUint32(this.pos, v, true)
    this.pos += bytes
  }
  ubig(v: bigint, bytes: 8 | 16 | 32) {
    this.ensure(bytes)
    if (bytes === 8) {
      this.view.setBigUint64(this.pos, v, true)
      this.pos += 8
      return
    }
    for (let i = 0; i < bytes; i++) {
      this.buf[this.pos++] = Number(v & 0xffn)
      v >>= 8n
    }
  }
  result() {
    return this.buf.slice(0, this.pos)
  }
}

class Reader {
  pos = 0
  /** Set when the bytes parse but some value fails its schema's own check (a digest that isn't 32 bytes). */
  suspect = false
  readonly view: DataView
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  need(n: number) {
    if (this.pos + n > this.buf.length) throw new BcsDecodeError({ message: "unexpected end of input", offset: this.pos })
  }
  u8() {
    this.need(1)
    return this.buf[this.pos++]!
  }
  uleb() {
    let result = 0
    let shift = 0
    for (;;) {
      const b = this.u8()
      result += (b & 0x7f) * 2 ** shift
      if ((b & 0x80) === 0) {
        // Canonical only, as Rust bcs: no trailing zero groups (`0x80 0x00` is not 0).
        if (b === 0 && shift > 0) throw new BcsDecodeError({ message: "non-canonical uleb128", offset: this.pos })
        break
      }
      shift += 7
      if (shift > 28) throw new BcsDecodeError({ message: "uleb128 overflow", offset: this.pos })
    }
    if (result > 0xffffffff) throw new BcsDecodeError({ message: "uleb128 overflow", offset: this.pos })
    return result
  }
  raw(n: number) {
    this.need(n)
    const out = this.buf.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  uint(bytes: 1 | 2 | 4) {
    this.need(bytes)
    const v = bytes === 1
      ? this.view.getUint8(this.pos)
      : bytes === 2
      ? this.view.getUint16(this.pos, true)
      : this.view.getUint32(this.pos, true)
    this.pos += bytes
    return v
  }
  ubig(bytes: 8 | 16 | 32) {
    this.need(bytes)
    if (bytes === 8) {
      const v = this.view.getBigUint64(this.pos, true)
      this.pos += 8
      return v
    }
    let v = 0n
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[this.pos + i]!)
    this.pos += bytes
    return v
  }
}

/**
 * Longest vector of zero-size elements (`tuple([])`, `struct({})`, `bytes(0)`)
 * that decoding accepts. Such elements consume no input, so the input cannot
 * bound their count; Move has no zero-size types, so this only stops a 5-byte
 * length prefix from allocating billions of entries.
 */
export const MAX_ZERO_SIZE_ITEMS = 1 << 16

const sizes = /* @__PURE__ */ new WeakMap<Layout, number>()
/** The fewest bytes a value of this layout can take (a lower bound; recursion counts as 0). */
const minSize = (l: Layout): number => {
  const known = sizes.get(l)
  if (known !== undefined) return known
  sizes.set(l, 0)
  const n = ((): number => {
    switch (l._tag) {
      case "uint":
      case "ubig":
        return l.bytes
      case "bytes":
        return l.length
      case "address":
        return 32
      case "fixedArray":
        return l.length * minSize(l.item())
      case "tuple":
        return l.items.reduce((sum, i) => sum + minSize(i()), 0)
      case "struct":
        return l.fields.reduce((sum, [, f]) => sum + minSize(f()), 0)
      default:
        // bool, uleb128, length-prefixed values, option and enum tags: at least one byte.
        return 1
    }
  })()
  sizes.set(l, n)
  return n
}

/** Refuse a vector length the remaining input cannot hold, before allocating anything. */
const checkLength = (r: Reader, n: number, min: number) => {
  if (min > 0 ? n * min > r.buf.length - r.pos : n > MAX_ZERO_SIZE_ITEMS) {
    throw new BcsDecodeError({
      message: min > 0
        ? `vector length ${n} exceeds the remaining input (${r.buf.length - r.pos} bytes)`
        : `vector of ${n} zero-size elements exceeds ${MAX_ZERO_SIZE_ITEMS}`,
      offset: r.pos
    })
  }
}

const utf8e = /* @__PURE__ */ new TextEncoder()
// ignoreBOM: keep a leading U+FEFF as data, so decoding never changes the string's bytes.
const utf8d = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** A value the writer can't take for this layout: `encode` then defers to the schema. */
class Invalid {}
const invalid = (ok: boolean) => {
  if (!ok) throw new Invalid()
}
const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)
const isUint = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max

/**
 * Write `v` as `l`, checking it as the layout's own schema would (ranges,
 * lengths, address form, digest length, well-formed strings, tags); anything
 * else throws `Invalid`.
 */
const write = (w: Writer, l: Layout, v: any): void => {
  switch (l._tag) {
    case "bool":
      invalid(typeof v === "boolean")
      return w.u8(v ? 1 : 0)
    case "uint":
      invalid(isUint(v, 2 ** (l.bytes * 8) - 1))
      return w.uint(v, l.bytes)
    case "ubig":
      invalid(typeof v === "bigint" && v >= 0n && v < 1n << BigInt(l.bytes * 8))
      return w.ubig(v, l.bytes)
    case "uleb128":
      invalid(isUint(v, 0xffffffff))
      return w.uleb(v)
    case "string": {
      invalid(typeof v === "string" && !LONE_SURROGATE.test(v))
      const b = utf8e.encode(v)
      w.uleb(b.length)
      return w.raw(b)
    }
    case "bytes":
      invalid(v instanceof Uint8Array && v.length === l.length)
      return w.raw(v)
    case "byteVector":
      invalid(v instanceof Uint8Array)
      w.uleb(v.length)
      return w.raw(v)
    case "address":
      invalid(typeof v === "string" && ADDRESS.test(v))
      return w.raw(Bytes.fromHex(v.slice(2)))
    case "base58": {
      invalid(typeof v === "string")
      const b = base58.decode(v)
      invalid(b.length === 32)
      w.uleb(b.length)
      return w.raw(b)
    }
    case "vector": {
      invalid(Array.isArray(v))
      w.uleb(v.length)
      const item = l.item()
      for (const x of v) write(w, item, x)
      return
    }
    case "fixedArray": {
      invalid(Array.isArray(v) && v.length === l.length)
      const item = l.item()
      for (const x of v) write(w, item, x)
      return
    }
    case "option":
      invalid(Option.isOption(v))
      if (Option.isNone(v)) return w.u8(0)
      w.u8(1)
      return write(w, l.item(), v.value)
    case "tuple":
      invalid(Array.isArray(v) && v.length === l.items.length)
      return l.items.forEach((item, i) => write(w, item(), v[i]))
    case "struct":
      invalid(isRecord(v))
      for (const [k, f] of l.fields) write(w, f(), v[k])
      return
    case "enum": {
      invalid(isRecord(v))
      const idx = l.variants.findIndex((x) => x.name === v._tag)
      invalid(idx >= 0)
      const variant = l.variants[idx]!
      w.uleb(idx)
      if (variant.payload === "flat") return write(w, variant.layout!(), v)
      if (variant.payload === "value") return write(w, variant.layout!(), v.value)
      return
    }
  }
}

const read = (r: Reader, l: Layout): any => {
  switch (l._tag) {
    case "bool": {
      const b = r.u8()
      if (b > 1) throw new BcsDecodeError({ message: `invalid bool ${b}`, offset: r.pos - 1 })
      return b === 1
    }
    case "uint":
      return r.uint(l.bytes)
    case "ubig":
      return r.ubig(l.bytes)
    case "uleb128":
      return r.uleb()
    case "string":
      return utf8d.decode(r.raw(r.uleb()))
    case "bytes":
      return r.raw(l.length)
    case "byteVector":
      return r.raw(r.uleb())
    case "address":
      return "0x" + Bytes.toHex(r.raw(32))
    case "base58": {
      const b = r.raw(r.uleb())
      // Not a digest: the schema pass reports it.
      if (b.length !== 32) r.suspect = true
      return base58.encode(b)
    }
    case "vector": {
      const n = r.uleb()
      const item = l.item()
      checkLength(r, n, minSize(item))
      const out: Array<unknown> = []
      for (let i = 0; i < n; i++) out.push(read(r, item))
      return out
    }
    case "fixedArray": {
      const item = l.item()
      const out: Array<unknown> = []
      for (let i = 0; i < l.length; i++) out.push(read(r, item))
      return out
    }
    case "option": {
      const tag = r.u8()
      if (tag === 0) return Option.none()
      if (tag === 1) return Option.some(read(r, l.item()))
      throw new BcsDecodeError({ message: `invalid option tag ${tag}`, offset: r.pos - 1 })
    }
    case "tuple":
      return l.items.map((item) => read(r, item()))
    case "struct": {
      const out: Record<string, unknown> = {}
      for (const [k, f] of l.fields) out[k] = read(r, f())
      return out
    }
    case "enum": {
      const idx = r.uleb()
      const variant = l.variants[idx]
      if (!variant) throw new BcsDecodeError({ message: `unknown enum variant ${idx}`, offset: r.pos })
      if (variant.payload === "flat") return { _tag: variant.name, ...read(r, variant.layout!()) }
      if (variant.payload === "value") return { _tag: variant.name, value: read(r, variant.layout!()) }
      return { _tag: variant.name }
    }
  }
}

// -----------------------------------------------------------------------------
// Public codec API
// -----------------------------------------------------------------------------

export class BcsDecodeError extends /* @__PURE__ */ Schema.TaggedError<BcsDecodeError>()("BcsDecodeError", {
  message: Schema.String,
  offset: Schema.Number
}) {}

/**
 * Serialize the *encoded* side of a BCS schema. Pure and synchronous: BCS of a
 * valid value cannot fail. Validates first, so an out-of-range u8 is a typed
 * failure rather than silently-truncated bytes; a value too deeply nested to
 * encode is a failure too, not a throw.
 *
 * A schema made only of this module's schemas is validated by the writer
 * itself; anything the writer refuses goes through the schema, so failures
 * are the schema's.
 */
export const encode = <T, E>(schema: Schema.Codec<T, E>) => {
  const layout = layoutOf(schema)
  const encodeSchema = Schema.encodeResult(schema as any)
  let fast: boolean | undefined
  return (value: T): Result.Result<Uint8Array, Schema.SchemaError> => {
    if (fast ??= trusted(schema)) {
      try {
        const w = new Writer()
        write(w, layout, value)
        return Result.succeed(w.result())
      } catch {
        // refused (or too deep): the schema pass decides
      }
    }
    try {
      return Result.map(encodeSchema(value) as Result.Result<E, Schema.SchemaError>, (e) => {
        const w = new Writer()
        write(w, layout, e)
        return w.result()
      })
    } catch (e) {
      return Result.fail(
        new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: `cannot encode: ${e instanceof Error ? e.message : String(e)}` }))
      )
    }
  }
}

export const encodeSync = <T, E>(schema: Schema.Codec<T, E>) => {
  const f = encode(schema)
  return (value: T): Uint8Array => Result.getOrThrow(f(value))
}

/**
 * Parse bytes, rejecting trailing bytes, then decode through the schema. A
 * schema made only of this module's schemas skips the schema pass: the reader
 * already checks what it would.
 */
export const decode = <T, E>(schema: Schema.Codec<T, E>) => {
  const layout = layoutOf(schema)
  const decodeSchema = Schema.decodeUnknownResult(schema as any)
  let fast: boolean | undefined
  return (bytes: Uint8Array): Result.Result<T, BcsDecodeError | Schema.SchemaError> => {
    let raw: unknown
    const r = new Reader(bytes)
    try {
      raw = read(r, layout)
      if (r.pos !== bytes.length) {
        return Result.fail(new BcsDecodeError({ message: `${bytes.length - r.pos} trailing bytes`, offset: r.pos }))
      }
    } catch (e) {
      if (e instanceof BcsDecodeError) return Result.fail(e)
      return Result.fail(new BcsDecodeError({ message: String(e), offset: -1 }))
    }
    if ((fast ??= trusted(schema)) && !r.suspect) return Result.succeed(raw as T)
    return decodeSchema(raw) as Result.Result<T, Schema.SchemaError>
  }
}

export const decodeSync = <T, E>(schema: Schema.Codec<T, E>) => {
  const f = decode(schema)
  return (bytes: Uint8Array): T => Result.getOrThrow(f(bytes))
}

/**
 * The BCS bytes of a schema as a Schema: `Schema.Codec<T, Uint8Array>`.
 * Drop it into any other schema, e.g. a protobuf message field holding BCS.
 */
export const bytesOf = <T, E>(schema: Schema.Codec<T, E>): Schema.Codec<T, Uint8Array> => {
  const enc = encode(schema)
  const dec = decode(schema)
  return Schema.Uint8Array.pipe(
    Schema.decodeTo(
      Schema.toType(schema as any) as Schema.Codec<T>,
      SchemaTransformation.transformEffect({
        decode: (bytes: Uint8Array) =>
          Result.match(dec(bytes), {
            onSuccess: Effect.succeed,
            onFailure: (e) =>
              Effect.fail(new SchemaIssue.InvalidValue({ message: String(e.message) }, bytes))
          }),
        encode: (value: T) =>
          Result.match(enc(value), {
            onSuccess: Effect.succeed,
            onFailure: (e) =>
              Effect.fail(new SchemaIssue.InvalidValue({ message: String(e.message) }, value))
          })
      })
    )
  ) as any
}
