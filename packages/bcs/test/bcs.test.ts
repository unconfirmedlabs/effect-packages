import { describe, expect, test } from "bun:test"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Bcs from "@unconfirmed/bcs/Bcs"

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

describe("ULEB128", () => {
  const d = Bcs.decode(Bcs.uleb128)
  test("canonical round trip", () => {
    for (const n of [0, 1, 127, 128, 16383, 16384, 2 ** 32 - 1]) {
      expect(Bcs.encodeSync(Bcs.uleb128)(n)).toEqual(uleb(n))
      expect(Result.getOrThrow(d(uleb(n)))).toBe(n)
    }
  })
  test("non-canonical encodings are refused", () => {
    expect(decodeError(d(new Uint8Array([0x80, 0x00]))).message).toBe("non-canonical uleb128")
    expect(decodeError(d(new Uint8Array([0x81, 0x80, 0x00]))).message).toBe("non-canonical uleb128")
  })
  test("overflow is refused", () => {
    expect(decodeError(d(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x10]))).message).toBe("uleb128 overflow")
    expect(decodeError(d(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0x01]))).message).toBe("uleb128 overflow")
  })
  test("out-of-range values do not encode", () => {
    expect(failure(Bcs.encode(Bcs.uleb128)(2 ** 32))).toBeInstanceOf(Schema.SchemaError)
    expect(failure(Bcs.encode(Bcs.uleb128)(-1))).toBeInstanceOf(Schema.SchemaError)
  })
})

describe("tags", () => {
  test("bool accepts only 0 and 1", () => {
    const d = Bcs.decode(Bcs.bool)
    expect(Result.getOrThrow(d(new Uint8Array([0])))).toBe(false)
    expect(Result.getOrThrow(d(new Uint8Array([1])))).toBe(true)
    expect(decodeError(d(new Uint8Array([2]))).message).toBe("invalid bool 2")
  })
  test("option accepts only tags 0 and 1", () => {
    const d = Bcs.decode(Bcs.option(Bcs.u8))
    expect(Result.getOrThrow(d(new Uint8Array([0])))).toEqual(Option.none())
    expect(Result.getOrThrow(d(new Uint8Array([1, 7])))).toEqual(Option.some(7))
    expect(decodeError(d(new Uint8Array([2, 7]))).message).toBe("invalid option tag 2")
  })
  test("enum: an unknown variant index is refused", () => {
    const E = Bcs.enum({ A: null, B: Bcs.u8 })
    expect(decodeError(Bcs.decode(E)(new Uint8Array([2]))).message).toBe("unknown enum variant 2")
    expect(Result.getOrThrow(Bcs.decode(E)(new Uint8Array([1, 9])))).toEqual({ _tag: "B", value: 9 })
  })
})

describe("framing", () => {
  test("trailing bytes are refused", () => {
    const e = decodeError(Bcs.decode(Bcs.u16)(new Uint8Array([1, 0, 0])))
    expect(e.message).toBe("1 trailing bytes")
    expect(e.offset).toBe(2)
  })
  test("truncated input is refused", () => {
    expect(decodeError(Bcs.decode(Bcs.u64)(new Uint8Array(7))).message).toBe("unexpected end of input")
    expect(decodeError(Bcs.decode(Bcs.string)(new Uint8Array([3, 0x61]))).message).toBe("unexpected end of input")
  })
  test("invalid UTF-8 is refused", () => {
    expect(Result.isFailure(Bcs.decode(Bcs.string)(new Uint8Array([1, 0xff])))).toBe(true)
  })
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
  test("a length that fits still decodes", () => {
    const xs = [1n, 2n, 3n]
    const b = Bcs.encodeSync(Bcs.vector(Bcs.u64))(xs)
    expect(Result.getOrThrow(Bcs.decode(Bcs.vector(Bcs.u64))(b))).toEqual(xs)
  })
})

describe("strings (CORE-21)", () => {
  test("a lone surrogate does not encode", () => {
    for (const s of ["\ud800", "a\udc00b", "\udbff"]) {
      expect(failure(Bcs.encode(Bcs.string)(s))).toBeInstanceOf(Schema.SchemaError)
    }
  })
  test("a surrogate pair encodes as 4 UTF-8 bytes", () => {
    expect(Bcs.encodeSync(Bcs.string)("😀")).toEqual(new Uint8Array([4, 0xf0, 0x9f, 0x98, 0x80]))
  })
  test("a leading BOM is kept as data", () => {
    const b = Bcs.encodeSync(Bcs.string)("﻿x")
    expect(Result.getOrThrow(Bcs.decode(Bcs.string)(b))).toBe("﻿x")
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
  })
  test("a deep enum chain encodes or fails, never throws", () => {
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

describe("skipping the schema pass changes no result", () => {
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
  test("a digest of the wrong length is a schema failure", () => {
    expect(failure(Bcs.decode(Bcs.Digest)(new Uint8Array([3, 1, 2, 3])))).toBeInstanceOf(Schema.SchemaError)
    expect(failure(Bcs.encode(Bcs.Digest)("abc" as Bcs.Digest))).toBeInstanceOf(Schema.SchemaError)
  })
  test("invalid inputs to encode fail as before", () => {
    const S = Bcs.struct({ a: Bcs.u8, b: Bcs.option(Bcs.Address) })
    expect(failure(Bcs.encode(S)({ a: 256, b: Option.none() }))).toBeInstanceOf(Schema.SchemaError)
    expect(failure(Bcs.encode(S)({ a: 1, b: Option.some("0xAB" as Bcs.Address) }))).toBeInstanceOf(Schema.SchemaError)
    expect(failure(Bcs.encode(S)({ a: 1 } as any))).toBeInstanceOf(Schema.SchemaError)
  })
  test("u64, u128 and u256 round trip at their bounds", () => {
    for (const [s, max] of [[Bcs.u64, 2n ** 64n - 1n], [Bcs.u128, 2n ** 128n - 1n], [Bcs.u256, 2n ** 256n - 1n]] as const) {
      for (const v of [0n, 1n, max]) expect(Result.getOrThrow(Bcs.decode(s)(Bcs.encodeSync(s)(v)))).toBe(v)
      expect(Result.isFailure(Bcs.encode(s)(max + 1n))).toBe(true)
    }
    expect(Bcs.encodeSync(Bcs.u64)(0x0102030405060708n)).toEqual(new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]))
  })
})

describe("BcsDecodeError", () => {
  test("is a Schema.TaggedError with a readable message and offset", () => {
    const e = decodeError(Bcs.decode(Bcs.bool)(new Uint8Array([2])))
    expect(e._tag).toBe("BcsDecodeError")
    expect(e.message).toBe("invalid bool 2")
    expect(e.offset).toBe(0)
    expect(String(e)).toBe("BcsDecodeError: invalid bool 2")
    expect(Schema.encodeSync(Bcs.BcsDecodeError)(e)).toEqual({ _tag: "BcsDecodeError", message: "invalid bool 2", offset: 0 })
    const trailing = decodeError(Bcs.decode(Bcs.bool)(new Uint8Array([1, 0])))
    expect(trailing.message).toBe("1 trailing bytes")
    expect(trailing.offset).toBe(1)
  })
})
