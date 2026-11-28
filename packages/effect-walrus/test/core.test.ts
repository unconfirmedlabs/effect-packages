/**
 * The pure core where it is not a straight comparison with `@mysten/walrus`
 * (`parity.core.test.ts`): the chain's certificate threshold, size limits,
 * blob id parsing, certificate parsing and cost.
 */
import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Bft, BlobId, Certificate, Cost, Encoding, Errors } from "../src/index.ts"
import { bytes } from "./oracle.ts"

describe("Bft", () => {
  test("n − f is the chain's 3w >= 2n + 1 (T2), and differs from 2f + 1 unless n = 1 (mod 3) (T4)", () => {
    // n, f, n - f, 2f + 1, f + 1
    const table: ReadonlyArray<readonly [number, number, number, number, number]> = [
      [1, 0, 1, 1, 1],
      [4, 1, 3, 3, 2],
      [5, 1, 4, 3, 2],
      [7, 2, 5, 5, 3],
      [10, 3, 7, 7, 4],
      [1000, 333, 667, 667, 334]
    ]
    for (const [n, f, minCorrect, quorum, validity] of table) {
      expect([Bft.maxFaulty(n), Bft.minCorrect(n), Bft.quorum(n), Bft.validity(n)]).toEqual([f, minCorrect, quorum, validity])
      expect(Bft.minCorrect(n)).toBe(Math.ceil((2 * n + 1) / 3))
    }
  })
})

describe("Encoding", () => {
  test("symbol size at the boundaries; past the maximum is BlobTooLarge (E2)", () => {
    const n = 1000
    const cells = 334 * 667
    const ok = (len: number) => Result.getOrThrow(Encoding.symbolSize(len, n))
    expect([ok(0), ok(2 * cells), ok(2 * cells + 1)]).toEqual([2, 2, 4])
    expect(Encoding.maxBlobSize(n)).toBe(14_599_533_452)
    expect(ok(Encoding.maxBlobSize(n))).toBe(65534)
    const over = Encoding.symbolSize(Encoding.maxBlobSize(n) + 1, n)
    expect(Result.isFailure(over) && over.failure).toBeInstanceOf(Errors.BlobTooLarge)
    expect(() => Encoding.sliverBytes(Encoding.maxBlobSize(10) + 1, 10)).toThrow(RangeError)
    expect(() => Encoding.encodedLength(Encoding.maxBlobSize(n) + 1, n)).toThrow(RangeError)
  })
})

describe("BlobId", () => {
  test("rejects anything but 32 bytes in canonical unpadded base64url", () => {
    const raw = bytes(32, 7)
    expect(Result.isFailure(BlobId.fromBytes(new Uint8Array(31)))).toBe(true)
    expect(Result.isFailure(BlobId.fromBytes(new Uint8Array(33)))).toBe(true)
    const id = Result.getOrThrow(BlobId.fromBytes(raw))
    expect(Schema.decodeUnknownSync(BlobId.BlobId)(id)).toBe(id)
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
      expect(Result.isFailure(r) && r.failure).toBeInstanceOf(Errors.InvalidBlobId)
      expect(() => Schema.decodeUnknownSync(BlobId.BlobId)(s)).toThrow()
    }
  })
})

describe("Certificate", () => {
  test("signersBitmap: duplicates collapse, out-of-range signers throw (M3)", () => {
    expect(Certificate.signersBitmap([0, 7, 8, 98], 99)).toEqual(Uint8Array.from([0x81, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x04]))
    expect(Certificate.signersBitmap([3, 3], 8)).toEqual(Uint8Array.of(8))
    expect(() => Certificate.signersBitmap([8], 8)).toThrow(RangeError)
    expect(() => Certificate.signersBitmap([-1], 8)).toThrow(RangeError)
  })

  test("fromParts reads the epoch and sorts signers; rejects duplicates, short messages, another intent", () => {
    const message = Uint8Array.from([1, 0, 3, 0x52, 0x02, 0, 0, ...new Uint8Array(32), 0])
    const signature = new Uint8Array(96)
    const cert = Result.getOrThrow(Certificate.fromParts({ signers: [5, 1, 3], serializedMessage: message, signature }))
    expect([cert.epoch, cert.signers]).toEqual([594, [1, 3, 5]])
    const wrongIntent = message.slice()
    wrongIntent[0] = 2
    const bad = [
      { signers: [1, 1], serializedMessage: message },
      { signers: [1], serializedMessage: message.slice(0, 5) },
      { signers: [1], serializedMessage: wrongIntent }
    ]
    for (const parts of bad) expect(Result.isFailure(Certificate.fromParts({ ...parts, signature }))).toBe(true)
  })
})

describe("Cost", () => {
  test("a 1-byte blob for one epoch at testnet prices (§6.4); storage scales with epochs, write does not", () => {
    expect(Cost.cost(1, 1, { storage: 4724n, write: 9421n }, 1000)).toEqual({
      encodedLength: 66_034_000,
      units: 63,
      storage: 63n * 4724n,
      write: 63n * 9421n,
      total: 891_135n
    })
    const c = Cost.cost(1, 5, { storage: 3n, write: 11n }, 1000)
    expect([c.storage, c.write, c.total]).toEqual([63n * 15n, 63n * 11n, 63n * 26n])
  })
})
