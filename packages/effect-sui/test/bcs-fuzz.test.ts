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
  ["Digest", Bcs.Digest, mysten.ObjectDigest],
  ["u128", Bcs.u128, mysten.u128()],
  ["uleb128", Bcs.uleb128, mysten.uleb128()],
  ["vector<u8>", Bcs.vector(Bcs.u8), mysten.vector(mysten.u8())],
  ["byteVector", Bcs.byteVector, mysten.byteVector()],
  ["vector<option<u256>>", Bcs.vector(Bcs.option(Bcs.u256)), mysten.vector(mysten.option(mysten.u256()))],
  ["vector<Address>", Bcs.vector(Bcs.Address), mysten.vector(mysten.Address)],
  ["tuple<bool, u16, string>", Bcs.tuple([Bcs.bool, Bcs.u16, Bcs.string]), mysten.tuple([mysten.bool(), mysten.u16(), mysten.string()])],
  ["fixedArray<3, u64>", Bcs.fixedArray(3, Bcs.u64), mysten.fixedArray(3, mysten.u64())]
]


/** Per schema; failures reproduce from the seed. */
const ROUNDS = 100

/**
 * Bytes that decode are canonical: they re-encode to themselves and @mysten/bcs
 * writes the same bytes for the decoded value. Returns a problem, or undefined.
 */
const checkDecoded = (schema: Bcs.BcsSchema<any, any>, theirs: { serialize: (v: any) => { toBytes(): Uint8Array } }, bytes: Uint8Array) => {
  const r = Bcs.decode(schema)(bytes)
  if (Result.isFailure(r)) {
    return r.failure instanceof Bcs.BcsDecodeError || r.failure instanceof Schema.SchemaError ? "refused" : `untyped failure ${String(r.failure)}`
  }
  if (toB64(Bcs.encodeSync(schema)(r.success)) !== toB64(bytes)) return `not canonical: ${toB64(bytes)}`
  try {
    if (toB64(theirs.serialize(toMysten(Bcs.layoutOf(schema), r.success)).toBytes()) !== toB64(bytes)) return `@mysten/bcs disagrees: ${toB64(bytes)}`
  } catch (e) {
    // Not a BCS rule: Mysten refuses empty or unsorted allowed proposers, which BCS (and we) accept.
    if (!String(e).includes("Allowed proposers")) throw e
  }
  return "accepted"
}

describe("random values and their corruptions, against @mysten/bcs", () => {
  for (const [name, schema, theirs] of cases) {
    test(name, () => {
      const rng = prng(name.length * 7919 + name.charCodeAt(0))
      const layout = Bcs.layoutOf(schema)
      const values = Array.from({ length: ROUNDS }, () => arbitrary(layout, rng))
      const ours = values.map((v) => Result.getOrThrow(Bcs.encode(schema)(v)))
      // Same bytes as @mysten/bcs, which also parses them; and back to the same value.
      expect(ours.map(toB64)).toEqual(values.map((v) => toB64(theirs.serialize(toMysten(layout, v)).toBytes())))
      for (const b of ours) theirs.parse(b)
      expect(ours.map((b) => Result.getOrThrow(Bcs.decode(schema)(b)))).toEqual(values)

      // Truncated or extended bytes are refused (typed); flipped bits and garbage are refused or canonical.
      const problems: Array<string> = []
      for (const good of ours) {
        const longer = new Uint8Array(good.length + 1)
        longer.set(good)
        const shorter = good.length > 0 ? [good.subarray(0, int(rng, good.length))] : []
        for (const b of [...shorter, longer]) {
          const r = checkDecoded(schema, theirs, b)
          if (r !== "refused") problems.push(`${toB64(b)}: ${r}`)
        }
        const flipped = good.slice()
        for (let k = 0; k <= int(rng, 3); k++) if (flipped.length) {
          const at = int(rng, flipped.length)
          flipped[at] = flipped[at]! ^ (1 << int(rng, 8))
        }
        for (const b of [flipped, randomBytes(rng, int(rng, 64))]) {
          const r = checkDecoded(schema, theirs, b)
          if (r !== "refused" && r !== "accepted") problems.push(r)
        }
      }
      expect(problems).toEqual([])
    })
  }

  test("integers, strings and addresses decode to the values @mysten/bcs reads", () => {
    const rng = prng(42)
    const check = (schema: Bcs.BcsSchema<any, any>, theirs: { parse: (b: Uint8Array) => unknown }, norm: (v: any) => unknown) => {
      const layout = Bcs.layoutOf(schema)
      const bytes = Array.from({ length: ROUNDS }, () => Bcs.encodeSync(schema)(arbitrary(layout, rng)))
      expect(bytes.map((b) => norm(Bcs.decodeSync(schema)(b)))).toEqual(bytes.map((b) => theirs.parse(b)))
    }
    check(Bcs.vector(Bcs.u64), mysten.vector(mysten.u64()), (v) => v.map(String))
    check(Bcs.vector(Bcs.u128), mysten.vector(mysten.u128()), (v) => v.map(String))
    check(Bcs.vector(Bcs.u256), mysten.vector(mysten.u256()), (v) => v.map(String))
    check(Bcs.vector(Bcs.u32), mysten.vector(mysten.u32()), (v) => v)
    check(Bcs.vector(Bcs.string), mysten.vector(mysten.string()), (v) => v)
    check(Bcs.vector(Bcs.Address), mysten.vector(mysten.Address), (v) => v)
    check(Bcs.Digest, mysten.ObjectDigest, (v) => v)
  })

  test("values the schema refuses do not encode", () => {
    const enc = <A>(schema: Bcs.BcsSchema<A, any>, v: unknown) => Bcs.encode(schema)(v as A)
    const accepted = [
      ...["0x" + "A".repeat(64), "0x" + "0".repeat(63), "0x" + "0".repeat(65), "0X" + "0".repeat(64), "0x" + "g".repeat(64), "0x" + "0".repeat(63) + "١", 5]
        .filter((v) => Result.isSuccess(enc(Bcs.Address, v))),
      ...["", "0", "1".repeat(33), base58.encode(new Uint8Array(31).fill(9)), base58.encode(new Uint8Array(33).fill(9)), "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKl"]
        .filter((v) => Result.isSuccess(enc(Bcs.Digest, v))),
      ...([
        [Bcs.u64, -1n],
        [Bcs.u64, 1n << 64n],
        [Bcs.u128, 1n << 128n],
        [Bcs.u256, 1n << 256n],
        [Bcs.u64, 1],
        [Bcs.u16, 65536],
        [Bcs.u32, 1.5],
        [Bcs.vector(Bcs.u8), [1, 256]],
        [T.Argument, { _tag: "Nope" }],
        [T.Argument, { _tag: "Input", value: -1 }]
      ] as ReadonlyArray<readonly [Bcs.BcsSchema<any, any>, unknown]>).filter(([s, v]) => Result.isSuccess(enc(s, v))).map(([, v]) => v)
    ]
    expect(accepted).toEqual([])
  })
})

describe("base58 digests agree with @scure/base", () => {
  test("random 32-byte digests both ways; random strings accepted exactly when 32 bytes", () => {
    const rng = prng(58)
    const raws = Array.from({ length: 200 }, () => randomBytes(rng, 32))
    expect(raws.map((raw) => Result.getOrThrow(Bcs.decode(Bcs.Digest)(new Uint8Array([32, ...raw]))) as string)).toEqual(raws.map((raw) => base58.encode(raw)))
    expect(raws.map((raw) => toB64(Bcs.encodeSync(Bcs.Digest)(base58.encode(raw) as Bcs.Digest)))).toEqual(raws.map((raw) => toB64(new Uint8Array([32, ...raw]))))
    expect(Result.getOrThrow(Bcs.decode(Bcs.Digest)(new Uint8Array(33).fill(0, 1).fill(32, 0, 1))) as string).toBe("1".repeat(32))

    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    const strings = Array.from({ length: 200 }, () => {
      let s = ""
      const n = 40 + int(rng, 8)
      for (let k = 0; k < n; k++) s += alphabet[rng() < 0.05 ? 0 : int(rng, 58)]
      return s
    })
    const ours = strings.map((s) => Result.match(Bcs.encode(Bcs.Digest)(s as Bcs.Digest), { onSuccess: toB64, onFailure: () => null }))
    const expected = strings.map((s) => {
      const raw = base58.decode(s)
      return raw.length === 32 ? toB64(new Uint8Array([32, ...raw])) : null
    })
    expect(ours).toEqual(expected)
  })
})
