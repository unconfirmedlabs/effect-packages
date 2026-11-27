/**
 * Quilts (§4.9): many small files in one blob, each readable on its own from
 * the few secondary slivers (columns) it occupies. Pure: no services, no WASM.
 *
 *   const { quilt, patches } = yield* Quilt.encode(entries, state.nShards)
 *   const certified = yield* Write.run(quilt, { attributes: Quilt.ATTRIBUTE, ... })
 *   const ids = patches.map((p) => Quilt.patchId(certified.blobId, p))
 *
 * The format is QuiltVersionV1 (`crates/walrus-core/src/encoding/quilt_encoding.rs`,
 * `@mysten/walrus` `utils/quilts.mjs`): the blob is the RS2 source matrix,
 * `rows = n − 2f` by `columns = n − f` symbols, filled column by column. Column 0
 * starts with the version byte (1), a `u32` LE index length and the BCS
 * `QuiltIndexV1`, spanning at most 10 columns. Each entry follows in its own run
 * of whole columns: a 6-byte header (version 1, `u32` LE length of the rest,
 * mask; bit 0 = has tags), a `u16` LE identifier length and the BCS identifier,
 * optionally a `u16` LE tags length and the BCS tags map, then the contents.
 * Entries are sorted by identifier (UTF-8 bytes, as Rust's `String` order).
 */
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Result from "effect/Result"
import * as BlobId from "./BlobId.ts"
import * as Encoding from "./Encoding.ts"
import { QuiltError } from "./Errors.ts"

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

export interface QuiltEntry {
  /** Unique within the quilt; non-empty, no control characters, no trailing whitespace (Rust rejects those on read). */
  readonly identifier: string
  readonly contents: Uint8Array
  readonly tags?: Readonly<Record<string, string>>
}

/** An entry's place in the quilt: columns `[startIndex, endIndex)`. */
export interface QuiltPatch {
  readonly identifier: string
  readonly startIndex: number
  readonly endIndex: number
  readonly tags: Readonly<Record<string, string>>
}

/** One file as read back from a quilt. */
export interface QuiltFile {
  readonly identifier: string
  readonly tags: Readonly<Record<string, string>>
  readonly contents: Uint8Array
}

/** The blob attribute that marks a quilt (`_walrusBlobType: "quilt"`), as the Rust client and `@mysten/walrus` set it. */
export const ATTRIBUTE = { _walrusBlobType: "quilt" } as const

/** Quilt format version (the first byte of the quilt and of each patch header and patch id). */
export const VERSION = 1
/** The index occupies at most this many columns. */
export const MAX_INDEX_COLUMNS = 10
/** Version byte and `u32` index length. */
export const INDEX_PREFIX_BYTES = 5
/** Version byte, `u32` length, mask. */
export const PATCH_HEADER_BYTES = 6
const HAS_TAGS = 1
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

/** The source matrix of a blob of `unencodedLength` bytes over `nShards` shards. */
export interface Layout {
  readonly nShards: number
  readonly symbolSize: number
  /** `n − 2f`: symbols per column. */
  readonly rows: number
  /** `n − f`: columns (secondary source slivers). */
  readonly columns: number
  /** `rows × symbolSize`: bytes per column. */
  readonly columnSize: number
}

export const layout = (unencodedLength: number, nShards: number): Result.Result<Layout, QuiltError> => {
  if (!Number.isInteger(nShards) || nShards < 1) return fail(`invalid shard count ${nShards}`)
  const size = Encoding.symbolSize(unencodedLength, nShards)
  if (Result.isFailure(size)) return fail(`a blob of ${unencodedLength} bytes is too large for ${nShards} shards`)
  const { primary: rows, secondary: columns } = Encoding.sourceSymbols(nShards)
  return Result.succeed({ nShards, symbolSize: size.success, rows, columns, columnSize: rows * size.success })
}

/**
 * Lay out `entries` as a quilt for `nShards` shards. Byte-identical to
 * `@mysten/walrus` `encodeQuilt` and the Rust `QuiltEncoderV1` for valid input.
 */
export const encode = (
  entries: ReadonlyArray<QuiltEntry>,
  nShards: number
): Result.Result<{ readonly quilt: Uint8Array; readonly patches: ReadonlyArray<QuiltPatch> }, QuiltError> => {
  if (!Number.isInteger(nShards) || nShards < 1) return fail(`invalid shard count ${nShards}`)
  if (entries.length === 0) return fail("a quilt needs at least one entry")
  const { primary: rows, secondary: columns } = Encoding.sourceSymbols(nShards)
  if (entries.length + 1 > columns) {
    return fail(`${entries.length} entries; at most ${columns - 1} fit in a quilt for ${nShards} shards`)
  }

  const prepared: Array<{ entry: QuiltEntry; id: Uint8Array; tags: Array<readonly [string, string]>; prefix: Uint8Array }> = []
  for (const entry of entries) {
    const invalid = identifierProblem(entry.identifier)
    if (invalid) return fail(`identifier ${JSON.stringify(entry.identifier)}: ${invalid}`)
    const tags = sortedTags(entry.tags ?? {})
    const prefix = patchPrefix(entry, tags)
    if (Result.isFailure(prefix)) return Result.fail(prefix.failure)
    prepared.push({ entry, id: utf8(entry.identifier), tags, prefix: prefix.success })
  }
  prepared.sort((a, b) => compareBytes(a.id, b.id))
  for (let i = 1; i < prepared.length; i++) {
    if (compareBytes(prepared[i - 1]!.id, prepared[i]!.id) === 0) {
      return fail(`duplicate identifier ${JSON.stringify(prepared[i]!.entry.identifier)}`)
    }
  }

  // The index's size does not depend on the column numbers (fixed-width u16), so size it with zeros first.
  const indexOf = (ends: ReadonlyArray<number>) =>
    encodeIndex({ patches: prepared.map((p, i) => ({ endIndex: ends[i] ?? 0, identifier: p.entry.identifier, tags: p.tags })) })
  const indexSize = INDEX_PREFIX_BYTES + indexOf([]).length
  const sizes = [indexSize, ...prepared.map((p) => p.prefix.length + p.entry.contents.length)]
  const symbolSize = computeSymbolSize(sizes, columns, rows)
  if (Result.isFailure(symbolSize)) return Result.fail(symbolSize.failure)

  const s = symbolSize.success
  const columnSize = s * rows
  const rowSize = s * columns
  const quilt = new Uint8Array(rowSize * rows)
  const indexColumns = Math.ceil(indexSize / columnSize)
  if (indexColumns > MAX_INDEX_COLUMNS) return fail(`the index needs ${indexColumns} columns, at most ${MAX_INDEX_COLUMNS}`)

  const patches: Array<QuiltPatch> = []
  let column = indexColumns
  for (const p of prepared) {
    writeColumns(quilt, p.prefix, column, rowSize, columnSize, s, 0)
    writeColumns(quilt, p.entry.contents, column, rowSize, columnSize, s, p.prefix.length)
    const used = Math.ceil((p.prefix.length + p.entry.contents.length) / columnSize)
    patches.push({ identifier: p.entry.identifier, startIndex: column, endIndex: column + used, tags: Object.fromEntries(p.tags) })
    column += used
  }
  const index = indexOf(patches.map((p) => p.endIndex))
  const prefixed = new Uint8Array(INDEX_PREFIX_BYTES + index.length)
  prefixed[0] = VERSION
  new DataView(prefixed.buffer).setUint32(1, index.length, true)
  prefixed.set(index, INDEX_PREFIX_BYTES)
  writeColumns(quilt, prefixed, 0, rowSize, columnSize, s, 0)
  return Result.succeed({ quilt, patches })
}

/** The patch id: URL-safe base64 (no padding) of `quiltId (32) ‖ version u8 ‖ startIndex u16 LE ‖ endIndex u16 LE`. */
export const patchId = (quiltId: BlobId.BlobId, patch: Pick<QuiltPatch, "startIndex" | "endIndex">): string => {
  const bytes = new Uint8Array(BlobId.LENGTH + 5)
  bytes.set(BlobId.toBytes(quiltId))
  const view = new DataView(bytes.buffer)
  view.setUint8(BlobId.LENGTH, VERSION)
  view.setUint16(BlobId.LENGTH + 1, patch.startIndex, true)
  view.setUint16(BlobId.LENGTH + 3, patch.endIndex, true)
  return base64Url(bytes)
}

export type ParsedId =
  | { readonly _tag: "Blob"; readonly blobId: BlobId.BlobId }
  | { readonly _tag: "Patch"; readonly quiltId: BlobId.BlobId; readonly startIndex: number; readonly endIndex: number }

/** A blob id (43 characters) or a quilt patch id (50 characters, version 1). */
export const parseId = (id: string): Result.Result<ParsedId, QuiltError> => {
  const bytes = fromBase64Url(id)
  if (bytes === undefined) return fail(`not URL-safe base64: ${JSON.stringify(id)}`)
  const blobId = BlobId.fromBytes(bytes.subarray(0, BlobId.LENGTH))
  if (bytes.length === BlobId.LENGTH && Result.isSuccess(blobId)) return Result.succeed({ _tag: "Blob", blobId: blobId.success })
  if (bytes.length !== BlobId.LENGTH + 5 || Result.isFailure(blobId)) return fail(`expected a 32-byte blob id or a 37-byte patch id, got ${bytes.length} bytes`)
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const version = view.getUint8(BlobId.LENGTH)
  if (version !== VERSION) return fail(`unsupported patch id version ${version}`)
  return Result.succeed({
    _tag: "Patch",
    quiltId: blobId.success,
    startIndex: view.getUint16(BlobId.LENGTH + 1, true),
    endIndex: view.getUint16(BlobId.LENGTH + 3, true)
  })
}

// -----------------------------------------------------------------------------
// Decoding (untrusted data: every length is checked)
// -----------------------------------------------------------------------------

/**
 * How many columns the index spans, from the first column alone: checks the
 * version byte and that the index fits in `MAX_INDEX_COLUMNS` columns.
 */
export const indexColumns = (firstColumn: Uint8Array, l: Layout): Result.Result<number, QuiltError> => {
  if (firstColumn.length < INDEX_PREFIX_BYTES) return fail("the first column is shorter than the index prefix")
  if (firstColumn[0] !== VERSION) return fail(`unsupported quilt version ${firstColumn[0]}`)
  const size = new DataView(firstColumn.buffer, firstColumn.byteOffset).getUint32(1, true)
  const max = l.columnSize * MAX_INDEX_COLUMNS - INDEX_PREFIX_BYTES
  if (size > max) return fail(`index of ${size} bytes exceeds ${max}`)
  const spans = Math.ceil((INDEX_PREFIX_BYTES + size) / l.columnSize)
  if (spans > l.columns) return fail(`the index spans ${spans} of ${l.columns} columns`)
  return Result.succeed(spans)
}

/**
 * The patches listed in the index. `columns` is the concatenation of columns
 * `0 .. indexColumns − 1` (at least). Start indices follow the Rust
 * `populate_start_indices`: the first patch starts after the index, each next
 * one where the previous ended; every range must be non-empty and in bounds.
 */
export const decodeIndex = (columns: Uint8Array, l: Layout): Result.Result<ReadonlyArray<QuiltPatch>, QuiltError> => {
  const spans = indexColumns(columns, l)
  if (Result.isFailure(spans)) return Result.fail(spans.failure)
  const size = new DataView(columns.buffer, columns.byteOffset).getUint32(1, true)
  if (columns.length < INDEX_PREFIX_BYTES + size) return fail("the index is cut short")
  const decoded = decodeIndexBcs(columns.subarray(INDEX_PREFIX_BYTES, INDEX_PREFIX_BYTES + size))
  if (Result.isFailure(decoded)) return fail(`malformed index: ${decoded.failure.message}`)
  const patches: Array<QuiltPatch> = []
  let start = spans.success
  for (const p of decoded.success.patches) {
    if (p.endIndex <= start || p.endIndex > l.columns) {
      return fail(`patch ${JSON.stringify(p.identifier)} has columns [${start}, ${p.endIndex}) in a quilt of ${l.columns}`)
    }
    patches.push({ identifier: p.identifier, startIndex: start, endIndex: p.endIndex, tags: Object.fromEntries(p.tags) })
    start = p.endIndex
  }
  return Result.succeed(patches)
}

/** One patch from the concatenation of its columns. */
export const decodePatch = (columns: Uint8Array): Result.Result<QuiltFile, QuiltError> => {
  if (columns.length < PATCH_HEADER_BYTES) return fail("the patch is shorter than its header")
  const view = new DataView(columns.buffer, columns.byteOffset, columns.length)
  if (view.getUint8(0) !== VERSION) return fail(`unsupported patch version ${view.getUint8(0)}`)
  const length = view.getUint32(1, true)
  const mask = view.getUint8(5)
  if (PATCH_HEADER_BYTES + length > columns.length) return fail(`the patch claims ${length} bytes but its columns hold ${columns.length - PATCH_HEADER_BYTES}`)
  const end = PATCH_HEADER_BYTES + length
  let at = PATCH_HEADER_BYTES

  if (at + 2 > end) return fail("no identifier length")
  const idSize = view.getUint16(at, true)
  at += 2
  if (at + idSize > end) return fail("the identifier overruns the patch")
  const identifier = decodeString(columns.subarray(at, at + idSize))
  if (Result.isFailure(identifier)) return fail(`malformed identifier: ${identifier.failure.message}`)
  at += idSize

  let tags: Record<string, string> = {}
  if (mask & HAS_TAGS) {
    if (at + 2 > end) return fail("no tags length")
    const tagsSize = view.getUint16(at, true)
    at += 2
    if (at + tagsSize > end) return fail("the tags overrun the patch")
    const decoded = decodeTags(columns.subarray(at, at + tagsSize))
    if (Result.isFailure(decoded)) return fail(`malformed tags: ${decoded.failure.message}`)
    tags = Object.fromEntries(decoded.success)
    at += tagsSize
  }
  return Result.succeed({ identifier: identifier.success, tags, contents: columns.slice(at, end) })
}

/**
 * Columns `[start, end)` of a whole quilt blob, concatenated (column-major).
 * Bytes past the blob's end read as zeros, as the matrix is padded (E2).
 */
export const columnsOf = (quilt: Uint8Array, l: Layout, start: number, end: number): Uint8Array => {
  const out = new Uint8Array(Math.max(0, end - start) * l.columnSize)
  const rowSize = l.symbolSize * l.columns
  let o = 0
  for (let c = start; c < end; c++) {
    for (let r = 0; r < l.rows; r++) {
      const from = r * rowSize + c * l.symbolSize
      if (from < quilt.length) out.set(quilt.subarray(from, Math.min(from + l.symbolSize, quilt.length)), o)
      o += l.symbolSize
    }
  }
  return out
}

/** Every file of a whole quilt blob, in index order. */
export const decode = (quilt: Uint8Array, nShards: number): Result.Result<ReadonlyArray<QuiltPatch & QuiltFile>, QuiltError> => {
  const l = layout(quilt.length, nShards)
  if (Result.isFailure(l)) return Result.fail(l.failure)
  const spans = indexColumns(columnsOf(quilt, l.success, 0, 1), l.success)
  if (Result.isFailure(spans)) return Result.fail(spans.failure)
  const patches = decodeIndex(columnsOf(quilt, l.success, 0, spans.success), l.success)
  if (Result.isFailure(patches)) return Result.fail(patches.failure)
  const out: Array<QuiltPatch & QuiltFile> = []
  for (const p of patches.success) {
    const file = decodePatch(columnsOf(quilt, l.success, p.startIndex, p.endIndex))
    if (Result.isFailure(file)) return Result.fail(file.failure)
    out.push({ ...p, ...file.success })
  }
  return Result.succeed(out)
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

const fail = (reason: string) => Result.fail(new QuiltError({ reason }))

/** A BCS `BTreeMap<String, String>`: pairs sorted by the BCS bytes of the key (the BCS canonical map order). */
const Tags = /* @__PURE__ */ Bcs.vector(/* @__PURE__ */ Bcs.tuple([Bcs.string, Bcs.string]))
const QuiltPatchV1 = /* @__PURE__ */ Bcs.struct({ endIndex: Bcs.u16, identifier: Bcs.string, tags: Tags })
const QuiltIndexV1 = /* @__PURE__ */ Bcs.struct({ patches: /* @__PURE__ */ Bcs.vector(QuiltPatchV1) })
const encodeIndex = /* @__PURE__ */ Bcs.encodeSync(QuiltIndexV1)
const encodeTags = /* @__PURE__ */ Bcs.encodeSync(Tags)
const encodeString = /* @__PURE__ */ Bcs.encodeSync(Bcs.string)
const decodeIndexBcs = /* @__PURE__ */ Bcs.decode(QuiltIndexV1)
const decodeTags = /* @__PURE__ */ Bcs.decode(Tags)
const decodeString = /* @__PURE__ */ Bcs.decode(Bcs.string)

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

const sortedTags = (tags: Readonly<Record<string, string>>): Array<readonly [string, string]> =>
  Object.entries(tags)
    .map(([k, v]) => ({ key: encodeString(k), pair: [k, v] as const }))
    .sort((a, b) => compareBytes(a.key, b.key))
    .map((t) => t.pair)

/** Rust `char::is_whitespace` (Unicode White_Space). */
const TRAILING_WHITESPACE = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/
/** Rust `char::is_control` (general category Cc). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** `validate_quilt_identifier` (`quilt_encoding.rs`): what the Rust decoder accepts. */
const identifierProblem = (identifier: string): string | undefined => {
  if (identifier.length === 0) return "empty"
  if (TRAILING_WHITESPACE.test(identifier)) return "trailing whitespace"
  if (CONTROL.test(identifier)) return "control characters"
  if (/[\ud800-\udfff]/.test(identifier.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) return "unpaired surrogate"
  return undefined
}

/** Header, identifier and tags: everything written before the contents. */
const patchPrefix = (entry: QuiltEntry, tags: ReadonlyArray<readonly [string, string]>): Result.Result<Uint8Array, QuiltError> => {
  const id = encodeString(entry.identifier)
  if (id.length >= U16_MAX) return fail(`identifier of ${id.length} BCS bytes; at most ${U16_MAX - 1}`)
  const tagBytes = tags.length > 0 ? encodeTags(tags) : undefined
  if (tagBytes && tagBytes.length > U16_MAX) return fail(`tags of ${tagBytes.length} BCS bytes; at most ${U16_MAX}`)
  const size = PATCH_HEADER_BYTES + 2 + id.length + (tagBytes ? 2 + tagBytes.length : 0)
  const length = size - PATCH_HEADER_BYTES + entry.contents.length
  if (length > U32_MAX) return fail(`entry ${JSON.stringify(entry.identifier)} of ${entry.contents.length} bytes exceeds the u32 patch length`)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint8(0, VERSION)
  view.setUint32(1, length, true)
  view.setUint8(5, tagBytes ? HAS_TAGS : 0)
  view.setUint16(6, id.length, true)
  out.set(id, 8)
  if (tagBytes) {
    view.setUint16(8 + id.length, tagBytes.length, true)
    out.set(tagBytes, 10 + id.length)
  }
  return Result.succeed(out)
}

const fits = (sizes: ReadonlyArray<number>, columns: number, columnSize: number): boolean =>
  sizes.reduce((acc, size) => acc + Math.ceil(size / columnSize), 0) <= columns

/**
 * The smallest even symbol size at which every blob (the index first) fits in
 * whole columns, the index in at most 10 (`compute_symbol_size`).
 */
const computeSymbolSize = (sizes: ReadonlyArray<number>, columns: number, rows: number): Result.Result<number, QuiltError> => {
  const total = sizes.reduce((a, b) => a + b, 0)
  let lo = Math.max(
    Math.ceil(total / (columns * rows)),
    Math.ceil(sizes[0]! / (rows * MAX_INDEX_COLUMNS)),
    Math.ceil(INDEX_PREFIX_BYTES / rows)
  )
  let hi = Math.ceil(Math.max(...sizes) / (Math.floor(columns / sizes.length) * rows))
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (fits(sizes, columns, mid * rows)) hi = mid
    else lo = mid + 1
  }
  const symbolSize = Math.ceil(lo / Encoding.SYMBOL_ALIGNMENT) * Encoding.SYMBOL_ALIGNMENT
  if (symbolSize > Encoding.MAX_SYMBOL_SIZE) {
    return fail(`the entries need symbol size ${symbolSize}, above the maximum ${Encoding.MAX_SYMBOL_SIZE}; remove some`)
  }
  if (!fits(sizes, columns, symbolSize * rows)) return fail("the entries do not fit in one quilt")
  return Result.succeed(symbolSize)
}

/** `write_bytes_to_columns`: `bytes` into columns from `start`, after skipping `skip` bytes of that run. */
const writeColumns = (
  quilt: Uint8Array,
  bytes: Uint8Array,
  start: number,
  rowSize: number,
  columnSize: number,
  symbolSize: number,
  skip: number
) => {
  const rows = columnSize / symbolSize
  let column = start + Math.floor(skip / columnSize)
  let row = Math.floor(skip / symbolSize) % rows
  let offset = skip % symbolSize
  let i = 0
  while (i < bytes.length) {
    const at = row * rowSize + column * symbolSize + offset
    const len = Math.min(symbolSize - offset, bytes.length - i)
    quilt.set(bytes.subarray(i, i + len), at)
    i += len
    offset = 0
    row = (row + 1) % rows
    if (row === 0) column++
  }
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

const base64Url = (bytes: Uint8Array): string => {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6))
    for (let k = 0; k < chars; k++) out += ALPHABET[(n >> (18 - 6 * k)) & 63]
  }
  return out
}

/** Strict: URL-safe alphabet, no padding, no stray bits. */
const fromBase64Url = (s: string): Uint8Array | undefined => {
  if (s.length % 4 === 1) return undefined
  const out = new Uint8Array(Math.floor((s.length * 6) / 8))
  let acc = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < s.length; i++) {
    const v = ALPHABET.indexOf(s[i]!)
    if (v < 0) return undefined
    acc = ((acc << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return undefined
  return out
}
