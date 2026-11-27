/**
 * Randomized BCS parity with @mysten/bcs (through @mysten/sui/bcs) for the core
 * Sui types, plus malformed input. Values are generated from each schema's BCS
 * layout with a seeded PRNG, so failures reproduce.
 */
import { bcs as mysten } from "@mysten/sui/bcs"
import { base58 } from "@scure/base"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { describe, expect, test } from "bun:test"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as T from "../src/TransactionData.ts"
import * as TypeTag from "../src/TypeTag.ts"
import { toB64, toMysten } from "./support.ts"

/** mulberry32 */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
type Rng = () => number

const int = (rng: Rng, n: number) => Math.floor(rng() * n)
const randomBytes = (rng: Rng, n: number) => {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = int(rng, 256)
  // Leading zeros exercise base58's "1" prefix and hex padding.
  if (n > 0 && rng() < 0.2) out.fill(0, 0, int(rng, n + 1))
  return out
}
/** Mostly small numbers, sometimes the bounds, sometimes anything. */
const randomBig = (rng: Rng, bits: number): bigint => {
  const r = rng()
  if (r < 0.1) return 0n
  if (r < 0.2) return (1n << BigInt(bits)) - 1n
  const width = r < 0.6 ? Math.min(bits, 8 + int(rng, 32)) : bits
  let v = 0n
  for (let i = 0; i < width; i += 8) v = (v << 8n) | BigInt(int(rng, 256))
  return v & ((1n << BigInt(bits)) - 1n)
}
const CHARS = ["a", "Z", "0", " ", "_", "é", "ü", "—", "€", "中", "😀", "\u0000", "﻿", "\u007F", "\u0080", "�"]
const randomString = (rng: Rng) => {
  let s = ""
  const n = rng() < 0.05 ? 200 + int(rng, 200) : int(rng, 12)
  for (let i = 0; i < n; i++) s += CHARS[int(rng, CHARS.length)]
  return s
}

/** A random value (our representation) of a layout; `depth` bounds recursion. */
const arbitrary = (l: Bcs.Layout, rng: Rng, depth = 0): any => {
  const len = () => (depth > 4 ? 0 : int(rng, 4))
  switch (l._tag) {
    case "bool":
      return rng() < 0.5
    case "uint":
      return Number(randomBig(rng, l.bytes * 8))
    case "ubig":
      return randomBig(rng, l.bytes * 8)
    case "uleb128":
      return Number(randomBig(rng, 32))
    case "string":
      return randomString(rng)
    case "bytes":
      return randomBytes(rng, l.length)
    case "byteVector":
      return randomBytes(rng, rng() < 0.05 ? 300 : int(rng, 40))
    case "address":
      return "0x" + Buffer.from(randomBytes(rng, 32)).toString("hex")
    case "base58":
      return base58.encode(randomBytes(rng, 32))
    case "vector":
      return Array.from({ length: len() }, () => arbitrary(l.item(), rng, depth + 1))
    case "fixedArray":
      return Array.from({ length: l.length }, () => arbitrary(l.item(), rng, depth + 1))
    case "option":
      return rng() < 0.5 ? Option.none() : Option.some(arbitrary(l.item(), rng, depth + 1))
    case "tuple":
      return l.items.map((i) => arbitrary(i(), rng, depth + 1))
    case "struct": {
      const o = Object.fromEntries(l.fields.map(([k, f]) => [k, arbitrary(f(), rng, depth + 1)]))
      // Mysten also checks a Move-level rule here: allowed proposers non-empty and strictly increasing.
      if ("proposers" in o) o.proposers = [...new Set([int(rng, 1000), ...o.proposers])].sort((a, b) => a - b)
      return o
    }
    case "enum": {
      const units = l.variants.filter((v) => v.payload === "unit")
      const pool = depth > 4 && units.length > 0 ? units : l.variants
      const v = pool[int(rng, pool.length)]!
      if (v.payload === "unit") return { _tag: v.name }
      const payload = arbitrary(v.layout!(), rng, depth + 1)
      return v.payload === "flat" ? { _tag: v.name, ...payload } : { _tag: v.name, value: payload }
    }
  }
}

const cases: ReadonlyArray<readonly [string, Bcs.BcsSchema<any, any>, { serialize: (v: any) => { toBytes(): Uint8Array }; parse: (b: Uint8Array) => unknown }]> = [
  ["TransactionData", T.TransactionData, mysten.TransactionData],
  ["TransactionKind", T.TransactionKind, mysten.TransactionKind],
  ["CallArg", T.CallArg, mysten.CallArg],
  ["Command", T.Command, mysten.Command],
  ["Argument", T.Argument, mysten.Argument],
  ["ObjectRef", T.ObjectRef, mysten.SuiObjectRef],
  ["GasData", T.GasData, mysten.GasData],
  ["TransactionExpiration", T.TransactionExpiration, mysten.TransactionExpiration],
  ["TypeTag", TypeTag.TypeTag, mysten.TypeTag],
  ["Address", Bcs.Address, mysten.Address],
  ["Digest", Bcs.Digest, mysten.ObjectDigest],
  ["u8", Bcs.u8, mysten.u8()],
  ["u16", Bcs.u16, mysten.u16()],
  ["u32", Bcs.u32, mysten.u32()],
  ["u64", Bcs.u64, mysten.u64()],
  ["u128", Bcs.u128, mysten.u128()],
  ["u256", Bcs.u256, mysten.u256()],
  ["uleb128", Bcs.uleb128, mysten.uleb128()],
  ["string", Bcs.string, mysten.string()],
  ["vector<u8>", Bcs.vector(Bcs.u8), mysten.vector(mysten.u8())],
  ["byteVector", Bcs.byteVector, mysten.byteVector()],
  ["vector<option<u256>>", Bcs.vector(Bcs.option(Bcs.u256)), mysten.vector(mysten.option(mysten.u256()))],
  ["vector<Address>", Bcs.vector(Bcs.Address), mysten.vector(mysten.Address)],
  ["tuple<bool, u16, string>", Bcs.tuple([Bcs.bool, Bcs.u16, Bcs.string]), mysten.tuple([mysten.bool(), mysten.u16(), mysten.string()])],
  ["fixedArray<3, u64>", Bcs.fixedArray(3, Bcs.u64), mysten.fixedArray(3, mysten.u64())]
]

const ROUNDS = 300

describe("random values: same bytes as @mysten/bcs, and back", () => {
  for (const [name, schema, theirs] of cases) {
    test(name, () => {
      const rng = prng(name.length * 7919 + name.charCodeAt(0))
      const layout = Bcs.layoutOf(schema)
      const encode = Bcs.encode(schema)
      const decode = Bcs.decode(schema)
      for (let i = 0; i < ROUNDS; i++) {
        const value = arbitrary(layout, rng)
        const ours = Result.getOrThrow(encode(value))
        expect(toB64(ours)).toBe(toB64(theirs.serialize(toMysten(layout, value)).toBytes()))
        const back = Result.getOrThrow(decode(ours))
        expect(back).toEqual(value)
        theirs.parse(ours)
      }
    })
  }
})

describe("primitive decodes agree with @mysten/bcs", () => {
  test("integers, strings and addresses", () => {
    const rng = prng(42)
    const check = (schema: Bcs.BcsSchema<any, any>, theirs: { parse: (b: Uint8Array) => unknown }, norm: (v: any) => unknown) => {
      const layout = Bcs.layoutOf(schema)
      for (let i = 0; i < ROUNDS; i++) {
        const bytes = Bcs.encodeSync(schema)(arbitrary(layout, rng))
        expect(norm(Bcs.decodeSync(schema)(bytes))).toEqual(theirs.parse(bytes))
      }
    }
    check(Bcs.vector(Bcs.u64), mysten.vector(mysten.u64()), (v) => v.map(String))
    check(Bcs.vector(Bcs.u128), mysten.vector(mysten.u128()), (v) => v.map(String))
    check(Bcs.vector(Bcs.u256), mysten.vector(mysten.u256()), (v) => v.map(String))
    check(Bcs.vector(Bcs.u32), mysten.vector(mysten.u32()), (v) => v)
    check(Bcs.vector(Bcs.string), mysten.vector(mysten.string()), (v) => v)
    check(Bcs.vector(Bcs.Address), mysten.vector(mysten.Address), (v) => v)
    check(Bcs.Digest, mysten.ObjectDigest, (v) => v)
  })
})

describe("malformed input", () => {
  /** Accepted bytes are canonical: they re-encode to themselves, and @mysten/bcs reads the same value. */
  const accepted = (schema: Bcs.BcsSchema<any, any>, theirs: { serialize: (v: any) => { toBytes(): Uint8Array } }, bytes: Uint8Array) => {
    const r = Bcs.decode(schema)(bytes)
    if (Result.isFailure(r)) {
      expect(r.failure instanceof Bcs.BcsDecodeError || r.failure instanceof Schema.SchemaError).toBe(true)
      return false
    }
    expect(toB64(Bcs.encodeSync(schema)(r.success))).toBe(toB64(bytes))
    let mine: Uint8Array
    try {
      mine = theirs.serialize(toMysten(Bcs.layoutOf(schema), r.success)).toBytes()
    } catch (e) {
      // Not a BCS rule: Mysten refuses empty or unsorted allowed proposers, which BCS (and we) accept.
      if (String(e).includes("Allowed proposers")) return true
      throw e
    }
    expect(toB64(mine)).toBe(toB64(bytes))
    return true
  }

  for (const [name, schema, theirs] of cases) {
    test(`${name}: mutated, truncated and extended bytes fail typed or round-trip exactly`, () => {
      const rng = prng(name.length * 31 + 7)
      const layout = Bcs.layoutOf(schema)
      for (let i = 0; i < ROUNDS; i++) {
        const good = Bcs.encodeSync(schema)(arbitrary(layout, rng))
        // truncated
        if (good.length > 0) expect(accepted(schema, theirs, good.subarray(0, int(rng, good.length)))).toBe(false)
        // trailing byte
        const longer = new Uint8Array(good.length + 1)
        longer.set(good)
        expect(accepted(schema, theirs, longer)).toBe(false)
        // random byte flips
        const bad = good.slice()
        for (let k = 0; k <= int(rng, 3); k++) if (bad.length) {
          const at = int(rng, bad.length)
          bad[at] = bad[at]! ^ (1 << int(rng, 8))
        }
        accepted(schema, theirs, bad)
        // random garbage
        accepted(schema, theirs, randomBytes(rng, int(rng, 64)))
      }
    })
  }

  test("specific malformed encodings are refused with a typed error", () => {
    const err = (schema: Bcs.BcsSchema<any, any>, bytes: Array<number>, message: string) => {
      const r = Bcs.decode(schema)(new Uint8Array(bytes))
      expect(Result.isFailure(r) && r.failure instanceof Bcs.BcsDecodeError && r.failure.message).toContain(message)
    }
    err(Bcs.string, [2, 0xc3, 0x28], "")
    err(Bcs.string, [3, 0xed, 0xa0, 0x80], "") // CESU-style surrogate
    err(Bcs.string, [2, 0xc0, 0x80], "") // overlong NUL
    err(Bcs.vector(Bcs.u8), [0x80, 0x00], "non-canonical uleb128")
    err(Bcs.vector(Bcs.u8), [0x81, 0x00], "non-canonical uleb128")
    err(Bcs.vector(Bcs.Address), [2, ...new Uint8Array(40)], "exceeds the remaining input")
    err(Bcs.vector(Bcs.u8), [0xff, 0xff, 0xff, 0xff, 0x0f], "exceeds the remaining input")
    err(T.TransactionData, [1], "unknown enum variant 1")
    err(T.Argument, [4], "unknown enum variant 4")
    err(TypeTag.TypeTag, [11], "unknown enum variant 11")
    err(Bcs.option(Bcs.u8), [2, 1], "invalid option tag 2")
    err(Bcs.bool, [3], "invalid bool 3")
    err(Bcs.u256, new Array(31).fill(0), "unexpected end of input")
    err(Bcs.Address, new Array(33).fill(0), "1 trailing bytes")
  })

  test("a digest that is not 32 bytes is a schema failure, never a bad value", () => {
    for (const n of [0, 1, 31, 33]) {
      const r = Bcs.decode(Bcs.Digest)(new Uint8Array([n, ...new Uint8Array(n).fill(5)]))
      expect(Result.isFailure(r) && r.failure instanceof Schema.SchemaError).toBe(true)
    }
  })

  test("values the schema refuses do not encode", () => {
    const enc = <A>(schema: Bcs.BcsSchema<A, any>, v: unknown) => Bcs.encode(schema)(v as A)
    for (const v of ["0x" + "A".repeat(64), "0x" + "0".repeat(63), "0x" + "0".repeat(65), "0X" + "0".repeat(64), "0x" + "g".repeat(64), "0x" + "0".repeat(63) + "١", 5]) {
      expect(Result.isFailure(enc(Bcs.Address, v))).toBe(true)
    }
    for (const v of ["", "0", "1".repeat(33), base58.encode(new Uint8Array(31).fill(9)), base58.encode(new Uint8Array(33).fill(9)), "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKl"]) {
      expect(Result.isFailure(enc(Bcs.Digest, v))).toBe(true)
    }
    for (const v of ["\ud800", "abc\udfff", "\udc00\ud800"]) expect(Result.isFailure(enc(Bcs.string, v))).toBe(true)
    expect(Result.isFailure(enc(Bcs.u64, -1n))).toBe(true)
    expect(Result.isFailure(enc(Bcs.u64, 1n << 64n))).toBe(true)
    expect(Result.isFailure(enc(Bcs.u128, 1n << 128n))).toBe(true)
    expect(Result.isFailure(enc(Bcs.u256, 1n << 256n))).toBe(true)
    expect(Result.isFailure(enc(Bcs.u64, 1))).toBe(true)
    expect(Result.isFailure(enc(Bcs.u16, 65536))).toBe(true)
    expect(Result.isFailure(enc(Bcs.u32, 1.5))).toBe(true)
    expect(Result.isFailure(enc(Bcs.vector(Bcs.u8), [1, 256]))).toBe(true)
    expect(Result.isFailure(enc(T.Argument, { _tag: "Nope" }))).toBe(true)
    expect(Result.isFailure(enc(T.Argument, { _tag: "Input", value: -1 }))).toBe(true)
  })
})

describe("base58 digests agree with @scure/base", () => {
  test("encode and decode random 32-byte digests", () => {
    const rng = prng(58)
    const d = Bcs.decode(Bcs.Digest)
    for (let i = 0; i < 2000; i++) {
      const raw = randomBytes(rng, 32)
      const s = base58.encode(raw)
      const bytes = new Uint8Array([32, ...raw])
      expect<string>(Result.getOrThrow(d(bytes))).toBe(s)
      expect(Bcs.encodeSync(Bcs.Digest)(s as Bcs.Digest)).toEqual(bytes)
    }
    expect<string>(Result.getOrThrow(d(new Uint8Array(33).fill(0, 1).fill(32, 0, 1)))).toBe("1".repeat(32))
  })
  test("random base58 strings: we accept exactly the 32-byte ones", () => {
    const rng = prng(59)
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    for (let i = 0; i < 2000; i++) {
      let s = ""
      const n = 40 + int(rng, 8)
      for (let k = 0; k < n; k++) s += alphabet[rng() < 0.05 ? 0 : int(rng, 58)]
      const raw = base58.decode(s)
      const r = Bcs.encode(Bcs.Digest)(s as Bcs.Digest)
      if (raw.length === 32) expect(Result.getOrThrow(r)).toEqual(new Uint8Array([32, ...raw]))
      else expect(Result.isFailure(r)).toBe(true)
    }
  })
})
