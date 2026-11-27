/**
 * Wire formats (E9, M1, M2) as `@unconfirmed/bcs` schemas, and the checks a
 * client runs on what nodes send before using it.
 */
import * as Bcs from "@unconfirmed/bcs/Bcs"
import type * as Address from "@unconfirmed/sui/Address"
import * as Result from "effect/Result"
import * as BlobId from "./BlobId.ts"
import * as Encoding from "./Encoding.ts"
import { InvalidMetadata, InvalidSliver } from "./Errors.ts"
import * as Merkle from "./Merkle.ts"

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** `enum { Empty, Digest([u8; 32]) }`. `Empty` hashes as 32 zero bytes. */
export const MerkleNode = /* @__PURE__ */ Bcs.enum({ Empty: null, Digest: /* @__PURE__ */ Bcs.bytes(32) })
export type MerkleNode = typeof MerkleNode.Type

/** BCS index 0 is the retired RaptorQ RedStuff (rejected by `verifyMetadata`), 1 is RS2 (E1). */
export const EncodingType = /* @__PURE__ */ Bcs.enum({ RedStuffRaptorQ: null, RS2: null })

export const SliverPairMetadata = /* @__PURE__ */ Bcs.struct({ primaryHash: MerkleNode, secondaryHash: MerkleNode })

/** `enum BlobMetadata { V1 { encoding_type, unencoded_length, hashes } }`: the metadata `PUT` body (N2). */
export const BlobMetadata = /* @__PURE__ */ Bcs.enum({
  V1: /* @__PURE__ */ Bcs.struct({
    encodingType: EncodingType,
    unencodedLength: Bcs.u64,
    hashes: /* @__PURE__ */ Bcs.vector(SliverPairMetadata)
  })
})
export type BlobMetadata = typeof BlobMetadata.Type

/** The metadata `GET` response (N1). */
export const BlobMetadataWithId = /* @__PURE__ */ Bcs.struct({ blobId: BlobId.Bcs32, metadata: BlobMetadata })
export type BlobMetadataWithId = typeof BlobMetadataWithId.Type

export const Symbols = /* @__PURE__ */ Bcs.struct({ data: Bcs.byteVector, symbolSize: Bcs.u16 })

/** `SliverData { symbols: { data, symbol_size: u16 }, index: u16 }` (N3). */
export const SliverData = /* @__PURE__ */ Bcs.struct({ symbols: Symbols, index: Bcs.u16 })
export type SliverData = typeof SliverData.Type

export const Intent = /* @__PURE__ */ Bcs.struct({ type: Bcs.u8, version: Bcs.u8, appId: Bcs.u8 })

/** Blob certification intent: type 1, version 0, app 3 (Storage) (M1). */
export const BLOB_CERT_INTENT = { type: 1, version: 0, appId: 3 } as const

export type Persistence = { readonly _tag: "Permanent" } | { readonly _tag: "Deletable"; readonly objectId: Address.Address }

export const PersistenceBcs = /* @__PURE__ */ Bcs.enum({
  Permanent: null,
  Deletable: /* @__PURE__ */ Bcs.struct({ objectId: Bcs.Address })
})

/** `intent ‖ epoch u32 ‖ blob id ‖ persistence` (M1). */
export const Confirmation = /* @__PURE__ */ Bcs.struct({
  intent: Intent,
  epoch: Bcs.u32,
  blobId: BlobId.Bcs32,
  persistence: PersistenceBcs
})
export type Confirmation = typeof Confirmation.Type

/** `{ signers: vector<u16>, serialized_message, signature }` (M2). */
export const Certificate = /* @__PURE__ */ Bcs.struct({
  signers: /* @__PURE__ */ Bcs.vector(Bcs.u16),
  serializedMessage: Bcs.byteVector,
  signature: Bcs.byteVector
})
export type Certificate = typeof Certificate.Type

// -----------------------------------------------------------------------------
// Metadata
// -----------------------------------------------------------------------------

export interface VerifiedMetadata {
  readonly blobId: BlobId.BlobId
  readonly unencodedLength: number
  readonly nShards: number
  readonly hashes: ReadonlyArray<{ readonly primary: Uint8Array; readonly secondary: Uint8Array }>
  /** BCS `BlobMetadata`, for `PUT`. */
  readonly bytes: Uint8Array
}

const nodeBytes = (node: MerkleNode): Uint8Array => (node._tag === "Digest" ? node.value : Merkle.empty())

const decodeWithId = /* @__PURE__ */ Bcs.decode(BlobMetadataWithId)

/**
 * Decode a node's metadata response and prove it belongs to `blobId`: the
 * embedded id, hash count, RS2, length <= max, derived id (E5). The Rust
 * client's `VerifiedBlobMetadataWithId::verify` (`metadata.rs:423-445`).
 */
export const verifyMetadata = (
  blobId: BlobId.BlobId,
  response: Uint8Array,
  nShards: number
): Result.Result<VerifiedMetadata, InvalidMetadata> => {
  const fail = (reason: string) => Result.fail(new InvalidMetadata({ blobId, reason }))
  const decoded = decodeWithId(response)
  if (Result.isFailure(decoded)) return fail(`malformed: ${decoded.failure.message}`)
  const { blobId: claimed, metadata } = decoded.success
  if (claimed !== blobId) return fail(`response is for blob ${claimed}`)
  if (metadata.encodingType._tag !== "RS2") return fail(`unsupported encoding type ${metadata.encodingType._tag}`)
  if (metadata.hashes.length !== nShards) return fail(`${metadata.hashes.length} hashes for ${nShards} shards`)
  const max = Encoding.maxBlobSize(nShards)
  if (metadata.unencodedLength > BigInt(max)) return fail(`unencoded length ${metadata.unencodedLength} exceeds ${max}`)
  const hashes = metadata.hashes.map((h) => ({ primary: nodeBytes(h.primaryHash), secondary: nodeBytes(h.secondaryHash) }))
  const leaves = hashes.map((h) => {
    const leaf = new Uint8Array(2 * Merkle.DIGEST_LENGTH)
    leaf.set(h.primary, 0)
    leaf.set(h.secondary, Merkle.DIGEST_LENGTH)
    return leaf
  })
  const derived = BlobId.derive(Encoding.RS2, metadata.unencodedLength, Merkle.root(leaves))
  if (derived !== blobId) return fail(`metadata hashes to blob ${derived}`)
  return Result.succeed({
    blobId,
    unencodedLength: Number(metadata.unencodedLength),
    nShards,
    hashes,
    bytes: response.slice(BlobId.LENGTH)
  })
}

// -----------------------------------------------------------------------------
// Slivers
// -----------------------------------------------------------------------------

export interface SliverHeader {
  readonly index: number
  readonly symbolSize: number
  /** The symbols, a view into the input (not a copy). */
  readonly data: Uint8Array
}

/** Read a BCS `SliverData` without copying its symbols. Fails on any malformed or trailing byte. */
export const parseSliver = (bytes: Uint8Array): Result.Result<SliverHeader, InvalidSliver> => {
  const fail = (reason: string) => Result.fail(new InvalidSliver({ reason }))
  let length = 0
  let shift = 1
  let pos = 0
  for (;;) {
    if (pos >= bytes.length || pos >= 5) return fail("malformed length prefix")
    const b = bytes[pos++]!
    length += (b & 0x7f) * shift
    shift *= 128
    if ((b & 0x80) === 0) {
      if (b === 0 && pos > 1) return fail("non-canonical length prefix")
      break
    }
  }
  if (bytes.length !== pos + length + 4) return fail(`expected ${pos + length + 4} bytes, got ${bytes.length}`)
  const data = bytes.subarray(pos, pos + length)
  const view = new DataView(bytes.buffer, bytes.byteOffset + pos + length, 4)
  return Result.succeed({ data, symbolSize: view.getUint16(0, true), index: view.getUint16(2, true) })
}

/**
 * Header checks that need no WASM: BCS shape, sliver index, symbol size and
 * data length for this blob. `symbols` is the number of symbols the sliver
 * carries: `secondary` source symbols for a primary sliver, `primary` for a
 * secondary one (E3).
 */
export const checkSliver = (
  bytes: Uint8Array,
  expected: { readonly index: number; readonly symbolSize: number; readonly symbols: number }
): Result.Result<void, InvalidSliver> => {
  const parsed = parseSliver(bytes)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  const { index, symbolSize, data } = parsed.success
  if (index !== expected.index) return Result.fail(new InvalidSliver({ reason: `index ${index}, expected ${expected.index}` }))
  if (symbolSize !== expected.symbolSize) {
    return Result.fail(new InvalidSliver({ reason: `symbol size ${symbolSize}, expected ${expected.symbolSize}` }))
  }
  const length = expected.symbols * expected.symbolSize
  if (data.length !== length) return Result.fail(new InvalidSliver({ reason: `${data.length} data bytes, expected ${length}` }))
  return Result.void
}

// -----------------------------------------------------------------------------
// Confirmations
// -----------------------------------------------------------------------------

const encodeConfirmation = /* @__PURE__ */ Bcs.encodeSync(Confirmation)

/** The exact bytes a node signs to confirm storage (M1). */
export const confirmationMessage = (epoch: number, blobId: BlobId.BlobId, persistence: Persistence): Uint8Array =>
  encodeConfirmation({ intent: BLOB_CERT_INTENT, epoch, blobId, persistence })
