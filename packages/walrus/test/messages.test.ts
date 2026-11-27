import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import { BlobId, Encoding, Errors, Merkle, Messages } from "../src/index.ts"
import { bytes, metadataResponse, wasmEncode } from "./oracle.ts"

const n = 10
const blob = bytes(1000, 42)
const encoded = wasmEncode(n, blob)
const id = encoded.blobId as BlobId.BlobId
const response = metadataResponse(encoded)

const rejects = (r: Result.Result<unknown, Errors.InvalidMetadata>, pattern: RegExp) => {
  expect(Result.isFailure(r)).toBe(true)
  if (Result.isFailure(r)) {
    expect(r.failure).toBeInstanceOf(Errors.InvalidMetadata)
    expect(r.failure.reason).toMatch(pattern)
  }
}

describe("verifyMetadata", () => {
  test("accepts real metadata", () => {
    const m = Result.getOrThrow(Messages.verifyMetadata(id, response, n))
    expect(m.blobId).toBe(id)
    expect(m.unencodedLength).toBe(1000)
    expect(m.nShards).toBe(n)
    expect(m.hashes.length).toBe(n)
    expect(m.hashes[3]!.primary).toEqual(new Uint8Array(encoded.metadata.metadata.V1.hashes[3]!.primary_hash.Digest))
    expect(m.bytes).toEqual(response.slice(32))
    // the root over the pair leaves is the WASM's root hash
    const leaves = m.hashes.map((h) => new Uint8Array([...h.primary, ...h.secondary]))
    expect(Merkle.root(leaves)).toEqual(encoded.rootHash)
  })

  test("accepts real metadata at n = 1000 (66,044 bytes, E9)", () => {
    const big = wasmEncode(1000, bytes(100, 1))
    const res = metadataResponse(big)
    expect(res.length).toBe(66_044)
    const m = Result.getOrThrow(Messages.verifyMetadata(big.blobId as BlobId.BlobId, res, 1000))
    expect(m.hashes.length).toBe(1000)
  }, 30_000)

  test("rejects a flipped hash", () => {
    const flipped = response.slice()
    flipped[flipped.length - 1]! ^= 1
    rejects(Messages.verifyMetadata(id, flipped, n), /hashes to blob/)
  })

  test("rejects metadata for another blob", () => {
    const other = wasmEncode(n, bytes(1000, 43))
    rejects(Messages.verifyMetadata(id, metadataResponse(other), n), /response is for blob/)
    // the embedded id is ours, the hashes are another blob's
    rejects(Messages.verifyMetadata(id, metadataResponse(other, { blobId: id }), n), /hashes to blob/)
  })

  test("rejects a wrong hash count", () => {
    rejects(Messages.verifyMetadata(id, response, n + 1), /10 hashes for 11 shards/)
    const short = metadataResponse(encoded, { hashes: encoded.metadata.metadata.V1.hashes.slice(1) })
    rejects(Messages.verifyMetadata(id, short, n), /9 hashes/)
  })

  test("rejects encoding type 0", () => {
    rejects(Messages.verifyMetadata(id, metadataResponse(encoded, { encodingType: "RedStuff" }), n), /encoding type/)
  })

  test("rejects an oversized length before hashing", () => {
    const max = BigInt(Encoding.maxBlobSize(n))
    rejects(Messages.verifyMetadata(id, metadataResponse(encoded, { unencodedLength: max + 1n }), n), /exceeds/)
    rejects(Messages.verifyMetadata(id, metadataResponse(encoded, { unencodedLength: (1n << 64n) - 1n }), n), /exceeds/)
  })

  test("rejects malformed and trailing bytes", () => {
    rejects(Messages.verifyMetadata(id, response.slice(0, 100), n), /malformed/)
    rejects(Messages.verifyMetadata(id, new Uint8Array([...response, 0]), n), /malformed/)
    rejects(Messages.verifyMetadata(id, new Uint8Array(0), n), /malformed/)
  })
})

describe("checkSliver", () => {
  const { symbolSize } = Encoding.sliverBytes(blob.length, n)
  const { primary: nPrimary, secondary: nSecondary } = Encoding.sourceSymbols(n)

  test("accepts every primary and secondary sliver the encoder wrote", () => {
    for (let p = 0; p < n; p++) {
      expect(Result.isSuccess(Messages.checkSliver(encoded.primary[p]!, { index: p, symbolSize, symbols: nSecondary }))).toBe(true)
      // secondary buffer k carries sliver index n - 1 - k (W3)
      expect(Result.isSuccess(Messages.checkSliver(encoded.secondary[p]!, { index: n - 1 - p, symbolSize, symbols: nPrimary })))
        .toBe(true)
    }
    const header = Result.getOrThrow(Messages.parseSliver(encoded.primary[0]!))
    expect(header.data.length).toBe(nSecondary * symbolSize)
    // the BCS schema reads the same
    const decoded = Bcs.decodeSync(Messages.SliverData)(encoded.primary[0]!)
    expect(decoded.index).toBe(0)
    expect(decoded.symbols.symbolSize).toBe(symbolSize)
    expect(decoded.symbols.data).toEqual(header.data)
  })

  const fails = (b: Uint8Array, expected: { index: number; symbolSize: number; symbols: number }, pattern: RegExp) => {
    const r = Messages.checkSliver(b, expected)
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) {
      expect(r.failure).toBeInstanceOf(Errors.InvalidSliver)
      expect(r.failure.reason).toMatch(pattern)
    }
  }

  test("rejections", () => {
    const s = encoded.primary[2]!
    const ok = { index: 2, symbolSize, symbols: nSecondary }
    fails(s, { ...ok, index: 3 }, /index 2, expected 3/)
    fails(s, { ...ok, symbolSize: symbolSize + 2 }, /symbol size/)
    fails(s, { ...ok, symbols: nSecondary + 1 }, /data bytes/)
    fails(s.slice(0, s.length - 1), ok, /expected/)
    fails(new Uint8Array([...s, 0]), ok, /expected/)
    fails(new Uint8Array(0), ok, /length prefix/)
    fails(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x01), ok, /length prefix/)
    fails(Uint8Array.of(0x80, 0x00, 0, 0, 0, 0), ok, /non-canonical/)
  })
})

describe("confirmationMessage (M1)", () => {
  const raw = bytes(32, 9)
  const blobId = Result.getOrThrow(BlobId.fromBytes(raw))

  test("permanent equals the live sample layout", () => {
    const m = Messages.confirmationMessage(594, blobId, { _tag: "Permanent" })
    expect(m).toEqual(Uint8Array.from([0x01, 0x00, 0x03, 0x52, 0x02, 0x00, 0x00, ...raw, 0x00]))
  })

  test("deletable carries the object id", () => {
    const objectId = Address.normalize("0xabc")
    const m = Messages.confirmationMessage(1, blobId, { _tag: "Deletable", objectId })
    expect(m).toEqual(Uint8Array.from([1, 0, 3, 1, 0, 0, 0, ...raw, 0x01, ...Buffer.from(objectId.slice(2), "hex")]))
    const decoded = Bcs.decodeSync(Messages.Confirmation)(m)
    expect(decoded.epoch).toBe(1)
    expect(decoded.blobId).toBe(blobId)
    expect(decoded.persistence).toEqual({ _tag: "Deletable", objectId })
  })
})
