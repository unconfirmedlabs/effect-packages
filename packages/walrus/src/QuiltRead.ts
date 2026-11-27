/**
 * Reading quilts (§4.9): the index, one patch by id, or one patch by
 * identifier, from only the secondary slivers (columns) involved.
 *
 *   const file = yield* QuiltRead.patch(patchId)
 *   const all = yield* QuiltRead.index(quiltId)
 *
 * Each column comes from the one node holding its shard in the **read**
 * committee (C6), is header-checked (`Messages.checkSliver`), and, unless
 * `verify: false`, is checked against the verified metadata's secondary hashes
 * with one `Encoder.sliverRoots` call per batch of columns before any of
 * its bytes is used. A column that cannot be fetched or does not match falls
 * back to `Read.blob` (a verified full read) for the rest of the call. This
 * closes `@mysten/walrus`'s unverified single-node quilt reads (§2 item 9).
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import type { BlobId } from "./BlobId.ts"
import { type Committee, Committees } from "./Committee.ts"
import { Encoder, type EncoderService } from "./Encoder.ts"
import * as Encoding from "./Encoding.ts"
import { BlobTooLarge, QuiltError } from "./Errors.ts"
import * as Messages from "./Messages.ts"
import * as Quilt from "./Quilt.ts"
import type { QuiltFile, QuiltPatch } from "./Quilt.ts"
import * as Read from "./Read.ts"
import type { ReadError, ReadOptions, ReadServices } from "./Read.ts"
import { NodeError, StorageNodes } from "./StorageNode.ts"
import * as StorageNode from "./StorageNode.ts"
import * as Bytes from "@unconfirmed/bcs/Bytes"

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

export type { QuiltFile, QuiltPatch } from "./Quilt.ts"

export interface QuiltReadOptions extends ReadOptions {
  /** `"slivers"` (default) reads only the columns needed; `"blob"` reads the whole quilt. */
  readonly from?: "slivers" | "blob"
  /**
   * Default `true`. `false` skips the Merkle check of each column and returns
   * columns as the one node holding each served them: what `@mysten/walrus`
   * does. Saves one WASM `encode` of a quilt-sized blob per call (W5).
   */
  readonly verify?: boolean
}

export type QuiltReadError = ReadError | QuiltError

/** Every patch in the index, with its patch id. */
export const index = (
  quiltId: BlobId,
  options: QuiltReadOptions = {}
): Effect.Effect<ReadonlyArray<QuiltPatch & { readonly id: string }>, QuiltReadError, ReadServices> =>
  Effect.gen(function*() {
    const source = yield* open(quiltId, options)
    const patches = yield* readIndex(source)
    return patches.map((p) => ({ ...p, id: Quilt.patchId(quiltId, p) }))
  })

/** One patch by its id (`Quilt.patchId`). */
export const patch = (id: string, options: QuiltReadOptions = {}): Effect.Effect<QuiltFile, QuiltReadError, ReadServices> =>
  Effect.gen(function*() {
    const parsed = yield* Effect.fromResult(Quilt.parseId(id))
    if (parsed._tag !== "Patch") return yield* new QuiltError({ reason: "a blob id, not a quilt patch id" })
    const source = yield* open(parsed.quiltId, options)
    return yield* readPatch(source, parsed.startIndex, parsed.endIndex)
  })

/**
 * One patch by its identifier: the index, then that patch's columns. The
 * index is decoded before it is verified (only to find the patch), then the
 * index and patch columns are verified together in one `sliverRoots` call;
 * anything unexpected (a mismatch, an index that does not decode, no such
 * identifier) takes the verified path: the index first, then the patch.
 */
export const byIdentifier = (
  quiltId: BlobId,
  identifier: string,
  options: QuiltReadOptions = {}
): Effect.Effect<QuiltFile, QuiltReadError, ReadServices> =>
  Effect.gen(function*() {
    const source = yield* open(quiltId, options)
    const fast = yield* findAndVerifyAtOnce(source, identifier)
    if (fast !== undefined) return yield* readPatch(source, fast.startIndex, fast.endIndex)
    const patches = yield* readIndex(source)
    const found = patches.find((p) => p.identifier === identifier)
    if (!found) return yield* new QuiltError({ reason: `no patch with identifier ${JSON.stringify(identifier)}` })
    return yield* readPatch(source, found.startIndex, found.endIndex)
  })

/**
 * The patch named `identifier`, with the index columns and the patch's columns verified in one go, or
 * `undefined` when the caller should take the verified path (no `check` on this source, or anything
 * unexpected). An unverified index is only used to choose which columns to fetch: nothing it says is
 * returned until its columns have passed the Merkle check.
 */
const findAndVerifyAtOnce = (source: Source, identifier: string): Effect.Effect<QuiltPatch | undefined, QuiltReadError> =>
  Effect.gen(function*() {
    const check = source.check
    if (check === undefined) return undefined
    const l = source.layout
    const spans = Quilt.indexColumns(yield* source.columns(0, 1, false), l)
    if (Result.isFailure(spans)) return undefined
    const count = spans.success
    const index = Quilt.decodeIndex(yield* source.columns(0, count, false), l)
    if (Result.isFailure(index)) return undefined
    const found = index.success.find((p) => p.identifier === identifier)
    if (!found || !(found.startIndex < found.endIndex) || found.endIndex > l.columns) return undefined
    yield* source.columns(found.startIndex, found.endIndex, false)
    const ok = yield* check([[0, count], [found.startIndex, found.endIndex]])
    // Verified: the index decoded above came from exactly these bytes.
    return ok ? found : undefined
  })

// -----------------------------------------------------------------------------
// Reading through columns
// -----------------------------------------------------------------------------

/** Columns of one quilt, for the length of one call. */
interface Source {
  readonly layout: Quilt.Layout
  /**
   * Columns `[start, end)`, concatenated. With `checked: false` the bytes may
   * not have been verified yet (only to size a later read); otherwise every
   * column has passed the Merkle check (or comes from a verified full read).
   */
  readonly columns: (start: number, end: number, checked?: boolean) => Effect.Effect<Uint8Array, QuiltReadError>
  /**
   * Merkle-check every fetched, unchecked column in these `[start, end)` ranges in as few `sliverRoots`
   * calls as possible; `false` if any differs. Absent when every column is verified on arrival.
   */
  readonly check?: (ranges: ReadonlyArray<readonly [number, number]>) => Effect.Effect<boolean, QuiltReadError>
}

const readIndex = (source: Source): Effect.Effect<ReadonlyArray<QuiltPatch>, QuiltReadError> =>
  Effect.gen(function*() {
    const l = source.layout
    // Size the index from the first column before verifying it, so the whole index is verified in one call.
    let spans = Quilt.indexColumns(yield* source.columns(0, 1, false), l)
    if (Result.isFailure(spans)) spans = Quilt.indexColumns(yield* source.columns(0, 1), l)
    const count = yield* Effect.fromResult(spans)
    return yield* Effect.fromResult(Quilt.decodeIndex(yield* source.columns(0, count), l))
  })

const readPatch = (source: Source, start: number, end: number): Effect.Effect<QuiltFile, QuiltReadError> =>
  Effect.gen(function*() {
    const l = source.layout
    if (!(start < end) || end > l.columns) {
      return yield* new QuiltError({ reason: `patch columns [${start}, ${end}) outside a quilt of ${l.columns}` })
    }
    return yield* Effect.fromResult(Quilt.decodePatch(yield* source.columns(start, end)))
  })

const quiltLayout = (unencodedLength: number, nShards: number) => Effect.fromResult(Quilt.layout(unencodedLength, nShards))

/** The whole quilt through `Read.blob` (verified unless `consistency: "skip"`), sliced. */
const blobSource = (quiltId: BlobId, nShards: number, options: QuiltReadOptions): Effect.Effect<Source, QuiltReadError, ReadServices> =>
  Effect.gen(function*() {
    const bytes = yield* Read.blob(quiltId, options)
    const layout = yield* quiltLayout(bytes.length, nShards)
    return { layout, columns: (start, end) => Effect.succeed(Quilt.columnsOf(bytes, layout, start, end)) }
  })

const open = (quiltId: BlobId, options: QuiltReadOptions): Effect.Effect<Source, QuiltReadError, ReadServices> =>
  Effect.gen(function*() {
    if (options.from === "blob") {
      const { current } = yield* Effect.flatMap(Effect.service(Committees), (c) => c.get)
      return yield* blobSource(quiltId, current.nShards, options)
    }
    const { committee, metadata } = yield* Read.locate(quiltId, options)
    const maxSize = options.maxSize ?? Read.DEFAULT_MAX_SIZE
    if (metadata.unencodedLength > maxSize) return yield* new BlobTooLarge({ size: metadata.unencodedLength, max: maxSize })
    return yield* sliverSource(quiltId, committee, metadata, options)
  })

const sliverSource = (
  quiltId: BlobId,
  committee: Committee,
  metadata: Messages.VerifiedMetadata,
  options: QuiltReadOptions
): Effect.Effect<Source, QuiltReadError, ReadServices> =>
  Effect.gen(function*() {
    const nodes = yield* Effect.service(StorageNodes)
    const encoder = yield* Effect.service(Encoder)
    const services = yield* Effect.context<ReadServices>()
    const n = committee.nShards
    const layout = yield* quiltLayout(metadata.unencodedLength, n)
    const retry = options.retry ?? Read.defaultRetry()
    const verify = options.verify ?? true
    const concurrency = Math.max(1, Math.min(layout.columns, Math.floor(IN_FLIGHT_BYTES / layout.columnSize)))

    /** Column data that passed the Merkle check (or `verify: false`). */
    const verified = new Map<number, Uint8Array>()
    /** Column data fetched and header-checked, not yet Merkle-checked: BCS bytes and the symbols. */
    const pending = new Map<number, { readonly bytes: Uint8Array; readonly data: Uint8Array }>()
    let fallback: Source | undefined

    const fetchColumn = (s: number): Effect.Effect<void, NodeError> =>
      Effect.suspend(() => {
        const pair = Encoding.pairOfSecondary(s, n)
        const shard = Encoding.shardOfPair(pair, quiltId, n)
        const node = (() => {
          try {
            return committee.nodeOfShard(shard)
          } catch {
            return undefined
          }
        })()
        if (!node) return Effect.fail(new NodeError({ node: `shard ${shard}`, kind: "Unavailable", message: `no node holds shard ${shard}` }))
        const url = node.url.replace(/\/+$/, "")
        return nodes.sliver(node, quiltId, pair, "secondary").pipe(
          Effect.flatMap((bytes) => {
            const parsed = Messages.parseSliver(bytes)
            const checked = Messages.checkSliver(bytes, { index: s, symbolSize: layout.symbolSize, symbols: layout.rows })
            return Result.isSuccess(checked) && Result.isSuccess(parsed)
              ? Effect.succeed({ bytes, data: parsed.success.data })
              : Effect.fail(
                new NodeError({
                  node: url,
                  kind: "Malformed",
                  message: `secondary sliver ${s}: ${Result.isFailure(checked) ? checked.failure.reason : "malformed"}`
                })
              )
          }),
          Effect.retry({ schedule: retry, while: StorageNode.retryable }),
          Effect.map((column) => {
            if (verify) pending.set(s, column)
            else verified.set(s, column.data)
          })
        )
      })

    /** Merkle-check the pending columns in the ranges; false if any differs from the metadata. */
    const checkRanges = (ranges: ReadonlyArray<readonly [number, number]>): Effect.Effect<boolean, QuiltReadError> =>
      Effect.gen(function*() {
        const todo = [...pending.keys()].filter((s) => ranges.some(([start, end]) => s >= start && s < end)).sort((a, b) => a - b)
        const ok = yield* sliverRootsMatch(encoder, n, layout, metadata, todo.map((s) => ({ s, bytes: pending.get(s)!.bytes })))
        if (!ok) return false
        for (const s of todo) {
          verified.set(s, pending.get(s)!.data)
          pending.delete(s)
        }
        return true
      })

    const useBlob = (reason: string) =>
      Effect.gen(function*() {
        yield* Effect.logDebug(`quilt ${quiltId}: reading the whole blob (${reason})`)
        fallback = yield* Effect.provideContext(blobSource(quiltId, n, options), services)
        return fallback
      })

    const columns: Source["columns"] = (start, end, checked = true) =>
      Effect.gen(function*() {
        if (fallback) return yield* fallback.columns(start, end)
        const wanted: Array<number> = []
        for (let s = start; s < end; s++) if (!verified.has(s) && !pending.has(s)) wanted.push(s)
        const fetched = yield* Effect.result(Effect.forEach(wanted, fetchColumn, { concurrency, discard: true }))
        if (Result.isFailure(fetched)) {
          return yield* (yield* useBlob(`column fetch failed: ${fetched.failure.message}`)).columns(start, end)
        }
        if (checked && !(yield* checkRanges([[start, end]]))) {
          return yield* (yield* useBlob("a column does not match the metadata")).columns(start, end)
        }
        const out = new Uint8Array((end - start) * layout.columnSize)
        for (let s = start; s < end; s++) out.set(verified.get(s) ?? pending.get(s)!.data, (s - start) * layout.columnSize)
        return out
      })

    const check: Source["check"] = (ranges) =>
      Effect.suspend(() => {
        if (fallback || !verify) return Effect.succeed(true)
        // A column that is not fetched yet cannot be checked: the verified path fetches and checks it.
        for (const [start, end] of ranges) for (let s = start; s < end; s++) if (!verified.has(s) && !pending.has(s)) return Effect.succeed(false)
        return checkRanges(ranges)
      })

    return { layout, columns, check }
  })

/** Sliver bytes in flight at once (the read path's budget). */
const IN_FLIGHT_BYTES = 12_500_000

/** One `Encoder.sliverRoots` call for all the columns, compared with `hashes[pairOfSecondary(s)].secondary`. */
const sliverRootsMatch = (
  encoder: EncoderService,
  n: number,
  layout: Quilt.Layout,
  metadata: Messages.VerifiedMetadata,
  columns: ReadonlyArray<{ readonly s: number; readonly bytes: Uint8Array }>
): Effect.Effect<boolean, QuiltReadError> =>
  Effect.gen(function*() {
    if (columns.length === 0) return true
    const roots = yield* encoder.sliverRoots(n, "secondary", layout.symbolSize, columns.map((c) => c.bytes))
    return columns.every((c, k) => Bytes.equal(roots[k]!, metadata.hashes[Encoding.pairOfSecondary(c.s, n)]!.secondary))
  })

