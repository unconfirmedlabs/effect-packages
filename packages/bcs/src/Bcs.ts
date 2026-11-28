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
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"

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
  /* @__PURE__ */ Schema.String.check(/* @__PURE__ */ Schema.isPattern(ADDRESS)).pipe(/* @__PURE__ */ Schema.brand("Address")),
  { _tag: "address" },
  LEAF
)
export type Address = typeof Address.Type

const isDigest = (s: string) => {
  const b = fromBase58(s)
  return b === undefined ? "invalid base58" : b.length === 32 || "expected a 32-byte base58 digest"
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
  const proxy = new Proxy({} as Layout, {
    get: (_, key) => {
      cached ??= f()
      return (cached as any)[key]
    }
  })
  // The codec compiler skips the proxy and works on the real layout.
  lazies.set(proxy, () => cached ??= f())
  return proxy
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
  buf: Uint8Array
  view: DataView
  pos = 0
  constructor(size: number) {
    this.buf = new Uint8Array(size)
    this.view = new DataView(this.buf.buffer)
  }
  ensure(n: number) {
    if (this.pos + n > this.buf.length) this.grow(n)
  }
  grow(n: number) {
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
    this.view = new DataView(next.buffer)
  }
  /** The low `bytes` bytes of `v`, little-endian. */
  uint(v: number, bytes: number) {
    this.ensure(bytes)
    for (let i = 0; i < bytes; i++) this.buf[this.pos++] = v >>> (8 * i)
  }
  /** `v` is a validated u32. */
  uleb(v: number) {
    this.ensure(5)
    const buf = this.buf
    let p = this.pos
    while (v >= 0x80) {
      buf[p++] = (v & 0x7f) | 0x80
      v >>>= 7
    }
    buf[p++] = v
    this.pos = p
  }
  raw(b: Uint8Array) {
    this.ensure(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
  }
}

class Reader {
  pos = 0
  /** Set when the bytes parse but some value fails its schema's own check (a digest that isn't 32 bytes). */
  suspect = false
  private dv: DataView | undefined = undefined
  constructor(readonly buf: Uint8Array) {}
  get view() {
    return this.dv ??= new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
  }
}

const fail = (message: string, offset: number): never => {
  throw new BcsDecodeError({ message, offset })
}

/** Claim the next `n` bytes; returns where they start. */
const take = (r: Reader, n: number): number => {
  const p = r.pos
  if (p + n > r.buf.length) fail("unexpected end of input", p)
  r.pos = p + n
  return p
}

const readUleb = (r: Reader): number => {
  const buf = r.buf
  const p = r.pos
  if (p < r.buf.length && buf[p]! < 0x80) {
    r.pos = p + 1
    return buf[p]!
  }
  let result = 0
  let shift = 0
  for (;;) {
    const b = buf[take(r, 1)]!
    result += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) {
      // Canonical only, as Rust bcs: no trailing zero groups (`0x80 0x00` is not 0).
      if (b === 0 && shift > 0) fail("non-canonical uleb128", r.pos)
      break
    }
    shift += 7
    if (shift > 28) fail("uleb128 overflow", r.pos)
  }
  if (result > 0xffffffff) fail("uleb128 overflow", r.pos)
  return result
}

/**
 * Longest vector of zero-size elements (`tuple([])`, `struct({})`, `bytes(0)`)
 * that decoding accepts. Such elements consume no input, so the input cannot
 * bound their count; Move has no zero-size types, so this only stops a 5-byte
 * length prefix from allocating billions of entries.
 */
export const MAX_ZERO_SIZE_ITEMS = 1 << 16

/** Refuse a vector length the remaining input cannot hold, before allocating anything. */
const checkLength = (r: Reader, n: number, min: number) => {
  if (min > 0 ? n * min > r.buf.length - r.pos : n > MAX_ZERO_SIZE_ITEMS) {
    fail(
      min > 0
        ? `vector length ${n} exceeds the remaining input (${r.buf.length - r.pos} bytes)`
        : `vector of ${n} zero-size elements exceeds ${MAX_ZERO_SIZE_ITEMS}`,
      r.pos
    )
  }
}

const utf8e = /* @__PURE__ */ new TextEncoder()
// ignoreBOM: keep a leading U+FEFF as data, so decoding never changes the string's bytes.
const utf8d = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

// --- hex / base58 ------------------------------------------------------------

/** `0x` + 64 hex digits, filled per address and decoded in one call (a flat string, not 33 concatenations). */
const ADDRESS_CHARS = /* @__PURE__ */ new Uint8Array(66).fill(48, 0, 1).fill(120, 1, 2)
// Every byte written is ASCII, which this decodes as itself.
const latin1 = /* @__PURE__ */ new TextDecoder("latin1")
/** The char code of lowercase hex digit `d`. */
const hexDigit = (d: number) => d + (d < 10 ? 48 : 87)
const NIBBLE = /* @__PURE__ */ (() => {
  const t = new Int8Array(256).fill(-1)
  for (let d = 0; d < 16; d++) t[hexDigit(d)] = d
  return t
})()
/** Value of a lowercase hex digit's char code, or -1. */
const nibble = (c: number) => (c < 256 ? NIBBLE[c]! : -1)

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const B58_DIGIT = /* @__PURE__ */ (() => {
  const t = new Int8Array(128).fill(-1)
  for (let i = 0; i < 58; i++) t[B58.charCodeAt(i)] = i
  return t
})()
const LIMB = 16777216 // 2^24: limb arithmetic stays exact in a double
const B58_4 = 11316496 // 58^4

/** Bitcoin-alphabet base58 of `buf[start, start + n)`, as `@scure/base` writes it. 24-bit limbs, 4 digits per pass. */
const toBase58 = (buf: Uint8Array, start: number, n: number): string => {
  const end = start + n
  let zeros = 0
  while (start + zeros < end && buf[start + zeros] === 0) zeros++
  const limbs: Array<number> = []
  for (let k = 0, i = end - 1; i >= start + zeros; i--, k++) {
    if (k % 3 === 0) limbs.push(buf[i]!)
    else limbs[limbs.length - 1]! += buf[i]! * (k % 3 === 1 ? 256 : 65536)
  }
  let len = limbs.length
  while (len > 0 && limbs[len - 1] === 0) len--
  const digits: Array<number> = []
  while (len > 0) {
    let rem = 0
    for (let i = len - 1; i >= 0; i--) {
      const cur = rem * LIMB + limbs[i]!
      const q = Math.floor(cur / B58_4)
      limbs[i] = q
      rem = cur - q * B58_4
    }
    while (len > 0 && limbs[len - 1] === 0) len--
    for (let k = 0; k < 4; k++) {
      const q = Math.floor(rem / 58)
      digits.push(rem - q * 58)
      rem = q
    }
  }
  while (digits.length > 0 && digits[digits.length - 1] === 0) digits.pop()
  let s = "1".repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]!]
  return s
}

/** Bytes of a base58 string, or `undefined` if it has a character outside the alphabet. */
const fromBase58 = (s: string): Uint8Array | undefined => {
  let zeros = 0
  while (zeros < s.length && s.charCodeAt(zeros) === 49) zeros++
  const limbs: Array<number> = []
  for (let i = zeros; i < s.length;) {
    let add = 0
    let mult = 1
    for (let k = 0; k < 4 && i < s.length; k++, i++) {
      const c = s.charCodeAt(i)
      const d = c < 128 ? B58_DIGIT[c]! : -1
      if (d < 0) return undefined
      add = add * 58 + d
      mult *= 58
    }
    let carry = add
    for (let j = 0; j < limbs.length; j++) {
      const cur = limbs[j]! * mult + carry
      carry = Math.floor(cur / LIMB)
      limbs[j] = cur - carry * LIMB
    }
    while (carry > 0) {
      const q = Math.floor(carry / LIMB)
      limbs.push(carry - q * LIMB)
      carry = q
    }
  }
  const byteAt = (k: number) => (limbs[(k / 3) | 0]! >>> (8 * (k % 3))) & 0xff
  let nb = limbs.length * 3
  while (nb > 0 && byteAt(nb - 1) === 0) nb--
  const out = new Uint8Array(zeros + nb)
  for (let k = 0; k < nb; k++) out[out.length - 1 - k] = byteAt(k)
  return out
}

// -----------------------------------------------------------------------------
// Compiled codecs
// -----------------------------------------------------------------------------

/** A value the writer can't take for this layout: `encode` then defers to the schema. */
class Invalid {}
const invalid = (ok: boolean) => {
  if (!ok) throw new Invalid()
}
const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)
const isUint = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max

/**
 * A layout compiled once into a reader and a writer (closures built on first
 * use of `encode`/`decode`, never per call). The writer checks `v` as the
 * layout's own schema would (ranges, lengths, address form, digest length,
 * well-formed strings, tags) and throws `Invalid` on anything else.
 */
interface Codec {
  read: (r: Reader) => any
  write: (w: Writer, v: any) => void
  /** The fewest bytes a value can take (a lower bound; an unfinished recursive layout counts as 0). */
  min: number
  /** Structs only: read the fields into `o` (a flattened enum variant then needs no copy). */
  readInto: ((r: Reader, o: Record<string, unknown>) => any) | undefined
}

const codecs = /* @__PURE__ */ new WeakMap<Layout, Codec>()
/** `Bcs.lazy` layouts (proxies), and how to reach the layout each stands for. */
const lazies = /* @__PURE__ */ new WeakMap<Layout, () => Layout>()

const compile = (layout: Layout): Codec => {
  let l = layout
  for (let f = lazies.get(l); f; f = lazies.get(l)) l = f()
  let c = codecs.get(l)
  if (c) return c
  // Registered before its parts, so a recursive layout finds itself.
  c = { read: undefined!, write: undefined!, min: 0, readInto: undefined }
  codecs.set(l, c)
  try {
    build(c, l)
  } catch (e) {
    // A part has no layout. Parts already built may hold `c`: make it fail the same way everywhere.
    c.read = c.write = () => {
      throw e
    }
  }
  return c
}

const readU32 = (buf: Uint8Array, p: number) =>
  (buf[p]! | (buf[p + 1]! << 8) | (buf[p + 2]! << 16) | (buf[p + 3]! << 24)) >>> 0
const M64 = 0xffffffffffffffffn

/** The reader of `u8`, by identity: `vector(u8)` takes a fast path. */
const readByte = (r: Reader) => r.buf[take(r, 1)]!

// vector<u8>: one bounds check and a plain loop, no per-element calls.
const readBytes = (r: Reader): Array<number> => {
  const n = readUleb(r)
  checkLength(r, n, 1)
  const p = take(r, n)
  const buf = r.buf
  // Safe to size up front: the length is bounded by the input now.
  const out: Array<number> = new Array(n)
  for (let i = 0; i < n; i++) out[i] = buf[p + i]!
  return out
}
const writeBytes = (w: Writer, v: any) => {
  invalid(Array.isArray(v))
  const n = v.length
  w.uleb(n)
  w.ensure(n)
  const buf = w.buf
  const p = w.pos
  for (let i = 0; i < n; i++) {
    const x = v[i]
    invalid(isUint(x, 255))
    buf[p + i] = x
  }
  w.pos = p + n
}

const build = (c: Codec, l: Layout): void => {
  switch (l._tag) {
    case "bool":
      c.min = 1
      c.read = (r) => {
        const p = take(r, 1)
        const b = r.buf[p]!
        if (b > 1) fail(`invalid bool ${b}`, p)
        return b === 1
      }
      c.write = (w, v) => {
        invalid(typeof v === "boolean")
        w.uint(v ? 1 : 0, 1)
      }
      return
    case "uint": {
      const bytes = l.bytes
      const max = 2 ** (bytes * 8) - 1
      c.min = bytes
      c.read = bytes === 1 ? readByte : (r) => {
        const p = take(r, bytes)
        return bytes === 2 ? r.buf[p]! | (r.buf[p + 1]! << 8) : readU32(r.buf, p)
      }
      c.write = (w, v) => {
        invalid(isUint(v, max))
        w.uint(v, bytes)
      }
      return
    }
    case "ubig": {
      const bytes = l.bytes
      const max = (1n << BigInt(bytes * 8)) - 1n
      c.min = bytes
      c.read = bytes === 8
        ? (r) => {
          const p = take(r, 8)
          // Under 2^32 (counts, small balances): one `BigInt` of a number, no DataView.
          return readU32(r.buf, p + 4) === 0 ? BigInt(readU32(r.buf, p)) : r.view.getBigUint64(p, true)
        }
        : (r) => {
          const p = take(r, bytes)
          const view = r.view
          let v = view.getBigUint64(p + bytes - 8, true)
          for (let i = bytes - 16; i >= 0; i -= 8) v = (v << 64n) | view.getBigUint64(p + i, true)
          return v
        }
      c.write = (w, v) => {
        invalid(typeof v === "bigint" && v >= 0n && v <= max)
        if (v <= 0xffffffffn) {
          // A small value: no bigint work beyond one conversion.
          w.uint(Number(v), 4)
          w.uint(0, bytes - 4)
          return
        }
        w.ensure(bytes)
        for (let i = 0; i < bytes; i += 8) {
          w.view.setBigUint64(w.pos + i, v & M64, true)
          v >>= 64n
        }
        w.pos += bytes
      }
      return
    }
    case "uleb128":
      c.min = 1
      c.read = readUleb
      c.write = (w, v) => {
        invalid(isUint(v, 0xffffffff))
        w.uleb(v)
      }
      return
    case "string":
      c.min = 1
      c.read = (r) => {
        const n = readUleb(r)
        const p = take(r, n)
        return utf8d.decode(r.buf.subarray(p, p + n))
      }
      c.write = (w, v) => {
        invalid(typeof v === "string")
        invalid(!LONE_SURROGATE.test(v))
        const b = utf8e.encode(v)
        w.uleb(b.length)
        w.raw(b)
      }
      return
    case "bytes": {
      const length = l.length
      c.min = length
      c.read = (r) => {
        const p = take(r, length)
        return r.buf.slice(p, p + length)
      }
      c.write = (w, v) => {
        invalid(v instanceof Uint8Array && v.length === length)
        w.raw(v)
      }
      return
    }
    case "byteVector":
      c.min = 1
      c.read = (r) => {
        const n = readUleb(r)
        const p = take(r, n)
        return r.buf.slice(p, p + n)
      }
      c.write = (w, v) => {
        invalid(v instanceof Uint8Array)
        w.uleb(v.length)
        w.raw(v)
      }
      return
    case "address":
      c.min = 32
      c.read = (r) => {
        const p = take(r, 32)
        const buf = r.buf
        const out = ADDRESS_CHARS
        for (let i = 0; i < 32; i++) {
          const b = buf[p + i]!
          out[2 + 2 * i] = hexDigit(b >> 4)
          out[3 + 2 * i] = hexDigit(b & 15)
        }
        return latin1.decode(out)
      }
      c.write = (w, v) => {
        // As `/^0x[0-9a-f]{64}$/`, checked while converting.
        invalid(typeof v === "string" && v.length === 66 && v.charCodeAt(0) === 48 && v.charCodeAt(1) === 120)
        w.ensure(32)
        const buf = w.buf
        const p = w.pos - 1
        let bad = 0
        for (let i = 2; i < 66; i += 2) {
          const hi = nibble(v.charCodeAt(i))
          const lo = nibble(v.charCodeAt(i + 1))
          bad |= hi | lo
          buf[p + (i >> 1)] = (hi << 4) | lo
        }
        // A non-hex digit is -1, which sets the sign bit.
        invalid(bad >= 0)
        w.pos = p + 33
      }
      return
    case "base58":
      c.min = 1
      c.read = (r) => {
        const n = readUleb(r)
        const p = take(r, n)
        // Not a digest: the schema pass reports it.
        if (n !== 32) r.suspect = true
        return toBase58(r.buf, p, n)
      }
      c.write = (w, v) => {
        invalid(typeof v === "string")
        const b = fromBase58(v)
        invalid(b !== undefined && b.length === 32)
        w.uleb(32)
        w.raw(b!)
      }
      return
    case "vector": {
      const item = compile(l.item())
      c.min = 1
      if (item.read === readByte) {
        c.read = readBytes
        c.write = writeBytes
        return
      }
      c.read = (r) => {
        const n = readUleb(r)
        checkLength(r, n, item.min)
        const out: Array<unknown> = new Array(n)
        for (let i = 0; i < n; i++) out[i] = item.read(r)
        return out
      }
      c.write = (w, v) => {
        invalid(Array.isArray(v))
        const n = v.length
        w.uleb(n)
        for (let i = 0; i < n; i++) item.write(w, v[i])
      }
      return
    }
    case "option": {
      c.min = 1
      const item = compile(l.item())
      c.read = (r) => {
        const p = take(r, 1)
        const tag = r.buf[p]
        if (tag === 0) return Option.none()
        if (tag !== 1) fail(`invalid option tag ${tag}`, p)
        return Option.some(item.read(r))
      }
      c.write = (w, v) => {
        invalid(Option.isOption(v))
        w.uint(Option.isSome(v) ? 1 : 0, 1)
        if (Option.isSome(v)) item.write(w, v.value)
      }
      return
    }
    case "tuple":
    case "fixedArray": {
      const items = l._tag === "tuple" ? l.items.map((i) => compile(i())) : Array(l.length).fill(compile(l.item()))
      const n = items.length
      c.min = items.reduce((sum, i) => sum + i.min, 0)
      c.read = (r) => {
        const out: Array<unknown> = []
        for (let i = 0; i < n; i++) out.push(items[i]!.read(r))
        return out
      }
      c.write = (w, v) => {
        invalid(Array.isArray(v) && v.length === n)
        for (let i = 0; i < n; i++) items[i]!.write(w, v[i])
      }
      return
    }
    case "struct": {
      const keys = l.fields.map(([k]) => k)
      const fields = l.fields.map(([, f]) => compile(f()))
      const n = keys.length
      c.min = fields.reduce((sum, f) => sum + f.min, 0)
      const readInto = (r: Reader, o: Record<string, unknown>) => {
        for (let i = 0; i < n; i++) o[keys[i]!] = fields[i]!.read(r)
        return o
      }
      c.readInto = readInto
      c.read = (r) => readInto(r, {})
      c.write = (w, v) => {
        invalid(isRecord(v))
        for (let i = 0; i < n; i++) fields[i]!.write(w, v[keys[i]!])
      }
      return
    }
    case "enum": {
      c.min = 1
      const index = new Map<unknown, number>()
      const readers: Array<(r: Reader) => unknown> = []
      const writers: Array<(w: Writer, v: any) => void> = []
      l.variants.forEach(({ layout, name, payload }, i) => {
        index.set(name, i)
        if (payload === "unit") {
          readers.push(() => ({ _tag: name }))
          writers.push(() => {})
          return
        }
        const p = compile(layout!())
        if (payload === "flat") {
          // A flat payload is a struct, which has `readInto`.
          readers.push((r) => p.readInto!(r, { _tag: name }))
          writers.push((w, v) => p.write(w, v))
        } else {
          readers.push((r) => ({ _tag: name, value: p.read(r) }))
          writers.push((w, v) => p.write(w, v.value))
        }
      })
      c.read = (r) => {
        const idx = readUleb(r)
        const read = readers[idx]
        return read === undefined ? fail(`unknown enum variant ${idx}`, r.pos) : read(r)
      }
      c.write = (w, v) => {
        invalid(isRecord(v))
        const idx = index.get(v._tag)
        invalid(idx !== undefined)
        w.uleb(idx!)
        writers[idx!]!(w, v)
      }
      return
    }
  }
}

let spare: Writer | undefined
/** Write `v` with `c` into a reused buffer; returns a copy of the bytes. */
const writeAll = (c: Codec, v: unknown): Uint8Array => {
  const w = spare ?? new Writer(1024)
  spare = undefined
  w.pos = 0
  try {
    c.write(w, v)
    return w.buf.slice(0, w.pos)
  } finally {
    // Don't hold on to a buffer a one-off large value grew.
    if (w.buf.length <= 65536) spare = w
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
  let codec: Codec | undefined
  return (value: T): Result.Result<Uint8Array, Schema.SchemaError> => {
    if (fast ??= trusted(schema)) {
      try {
        return Result.succeed(writeAll(codec ??= compile(layout), value))
      } catch {
        // refused (or too deep): the schema pass decides
      }
    }
    try {
      return Result.map(
        encodeSchema(value) as Result.Result<E, Schema.SchemaError>,
        (e) => writeAll(codec ??= compile(layout), e)
      )
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

/** Read one value from `r`, then decode it through the schema (`whole`: no trailing bytes). */
const reader = <T, E>(schema: Schema.Codec<T, E>) => {
  const layout = layoutOf(schema)
  const decodeSchema = Schema.decodeUnknownResult(schema as any)
  let fast: boolean | undefined
  let codec: Codec | undefined
  return (r: Reader, whole: boolean): Result.Result<T, BcsDecodeError | Schema.SchemaError> => {
    let raw: unknown
    try {
      raw = (codec ??= compile(layout)).read(r)
      if (whole && r.pos !== r.buf.length) {
        return Result.fail(new BcsDecodeError({ message: `${r.buf.length - r.pos} trailing bytes`, offset: r.pos }))
      }
    } catch (e) {
      if (e instanceof BcsDecodeError) return Result.fail(e)
      return Result.fail(new BcsDecodeError({ message: String(e), offset: -1 }))
    }
    if ((fast ??= trusted(schema)) && !r.suspect) return Result.succeed(raw as T)
    return decodeSchema(raw) as Result.Result<T, Schema.SchemaError>
  }
}

/**
 * Parse bytes, rejecting trailing bytes, then decode through the schema. A
 * schema made only of this module's schemas skips the schema pass: the reader
 * already checks what it would.
 */
export const decode = <T, E>(schema: Schema.Codec<T, E>) => {
  const read = reader(schema)
  return (bytes: Uint8Array): Result.Result<T, BcsDecodeError | Schema.SchemaError> => read(new Reader(bytes), true)
}

/**
 * Decode a value from the start of `bytes` and return it with the bytes after
 * it (a view, not a copy): read the head of a larger value without spelling
 * out the rest of its layout. `decode` is the same read that also insists
 * nothing follows.
 */
export const decodePrefix = <T, E>(schema: Schema.Codec<T, E>) => {
  const read = reader(schema)
  return (bytes: Uint8Array): Result.Result<{ readonly value: T; readonly rest: Uint8Array }, BcsDecodeError | Schema.SchemaError> => {
    const r = new Reader(bytes)
    return Result.map(read(r, false), (value) => ({ value, rest: bytes.subarray(r.pos) }))
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
