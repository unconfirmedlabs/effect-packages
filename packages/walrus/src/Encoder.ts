/**
 * RS2 erasure coding, sliver verification and BLS through
 * `@unconfirmed/walrus-wasm` (§1.7, §4.3): our own build of `walrus-core`
 * 1.62.0 with WebAssembly SIMD, byte-identical to `@mysten/walrus-wasm` 0.3.1
 * (parity tests) and several times faster.
 *
 * Every WASM call is synchronous (about 0.5 s at `n = 1000`, W5). The service
 * only passes plain data (numbers and `Uint8Array`s) across its boundary, so a
 * worker-backed layer can replace `layer` later without changing callers
 * (open question 5).
 *
 * Loading the WASM (W2). The module is imported lazily, the first time a
 * layer is built, so importing this file (or the package index) costs nothing
 * until an `Encoder` is needed:
 *
 * - Bun and Node: `@unconfirmed/walrus-wasm` reads
 *   `nodejs/walrus_wasm_bg.wasm` next to its glue with `fs` (`__dirname`) and
 *   compiles it synchronously; `wasmUrl` is ignored. When bundling for a
 *   server, keep `@unconfirmed/walrus-wasm` external, or copy
 *   `nodejs/walrus_wasm_bg.wasm` next to a CJS bundle.
 * - Browsers (the `browser` export condition): the glue fetches the SIMD
 *   build (`web/walrus_wasm_bg.wasm`), or the scalar one
 *   (`web/walrus_wasm_nosimd_bg.wasm`) when `WebAssembly.validate` rejects a
 *   SIMD instruction. Without `wasmUrl` / `wasmFallbackUrl` they are found with
 *   `new URL(…, import.meta.url)`, which Vite and webpack 5 turn into emitted
 *   assets; esbuild, Rolldown and Bun's bundler do not, so serve the files and
 *   pass their URLs (or copy them next to the chunk).
 *
 * A failed load is an `EncoderError` with operation `"init"`.
 */
import type * as Wasm from "@unconfirmed/walrus-wasm"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
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
   * The Merkle root of each given BCS `SliverData`, in order: each sliver is
   * expanded along the other axis and its `n` symbols hashed, as
   * `SliverData::verify` does (E8). Compare entry `i` with the metadata's
   * `hashes[sliverPair].primary` / `.secondary`. Each must carry `symbolSize`
   * and the axis' symbol count (run `Messages.checkSliver` first to blame a
   * node for a malformed one). Works for repair slivers too. One WASM call,
   * any number of slivers.
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
  /** Where browsers fetch the SIMD build (`web/walrus_wasm_bg.wasm`) from. Ignored on Bun and Node (W2). */
  readonly wasmUrl?: string | URL
  /** Where browsers without WebAssembly SIMD fetch the scalar build (`web/walrus_wasm_nosimd_bg.wasm`) from. Ignored on Bun and Node. */
  readonly wasmFallbackUrl?: string | URL
}

// -----------------------------------------------------------------------------
// WASM results
// -----------------------------------------------------------------------------

const blobIdOf = (bytes: Uint8Array): BlobId.BlobId => {
  const r = BlobId.fromBytes(bytes)
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

/** `walrus-core` panics below 4 shards (W7); a `u16` above. */
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
      const wasm = await import("@unconfirmed/walrus-wasm")
      // A no-op on Bun and Node; picks a build, fetches and instantiates it in browsers (once per realm).
      await wasm.default({
        ...(options?.wasmUrl === undefined ? {} : { module_or_path: options.wasmUrl }),
        ...(options?.wasmFallbackUrl === undefined ? {} : { fallback_module_or_path: options.wasmFallbackUrl })
      })
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

    const encode: EncoderService["encode"] = (nShards, blob) =>
      Effect.gen(function*() {
        yield* checkShards("encode", nShards)
        yield* checkLength("encode", blob.length, nShards)
        return yield* attempt("encode", (): EncodedBlob => {
          // `primary ‖ secondary ‖ metadata ‖ blob id ‖ root hash`; the slivers are views into it.
          const out = withEncoder(nShards, (e) => e.encode(blob))
          const sizes = Encoding.bcsSliverBytes(blob.length, nShards)
          const slivers = nShards * (sizes.primary + sizes.secondary)
          if (out.length <= slivers + 64) throw new Error(`WASM returned ${out.length} bytes, expected more than ${slivers + 64}`)
          const primary = Array.from({ length: nShards }, (_, p) => out.subarray(p * sizes.primary, (p + 1) * sizes.primary))
          const base = nShards * sizes.primary
          const secondary = Array.from({ length: nShards }, (_, p) =>
            out.subarray(base + p * sizes.secondary, base + (p + 1) * sizes.secondary))
          return {
            blobId: blobIdOf(out.slice(out.length - 64, out.length - 32)),
            rootHash: out.slice(out.length - 32),
            unencodedLength: blob.length,
            nShards,
            metadata: out.subarray(slivers, out.length - 64),
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
          const out = withEncoder(nShards, (e) => e.compute_metadata(blob))
          if (out.length !== 64) throw new Error(`WASM returned ${out.length} bytes of metadata, expected 64`)
          return { blobId: blobIdOf(out.slice(0, 32)), rootHash: out.slice(32) }
        })
      }).pipe(Effect.withSpan("Encoder.blobId", { attributes: { "walrus.n_shards": nShards, "walrus.blob_size": blob.length } }))

    const decode: EncoderService["decode"] = (nShards, unencodedLength, primarySlivers) =>
      Effect.gen(function*() {
        yield* checkShards("decode", nShards)
        yield* checkLength("decode", unencodedLength, nShards)
        return yield* attempt("decode", () => {
          const out = withEncoder(nShards, (e) => e.decode(BigInt(unencodedLength), [...primarySlivers]))
          if (out.length !== unencodedLength) throw new Error(`decoded ${out.length} bytes, expected ${unencodedLength}`)
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
        if (slivers.length === 0) return []
        // A primary sliver holds a row (`secondary` symbols), a secondary one a column (`primary` symbols) (E3).
        const source = Encoding.sourceSymbols(nShards)
        const symbols = axis === "primary" ? source.secondary : source.primary
        for (let i = 0; i < slivers.length; i++) {
          const parsed = Messages.parseSliver(slivers[i]!)
          if (Result.isFailure(parsed)) return yield* fail(op, `sliver ${i}: ${parsed.failure.reason}`)
          const { symbolSize: s, data: d } = parsed.success
          if (s !== symbolSize) return yield* fail(op, `sliver ${i}: symbol size ${s}, expected ${symbolSize}`)
          if (d.length !== symbols * symbolSize) return yield* fail(op, `sliver ${i}: ${d.length} data bytes, expected ${symbols * symbolSize}`)
        }
        return yield* attempt(op, () => {
          const out = withEncoder(nShards, (e) => e.sliver_roots(axis === "primary", [...slivers]))
          if (out.length !== 32 * slivers.length) throw new Error(`WASM returned ${out.length} bytes of roots for ${slivers.length} slivers`)
          return Array.from({ length: slivers.length }, (_, i) => out.slice(32 * i, 32 * (i + 1)))
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
 * instances when the layer's scope closes. `wasmUrl` / `wasmFallbackUrl` are
 * needed in browsers only (W2; see the module comment).
 */
export const layer = (options?: EncoderOptions): Layer.Layer<Encoder, EncoderError> => Layer.effect(Encoder, make(options))
