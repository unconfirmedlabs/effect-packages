/**
 * Parity with `@mysten/walrus` 2.0.1 (§6.2) for the pure core: sizes, the
 * shard mapping, bitmaps, blob id forms and the BCS of every wire type.
 */
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import { Bft, BlobId, Certificate, Encoding, Messages } from "../src/index.ts"
import { bytes, metadataResponse, mystenBcs, mystenUtils, rng, wasmEncode } from "./oracle.ts"

const SHARD_COUNTS = [1, 2, 3, 4, 5, 7, 10, 13, 100, 667, 1000, 1001, 4096]

describe("sizes", () => {
  test("source symbols, encoded length, sliver sizes, storage units over a random range", () => {
    const next = rng(11)
    for (const n of SHARD_COUNTS) {
      const { primarySymbols, secondarySymbols } = mystenUtils.getSourceSymbols(n)
      expect(Encoding.sourceSymbols(n)).toEqual({ primary: primarySymbols, secondary: secondarySymbols })
      const max = Encoding.maxBlobSize(n)
      const lengths = [0, 1, 2, primarySymbols * secondarySymbols, primarySymbols * secondarySymbols * 2 + 1, max - 1, max]
      for (let i = 0; i < 200; i++) lengths.push(next(Math.min(max, 2 ** 31)))
      for (const len of lengths) {
        const encoded = Encoding.encodedLength(len, n)
        expect(encoded).toBe(mystenUtils.encodedBlobLength(len, n))
        expect(Encoding.storageUnits(encoded)).toBe(mystenUtils.storageUnitsFromSize(encoded))
        const sizes = mystenUtils.getSizes(len, n)
        expect(Encoding.sliverBytes(len, n)).toEqual({ symbolSize: sizes.symbolSize, primary: sizes.rowSize, secondary: sizes.columnSize })
      }
    }
  })

  test("thresholds", () => {
    for (let n = 1; n <= 1000; n++) {
      // isQuorum(size) is size > 2f; isAboveValidity(size) is size > f
      expect(mystenUtils.isQuorum(Bft.quorum(n), n)).toBe(true)
      expect(mystenUtils.isQuorum(Bft.quorum(n) - 1, n)).toBe(false)
      expect(mystenUtils.isAboveValidity(Bft.validity(n), n)).toBe(true)
      expect(mystenUtils.isAboveValidity(Bft.validity(n) - 1, n)).toBe(false)
    }
  })

  test("BCS sliver buffer sizes are exactly what the WASM writes (W3)", () => {
    for (const [n, len] of [[10, 0], [10, 1], [10, 5000], [7, 300], [13, 70_000]] as const) {
      const e = wasmEncode(n, bytes(len, n))
      const sizes = Encoding.bcsSliverBytes(len, n)
      for (const s of e.primary) expect(Result.isSuccess(Messages.parseSliver(s))).toBe(true)
      for (const s of e.secondary) expect(Result.isSuccess(Messages.parseSliver(s))).toBe(true)
      expect(e.primary[0]!.length).toBe(sizes.primary)
      expect(e.secondary[0]!.length).toBe(sizes.secondary)
    }
  })
})

describe("shard mapping and bitmaps", () => {
  test("shardOfPair, pairOfShard, pairOfSecondary", () => {
    const next = rng(5)
    for (let i = 0; i < 50; i++) {
      const id = Result.getOrThrow(BlobId.fromBytes(bytes(32, i + 1)))
      for (const n of SHARD_COUNTS) {
        for (let k = 0; k < 5; k++) {
          const index = next(n)
          expect(Encoding.shardOfPair(index, id, n)).toBe(mystenUtils.toShardIndex(index, id, n))
          expect(Encoding.pairOfShard(index, id, n)).toBe(mystenUtils.toPairIndex(index, id, n))
          expect(Encoding.pairOfSecondary(index, n)).toBe(mystenUtils.sliverPairIndexFromSecondarySliverIndex(index, n))
        }
      }
    }
  })

  test("signersBitmap", () => {
    const next = rng(3)
    for (let i = 0; i < 200; i++) {
      const members = 1 + next(200)
      const signers = [...new Set(Array.from({ length: next(members + 1) }, () => next(members)))].sort((a, b) => a - b)
      expect(Certificate.signersBitmap(signers, members)).toEqual(mystenUtils.signersToBitmap(signers, members))
    }
  })
})

describe("blob id forms", () => {
  test("text and u256", () => {
    for (let i = 0; i < 200; i++) {
      const raw = bytes(32, i + 100)
      const id = Result.getOrThrow(BlobId.fromBytes(raw))
      expect(id).toBe(mystenBcs.blobIdFromBytes(raw) as BlobId.BlobId)
      expect(id).toBe(mystenUtils.urlSafeBase64(raw) as BlobId.BlobId)
      const n = BlobId.toU256(id)
      expect(n).toBe(mystenBcs.blobIdToInt(id))
      expect(BlobId.fromU256(n)).toBe(mystenBcs.blobIdFromInt(n) as BlobId.BlobId)
    }
  })
})

describe("BCS", () => {
  const n = 10
  const encoded = wasmEncode(n, bytes(2000, 77))
  const id = encoded.blobId as BlobId.BlobId

  test("BlobMetadataWithId and BlobMetadata", () => {
    const response = metadataResponse(encoded)
    const ours = Bcs.decodeSync(Messages.BlobMetadataWithId)(response)
    expect(ours.blobId).toBe(id)
    expect(Bcs.encodeSync(Messages.BlobMetadataWithId)(ours)).toEqual(response)
    const v1 = encoded.metadata.metadata.V1
    const mysten = mystenBcs.BlobMetadata.serialize({
      V1: {
        encoding_type: "RS2",
        unencoded_length: BigInt(v1.unencoded_length),
        hashes: v1.hashes.map((h) => ({
          primary_hash: { Digest: new Uint8Array(h.primary_hash.Digest) },
          secondary_hash: { Digest: new Uint8Array(h.secondary_hash.Digest) }
        }))
      }
    }).toBytes()
    expect(Bcs.encodeSync(Messages.BlobMetadata)(ours.metadata)).toEqual(mysten)
    expect(Result.getOrThrow(Messages.verifyMetadata(id, response, n)).bytes).toEqual(mysten)
    // an Empty hash
    const withEmpty = mystenBcs.BlobMetadata.serialize({
      V1: { encoding_type: "RS2", unencoded_length: 1n, hashes: [{ primary_hash: { Empty: null }, secondary_hash: { Digest: new Uint8Array(32).fill(1) } }] }
    }).toBytes()
    const decoded = Bcs.decodeSync(Messages.BlobMetadata)(withEmpty)
    expect(decoded.hashes[0]!.primaryHash).toEqual({ _tag: "Empty" })
    expect(Bcs.encodeSync(Messages.BlobMetadata)(decoded)).toEqual(withEmpty)
  })

  test("SliverData", () => {
    for (const s of [encoded.primary[0]!, encoded.secondary[4]!]) {
      const mysten = mystenBcs.SliverData.parse(s)
      const ours = Bcs.decodeSync(Messages.SliverData)(s)
      expect(ours.index).toBe(mysten.index)
      expect(ours.symbols.symbolSize).toBe(mysten.symbols.symbol_size)
      expect(Bcs.encodeSync(Messages.SliverData)(ours)).toEqual(
        mystenBcs.SliverData.serialize({ symbols: { data: ours.symbols.data, symbol_size: ours.symbols.symbolSize }, index: ours.index }).toBytes()
      )
    }
  })

  test("Confirmation, permanent and deletable", () => {
    const objectId = Address.normalize("0x5eed")
    for (const epoch of [0, 594, 2 ** 32 - 1]) {
      expect(Messages.confirmationMessage(epoch, id, { _tag: "Permanent" })).toEqual(
        mystenBcs.StorageConfirmation.serialize({
          intent: mystenBcs.IntentType.BLOB_CERT_MSG,
          epoch,
          messageContents: { blobId: id, blobType: { Permanent: null } }
        }).toBytes()
      )
      expect(Messages.confirmationMessage(epoch, id, { _tag: "Deletable", objectId })).toEqual(
        mystenBcs.StorageConfirmation.serialize({
          intent: mystenBcs.IntentType.BLOB_CERT_MSG,
          epoch,
          messageContents: { blobId: id, blobType: { Deletable: { objectId } } }
        }).toBytes()
      )
    }
  })

  test("Certificate", () => {
    const value = { signers: [0, 3, 999], serializedMessage: Messages.confirmationMessage(5, id, { _tag: "Permanent" }), signature: new Uint8Array(96).fill(7) }
    expect(Bcs.encodeSync(Messages.Certificate)(value)).toEqual(mystenBcs.CertificateBcs.serialize(value).toBytes())
  })
})
