# `@unconfirmed/walrus-wasm`

Walrus RS2 erasure coding, per-sliver Merkle roots and BLS12-381 min-pk in WebAssembly, for `@unconfirmed/walrus`'s `Encoder`. It replaces `@mysten/walrus-wasm` 0.3.1 and is byte-for-byte compatible with it: the same blob ids, metadata, slivers and decoded blobs (`packages/walrus/test/parity.encoder.test.ts`, `test/wasm.test.ts`).

The built artifacts are committed (`nodejs/`, `web/`), so the repo works without a Rust toolchain. Rebuild them only when `src/`, `Cargo.toml` or `Cargo.lock` changes.

## What is in it

| Export | |
|---|---|
| `BlobEncoder(nShards)` | One per shard count (at least 4; fewer throws, it does not trap). |
| `.encode(blob)` | `primary slivers ‖ secondary slivers ‖ metadata ‖ blob id (32) ‖ root hash (32)`: `n` BCS `SliverData` per axis in sliver-pair order (pair `p` carries secondary sliver `n − 1 − p`), then BCS `BlobMetadata`. One buffer, so JS slices views instead of passing `2n` buffers in. |
| `.compute_metadata(blob)` | `blob id ‖ root hash`. |
| `.decode(length, primarySlivers)` | The blob, from at least `n − 2f` BCS primary slivers (systematic or repair). Verifies nothing. |
| `.sliver_roots(primary, slivers)` | The Merkle root of each BCS sliver (`32 × k` bytes): the sliver expanded along the other axis and its `n` symbols hashed, as `walrus-core`'s `SliverData::verify` does. Compare with the metadata's `hashes[pair].primary` / `.secondary`. This replaces the crafted-blob trick (encoding a whole `rows × columns` blob to read a few hashes back). |
| `bls12381_min_pk_verify`, `bls12381_min_pk_aggregate`, `bls12381_min_pk_verify_aggregate` | As in `@mysten/walrus-wasm`, taking `Uint8Array[]` instead of `serde`-converted arrays. |
| `simd()` | Whether the loaded build is the `simd128` one. |
| `default` (`init`), `simdSupported()` | Browsers: picks a build (below), fetches and instantiates it. Bun and Node: no-op, `true`. |

Every error is a thrown `Error` (`JsError`); `@unconfirmed/walrus`'s `Encoder` turns each into an `EncoderError`.

## Source

- `walrus-core` at `MystenLabs/walrus` `2bd352b6` (workspace version 1.62.0, the revision `docs/design/walrus.md` cites), with the `fastcrypto` revision it pins (`4db0e90c`, `wasm` feature). `@mysten/walrus-wasm` 0.3.1 was built from `walrus-core` 1.40.0 (`0173958c`); the encoding is unchanged between the two, and the parity tests check it.
- `reed-solomon-simd` 3.1.0, patched (`[patch.crates-io]`) with `vendor/reed-solomon-simd/`: a verbatim copy of `misofm/reed-solomon-simd` at `df19424` (branch `wide-engine`). Upstream 3.1.0 has SIMD engines for x86 and AArch64 only, so on wasm32 it runs its scalar engine. The fork adds an engine written with the `wide` crate's `u8x16`, which `DefaultEngine` selects at compile time when `simd128` is on; its output is byte-identical to the scalar engine's. Vendored because the fork is not public; replace the patch with a git or crates.io dependency once it is.
- Our own code (`src/`):
  - `encode.rs` follows `walrus-core`'s `BlobEncoder::encode_with_metadata` step for step with the same `ReedSolomonEncoder`s, but writes slivers straight into their BCS slots in the output and hashes symbols with `merkle.rs`. `decode` is `walrus-core`'s.
  - `blake2b.rs`: BLAKE2b-256 over two equal-length messages at once, one per 64-bit lane of a `v128` (scalar `[u64; 2]` without `simd128`). Metadata is about `3n²` hashes (`n²` symbol leaves, `2n(n − 1)` inner nodes), so pairs are always at hand. Each round is an out-of-line function: a fully unrolled compression is too large for JavaScriptCore's optimizing tier (Bun, Safari) and ran at a third of the speed there.
  - `merkle.rs`: `walrus-core`'s Merkle tree (leaf `0x00 ‖ data`, inner `0x01 ‖ left ‖ right`, zero padding) on top of it.
  - `cargo test` checks `blake2b.rs` against `fastcrypto`'s `Blake2b256`, `merkle.rs` against `walrus-core`'s `MerkleTree`, and `encode` (blob id, metadata bytes, every sliver, every sliver root) against `walrus-core`'s encoder for many shard counts and lengths.

## Builds

| File | Build | Size (gzip) |
|---|---|---|
| `nodejs/walrus_wasm_bg.wasm` | `simd128`, CommonJS glue (`fs` + `__dirname`, synchronous on import) | 267 KB (99 KB) |
| `web/walrus_wasm_bg.wasm` | `simd128`, ES module glue (`init`) | 267 KB (99 KB) |
| `web/walrus_wasm_nosimd_bg.wasm` | scalar, same glue | 254 KB (97 KB) |
| `@mysten/walrus-wasm` 0.3.1 `web/walrus_wasm_bg.wasm`, for comparison | scalar, `opt-level = "s"`, no `wasm-opt` | 358 KB (184 KB) |

Release profile: `opt-level = 3`, fat LTO, one codegen unit, `panic = "abort"`; then `wasm-opt -O3`. `-O4` and `-Oz` were measured too (an earlier SIMD build, name section kept; `compute_metadata` at `n = 1000` on Node): `-O3` 288.4 KB / 496 ms, `-O4` 289.8 KB / 489 ms, `-Oz` 286.2 KB / 494 ms, without `wasm-opt` 356.5 KB / 493 ms. The differences are within noise for speed and 1% for size, so `-O3` stays (set `WASM_OPT_LEVEL` to try others). The hot code is LLVM's; `wasm-opt` mostly shrinks the binary.

**Fallback.** Every current engine has WebAssembly SIMD (Chrome 91, Firefox 89, Safari 16.4, Node 16.4, Bun, Deno). For older browsers `web.js` validates a three-instruction SIMD module with `WebAssembly.validate` and fetches the scalar build when it fails; both builds share one glue (the build script checks), so this costs one extra file on the server and nothing at run time. Bun and Node always load the SIMD build. In browsers pass `wasmUrl` / `wasmFallbackUrl` to `Encoder.layer` (or `Walrus.layer`) when the bundler does not emit `new URL(…, import.meta.url)` assets.

## Building

```sh
cd packages/walrus-wasm
bun run build          # rebuild nodejs/ and web/
bun run build:check    # rebuild into a temp dir and compare byte for byte with the committed files
cargo test --release   # the Rust tests (native)
```

| Tool | Version | Where it comes from |
|---|---|---|
| rustc / cargo | 1.99.1, target `wasm32-unknown-unknown` | `rust-toolchain.toml` (rustup installs it) |
| wasm-bindgen CLI | 0.2.127 (= the crate, pinned `=0.2.127`) | `cargo install wasm-bindgen-cli --version 0.2.127 --locked` |
| Binaryen `wasm-opt` | 132 | the root devDependency `binaryen` 132.0.0 (exact), `node_modules/.bin/wasm-opt` |
| clang | any with the wasm32 target (18.1 here) | system; `blst` (BLS) compiles C for wasm32 |

`scripts/build.ts` builds the crate twice (`RUSTFLAGS=-C target-feature=+simd128` into `target/simd`, plain into `target/nosimd`, both `--locked`), runs `wasm-bindgen --target nodejs` / `--target web` with `--remove-name-section`, checks that the scalar build's web glue equals the SIMD one's, writes `nodejs/package.json` (`"type": "commonjs"`), and runs `wasm-opt -O3` on each `.wasm`. `--remap-path-prefix` maps the cargo home to `/cargo` and the package directory to `/walrus-wasm`, so panic locations embedded in the binary do not depend on the machine; with the same toolchain the output is byte-identical (`build:check`).

## Speed

`bun packages/walrus/scripts/bench-wasm.ts` (and `node …`): raw calls, median of 3 to 9 runs after a warm-up, milliseconds unless marked, x64 Linux, Bun 1.4.4 and Node 24.22.1. Mysten is `@mysten/walrus-wasm` 0.3.1; its "roots" is the crafted-blob method. `n = 10` cannot hold 10 MB (its maximum is 1.8 MB).

| n | blob | operation | Bun: ours | Bun: Mysten | × | Node: ours | Node: Mysten | × |
|---|---|---|---|---|---|---|---|---|
| 10 | 1 KB | encode | 0.2 | 0.5 | 2.1 | 0.2 | 0.5 | 1.9 |
| 10 | 1 KB | blobId | 0.2 | 0.3 | 1.6 | 0.1 | 0.2 | 1.9 |
| 10 | 1 KB | decode systematic | 0.1 | 0.2 | 2.2 | 0.0 | 0.0 | 4.2 |
| 10 | 1 KB | decode repair | 4.7 | 10 | 2.2 | 4.6 | 10 | 2.3 |
| 10 | 1 KB | roots (4 slivers) | 0.1 | 0.3 | 4.8 | 0.0 | 0.3 | 9.8 |
| 10 | 1 MB | encode | 7.1 | 28 | 4.0 | 7.3 | 15 | 2.0 |
| 10 | 1 MB | blobId | 4.7 | 25 | 5.4 | 4.9 | 14 | 2.8 |
| 10 | 1 MB | decode systematic | 0.6 | 0.2 | 0.4 | 0.7 | 0.3 | 0.4 |
| 10 | 1 MB | decode repair | 6.4 | 35 | 5.4 | 7.0 | 33 | 4.7 |
| 10 | 1 MB | roots (4 slivers) | 1.8 | 28 | 15.6 | 1.9 | 15 | 7.7 |
| 100 | 1 KB | encode | 5.1 | 25 | 4.9 | 5.3 | 14 | 2.6 |
| 100 | 1 KB | blobId | 5.1 | 24 | 4.8 | 5.1 | 14 | 2.6 |
| 100 | 1 KB | decode systematic | 0.1 | 0.2 | 1.6 | 0.1 | 0.2 | 1.4 |
| 100 | 1 KB | decode repair | 46 | 107 | 2.4 | 44 | 103 | 2.3 |
| 100 | 1 KB | roots (34 slivers) | 1.7 | 25 | 15.1 | 1.2 | 14 | 11.8 |
| 100 | 1 MB | encode | 14 | 86 | 6.1 | 13 | 59 | 4.4 |
| 100 | 1 MB | blobId | 12 | 83 | 7.2 | 12 | 58 | 4.7 |
| 100 | 1 MB | decode systematic | 0.4 | 0.4 | 1.1 | 0.5 | 0.5 | 1.0 |
| 100 | 1 MB | decode repair | 51 | 188 | 3.7 | 50 | 178 | 3.5 |
| 100 | 1 MB | roots (34 slivers) | 3.2 | 86 | 26.7 | 3.4 | 59 | 17.5 |
| 100 | 10 MB | encode | 113 | 672 | 5.9 | 123 | 490 | 4.0 |
| 100 | 10 MB | blobId | 78 | 649 | 8.3 | 85 | 469 | 5.5 |
| 100 | 10 MB | decode systematic | 7.6 | 3.1 | 0.4 | 4.2 | 3.1 | 0.7 |
| 100 | 10 MB | decode repair | 98 | 932 | 9.5 | 107 | 858 | 8.0 |
| 100 | 10 MB | roots (34 slivers) | 24 | 678 | 28.3 | 25 | 489 | 19.3 |
| 1000 | 1 KB | encode | 495 | 2.57 s | 5.2 | 520 | 1.54 s | 3.0 |
| 1000 | 1 KB | blobId | 491 | 2.55 s | 5.2 | 517 | 1.52 s | 2.9 |
| 1000 | 1 KB | decode systematic | 9.1 | 12 | 1.3 | 9.8 | 13 | 1.4 |
| 1000 | 1 KB | decode repair | 573 | 2.32 s | 4.0 | 585 | 2.23 s | 3.8 |
| 1000 | 1 KB | roots (334 slivers) | 109 | 2.57 s | 23.6 | 115 | 1.54 s | 13.4 |
| 1000 | 1 MB | encode | 494 | 2.57 s | 5.2 | 519 | 1.65 s | 3.2 |
| 1000 | 1 MB | blobId | 486 | 2.55 s | 5.2 | 541 | 1.52 s | 2.8 |
| 1000 | 1 MB | decode systematic | 8.9 | 12 | 1.3 | 9.8 | 13 | 1.3 |
| 1000 | 1 MB | decode repair | 566 | 2.32 s | 4.1 | 579 | 2.23 s | 3.8 |
| 1000 | 1 MB | roots (334 slivers) | 108 | 2.58 s | 23.8 | 114 | 1.54 s | 13.5 |
| 1000 | 10 MB | encode | 538 | 2.62 s | 4.9 | 569 | 1.57 s | 2.8 |
| 1000 | 10 MB | blobId | 495 | 2.56 s | 5.2 | 524 | 1.54 s | 2.9 |
| 1000 | 10 MB | decode systematic | 15 | 15 | 1.0 | 13 | 17 | 1.3 |
| 1000 | 10 MB | decode repair | 573 | 2.32 s | 4.1 | 582 | 2.24 s | 3.8 |
| 1000 | 10 MB | roots (334 slivers) | 109 | 2.63 s | 24.1 | 116 | 1.56 s | 13.5 |
| — | — | BLS verify | 9.0 | 9.7 | 1.1 | 8.8 | 9.0 | 1.0 |
| — | — | BLS aggregate 667 | 124 | 176 | 1.4 | 124 | 150 | 1.2 |
| — | — | BLS verify agg. 667 | 12 | 29 | 2.3 | 12 | 22 | 1.8 |

Where the time goes at `n = 1000` (V8 profile): encoding is about 70% BLAKE2b (`3n²` compressions however small the blob) and 30% Reed-Solomon. Mysten's build spends 1.5–2.6 s on the same work with the scalar Reed-Solomon engine, scalar hashing and `opt-level = "s"`. A repair decode is about 60% `reed-solomon-simd`'s `eval_poly`: the erasure locator is recomputed (a 2¹⁶-point transform) for each of the `n − f` column decodes although the erasure pattern is the same for all of them; caching it in the fork would bring a repair decode near 0.2 s. Systematic decodes copy and are already fast; at 1–10 MB ours is a few ms slower there (one more copy across the boundary). BLS (`blst` compiled to wasm32, no SIMD) is the same code as Mysten's; the aggregate paths are faster only because the arguments are no longer converted through `serde`.

SIMD check: the hot loops are `v128` code (`i8x16.swizzle` table lookups in the Reed-Solomon engine, `i64x2` lanes in BLAKE2b; `wasm-dis` shows none in the scalar build), and `simd()` reports the build at run time. Before the fork's engine, the `simd128` build of upstream `reed-solomon-simd` 3.1.0 ran its scalar engine (1.07 s per encode at `n = 1000` on Node; 0.65 s with the fork's engine; 0.49 s with SIMD hashing too).
