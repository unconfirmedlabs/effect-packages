import { blake2b } from "@noble/hashes/blake2.js"
import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Bft, BlobId, Certificate, Cost, Encoding, Errors, Merkle } from "../src/index.ts"
import { bytes } from "./oracle.ts"

const H = (b: Uint8Array) => blake2b(b, { dkLen: 32 })
const cat = (...parts: Array<Uint8Array | Array<number>>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

describe("Bft", () => {
  // n, f, n - f, 2f + 1, f + 1
  const table: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [1, 0, 1, 1, 1],
    [4, 1, 3, 3, 2],
    [5, 1, 4, 3, 2],
    [6, 1, 5, 3, 2],
    [7, 2, 5, 5, 3],
    [10, 3, 7, 7, 4],
    [100, 33, 67, 67, 34],
    [1000, 333, 667, 667, 334]
  ]
  test.each(table)("n = %d", (n, f, minCorrect, quorum, validity) => {
    expect(Bft.maxFaulty(n)).toBe(f)
    expect(Bft.minCorrect(n)).toBe(minCorrect)
    expect(Bft.quorum(n)).toBe(quorum)
    expect(Bft.validity(n)).toBe(validity)
  })

  test("T4: 2f + 1 and n - f differ unless n = 1 (mod 3)", () => {
    for (let n = 1; n <= 1000; n++) {
      expect(Bft.quorum(n) === Bft.minCorrect(n)).toBe(n % 3 === 1)
      // T2: the chain's 3w >= 2n + 1 is exactly w >= n - f
      const chainMin = Math.ceil((2 * n + 1) / 3)
      expect(chainMin).toBe(Bft.minCorrect(n))
    }
    expect(Bft.quorum(5)).toBe(3)
    expect(Bft.minCorrect(5)).toBe(4)
  })
})

describe("Encoding", () => {
  test("source symbols (T5)", () => {
    expect(Encoding.sourceSymbols(1000)).toEqual({ primary: 334, secondary: 667 })
    expect(Encoding.sourceSymbols(10)).toEqual({ primary: 4, secondary: 7 })
    expect(Encoding.sourceSymbols(1)).toEqual({ primary: 1, secondary: 1 })
  })

  test("symbol size at the boundaries (E2)", () => {
    const n = 1000
    const cells = 334 * 667
    const ok = (len: number) => Result.getOrThrow(Encoding.symbolSize(len, n))
    expect(ok(0)).toBe(2)
    expect(ok(1)).toBe(2)
    expect(ok(cells)).toBe(2)
    expect(ok(2 * cells)).toBe(2)
    expect(ok(2 * cells + 1)).toBe(4)
    expect(ok(3 * cells)).toBe(4)
    expect(Encoding.maxBlobSize(n)).toBe(14_599_533_452)
    expect(ok(Encoding.maxBlobSize(n))).toBe(65534)
    const over = Encoding.symbolSize(Encoding.maxBlobSize(n) + 1, n)
    expect(Result.isFailure(over)).toBe(true)
    if (Result.isFailure(over)) {
      expect(over.failure).toBeInstanceOf(Errors.BlobTooLarge)
      expect(over.failure.max).toBe(14_599_533_452)
    }
  })

  test("sliver sizes (E3, W3)", () => {
    expect(Encoding.sliverBytes(1, 1000)).toEqual({ symbolSize: 2, primary: 667 * 2, secondary: 334 * 2 })
    // 1334 needs a 2-byte uleb128 prefix; 668 too
    expect(Encoding.bcsSliverBytes(1, 1000)).toEqual({ primary: 2 + 1334 + 4, secondary: 2 + 668 + 4 })
    // n = 10: 7 * 2 = 14 bytes, 1-byte prefix
    expect(Encoding.bcsSliverBytes(0, 10)).toEqual({ primary: 1 + 14 + 4, secondary: 1 + 8 + 4 })
    expect(() => Encoding.sliverBytes(Encoding.maxBlobSize(10) + 1, 10)).toThrow(RangeError)
  })

  test("encoded length and storage units (E4)", () => {
    expect(Encoding.encodedLength(1, 1000)).toBe(66_034_000)
    expect(Encoding.storageUnits(66_034_000)).toBe(63)
    expect(Encoding.encodedLength(0, 1000)).toBe(66_034_000)
    expect(Encoding.storageUnits(0)).toBe(0)
    expect(Encoding.storageUnits(1)).toBe(1)
    expect(Encoding.storageUnits(1024 * 1024)).toBe(1)
    expect(Encoding.storageUnits(1024 * 1024 + 1)).toBe(2)
    const max = Encoding.maxBlobSize(1000)
    expect(Encoding.encodedLength(max, 1000)).toBe(1000 * (1000 * 64 + 32) + 1000 * 1001 * 65534)
    expect(() => Encoding.encodedLength(max + 1, 1000)).toThrow(RangeError)
  })

  test("shard mapping (E7)", () => {
    const zero = BlobId.fromU256(0n)
    expect(Encoding.shardOfPair(5, zero, 1000)).toBe(5)
    // big-endian bytes: the last byte is least significant; 0xff...ff mod 1000
    const ones = Result.getOrThrow(BlobId.fromBytes(new Uint8Array(32).fill(0xff)))
    const offset = Number(((1n << 256n) - 1n) % 1000n)
    expect(Encoding.rotationOffset(ones, 1000)).toBe(offset)
    for (const pair of [0, 1, 500, 999]) {
      const shard = Encoding.shardOfPair(pair, ones, 1000)
      expect(shard).toBe((pair + offset) % 1000)
      expect(Encoding.pairOfShard(shard, ones, 1000)).toBe(pair)
    }
    expect(Encoding.pairOfSecondary(0, 1000)).toBe(999)
    expect(Encoding.pairOfSecondary(999, 1000)).toBe(0)
  })
})

describe("BlobId", () => {
  const raw = bytes(32, 7)

  test("bytes and text round trip", () => {
    const id = Result.getOrThrow(BlobId.fromBytes(raw))
    expect(id.length).toBe(43)
    expect(id).toBe(Buffer.from(raw).toString("base64url") as BlobId.BlobId)
    expect(BlobId.toBytes(id)).toEqual(raw)
    expect(Result.getOrThrow(BlobId.fromString(id))).toBe(id)
    expect(Schema.decodeUnknownSync(BlobId.BlobId)(id)).toBe(id)
  })

  test("u256 is little-endian (E6)", () => {
    const id = Result.getOrThrow(BlobId.fromBytes(raw))
    let le = 0n
    for (let i = 31; i >= 0; i--) le = (le << 8n) | BigInt(raw[i]!)
    expect(BlobId.toU256(id)).toBe(le)
    expect(BlobId.fromU256(le)).toBe(id)
    expect(BlobId.toBytes(BlobId.fromU256(1n))[0]).toBe(1)
    const max = (1n << 256n) - 1n
    expect(BlobId.toU256(BlobId.fromU256(max))).toBe(max)
  })

  test("rejections", () => {
    expect(Result.isFailure(BlobId.fromBytes(new Uint8Array(31)))).toBe(true)
    expect(Result.isFailure(BlobId.fromBytes(new Uint8Array(33)))).toBe(true)
    const id = Result.getOrThrow(BlobId.fromBytes(raw))
    const bad = [
      "",
      id.slice(0, 42), // too short
      id + "A", // too long
      id.slice(0, 42) + "=", // padding character
      Buffer.from(raw).toString("base64"), // standard base64 with padding
      id.slice(0, 10) + "+" + id.slice(11), // standard alphabet
      id.slice(0, 42) + "B" // non-zero trailing bits
    ]
    for (const s of bad) {
      const r = BlobId.fromString(s)
      expect(Result.isFailure(r)).toBe(true)
      if (Result.isFailure(r)) expect(r.failure).toBeInstanceOf(Errors.InvalidBlobId)
      expect(() => Schema.decodeUnknownSync(BlobId.BlobId)(s)).toThrow()
    }
  })

  test("derive (E5)", () => {
    const root = bytes(32, 3)
    const expected = H(cat([1], [0x39, 0x30, 0, 0, 0, 0, 0, 0], root))
    expect(BlobId.toBytes(BlobId.derive(1, 12345n, root))).toEqual(expected)
  })
})

describe("Merkle", () => {
  const leaf = (b: Uint8Array) => H(cat([0], b))
  const inner = (l: Uint8Array, r: Uint8Array) => H(cat([1], l, r))
  const Z = new Uint8Array(32)
  const L = [bytes(64, 1), bytes(64, 2), bytes(64, 3)]

  test("0, 1, 2, 3 leaves", () => {
    expect(Merkle.root([])).toEqual(Z)
    expect(Merkle.root([L[0]!])).toEqual(leaf(L[0]!))
    expect(Merkle.root([L[0]!, L[1]!])).toEqual(inner(leaf(L[0]!), leaf(L[1]!)))
    expect(Merkle.root(L)).toEqual(inner(inner(leaf(L[0]!), leaf(L[1]!)), inner(leaf(L[2]!), Z)))
  })

  test("1000 leaves: odd levels padded with zeros at every height", () => {
    const leaves = Array.from({ length: 1000 }, (_, i) => bytes(64, i + 1))
    // An independent recursive formulation: pad to the next power of two with
    // empty subtrees, whose hash is all zeros.
    const rec = (hs: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
      if (hs.length === 0) return Z
      if (size === 1) return hs[0]!
      const half = size / 2
      return inner(rec(hs.slice(0, half), half), rec(hs.slice(half), half))
    }
    expect(hex(Merkle.root(leaves))).toBe(hex(rec(leaves.map(leaf), 1024)))
  })
})

describe("Certificate", () => {
  test("signersBitmap (M3)", () => {
    expect(Certificate.signersBitmap([], 0)).toEqual(new Uint8Array(0))
    expect(Certificate.signersBitmap([0], 1)).toEqual(Uint8Array.of(1))
    expect(Certificate.signersBitmap([0, 7, 8, 98], 99)).toEqual(
      Uint8Array.from([0x81, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x04])
    )
    expect(Certificate.signersBitmap([3, 3], 8)).toEqual(Uint8Array.of(8))
    expect(() => Certificate.signersBitmap([8], 8)).toThrow(RangeError)
    expect(() => Certificate.signersBitmap([-1], 8)).toThrow(RangeError)
  })

  test("fromParts reads the epoch and sorts signers", () => {
    const message = Uint8Array.from([1, 0, 3, 0x52, 0x02, 0, 0, ...new Uint8Array(32), 0])
    const cert = Result.getOrThrow(Certificate.fromParts({ signers: [5, 1, 3], serializedMessage: message, signature: new Uint8Array(96) }))
    expect(cert.epoch).toBe(594)
    expect(cert.signers).toEqual([1, 3, 5])
    expect(Result.isFailure(Certificate.fromParts({ signers: [1, 1], serializedMessage: message, signature: new Uint8Array(96) }))).toBe(true)
    expect(Result.isFailure(Certificate.fromParts({ signers: [1], serializedMessage: message.slice(0, 5), signature: new Uint8Array(96) })))
      .toBe(true)
    const wrongIntent = message.slice()
    wrongIntent[0] = 2
    expect(Result.isFailure(Certificate.fromParts({ signers: [1], serializedMessage: wrongIntent, signature: new Uint8Array(96) }))).toBe(true)
  })

  test("JSON form", () => {
    const cert: Certificate.Certificate = {
      epoch: 7,
      signers: [0, 2],
      serializedMessage: Uint8Array.of(1, 2, 3),
      signature: new Uint8Array(96).fill(9)
    }
    const json = Schema.encodeSync(Certificate.Certificate)(cert)
    expect(json.serializedMessage).toBe("AQID")
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
    expect(Schema.decodeUnknownSync(Certificate.Certificate)(json)).toEqual(cert)
  })
})

describe("Cost", () => {
  test("a 1-byte blob for one epoch at testnet prices (§6.4)", () => {
    expect(Cost.cost(1, 1, { storage: 4724n, write: 9421n }, 1000)).toEqual({
      encodedLength: 66_034_000,
      units: 63,
      storage: 63n * 4724n,
      write: 63n * 9421n,
      total: 891_135n
    })
  })

  test("storage scales with epochs, write does not", () => {
    const c = Cost.cost(10_000_000, 5, { storage: 3n, write: 11n }, 1000)
    const units = Encoding.storageUnits(Encoding.encodedLength(10_000_000, 1000))
    expect(c.units).toBe(units)
    expect(c.storage).toBe(BigInt(units) * 15n)
    expect(c.write).toBe(BigInt(units) * 11n)
    expect(c.total).toBe(c.storage + c.write)
  })
})
