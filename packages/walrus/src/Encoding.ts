/**
 * RS2 sizes and the sliver-to-shard mapping (E1–E7). `n` is the number of
 * shards. Lengths are `number`: the largest blob at the largest `n` is below
 * `2^53`.
 */
import * as Result from "effect/Result"
import * as BlobId from "./BlobId.ts"
import * as Bft from "./Bft.ts"
import { BlobTooLarge } from "./Errors.ts"

/** The only encoding type (E1). BCS variant index 1; index 0 (RaptorQ RedStuff) is rejected. */
export const RS2 = 1

/** RS2 symbols are aligned to 2 bytes. */
export const SYMBOL_ALIGNMENT = 2
/** The largest RS2 symbol: `u16::MAX − 1`. */
export const MAX_SYMBOL_SIZE = 65534
/** Bytes per storage unit (1 MiB). */
export const BYTES_PER_UNIT = 1024 * 1024
const DIGEST_LENGTH = 32

/** Primary `n − 2f` (rows), secondary `n − f` (columns) (T5). */
export const sourceSymbols = (n: number): { readonly primary: number; readonly secondary: number } => {
  const f = Bft.maxFaulty(n)
  return { primary: n - 2 * f, secondary: n - f }
}

/** `primary × secondary × 65534` (E2). */
export const maxBlobSize = (n: number): number => {
  const { primary, secondary } = sourceSymbols(n)
  return primary * secondary * MAX_SYMBOL_SIZE
}

/** The symbol size before the 65534 limit is applied. */
const rawSymbolSize = (unencodedLength: number, n: number): number => {
  const { primary, secondary } = sourceSymbols(n)
  const raw = Math.ceil(Math.max(unencodedLength, 1) / (primary * secondary))
  return Math.ceil(raw / SYMBOL_ALIGNMENT) * SYMBOL_ALIGNMENT
}

/** `max(len, 1).divCeil(primary × secondary)`, rounded up to a multiple of 2; fails above 65534 (E2). */
export const symbolSize = (unencodedLength: number, n: number): Result.Result<number, BlobTooLarge> => {
  const size = rawSymbolSize(unencodedLength, n)
  return size > MAX_SYMBOL_SIZE
    ? Result.fail(new BlobTooLarge({ size: unencodedLength, max: maxBlobSize(n) }))
    : Result.succeed(size)
}

// Does not go through `symbolSize`: the size helpers below then need no error class (and no `Schema`) in a bundle.
const symbolSizeOrThrow = (unencodedLength: number, n: number): number => {
  const size = rawSymbolSize(unencodedLength, n)
  if (size > MAX_SYMBOL_SIZE) throw new RangeError(`blob of ${unencodedLength} bytes exceeds ${maxBlobSize(n)} for ${n} shards`)
  return size
}

/**
 * Bytes of one primary sliver (`secondary × symbolSize`) and one secondary
 * sliver (`primary × symbolSize`) (E3). Throws `RangeError` above `maxBlobSize`:
 * check with `symbolSize` first when the length is untrusted.
 */
export const sliverBytes = (
  unencodedLength: number,
  n: number
): { readonly symbolSize: number; readonly primary: number; readonly secondary: number } => {
  const s = symbolSizeOrThrow(unencodedLength, n)
  const { primary, secondary } = sourceSymbols(n)
  return { symbolSize: s, primary: secondary * s, secondary: primary * s }
}

const uleb128Length = (v: number): number => {
  let size = 1
  while (v >= 128) {
    v = Math.floor(v / 128)
    size++
  }
  return size
}

/** Exact BCS `SliverData` sizes, `uleb128(len) + len + 2 (symbol size) + 2 (index)`: the WASM `encode` buffers (W3). */
export const bcsSliverBytes = (unencodedLength: number, n: number): { readonly primary: number; readonly secondary: number } => {
  const { primary, secondary } = sliverBytes(unencodedLength, n)
  return { primary: uleb128Length(primary) + primary + 4, secondary: uleb128Length(secondary) + secondary + 4 }
}

/** `n × (n × 64 + 32) + n × (primary + secondary) × symbolSize` (E4). Throws `RangeError` above `maxBlobSize`. */
export const encodedLength = (unencodedLength: number, n: number): number => {
  const s = symbolSizeOrThrow(unencodedLength, n)
  const { primary, secondary } = sourceSymbols(n)
  return n * (n * DIGEST_LENGTH * 2 + DIGEST_LENGTH) + n * (primary + secondary) * s
}

/** `encodedLength.divCeil(1 MiB)` (E4). */
export const storageUnits = (encodedLength: number): number => Math.ceil(encodedLength / BYTES_PER_UNIT)

/** The blob id's bytes as a big-endian integer, mod `n` (E7). */
export const rotationOffset = (blobId: BlobId.BlobId, n: number): number =>
  BlobId.toBytes(blobId).reduce((acc, byte) => (acc * 256 + byte) % n, 0)

/** Sliver pair `p` is stored on shard `(p + offset) mod n` (E7). */
export const shardOfPair = (pairIndex: number, blobId: BlobId.BlobId, n: number): number =>
  (pairIndex + rotationOffset(blobId, n)) % n

/** The sliver pair held by `shard` (E7). */
export const pairOfShard = (shard: number, blobId: BlobId.BlobId, n: number): number =>
  (n + shard - rotationOffset(blobId, n)) % n

/** Secondary sliver index `s` belongs to pair `n − 1 − s` (E7). */
export const pairOfSecondary = (sliverIndex: number, n: number): number => n - 1 - sliverIndex
