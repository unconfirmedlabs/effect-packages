/* @ts-self-types="./walrus_wasm.d.ts" */

/**
 * An RS2 encoder for one shard count.
 */
class BlobEncoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BlobEncoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_blobencoder_free(ptr, 0);
    }
    /**
     * The blob id and root hash of `data` without the slivers: `blob_id (32)
     * ‖ root_hash (32)`.
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    compute_metadata(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.blobencoder_compute_metadata(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Decode a blob of `blob_size` bytes from BCS `SliverData<Primary>`
     * slivers (at least `n − 2f` distinct ones). Verifies nothing.
     * @param {bigint} blob_size
     * @param {Uint8Array[]} slivers
     * @returns {Uint8Array}
     */
    decode(blob_size, slivers) {
        const ptr0 = passArrayJsValueToWasm0(slivers, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.blobencoder_decode(this.__wbg_ptr, blob_size, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Encode `data`.
     *
     * Returns `primary slivers ‖ secondary slivers ‖ metadata ‖ blob_id (32)
     * ‖ root_hash (32)`: `n` BCS `SliverData` of each axis in sliver-pair
     * order (pair `p` carries secondary sliver `n − 1 − p`; all slivers of one
     * axis have the same length), then BCS `BlobMetadata` (the metadata `PUT`
     * body).
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    encode(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.blobencoder_encode(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * The shard count this encoder was built for.
     * @returns {number}
     */
    get n_shards() {
        const ret = wasm.blobencoder_n_shards(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} n_shards
     */
    constructor(n_shards) {
        const ret = wasm.blobencoder_new(n_shards);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        BlobEncoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The Merkle root (the metadata hash) of each BCS `SliverData`, as
     * `32 × slivers.length` bytes in order: primary slivers when `primary`,
     * else secondary. Each sliver is expanded along the other axis and its
     * `n` symbols hashed, exactly as `SliverData::verify` does; the root
     * depends only on the sliver's symbols, not on its index.
     * @param {boolean} primary
     * @param {Uint8Array[]} slivers
     * @returns {Uint8Array}
     */
    sliver_roots(primary, slivers) {
        const ptr0 = passArrayJsValueToWasm0(slivers, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.blobencoder_sliver_roots(this.__wbg_ptr, primary, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
}
if (Symbol.dispose) BlobEncoder.prototype[Symbol.dispose] = BlobEncoder.prototype.free;
exports.BlobEncoder = BlobEncoder;

/**
 * Aggregate 96-byte signatures.
 * @param {Uint8Array[]} signatures
 * @returns {Uint8Array}
 */
function bls12381_min_pk_aggregate(signatures) {
    const ptr0 = passArrayJsValueToWasm0(signatures, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.bls12381_min_pk_aggregate(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.bls12381_min_pk_aggregate = bls12381_min_pk_aggregate;

/**
 * Verify a BLS12-381 min-pk signature. The key may be compressed (48 bytes)
 * or uncompressed (96 bytes).
 * @param {Uint8Array} signature
 * @param {Uint8Array} public_key
 * @param {Uint8Array} msg
 * @returns {boolean}
 */
function bls12381_min_pk_verify(signature, public_key, msg) {
    const ptr0 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(public_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(msg, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.bls12381_min_pk_verify(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
exports.bls12381_min_pk_verify = bls12381_min_pk_verify;

/**
 * Verify an aggregate signature over one message.
 * @param {Uint8Array[]} public_keys
 * @param {Uint8Array} msg
 * @param {Uint8Array} signature
 * @returns {boolean}
 */
function bls12381_min_pk_verify_aggregate(public_keys, msg, signature) {
    const ptr0 = passArrayJsValueToWasm0(public_keys, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(msg, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.bls12381_min_pk_verify_aggregate(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
exports.bls12381_min_pk_verify_aggregate = bls12381_min_pk_verify_aggregate;

/**
 * Whether this is the `simd128` build (Reed-Solomon engine and hashing).
 * @returns {boolean}
 */
function simd() {
    const ret = wasm.simd();
    return ret !== 0;
}
exports.simd = simd;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_408e67f47ca7b58b: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_length_36bd29c6848c2144: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_prototypesetcall_de8e0d9553586985: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./walrus_wasm_bg.js": import0,
    };
}

const BlobEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_blobencoder_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/walrus_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
