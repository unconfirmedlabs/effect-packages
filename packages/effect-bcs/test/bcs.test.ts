/**
 * Canonical-encoding rules and decode bounds. Randomized parity with @mysten/bcs
 * lives in packages/effect-sui/test/bcs-fuzz.test.ts.
 */
import { describe, expect, test } from "bun:test"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"

const uleb = (n: number) => {
  const out: Array<number> = []
  do {
    let b = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    out.push(b)
  } while (n > 0)
  return new Uint8Array(out)
}

const failure = <A, E>(r: Result.Result<A, E>): E => {
  if (Result.isSuccess(r)) throw new Error(`expected a failure, got ${String(r.success)}`)
  return r.failure
}

const decodeError = (r: Result.Result<unknown, unknown>) => {
  const e = failure(r)
  expect(e).toBeInstanceOf(Bcs.BcsDecodeError)
  return e as Bcs.BcsDecodeError
}

/** Each case: schema, bytes, the decode error message. */
const refused: ReadonlyArray<readonly [string, Bcs.BcsSchema<any, any>, ReadonlyArray<number>, string]> = [
  ["non-canonical uleb128", Bcs.uleb128, [0x80, 0x00], "non-canonical uleb128"],
  ["non-canonical uleb128 (3 bytes)", Bcs.uleb128, [0x81, 0x80, 0x00], "non-canonical uleb128"],
  ["uleb128 over 32 bits", Bcs.uleb128, [0x80, 0x80, 0x80, 0x80, 0x10], "uleb128 overflow"],
  ["uleb128 longer than 5 bytes", Bcs.uleb128, [0xff, 0xff, 0xff, 0xff, 0xff, 0x01], "uleb128 overflow"],
  ["bool 2", Bcs.bool, [2], "invalid bool 2"],
  ["option tag 2", Bcs.option(Bcs.u8), [2, 7], "invalid option tag 2"],
  ["unknown enum variant", Bcs.enum({ A: null, B: Bcs.u8 }), [2], "unknown enum variant 2"],
  ["trailing bytes", Bcs.u16, [1, 0, 0], "1 trailing bytes"],
  ["truncated u64", Bcs.u64, [0, 0, 0, 0, 0, 0, 0], "unexpected end of input"],
  ["truncated string", Bcs.string, [3, 0x61], "unexpected end of input"],
  ["invalid UTF-8", Bcs.string, [2, 0xc3, 0x28], ""],
  ["CESU-style surrogate", Bcs.string, [3, 0xed, 0xa0, 0x80], ""],
  ["overlong NUL", Bcs.string, [2, 0xc0, 0x80], ""]
]

describe("non-canonical and malformed bytes are a typed BcsDecodeError", () => {
  test("ULEB128, bool, option and enum tags, framing and UTF-8", () => {
    for (const [name, schema, bytes, message] of refused) {
      // The name rides along so a failure says which case.
      expect([name, decodeError(Bcs.decode(schema)(new Uint8Array(bytes))).message]).toEqual([name, expect.stringContaining(message)])
    }
  })

  test("the error carries the offset", () => {
    expect(decodeError(Bcs.decode(Bcs.u16)(new Uint8Array([1, 0, 0]))).offset).toBe(2)
    expect(decodeError(Bcs.decode(Bcs.bool)(new Uint8Array([2]))).offset).toBe(0)
  })

  test("tags in range still decode", () => {
    expect(Result.getOrThrow(Bcs.decode(Bcs.option(Bcs.u8))(new Uint8Array([1, 7])))).toEqual(Option.some(7))
    expect(Result.getOrThrow(Bcs.decode(Bcs.enum({ A: null, B: Bcs.u8 }))(new Uint8Array([1, 9])))).toEqual({ _tag: "B", value: 9 })
    expect(Result.getOrThrow(Bcs.decode(Bcs.uleb128)(uleb(2 ** 32 - 1)))).toBe(2 ** 32 - 1)
  })
})

test("decodePrefix reads the head of a larger value and returns the rest; decode still refuses it", () => {
  const Full = Bcs.struct({ version: Bcs.u8, id: Bcs.byteVector, tail: Bcs.vector(Bcs.u64) })
  const Head = Bcs.struct({ version: Bcs.u8, id: Bcs.byteVector })
  const bytes = Bcs.encodeSync(Full)({ version: 0, id: new Uint8Array([1, 2]), tail: [5n] })
  const { value, rest } = Result.getOrThrow(Bcs.decodePrefix(Head)(bytes))
  expect(value).toEqual({ version: 0, id: new Uint8Array([1, 2]) })
  expect(Result.getOrThrow(Bcs.decode(Bcs.vector(Bcs.u64))(rest))).toEqual([5n])
  expect(decodeError(Bcs.decode(Head)(bytes)).message).toBe("9 trailing bytes")
})

describe("vector lengths are bounded by the input (CORE-4)", () => {
  test("a 5-byte length prefix for vector<u64> fails before allocating", () => {
    const before = process.memoryUsage().rss
    const t = performance.now()
    const e = decodeError(Bcs.decode(Bcs.vector(Bcs.u64))(uleb(100_000_000)))
    expect(e.message).toContain("exceeds the remaining input")
    expect(performance.now() - t).toBeLessThan(50)
    expect(process.memoryUsage().rss - before).toBeLessThan(50 * 1024 * 1024)
  })
  test("the same through nested layouts", () => {
    const V = Bcs.vector(Bcs.struct({ a: Bcs.Address, b: Bcs.vector(Bcs.u8) }))
    expect(decodeError(Bcs.decode(V)(uleb(2 ** 32 - 1))).message).toContain("exceeds the remaining input")
    const bytes = new Uint8Array([...uleb(3), 1, 2])
    expect(decodeError(Bcs.decode(Bcs.vector(Bcs.u8))(bytes)).message).toContain("exceeds the remaining input")
  })
  test("zero-size elements are capped", () => {
    for (const item of [Bcs.tuple([]), Bcs.struct({}), Bcs.bytes(0)] as ReadonlyArray<Bcs.BcsSchema<any, any>>) {
      const t = performance.now()
      const e = decodeError(Bcs.decode(Bcs.vector(item))(uleb(2 ** 32 - 1)))
      expect(e.message).toContain("zero-size elements")
      expect(performance.now() - t).toBeLessThan(50)
    }
    const ok = Bcs.decode(Bcs.vector(Bcs.struct({})))(uleb(Bcs.MAX_ZERO_SIZE_ITEMS))
    expect(Result.getOrThrow(ok).length).toBe(Bcs.MAX_ZERO_SIZE_ITEMS)
  })
})

describe("strings (CORE-21)", () => {
  test("a lone surrogate does not encode; a pair is 4 UTF-8 bytes; a leading BOM is data", () => {
    for (const s of ["\ud800", "a\udc00b", "\udbff", "\udc00\ud800"]) {
      expect(failure(Bcs.encode(Bcs.string)(s))).toBeInstanceOf(Schema.SchemaError)
    }
    expect(Bcs.encodeSync(Bcs.string)("😀")).toEqual(new Uint8Array([4, 0xf0, 0x9f, 0x98, 0x80]))
    expect(Result.getOrThrow(Bcs.decode(Bcs.string)(Bcs.encodeSync(Bcs.string)("﻿x")))).toBe("﻿x")
  })
})

describe("deep values", () => {
  interface Tree {
    readonly _tag: "leaf" | "node"
    readonly value?: Tree
  }
  const Tree: Bcs.BcsSchema<any, any> = Bcs.enum({ leaf: null, node: Bcs.lazy((): Bcs.BcsSchema<any, any> => Tree) })
  test("encoding a value nested too deeply is a failure, not a throw", () => {
    const List: Bcs.BcsSchema<any, any> = Bcs.struct({ next: Bcs.option(Bcs.lazy((): Bcs.BcsSchema<any, any> => List)) })
    let l: any = { next: Option.none() }
    for (let i = 0; i < 1_000_000; i++) l = { next: Option.some(l) }
    expect(failure(Bcs.encode(List)(l))).toBeInstanceOf(Schema.SchemaError)
    let t: Tree = { _tag: "leaf" }
    for (let i = 0; i < 200_000; i++) t = { _tag: "node", value: t }
    expect(() => Bcs.encode(Tree)(t)).not.toThrow()
  })
  test("decoding bytes nested too deeply is a failure, not a throw", () => {
    const bytes = new Uint8Array(200_001).fill(1)
    bytes[200_000] = 0
    decodeError(Bcs.decode(Tree)(bytes))
  })
})

describe("the schema pass skipped for Bcs-built trees (CORE-16) changes no result", () => {
  test("a transform inside a struct still runs its schema", () => {
    const Hex = Bcs.transform(Bcs.byteVector, Schema.String, {
      decode: (b) => Buffer.from(b).toString("hex"),
      encode: (s) => new Uint8Array(Buffer.from(s, "hex"))
    })
    const S = Bcs.struct({ a: Bcs.u8, h: Hex })
    const b = Bcs.encodeSync(S)({ a: 1, h: "beef" })
    expect(b).toEqual(new Uint8Array([1, 2, 0xbe, 0xef]))
    expect(Result.getOrThrow(Bcs.decode(S)(b))).toEqual({ a: 1, h: "beef" })
  })
  test("a re-annotated BCS schema goes through its schema and still works", () => {
    const S = Bcs.vector(Bcs.u8.annotate({ title: "byte" }))
    expect(Result.getOrThrow(Bcs.decode(S)(new Uint8Array([2, 2, 3])))).toEqual([2, 3])
    expect(Result.isFailure(Bcs.encode(S)([2, 256]))).toBe(true)
    expect(Bcs.encodeSync(S)([4])).toEqual(new Uint8Array([1, 4]))
  })
  test("refusals are a SchemaError on both paths: bad fields, missing fields, a digest of the wrong length", () => {
    const S = Bcs.struct({ a: Bcs.u8, b: Bcs.option(Bcs.Address) })
    expect(failure(Bcs.encode(S)({ a: 256, b: Option.none() }))).toBeInstanceOf(Schema.SchemaError)
    expect(failure(Bcs.encode(S)({ a: 1, b: Option.some("0xAB" as Bcs.Address) }))).toBeInstanceOf(Schema.SchemaError)
    expect(failure(Bcs.encode(S)({ a: 1 } as any))).toBeInstanceOf(Schema.SchemaError)
    expect(failure(Bcs.encode(Bcs.Digest)("abc" as Bcs.Digest))).toBeInstanceOf(Schema.SchemaError)
    expect(failure(Bcs.encode(Bcs.uleb128)(2 ** 32))).toBeInstanceOf(Schema.SchemaError)
    expect(failure(Bcs.encode(Bcs.uleb128)(-1))).toBeInstanceOf(Schema.SchemaError)
    for (const n of [0, 3, 31, 33]) {
      expect(failure(Bcs.decode(Bcs.Digest)(new Uint8Array([n, ...new Uint8Array(n).fill(5)])))).toBeInstanceOf(Schema.SchemaError)
    }
  })
})
