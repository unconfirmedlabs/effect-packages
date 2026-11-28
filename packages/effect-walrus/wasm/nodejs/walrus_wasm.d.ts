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
