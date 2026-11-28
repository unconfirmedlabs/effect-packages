/**
 * What we accept from a storage node: `verifyMetadata` (the metadata must hash
 * to the blob id) and `checkSliver` (the BCS header must match the sliver we
 * asked for). Byte parity of the types with `@mysten/walrus` is in
 * `parity.core.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import { BlobId, Encoding, Errors, Merkle, Messages } from "../src/index.ts"
import { bytes, metadataResponse, wasmEncode } from "./oracle.ts"

const n = 10
const blob = bytes(1000, 42)
const encoded = wasmEncode(n, blob)
const id = encoded.blobId as BlobId.BlobId
const response = metadataResponse(encoded)

describe("verifyMetadata", () => {
  test("accepts real metadata", () => {
    const m = Result.getOrThrow(Messages.verifyMetadata(id, response, n))
    expect([m.blobId, m.unencodedLength, m.nShards, m.hashes.length]).toEqual([id, 1000, n, n])
    expect(m.hashes[3]!.primary).toEqual(new Uint8Array(encoded.metadata.metadata.V1.hashes[3]!.primary_hash.Digest))
    expect(m.bytes).toEqual(response.slice(32))
    // the root over the pair leaves is the WASM's root hash
    expect(Merkle.root(m.hashes.map((h) => new Uint8Array([...h.primary, ...h.secondary])))).toEqual(encoded.rootHash)
  })

  test("rejects lying, mismatched, oversized and malformed metadata", () => {
    const flipped = response.slice()
    flipped[flipped.length - 1]! ^= 1
    const other = wasmEncode(n, bytes(1000, 43))
    const max = BigInt(Encoding.maxBlobSize(n))
    const cases: ReadonlyArray<readonly [Uint8Array, RegExp, number?]> = [
      [flipped, /hashes to blob/],
      [metadataResponse(other), /response is for blob/],
      // the embedded id is ours, the hashes are another blob's
      [metadataResponse(other, { blobId: id }), /hashes to blob/],
      [response, /10 hashes for 11 shards/, n + 1],
      [metadataResponse(encoded, { hashes: encoded.metadata.metadata.V1.hashes.slice(1) }), /9 hashes/],
      [metadataResponse(encoded, { encodingType: "RedStuff" }), /encoding type/],
      // checked before hashing
      [metadataResponse(encoded, { unencodedLength: max + 1n }), /exceeds/],
      [metadataResponse(encoded, { unencodedLength: (1n << 64n) - 1n }), /exceeds/],
      [response.slice(0, 100), /malformed/],
      [new Uint8Array([...response, 0]), /malformed/],
      [new Uint8Array(0), /malformed/]
    ]
    for (const [bytes, pattern, shards] of cases) {
      const r = Messages.verifyMetadata(id, bytes, shards ?? n)
      expect(Result.isFailure(r) && r.failure).toBeInstanceOf(Errors.InvalidMetadata)
      expect(Result.isFailure(r) && r.failure.reason).toMatch(pattern)
    }
  })
})

describe("checkSliver", () => {
  const { symbolSize } = Encoding.sliverBytes(blob.length, n)
  const { primary: nPrimary, secondary: nSecondary } = Encoding.sourceSymbols(n)

  test("accepts every primary and secondary sliver the encoder wrote", () => {
    // secondary buffer k carries sliver index n - 1 - k (W3)
    const ok = encoded.primary.every((s, p) => Result.isSuccess(Messages.checkSliver(s, { index: p, symbolSize, symbols: nSecondary }))) &&
      encoded.secondary.every((s, p) => Result.isSuccess(Messages.checkSliver(s, { index: n - 1 - p, symbolSize, symbols: nPrimary })))
    expect(ok).toBe(true)
    expect(Result.getOrThrow(Messages.parseSliver(encoded.primary[0]!)).data.length).toBe(nSecondary * symbolSize)
  })

  test("rejections", () => {
    const s = encoded.primary[2]!
    const ok = { index: 2, symbolSize, symbols: nSecondary }
    const cases: ReadonlyArray<readonly [Uint8Array, typeof ok, RegExp]> = [
      [s, { ...ok, index: 3 }, /index 2, expected 3/],
      [s, { ...ok, symbolSize: symbolSize + 2 }, /symbol size/],
      [s, { ...ok, symbols: nSecondary + 1 }, /data bytes/],
      [s.slice(0, s.length - 1), ok, /expected/],
      [new Uint8Array([...s, 0]), ok, /expected/],
      [new Uint8Array(0), ok, /length prefix/],
      [Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x01), ok, /length prefix/],
      [Uint8Array.of(0x80, 0x00, 0, 0, 0, 0), ok, /non-canonical/]
    ]
    for (const [bytes, expected, pattern] of cases) {
      const r = Messages.checkSliver(bytes, expected)
      expect(Result.isFailure(r) && r.failure).toBeInstanceOf(Errors.InvalidSliver)
      expect(Result.isFailure(r) && r.failure.reason).toMatch(pattern)
    }
  })
})
