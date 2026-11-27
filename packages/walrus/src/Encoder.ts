/**
 * RS2 erasure coding and BLS through `@mysten/walrus-wasm` 0.3.1 (§1.7, §4.3).
 *
 * Every WASM call is synchronous and slow (about 2.5 s at `n = 1000`, W5). The
 * service only passes plain data (numbers and `Uint8Array`s) across its
 * boundary, so a worker-backed layer can replace `layer` later without
 * changing callers (open question 5).
 *
 * Loading the WASM (W2). The module is imported lazily, the first time a
 * layer is built, so importing this file (or the package index) costs nothing
 * until an `Encoder` is needed:
 *
 * - Bun and Node: `@mysten/walrus-wasm` reads `walrus_wasm_bg.wasm` next to
 *   its glue with `fs` (`__dirname`) and compiles it synchronously; `wasmUrl`
 *   is ignored. When bundling for a server, keep `@mysten/walrus-wasm`
 *   external, or copy `nodejs/walrus_wasm_bg.wasm` next to a CJS bundle
 *   (esbuild's ESM output has no `__dirname`; Bun's bundler hard-codes the
 *   build machine's path).
 * - Browsers (the `browser` export condition): the glue fetches the web
 *   build's `.wasm` (358 KB). Without `wasmUrl` it uses `new URL(
 *   "walrus_wasm_bg.wasm", import.meta.url)`, which Vite and webpack 5 turn
 *   into an emitted asset; esbuild, Rolldown and Bun's bundler do not, so
 *   serve `web/walrus_wasm_bg.wasm` and pass its URL as `wasmUrl` (or copy
 *   it next to the chunk). In Vite:
 *   `import wasmUrl from "@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url"`.
 *
 * A failed load is an `EncoderError` with operation `"init"`.
 */
import type * as Wasm from "@mysten/walrus-wasm"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as BlobId from "./BlobId.ts"
import * as Encoding from "./Encoding.ts"
import { EncoderError } from "./Errors.ts"
import * as Messages from "./Messages.ts"

export interface EncodedBlob {
  readonly blobId: BlobId.BlobId
  readonly rootHash: Uint8Array
  readonly unencodedLength: number
  readonly nShards: number
  /** BCS `BlobMetadata`, the metadata `PUT` body (N2). */
  readonly metadata: Uint8Array
  /** BCS `SliverData`, by pair index. */
  readonly primary: ReadonlyArray<Uint8Array>
  /** BCS `SliverData`, by pair index: entry `p` carries secondary sliver index `n − 1 − p` (E7). */
  readonly secondary: ReadonlyArray<Uint8Array>
}

export type Axis = "primary" | "secondary"

export interface EncoderService {
  readonly encode: (nShards: number, blob: Uint8Array) => Effect.Effect<EncodedBlob, EncoderError>
  /** The blob id and root hash without the slivers (`compute_metadata`): what registration and the relay need. */
  readonly blobId: (
    nShards: number,
    blob: Uint8Array
  ) => Effect.Effect<{ readonly blobId: BlobId.BlobId; readonly rootHash: Uint8Array }, EncoderError>
  /** From >= n − 2f distinct BCS primary slivers. Verifies nothing (W4): check the result's blob id. */
  readonly decode: (
    nShards: number,
    unencodedLength: number,
    primarySlivers: ReadonlyArray<Uint8Array>
  ) => Effect.Effect<Uint8Array, EncoderError>
  /**
   * The Merkle root of each given BCS `SliverData`, in order, by the
   * crafted-blob method (W6): compare entry `i` with the metadata's
   * `hashes[sliverPair].primary` / `.secondary`. At most `n − 2f` primary or
   * `n − f` secondary slivers per call; each must carry `symbolSize` and the
   * axis' symbol count (run `Messages.checkSliver` first to blame a node for
   * a malformed one). Works for repair slivers too (E8). One WASM call.
   */
  readonly sliverRoots: (
    nShards: number,
    axis: Axis,
    symbolSize: number,
    slivers: ReadonlyArray<Uint8Array>
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, EncoderError>
  /** BLS12-381 min-pk. The key may be 48 (compressed) or 96 (uncompressed) bytes (M5); a malformed key or signature is an `EncoderError`. */
  readonly blsVerify: (signature: Uint8Array, publicKey: Uint8Array, message: Uint8Array) => Effect.Effect<boolean, EncoderError>
  readonly blsAggregate: (signatures: ReadonlyArray<Uint8Array>) => Effect.Effect<Uint8Array, EncoderError>
  readonly blsVerifyAggregate: (
    publicKeys: ReadonlyArray<Uint8Array>,
    message: Uint8Array,
    signature: Uint8Array
  ) => Effect.Effect<boolean, EncoderError>
}

export class Encoder extends Context.Service<Encoder, EncoderService>()("@unconfirmed/walrus/Encoder") {}

export interface EncoderOptions {
  /** Where the browser build fetches `walrus_wasm_bg.wasm` from. Ignored on Bun and Node (W2). */
  readonly wasmUrl?: string | URL
}

// -----------------------------------------------------------------------------
// WASM result shapes (W3)
// -----------------------------------------------------------------------------

type WasmNode = { readonly Digest: ArrayLike<number> } | "Empty" | { readonly Empty: unknown }

interface WasmMetadata {
  readonly blob_id: ArrayLike<number>
  readonly metadata: {
    readonly V1: {
      readonly unencoded_length: number | bigint
      readonly hashes: ReadonlyArray<{ readonly primary_hash: WasmNode; readonly secondary_hash: WasmNode }>
    }
  }
}

const merkleNode = (node: WasmNode): Messages.MerkleNode =>
  typeof node === "object" && "Digest" in node
    ? { _tag: "Digest", value: Uint8Array.from(node.Digest) }
    : { _tag: "Empty" }

const digest = (node: WasmNode, what: string): Uint8Array => {
  if (typeof node === "object" && "Digest" in node) return Uint8Array.from(node.Digest)
  throw new Error(`${what} is not a digest`)
}

const encodeMetadata = /* @__PURE__ */ Bcs.encodeSync(Messages.BlobMetadata)

const blobIdOf = (bytes: ArrayLike<number>): BlobId.BlobId => {
  const r = BlobId.fromBytes(Uint8Array.from(bytes))
  if (Result.isFailure(r)) throw new Error(`WASM returned a blob id of ${r.failure.input}`)
  return r.success
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const fail = (operation: string, message: string) => Effect.fail(new EncoderError({ operation, message }))

/** Run a synchronous WASM call; anything it throws (`JsError`, `RangeError`, ...) becomes an `EncoderError`. */
const attempt = <A>(operation: string, f: () => A): Effect.Effect<A, EncoderError> =>
  Effect.try({ try: f, catch: (e) => new EncoderError({ operation, message: messageOf(e) }) })

/** The WASM traps (a Rust panic) below 4 shards (W7); a `u16` above. */
export const MIN_SHARDS = 4
export const MAX_SHARDS = 0xffff

const checkShards = (operation: string, nShards: number): Effect.Effect<void, EncoderError> =>
  Number.isInteger(nShards) && nShards >= MIN_SHARDS && nShards <= MAX_SHARDS
    ? Effect.void
    : fail(operation, `nShards must be an integer in [${MIN_SHARDS}, ${MAX_SHARDS}], got ${nShards}`)

const checkLength = (operation: string, length: number, nShards: number): Effect.Effect<void, EncoderError> => {
  if (!Number.isSafeInteger(length) || length < 0) return fail(operation, `invalid blob length ${length}`)
  const max = Encoding.maxBlobSize(nShards)
  return length > max ? fail(operation, `blob of ${length} bytes exceeds ${max} for ${nShards} shards`) : Effect.void
}

const loadWasm = (options: EncoderOptions | undefined): Effect.Effect<typeof Wasm, EncoderError> =>
  Effect.tryPromise({
    try: async () => {
      const wasm = await import("@mysten/walrus-wasm")
      // A no-op on Bun and Node; fetches and instantiates in browsers (once per realm).
      await wasm.default(options?.wasmUrl === undefined ? undefined : { module_or_path: options.wasmUrl })
      return wasm
    },
    catch: (e) => new EncoderError({ operation: "init", message: messageOf(e) })
  })

/**
 * Build the in-thread service: load the WASM, and keep one `BlobEncoder` per
 * `nShards`, all freed when `scope` closes. Calls after that fail with an
 * `EncoderError`.
 */
export const make = (options?: EncoderOptions): Effect.Effect<EncoderService, EncoderError, Scope.Scope> =>
  Effect.gen(function*() {
    const wasm = yield* loadWasm(options)
    const encoders = new Map<number, Wasm.BlobEncoder>()
    let closed = false

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
        for (const encoder of encoders.values()) {
          try {
            encoder.free()
          } catch {
            // cannot happen for an instance that never trapped; nothing to do if it does
          }
        }
        encoders.clear()
      })
    )

    /**
     * Run `f` on the cached `BlobEncoder` for `nShards`. A trap (Rust panic)
     * leaves the instance marked as borrowed, so that every later call on it,
     * and `free`, throws: drop it from the cache (leaking its memory) and let
     * the next call build a fresh one.
     */
    const withEncoder = <A>(nShards: number, f: (encoder: Wasm.BlobEncoder) => A): A => {
      if (closed) throw new Error("the Encoder layer's scope is closed")
      let encoder = encoders.get(nShards)
      if (encoder === undefined) {
        encoder = new wasm.BlobEncoder(nShards)
        encoders.set(nShards, encoder)
      }
      try {
        return f(encoder)
      } catch (e) {
        if (e instanceof WebAssembly.RuntimeError) encoders.delete(nShards)
        throw e
      }
    }

    /** `encode` into exactly sized buffers (W3). */
    const rawEncode = (nShards: number, blob: Uint8Array) => {
      const sizes = Encoding.bcsSliverBytes(blob.length, nShards)
      const primary = Array.from({ length: nShards }, () => new Uint8Array(sizes.primary))
      const secondary = Array.from({ length: nShards }, () => new Uint8Array(sizes.secondary))
      const [metadata, root] = withEncoder(nShards, (e) => e.encode(blob, primary, secondary)) as [WasmMetadata, WasmNode]
      return { metadata, root, primary, secondary }
    }

    const encode: EncoderService["encode"] = (nShards, blob) =>
      Effect.gen(function*() {
        yield* checkShards("encode", nShards)
        yield* checkLength("encode", blob.length, nShards)
        return yield* attempt("encode", (): EncodedBlob => {
          const { metadata, root, primary, secondary } = rawEncode(nShards, blob)
          const v1 = metadata.metadata.V1
          return {
            blobId: blobIdOf(metadata.blob_id),
            rootHash: digest(root, "root hash"),
            unencodedLength: blob.length,
            nShards,
            metadata: encodeMetadata({
              _tag: "V1",
              encodingType: { _tag: "RS2" },
              unencodedLength: BigInt(v1.unencoded_length),
              hashes: v1.hashes.map((h) => ({ primaryHash: merkleNode(h.primary_hash), secondaryHash: merkleNode(h.secondary_hash) }))
            }),
            primary,
            secondary
          }
        })
      }).pipe(Effect.withSpan("Encoder.encode", { attributes: { "walrus.n_shards": nShards, "walrus.blob_size": blob.length } }))

    const blobId: EncoderService["blobId"] = (nShards, blob) =>
      Effect.gen(function*() {
        yield* checkShards("blobId", nShards)
        yield* checkLength("blobId", blob.length, nShards)
        return yield* attempt("blobId", () => {
          const [id, root] = withEncoder(nShards, (e) => e.compute_metadata(blob)) as [ArrayLike<number>, WasmNode, unknown, unknown]
          return { blobId: blobIdOf(id), rootHash: digest(root, "root hash") }
        })
      }).pipe(Effect.withSpan("Encoder.blobId", { attributes: { "walrus.n_shards": nShards, "walrus.blob_size": blob.length } }))

    const decode: EncoderService["decode"] = (nShards, unencodedLength, primarySlivers) =>
      Effect.gen(function*() {
        yield* checkShards("decode", nShards)
        yield* checkLength("decode", unencodedLength, nShards)
        return yield* attempt("decode", () => {
          const out = new Uint8Array(unencodedLength)
          // The WASM deserialises the blob id and ignores it (W4).
          withEncoder(nShards, (e) => e.decode(new Uint8Array(BlobId.LENGTH), BigInt(unencodedLength), [...primarySlivers], out))
          return out
        })
      }).pipe(Effect.withSpan("Encoder.decode", {
        attributes: { "walrus.n_shards": nShards, "walrus.blob_size": unencodedLength, "walrus.slivers": primarySlivers.length }
      }))

    const sliverRoots: EncoderService["sliverRoots"] = (nShards, axis, symbolSize, slivers) =>
      Effect.gen(function*() {
        const op = "sliverRoots"
        yield* checkShards(op, nShards)
        if (!Number.isInteger(symbolSize) || symbolSize < 2 || symbolSize > Encoding.MAX_SYMBOL_SIZE || symbolSize % 2 !== 0) {
          return yield* fail(op, `symbol size must be even and in [2, ${Encoding.MAX_SYMBOL_SIZE}], got ${symbolSize}`)
        }
        const { primary: rows, secondary: columns } = Encoding.sourceSymbols(nShards)
        const limit = axis === "primary" ? rows : columns
        if (slivers.length > limit) return yield* fail(op, `${slivers.length} ${axis} slivers, at most ${limit} per call`)
        if (slivers.length === 0) return []
        // A primary sliver holds a row (`columns` symbols), a secondary one a column (`rows` symbols) (E3).
        const symbols = axis === "primary" ? columns : rows
        const data: Array<Uint8Array> = []
        for (let i = 0; i < slivers.length; i++) {
          const parsed = Messages.parseSliver(slivers[i]!)
          if (Result.isFailure(parsed)) return yield* fail(op, `sliver ${i}: ${parsed.failure.reason}`)
          const { symbolSize: s, data: d } = parsed.success
          if (s !== symbolSize) return yield* fail(op, `sliver ${i}: symbol size ${s}, expected ${symbolSize}`)
          if (d.length !== symbols * symbolSize) return yield* fail(op, `sliver ${i}: ${d.length} data bytes, expected ${symbols * symbolSize}`)
          data.push(d)
        }
        // The crafted blob: exactly `rows × columns × symbolSize` bytes, so its symbol size is `symbolSize` (E2),
        // with the slivers as its first rows (primary) or columns (secondary), zeros elsewhere (W6).
        const blob = new Uint8Array(rows * columns * symbolSize)
        const rowBytes = columns * symbolSize
        if (axis === "primary") {
          data.forEach((d, r) => blob.set(d, r * rowBytes))
        } else {
          data.forEach((d, c) => {
            for (let r = 0; r < rows; r++) {
              blob.set(d.subarray(r * symbolSize, (r + 1) * symbolSize), r * rowBytes + c * symbolSize)
            }
          })
        }
        return yield* attempt(op, () => {
          const hashes = rawEncode(nShards, blob).metadata.metadata.V1.hashes
          return data.map((_, i) =>
            axis === "primary"
              ? digest(hashes[i]!.primary_hash, `primary hash ${i}`)
              : digest(hashes[nShards - 1 - i]!.secondary_hash, `secondary hash ${nShards - 1 - i}`)
          )
        })
      }).pipe(Effect.withSpan("Encoder.sliverRoots", {
        attributes: { "walrus.n_shards": nShards, "walrus.axis": axis, "walrus.slivers": slivers.length }
      }))

    const blsVerify: EncoderService["blsVerify"] = (signature, publicKey, message) =>
      attempt("blsVerify", () => wasm.bls12381_min_pk_verify(signature, publicKey, message))

    const blsAggregate: EncoderService["blsAggregate"] = (signatures) =>
      attempt("blsAggregate", () => wasm.bls12381_min_pk_aggregate([...signatures]))

    const blsVerifyAggregate: EncoderService["blsVerifyAggregate"] = (publicKeys, message, signature) =>
      attempt("blsVerifyAggregate", () => wasm.bls12381_min_pk_verify_aggregate([...publicKeys], message, signature))

    return { encode, blobId, decode, sliverRoots, blsVerify, blsAggregate, blsVerifyAggregate } satisfies EncoderService
  })

/**
 * Initialises the WASM once per layer build and frees its `BlobEncoder`
 * instances when the layer's scope closes. `wasmUrl` is needed in browsers
 * only (W2; see the module comment).
 */
export const layer = (options?: EncoderOptions): Layer.Layer<Encoder, EncoderError> => Layer.effect(Encoder, make(options))
