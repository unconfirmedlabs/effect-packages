/* tslint:disable */
/* eslint-disable */

/**
 * An RS2 encoder for one shard count.
 */
export class BlobEncoder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The blob id and root hash of `data` without the slivers: `blob_id (32)
     * ‖ root_hash (32)`.
     */
    compute_metadata(data: Uint8Array): Uint8Array;
    /**
     * Decode a blob of `blob_size` bytes from BCS `SliverData<Primary>`
     * slivers (at least `n − 2f` distinct ones). Verifies nothing.
     */
    decode(blob_size: bigint, slivers: Uint8Array[]): Uint8Array;
    /**
     * Encode `data`.
     *
     * Returns `primary slivers ‖ secondary slivers ‖ metadata ‖ blob_id (32)
     * ‖ root_hash (32)`: `n` BCS `SliverData` of each axis in sliver-pair
     * order (pair `p` carries secondary sliver `n − 1 − p`; all slivers of one
     * axis have the same length), then BCS `BlobMetadata` (the metadata `PUT`
     * body).
     */
    encode(data: Uint8Array): Uint8Array;
    constructor(n_shards: number);
    /**
     * The Merkle root (the metadata hash) of each BCS `SliverData`, as
     * `32 × slivers.length` bytes in order: primary slivers when `primary`,
     * else secondary. Each sliver is expanded along the other axis and its
     * `n` symbols hashed, exactly as `SliverData::verify` does; the root
     * depends only on the sliver's symbols, not on its index.
     */
    sliver_roots(primary: boolean, slivers: Uint8Array[]): Uint8Array;
    /**
     * The shard count this encoder was built for.
     */
    readonly n_shards: number;
}

/**
 * Aggregate 96-byte signatures.
 */
export function bls12381_min_pk_aggregate(signatures: Uint8Array[]): Uint8Array;

/**
 * Verify a BLS12-381 min-pk signature. The key may be compressed (48 bytes)
 * or uncompressed (96 bytes).
 */
export function bls12381_min_pk_verify(signature: Uint8Array, public_key: Uint8Array, msg: Uint8Array): boolean;

/**
 * Verify an aggregate signature over one message.
 */
export function bls12381_min_pk_verify_aggregate(public_keys: Uint8Array[], msg: Uint8Array, signature: Uint8Array): boolean;

/**
 * Whether this is the `simd128` build (Reed-Solomon engine and hashing).
 */
export function simd(): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_blobencoder_free: (a: number, b: number) => void;
    readonly blobencoder_compute_metadata: (a: number, b: number, c: number) => [number, number, number, number];
    readonly blobencoder_decode: (a: number, b: bigint, c: number, d: number) => [number, number, number, number];
    readonly blobencoder_encode: (a: number, b: number, c: number) => [number, number, number, number];
    readonly blobencoder_n_shards: (a: number) => number;
    readonly blobencoder_new: (a: number) => [number, number, number];
    readonly blobencoder_sliver_roots: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly bls12381_min_pk_aggregate: (a: number, b: number) => [number, number, number, number];
    readonly bls12381_min_pk_verify: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly bls12381_min_pk_verify_aggregate: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly simd: () => number;
    readonly rustsecp256k1_v0_8_1_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_8_1_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_8_1_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_8_1_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
