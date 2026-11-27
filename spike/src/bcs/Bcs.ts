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
import { Data, Effect, Option, Result, Schema, SchemaAST, SchemaIssue, SchemaTransformation } from "effect"

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

const withLayout = <S extends Schema.Top>(schema: S, layout: Layout): S =>
  schema.annotate({ [BCS]: layout } as any) as S

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

const uint = (bytes: 1 | 2 | 4) =>
  withLayout(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** (bytes * 8) - 1 })),
    { _tag: "uint", bytes }
  )
const ubig = (bytes: 8 | 16 | 32) =>
  withLayout(
    Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: (1n << BigInt(bytes * 8)) - 1n })),
    { _tag: "ubig", bytes }
  )

export const bool = withLayout(Schema.Boolean, { _tag: "bool" })
export const u8 = uint(1)
export const u16 = uint(2)
export const u32 = uint(4)
export const u64 = ubig(8)
export const u128 = ubig(16)
export const u256 = ubig(32)
export const uleb128 = withLayout(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 32 - 1 })), {
  _tag: "uleb128"
})
export const string = withLayout(Schema.String, { _tag: "string" })
export const byteVector = withLayout(Schema.Uint8Array, { _tag: "byteVector" })
export const bytes = (length: number) =>
  withLayout(
    Schema.Uint8Array.check(Schema.makeFilter((u) => u.length === length || `expected ${length} bytes`)),
    { _tag: "bytes", length }
  )

/** A 32-byte account address / object id, as normalized `0x` + 64 lowercase hex. */
export const Address = withLayout(
  Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/)).pipe(Schema.brand("SuiAddress")),
  { _tag: "address" }
)
export type Address = typeof Address.Type

/** A 32-byte digest shown as base58 (object/transaction digests, chain ids). */
export const Digest = withLayout(
  Schema.String.check(
    Schema.makeFilter((s) => {
      try {
        return base58.decode(s).length === 32 || "expected a 32-byte base58 digest"
      } catch {
        return "invalid base58"
      }
    })
  ).pipe(Schema.brand("Digest")),
  { _tag: "base58" }
)
export type Digest = typeof Digest.Type

// -----------------------------------------------------------------------------
// Combinators
// -----------------------------------------------------------------------------

export const vector = <S extends Schema.Top>(item: S) =>
  withLayout(Schema.Array(item), { _tag: "vector", item: () => layoutOf(item) })

export const fixedArray = <S extends Schema.Top>(length: number, item: S) =>
  withLayout(
    Schema.Array(item).check(Schema.makeFilter((a) => a.length === length || `expected ${length} items`)),
    { _tag: "fixedArray", length, item: () => layoutOf(item) }
  )

export const option = <S extends Schema.Top>(item: S) =>
  withLayout(Schema.Option(item), { _tag: "option", item: () => layoutOf(item) })

export const tuple = <const Items extends ReadonlyArray<Schema.Top>>(items: Items) =>
  withLayout(Schema.Tuple(items), { _tag: "tuple", items: items.map((i) => () => layoutOf(i)) })

export const struct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  withLayout(Schema.Struct(fields), {
    _tag: "struct",
    fields: Object.entries(fields).map(([k, s]) => [k, () => layoutOf(s as Schema.Top)] as const)
  })

/** Recursive types: `Bcs.lazy(() => TypeTag)`. */
export const lazy = <S extends Schema.Top>(f: () => S) =>
  withLayout(Schema.suspend(f), lazyLayout(() => layoutOf(f())))
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
  const members = Object.entries(variants).map(([name, payload]) => {
    if (payload === null) return Schema.TaggedStruct(name, {})
    if (isStructSchema(payload)) return Schema.TaggedStruct(name, payload.fields)
    return Schema.TaggedStruct(name, { value: payload })
  })
  const layout: Layout = {
    _tag: "enum",
    variants: Object.entries(variants).map(([name, payload]) =>
      payload === null
        ? { name, payload: "unit" as const, layout: undefined }
        : isStructSchema(payload)
        ? { name, payload: "flat" as const, layout: () => layoutOf(payload) }
        : { name, payload: "value" as const, layout: () => layoutOf(payload) }
    )
  }
  return withLayout(Schema.Union(members), layout) as any
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
      if ((b & 0x80) === 0) break
      shift += 7
      if (shift > 28) throw new BcsDecodeError({ message: "uleb128 overflow", offset: this.pos })
    }
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
    let v = 0n
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[this.pos + i]!)
    this.pos += bytes
    return v
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}
const utf8e = new TextEncoder()
const utf8d = new TextDecoder("utf-8", { fatal: true })

const write = (w: Writer, l: Layout, v: any): void => {
  switch (l._tag) {
    case "bool":
      return w.u8(v ? 1 : 0)
    case "uint":
      return w.uint(v, l.bytes)
    case "ubig":
      return w.ubig(v, l.bytes)
    case "uleb128":
      return w.uleb(v)
    case "string": {
      const b = utf8e.encode(v)
      w.uleb(b.length)
      return w.raw(b)
    }
    case "bytes":
      return w.raw(v)
    case "byteVector":
      w.uleb(v.length)
      return w.raw(v)
    case "address":
      return w.raw(unhex(v.slice(2)))
    case "base58": {
      const b = base58.decode(v)
      w.uleb(b.length)
      return w.raw(b)
    }
    case "vector": {
      w.uleb(v.length)
      const item = l.item()
      for (const x of v) write(w, item, x)
      return
    }
    case "fixedArray": {
      const item = l.item()
      for (const x of v) write(w, item, x)
      return
    }
    case "option":
      if (Option.isNone(v)) return w.u8(0)
      w.u8(1)
      return write(w, l.item(), v.value)
    case "tuple":
      return l.items.forEach((item, i) => write(w, item(), v[i]))
    case "struct":
      for (const [k, f] of l.fields) write(w, f(), v[k])
      return
    case "enum": {
      const idx = l.variants.findIndex((x) => x.name === v._tag)
      if (idx < 0) throw new Error(`unknown variant ${v._tag}`)
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
      return "0x" + hex(r.raw(32))
    case "base58":
      return base58.encode(r.raw(r.uleb()))
    case "vector": {
      const n = r.uleb()
      const item = l.item()
      const out = new Array(n)
      for (let i = 0; i < n; i++) out[i] = read(r, item)
      return out
    }
    case "fixedArray": {
      const item = l.item()
      return Array.from({ length: l.length }, () => read(r, item))
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

export class BcsDecodeError extends Data.TaggedError("BcsDecodeError")<{
  readonly message: string
  readonly offset: number
}> {}

/**
 * Serialize the *encoded* side of a BCS schema. Pure and synchronous: BCS of a
 * valid value cannot fail. Validates first, so an out-of-range u8 is a typed
 * failure rather than silently-truncated bytes.
 */
export const encode = <T, E>(schema: Schema.Codec<T, E>) => {
  const layout = layoutOf(schema)
  const encodeSchema = Schema.encodeResult(schema as any)
  return (value: T): Result.Result<Uint8Array, Schema.SchemaError> =>
    Result.map(encodeSchema(value) as Result.Result<E, Schema.SchemaError>, (e) => {
      const w = new Writer()
      write(w, layout, e)
      return w.result()
    })
}

export const encodeSync = <T, E>(schema: Schema.Codec<T, E>) => {
  const f = encode(schema)
  return (value: T): Uint8Array => Result.getOrThrow(f(value))
}

/** Parse bytes, rejecting trailing bytes, then decode through the schema. */
export const decode = <T, E>(schema: Schema.Codec<T, E>) => {
  const layout = layoutOf(schema)
  const decodeSchema = Schema.decodeUnknownResult(schema as any)
  return (bytes: Uint8Array): Result.Result<T, BcsDecodeError | Schema.SchemaError> => {
    let raw: unknown
    try {
      const r = new Reader(bytes)
      raw = read(r, layout)
      if (r.pos !== bytes.length) {
        return Result.fail(new BcsDecodeError({ message: `${bytes.length - r.pos} trailing bytes`, offset: r.pos }))
      }
    } catch (e) {
      if (e instanceof BcsDecodeError) return Result.fail(e)
      return Result.fail(new BcsDecodeError({ message: String(e), offset: -1 }))
    }
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
