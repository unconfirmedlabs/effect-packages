/**
 * Dev-only oracles: `@mysten/walrus` 2.0.1 internals (loaded from its shipped
 * build, untyped) and the raw `@mysten/walrus-wasm` encoder, used to produce
 * real metadata and slivers without our own `Encoder` (W3).
 */
import { BlobEncoder } from "@mysten/walrus-wasm"
import * as Encoding from "../src/Encoding.ts"

const utilsModule = "../../../node_modules/@mysten/walrus/dist/utils/index.mjs"
const bcsModule = "../../../node_modules/@mysten/walrus/dist/utils/bcs.mjs"

export const mystenUtils = (await import(utilsModule)) as {
  encodedBlobLength: (unencodedLength: number, nShards: number) => number
  getSourceSymbols: (nShards: number) => { primarySymbols: number; secondarySymbols: number }
  getSizes: (blobSize: number, nShards: number) => { symbolSize: number; rowSize: number; columnSize: number }
  isQuorum: (size: number, nShards: number) => boolean
  isAboveValidity: (size: number, nShards: number) => boolean
  storageUnitsFromSize: (size: number) => number
  toShardIndex: (pairIndex: number, blobId: string, nShards: number) => number
  toPairIndex: (shardIndex: number, blobId: string, nShards: number) => number
  sliverPairIndexFromSecondarySliverIndex: (sliverIndex: number, nShards: number) => number
  signersToBitmap: (signers: Array<number>, committeeSize: number) => Uint8Array
  urlSafeBase64: (bytes: Uint8Array) => string
}

interface MystenBcsType<T = any> {
  serialize: (value: T) => { toBytes: () => Uint8Array }
  parse: (bytes: Uint8Array) => any
}
export const mystenBcs = (await import(bcsModule)) as {
  BlobMetadata: MystenBcsType
  BlobMetadataWithId: MystenBcsType
  SliverData: MystenBcsType
  StorageConfirmation: MystenBcsType
  CertificateBcs: MystenBcsType
  BlobId: MystenBcsType
  IntentType: { BLOB_CERT_MSG: number }
  blobIdFromBytes: (bytes: Uint8Array) => string
  blobIdFromInt: (n: bigint) => string
  blobIdToInt: (id: string) => bigint
}

export interface WasmMetadata {
  blob_id: Array<number>
  metadata: {
    V1: {
      encoding_type: "RS2"
      unencoded_length: number | bigint
      hashes: Array<{ primary_hash: { Digest: Array<number> }; secondary_hash: { Digest: Array<number> } }>
    }
  }
}

export interface WasmEncoded {
  readonly blobId: string
  readonly rootHash: Uint8Array
  readonly metadata: WasmMetadata
  readonly primary: ReadonlyArray<Uint8Array>
  readonly secondary: ReadonlyArray<Uint8Array>
}

/** Encode with the raw WASM into buffers sized by `Encoding.bcsSliverBytes` (which must be exact, W3). */
export const wasmEncode = (n: number, data: Uint8Array): WasmEncoded => {
  const sizes = Encoding.bcsSliverBytes(data.length, n)
  const primary = Array.from({ length: n }, () => new Uint8Array(sizes.primary))
  const secondary = Array.from({ length: n }, () => new Uint8Array(sizes.secondary))
  const encoder = new BlobEncoder(n)
  try {
    const [metadata, root] = encoder.encode(data, primary, secondary) as [WasmMetadata, { Digest: Array<number> }]
    return {
      blobId: mystenBcs.blobIdFromBytes(new Uint8Array(metadata.blob_id)),
      rootHash: new Uint8Array(root.Digest),
      metadata,
      primary,
      secondary
    }
  } finally {
    encoder.free()
  }
}

/** The node's metadata response for an encoded blob, serialised by `@mysten/walrus`'s BCS (independent of ours). */
export const metadataResponse = (
  encoded: WasmEncoded,
  override?: { readonly blobId?: string; readonly encodingType?: "RS2" | "RedStuff"; readonly unencodedLength?: bigint; readonly hashes?: WasmMetadata["metadata"]["V1"]["hashes"] }
): Uint8Array =>
  mystenBcs.BlobMetadataWithId.serialize({
    blobId: override?.blobId ?? encoded.blobId,
    metadata: {
      V1: {
        encoding_type: override?.encodingType ?? "RS2",
        unencoded_length: override?.unencodedLength ?? BigInt(encoded.metadata.metadata.V1.unencoded_length),
        hashes: (override?.hashes ?? encoded.metadata.metadata.V1.hashes).map((h) => ({
          primary_hash: { Digest: new Uint8Array(h.primary_hash.Digest) },
          secondary_hash: { Digest: new Uint8Array(h.secondary_hash.Digest) }
        }))
      }
    }
  }).toBytes()

/** Deterministic pseudo-random bytes. */
export const bytes = (length: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(length)
  let x = seed >>> 0 || 1
  for (let i = 0; i < length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

/** A seeded integer generator in `[0, max)`. */
export const rng = (seed: number) => {
  let x = seed >>> 0 || 1
  return (max: number): number => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) % max
  }
}
