# `@unconfirmed/walrus` — design

Status: design, 2026-11-27. Implementers: read this file, `docs/design/quorum.md`, `EXPLORATION.md` §5, and the README sections "How it composes" and "Move codegen".

A ground-up Walrus client on `@unconfirmed/sui`: read and write blobs against storage nodes with `@unconfirmed/quorum`, erasure coding through `@mysten/walrus-wasm`, Move bindings from `@unconfirmed/sui-codegen`. Upload relay, quilts and aggregator/publisher HTTP are included as separate modules.

## 0. References and how to cite them

| Reference | Version | Where |
|---|---|---|
| `@mysten/walrus` | 2.0.1 (root devDependency, exact) | `node_modules/@mysten/walrus/dist/` — cited as `walrus/dist/<file>:<line>` |
| `@mysten/walrus-wasm` | 0.3.1 (root devDependency, exact; becomes a runtime dependency of this package) | `node_modules/@mysten/walrus-wasm/` |
| `@mysten/seal` | 2.0.1 (root devDependency, exact; for the quorum design only) | `node_modules/@mysten/seal/dist/` |
| Walrus Rust repo | `MystenLabs/walrus` at `2bd352b6` (2026-11-23), workspace version 1.62.0 | cited as `crates/...`, `contracts/...`, `testnet-contracts/...` |
| Testnet, read 2026-11-27 | epoch 594, 1000 shards, 99 nodes, epoch length 1 day, max 53 epochs ahead | `walrus info` (CLI 1.59.0 still talks to testnet), node probes, GraphQL |

On-chain ids:

| | Testnet | Mainnet |
|---|---|---|
| System object | `0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af` | `0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2` |
| Staking object | `0xbe46180321c30aab2f8b3501e24048377287fa708018a5b7c2792b35fe339ee3` | `0x10b9d30c28448939ce6c4d6c6e0ffce4a7f8a4ada8248bdad09ef8b70e4a3904` |
| Type-origin package (testnet) | `0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66` | read from the system object's type |
| Current package (`System.package_id`, version 4) | `0x7d3b2086808a62bbc44d18c6b1d407973d77dd26946735873092c2f5650b4611` | read from the system object |

"Live-verified" below means I observed it on testnet on 2026-11-27 with throwaway scripts (not kept in the repo).

## 1. Protocol facts

Each fact is something the implementation depends on. `n` is the number of shards, `f = ⌊(n − 1) / 3⌋`.

### 1.1 Thresholds

| # | Fact | Source |
|---|---|---|
| T1 | `f = ⌊(n−1)/3⌋`; "min correct" is `n − f`; the Rust "quorum" is weight `> 2f`; "validity" is weight `> f`. | `crates/walrus-core/src/bft.rs:55-68`; `crates/walrus-sui/src/types.rs:292-321` |
| T2 | **The chain accepts a certificate when `3·weight ≥ 2n + 1`, which equals `weight ≥ n − f` for every `n`.** Weight is shards, not nodes. | `contracts/walrus/sources/system/bls_aggregate.move:164-166`, `:202-286` |
| T3 | The Rust client builds a certificate only at `weight ≥ n − f`, and treats an upload as done at the same weight. | `crates/walrus-sdk/src/node_client.rs:2161-2197`; `crates/walrus-sdk/src/uploader.rs:272-277` |
| T4 | `> 2f` and `≥ n − f` are the same number only when `n ≡ 1 (mod 3)`. With `n = 1000` both are 667. For `n = 5` they are 3 and 4. **Use `n − f` for writes and certificates, `2f + 1` for read-side sampling, `f + 1` for validity.** | arithmetic on T1, T2 |
| T5 | Source symbols: primary `n − 2f` (334), secondary `n − f` (667). A blob decodes from `n − 2f` primary slivers. | `crates/walrus-core/src/encoding/config.rs:742-750`, `:223-225` |

### 1.2 Encoding, sizes, ids

| # | Fact | Source |
|---|---|---|
| E1 | Only encoding type RS2 (`1`) exists; type `0` is rejected. | `crates/walrus-core/src/lib.rs:762-795` |
| E2 | `symbolSize = max(len, 1).divCeil(primary × secondary)` rounded up to a multiple of 2; maximum `65534`. Maximum blob size is `primary × secondary × 65534` (14,599,533,452 bytes at `n = 1000`). | `crates/walrus-core/src/encoding/utils.rs:10-25`; `crates/walrus-core/src/lib.rs:843-855`; `config.rs:795-798` |
| E3 | A primary sliver holds `secondary × symbolSize` bytes, a secondary sliver `primary × symbolSize`. The blob is the source matrix in row-major order: `primary` rows of `secondary` symbols; primary sliver `i` is row `i` of the row-expanded matrix. | `config.rs:311-318`; `crates/walrus-core/src/encoding/blob_encoding.rs` (`ExpandedMessageMatrix`) |
| E4 | `encodedLength = n × (n × 64 + 32) + n × (primary + secondary) × symbolSize`. Storage units are `encodedLength.divCeil(1 MiB)`. A 1-byte blob is 66,034,000 bytes encoded: 63 units. | `config.rs:756-851`; `contracts/walrus/sources/system/system_state_inner.move:30`, `:776` |
| E5 | Blob id = `blake2b256(encodingType u8 ‖ unencodedLength u64 LE ‖ merkleRoot)`. The Merkle tree is over one leaf per sliver pair, `primaryHash ‖ secondaryHash` (64 bytes); leaf hash `blake2b256(0x00 ‖ leaf)`, inner hash `blake2b256(0x01 ‖ left ‖ right)`, an odd level is padded with 32 zero bytes. | `crates/walrus-core/src/lib.rs:130-176`; `crates/walrus-core/src/metadata.rs:571-578`, `:638-643`; `crates/walrus-core/src/merkle.rs:18-20` and `build_from_leaf_hashes` |
| E6 | A blob id is 32 bytes. As text it is URL-safe base64 without padding (43 characters). On chain it is the `u256` read little-endian from those bytes. The root hash is passed to Move the same way. | `walrus/dist/utils/bcs.mjs:25-37`; `contracts/walrus/sources/system/blob.move:126-138` |
| E7 | Sliver pair `p` is stored on shard `(p + offset) mod n`, `offset = (blob id bytes as a big-endian integer) mod n`. Secondary sliver index `s` belongs to pair `n − 1 − s`. | `crates/walrus-core/src/encoding/mapping.rs:94-134`; `crates/walrus-core/src/lib.rs:485-510` |
| E8 | A sliver's hash is the Merkle root over its `n` symbols after expanding it along the other axis. It depends only on that sliver's own symbols. | `crates/walrus-core/src/encoding/slivers.rs:169-178`, `:387-391` |
| E9 | BCS: `BlobMetadataWithId { blob_id: [u8; 32], metadata: enum { V1 { encoding_type: enum, unencoded_length: u64, hashes: vector<{ primary_hash, secondary_hash }> } } }`, each hash `enum { Empty, Digest([u8; 32]) }`. `SliverData { symbols: { data: vector<u8>, symbol_size: u16 }, index: u16 }`. A metadata response is 66,044 bytes at `n = 1000` (live-verified). | `walrus/dist/utils/bcs.mjs:4-57`; `crates/walrus-core/src/metadata.rs`; live |

### 1.3 Storage node REST API

Base URL `https://<network_address>`; `network_address` is `host:port` from the node's on-chain info.

| # | Endpoint | Notes | Source |
|---|---|---|---|
| N1 | `GET /v1/blobs/{id}/metadata` | BCS `BlobMetadataWithId`, `content-type: application/octet-stream`. Unknown blob: `404`, reason `METADATA_NOT_FOUND`. | `crates/walrus-service/src/node/server/routes.rs:75`, `:137-150`; live |
| N2 | `PUT /v1/blobs/{id}/metadata` | Body: BCS `BlobMetadata` (no id). `201` stored, `200` already stored, `202` buffered (only with `?pending=true`). Not yet registered: `400`, reason `NOT_REGISTERED`. | `routes.rs:188-225`; `crates/walrus-service/src/node/errors.rs:180`, `:199` |
| N3 | `GET` / `PUT /v1/blobs/{id}/slivers/{pairIndex}/{primary\|secondary}` | BCS `SliverData`. A shard the node does not hold: `400`, reason `SHARD_NOT_ASSIGNED`. Blocked: `451`, reason `FORBIDDEN_BLOB`. Storing before metadata: `400`, reason `METADATA_NOT_FOUND`. Unknown sliver: `404`, reason `SLIVER_NOT_FOUND`; pair index `≥ n`: `400`, reason `INDEX_OUT_OF_RANGE` (live). An unparsable blob id in any path: `400` with a `text/plain` body (live). | `routes.rs:79`, `:246-345`; `errors.rs:88`, `:153-158`, `:301-340`; live |
| N4 | `GET /v1/blobs/{id}/metadata/status`, `GET .../slivers/{pairIndex}/{type}/status` | JSON `"nonexistent" \| "buffered" \| "stored"`, **lower-case**. | `crates/walrus-storage-node-client/src/api.rs:208-218`; live (`"stored"`) |
| N5 | `GET /v1/blobs/{id}/confirmation/permanent`, `GET .../confirmation/deletable/{objectId}` | JSON `{ signed: { serializedMessage: base64, signature: base64 } }`. Optional `?wait_for_registration=true&wait_millis=`. Unregistered blob: `400`, reason `NOT_REGISTERED` (live); slivers missing: `400`, reason `MISSING_SLIVERS`. | `routes.rs:84-88`, `:405-470`; `crates/walrus-core/src/messages.rs` (`SignedMessage`); live |
| N6 | `GET /v1/blobs/{id}/status` | JSON `BlobStatus` (S1). **An unknown blob is `200` with `"nonexistent"`, not `404`** (live-verified). | `routes.rs:97`; `api.rs:43-78`; live |
| N7 | Success envelope `{ "success": { "code", "data" } }`; error envelope `{ "error": { "status", "code", "message", "details": [{ "@type": "ErrorInfo", "reason", "domain", "metadata" }] } }`. | `api.rs:21-33`; live |
| N8 | All 77 reachable testnet nodes advertise `pending` and `wait_for_registration` in `/v1/api`. The Rust client leaves both off by default. | live; `crates/walrus-sdk/src/config/communication_config.rs:266-268` |

`BlobStatus` (S1), camelCase with one exception:

```
"nonexistent"
{ "invalid":   { "event": { "txDigest", "eventSeq" } } }
{ "permanent": { "endEpoch", "isCertified", "statusEvent": {…}, "deletableCounts": {…}, "initialCertifiedEpoch": number | null } }
{ "deletable": { "initialCertifiedEpoch": number | null, "deletableCounts": { "count_deletable_total", "count_deletable_certified" } } }
```

The two `count_deletable_*` fields are snake_case (`api.rs:111-116` has no rename; live-verified). Status order, latest last: `nonexistent < deletable < permanent < invalid`, and within a variant by the tuples in `api.rs:138-200`.

### 1.4 Messages and certificates

| # | Fact | Source |
|---|---|---|
| M1 | A confirmation is BCS `intent (type 1, version 0, app 3) ‖ epoch u32 LE ‖ blob id (32) ‖ persistence`, with persistence `0x00` (permanent) or `0x01 ‖ objectId (32)` (deletable). Live sample: `01 00 03 ‖ 52 02 00 00 ‖ <id> ‖ 00`. | `crates/walrus-core/src/messages/storage_confirmation.rs`; `crates/walrus-core/src/messages.rs` (`Intent`); live |
| M2 | Signatures are BLS12-381 min-pk (96-byte signatures). A certificate is `{ signers: vector<u16>, serialized_message, signature }` with the aggregate of the signers' signatures over one identical message. | `crates/walrus-core/src/messages/certificate.rs` |
| M3 | On chain, the signers are a bitmap over `System…committee.members`, bit `i` of byte `i / 8` (LSB first), at most `⌈members / 8⌉` bytes. | `bls_aggregate.move:202-250`; `walrus/dist/utils/index.mjs:67-76` |
| M4 | `certify_blob` aborts unless the certificate's epoch equals the system's current epoch, the blob is not already certified, its storage has not ended, and the persistence type (and object id, if deletable) match the `Blob`. | `contracts/walrus/sources/system/system_state_inner.move:352-370`; `contracts/walrus/sources/system/blob.move:197-227` |
| M5 | On chain, public keys are 96-byte **uncompressed** G1 points, both in `BlsCommitteeMember.public_key` and in a staking pool's `node_info.public_key`. `bls12381_min_pk_verify` in `@mysten/walrus-wasm` accepts both the 96-byte and the 48-byte compressed form (tested). `@noble/curves` `bls12_381.longSignatures` produces signatures and aggregates that the WASM verifies (tested), so tests can sign as fake nodes. | live; local test |

### 1.5 Chain state

| # | Fact | Source |
|---|---|---|
| C1 | `System { id, version: u64, package_id, new_package_id }` and `Staking` likewise. The real state is a dynamic field named by `version` (type `u64`): `SystemStateInnerV1`, `StakingInnerV1`. | `contracts/walrus/sources/system.move:50-64`; `walrus/dist/client.mjs:134-146`; live |
| C2 | Move calls go to `System.package_id` (it changes on upgrade). Type strings use the type-origin package, the address in the system object's own type. | `walrus/dist/client.mjs:103-119`; live |
| C3 | `StakingInnerV1` holds `epoch`, `n_shards`, `committee`, `previous_committee`, `next_committee`, `epoch_state`. A committee is a `VecMap<ID, vector<u16>>` (node id → shards) **sorted by node id**. `epoch_state` is `EpochChangeSync(u16) \| EpochChangeDone(ms) \| NextParamsSelected(ms)`. | `contracts/walrus/sources/staking/committee.move:17-21`; `staking_inner.move`; `crates/walrus-sui/src/types/move_structs.rs:799-811` |
| C4 | A node's info is its `StakingPool` object (object id = node id): `node_info { name, node_id, network_address, public_key, network_public_key, … }`. | `walrus/dist/client.mjs:1317-1346`; `crates/walrus-sui/src/client/read_client.rs:1134-1158` |
| C5 | **The BLS committee in the system object lists members in the staking committee's order, by construction**: `next_bls_committee` walks the staking committee and asserts the keys line up. Live-verified at epoch 594: same ids in the same order, same weights. Both reference clients rely on it without checking. | `contracts/walrus/sources/staking/staking_inner.move:821-842`; `crates/walrus-sdk/src/node_client.rs:2175-2180`; live |
| C6 | Reads go to the current committee, except during `EpochChangeSync` for a blob first certified before the current epoch: then the previous committee. A certified epoch above the client's epoch means the client is behind. | `crates/walrus-sdk/src/active_committees.rs:153-167` |
| C7 | Prices are in the system state: `storage_price_per_unit_size` (per unit per epoch) and `write_price_per_unit_size` (per unit, once). Testnet today: 4724 and 9421 FROST. | `walrus/dist/client.mjs:418-428`; `walrus info` |
| C8 | `reserve_space(&mut System, storage_amount: u64, epochs_ahead: u32, payment: &mut Coin<WAL>): Storage`; `register_blob(&mut System, Storage, blob_id: u256, root_hash: u256, size: u64, encoding_type: u8, deletable: bool, write_payment: &mut Coin<WAL>): Blob`; `certify_blob(&System, &mut Blob, signature, signers_bitmap, message)`; `delete_blob(&System, Blob): Storage`; `extend_blob(&mut System, &mut Blob, extended_epochs: u32, payment)`; `blob::burn(Blob)`; `storage_resource::destroy(Storage)`. `storage_amount` is the encoded length; `size` is the unencoded length. | `contracts/walrus/sources/system.move:179-262`; `blob.move:261`; `storage_resource.move:152` |
| C9 | `Blob { id, registered_epoch: u32, blob_id: u256, size: u64, encoding_type: u8, certified_epoch: Option<u32>, storage: Storage { id, start_epoch, end_epoch, storage_size }, deletable }`. | `blob.move:47-58` |
| C10 | Testnet and mainnet both run contract version 4 (`Move.lock`), which already includes storage pools. | `testnet-contracts/walrus/Move.lock`, `mainnet-contracts/walrus/Move.lock` |

### 1.6 Upload relay

| # | Fact | Source |
|---|---|---|
| R1 | `GET /v1/tip-config` answers `"no_tip"` or `{ "send_tip": { "address", "kind": { "const": u64 } \| { "linear": { "base", "encoded_size_mul_per_kib" } } } }`. Testnet relay (`https://upload-relay.testnet.walrus.space`): const 105 MIST. A linear tip is `base + encodedLength.divCeil(1024) × mul`. | `crates/walrus-sdk/src/upload_relay/tip_config.rs`; live |
| R2 | `POST /v1/blob-upload-relay?blob_id=&tx_id=&nonce=&deletable_blob_object=&encoding_type=`, body the raw blob. `nonce` is URL-safe base64 without padding; `tx_id` and `nonce` are required when a tip is. | `crates/walrus-sdk/src/upload_relay/params.rs:52-73`; `crates/walrus-sdk/src/upload_relay.rs:36-60` |
| R3 | The relay loads `tx_id` and requires **its first input** to be a pure value equal to BCS `{ blob_digest: sha256(blob), nonce_digest: sha256(nonce), unencoded_length: u64 }` (72 bytes), the transaction to be recent, and its SUI balance changes to pay the tip address at least the tip. | `crates/walrus-upload-relay/src/utils.rs:24-84`; `crates/walrus-upload-relay/src/tip/check.rs` |
| R4 | The response is JSON `{ blob_id, confirmation_certificate: { signers: number[], serialized_message: number[], signature: base64url } }`. | `crates/walrus-sdk/src/upload_relay.rs:27-33`; `walrus/dist/upload-relay/client.mjs:47-54` |

### 1.7 `@mysten/walrus-wasm` 0.3.1

| # | Fact | Source |
|---|---|---|
| W1 | Exports: `BlobEncoder(nShards)` with `encode`, `compute_metadata`, `decode`; `bls12381_min_pk_verify`, `bls12381_min_pk_aggregate`, `bls12381_min_pk_verify_aggregate`; default export `init`. RS2 only. Nothing verifies a single sliver or recovers one. | `walrus-wasm/src/encoder.rs`, `src/bls12381.rs`, `index.d.mts` |
| W2 | On Node and Bun the module loads synchronously **at import time** (`readFileSync(__dirname + "/walrus_wasm_bg.wasm")`, then `new WebAssembly.Module`) and `init` is a no-op. The `browser` export condition needs `init({ module_or_path })`; without an argument it fetches `new URL("walrus_wasm_bg.wasm", import.meta.url)`, the web build's own 358 KB file (not the Node one). Bundled (tested with Bun 1.4.4, esbuild 0.28.2, Rolldown 1.3.4): Bun's bundler hard-codes the build machine's absolute `__dirname`, so the bundle runs only where it was built; esbuild's ESM output fails (`__dirname` is undefined); Rolldown and esbuild CJS look for the `.wasm` next to the bundle; for browsers none of the three emits the `.wasm` asset, so it must be copied next to the chunk or passed as `module_or_path` (Vite and webpack 5 do handle `new URL(…, import.meta.url)`). | `walrus-wasm/package.json`, `index.mjs`, `nodejs/walrus_wasm.js:554-557`, `web/walrus_wasm.js:599-622`; local test |
| W3 | `encode(data, primary[n], secondary[n])` writes BCS `SliverData` into caller-allocated buffers whose sizes must be exact: `uleb128(len) + len + 4`. It returns `[{ blob_id: number[], metadata: { V1: { encoding_type: "RS2", unencoded_length: number, hashes: [{ primary_hash: { Digest: number[] }, secondary_hash: {…} }] } } }, { Digest: number[] }]`. Buffer `k` of `secondary` carries sliver index `n − 1 − k`. | `encoder.rs:38-85`, `:158-177`; `walrus/dist/wasm.mjs:9-23`, `:61-84`; local test |
| W4 | `decode` needs at least `n − 2f` distinct, well-formed primary slivers and throws on fewer or on duplicates; all `n` is fine. It ignores its blob id argument and verifies nothing. | `encoder.rs:120-156`; local test |
| W5 | **Every call takes about 2.5 s at `n = 1000` whatever the blob size up to 5 MB** (Bun 1.4.4, x64: encode 2.6 s, `compute_metadata` 2.5 s, decode 2.3 s), synchronously on the calling thread. Beyond that it grows by about 0.07 s per MiB (20 MiB: 3.5 s; 60 MiB: 6.9 s), and `encode` peaks at about 10× the blob size in memory (60 MiB: 665 MB RSS). | local test |
| W6 | **A sliver can be verified with stock `encode`.** Stack up to `n − 2f` fetched primary slivers as the rows of a crafted blob of exactly `primary × secondary × symbolSize` bytes; `encode` then returns each sliver's own Merkle root as `hashes[row].primary_hash`. Likewise place up to `n − f` secondary slivers as columns; column `c` comes back as `hashes[n − 1 − c].secondary_hash`. Both hold for repair slivers too (E8). Tested with corrupted slivers at symbol sizes 2 and 14: exactly the corrupted ones mismatch. | local test, follows from E3 and E8 |
| W7 | **`n < 4` traps** (`unreachable`, a Rust panic) in `encode` and `compute_metadata`; `new BlobEncoder(n)` itself succeeds. A trap leaves that `BlobEncoder` marked as borrowed: every later call on it, and `free`, throws "attempted to take ownership of Rust value while it was borrowed". Other instances, and the module, keep working. | local test |

### 1.8 Where the Rust client and `@mysten/walrus` disagree

| Topic | Rust client | `@mysten/walrus` 2.0.1 | We follow |
|---|---|---|---|
| Certificate threshold | weight `≥ n − f` (T3) | number of **nodes** `> 2f'` over the member count (`client.mjs:673`) | Rust / chain (T2) |
| After the write quorum | stops, plus a `0.5t + 500 ms` window | awaits every node (`client.mjs:1131`) | Rust |
| Metadata | verified against the blob id before use (`metadata.rs:423-445`) | not verified; its length sizes an allocation (`wasm.mjs:36`) | Rust |
| Slivers | each verified against metadata (`crates/walrus-storage-node-client/src/client.rs`, `get_and_verify_sliver`) | not verified; whole-blob re-encode at the end | verify on demand (W6), plus the re-encode |
| Status | groups by equality, ranks by the full order, falls back to an on-chain event | groups by `JSON.stringify`, ranks by variant only (`constants.mjs:17-22`), no fallback | Rust order; no event fallback in v1 (open question 6) |
| "Stored" check | `stored` / `buffered` (N4) | compares with `"Stored"` / `"Buffered"`: never true | Rust |
| Retries | exponential backoff on every node call, 1 s → 30 s, 5 retries (`crates/walrus-utils/src/backoff.rs:50-58`) | only the metadata `PUT`, 3 tries, 1 s apart, only `NOT_REGISTERED` | Rust-like, per member |
| Concurrency | byte-budgeted: at most 12.5 MB of slivers in flight, 10 connections per node | every `PUT` at once | Rust-like |
| Node TLS | pins each node's network key; ignores the web PKI | web PKI through `fetch` | web PKI (see §7, risk 1) |
| Committee for reads | chosen per blob from its certified epoch | memoised once per client | Rust |
| Consistency check | default: systematic primary hashes; strict: re-encode | always re-encode | strict or skip |

## 2. Behaviour in `@mysten/walrus` 2.0.1 that must not be ported

Line numbers are in `walrus/dist/`. Items 1–5 are the ones `EXPLORATION.md` §5 lists; all five are confirmed. The rest were found while verifying them.

| # | Behaviour | Evidence |
|---|---|---|
| 1 | `getSlivers` resolves only on the success **after** the threshold: the count is checked before the push. It always makes one extra request and never settles when exactly `n − 2f` succeed, because the failure branch cannot fire once the count is there. | `client.mjs:286-291`, `:307-312` |
| 2 | `getVerifiedBlobStatus` has the same off-by-one, and its `finally` rejects with "not enough statuses" when the node that completes the quorum is the last to settle. Its "quorum of 404" branch is dead: nodes answer `200 "nonexistent"` (N6). | `client.mjs:337-346`, `:348-358` |
| 3 | `chunk(executors, floor(len / 10))` has size 0 for fewer than 10 remaining nodes: `RangeError` for 1–9, and with none left the promise never settles. | `client.mjs:210`; `@mysten/utils` `dist/chunk.mjs:2-5` (reproduced) |
| 4 | Signer indices and public keys come from the staking committee while the epoch and bitmap length come from the system object, with nothing checking that the two agree. They do agree on chain (C5), but the two objects are loaded and cached separately, so a client can pair one epoch's committee with another's. | `client.mjs:655-674`, `:700`, `:1337-1342` |
| 5 | Quorum is counted in nodes for the certificate and in shards for upload failures. On testnet today the 42 largest nodes hold 667 shards (a valid certificate the SDK refuses, needing 65 nodes), and the 65 smallest hold 425 (a certificate the SDK builds and the chain rejects). | `client.mjs:673` vs `:1140-1141`; live committee |
| 6 | The status checks compare with `"Stored"` and `"Buffered"`; nodes answer lower-case. Metadata and every sliver are always re-uploaded. | `client.mjs:1181`, `:1227`; N4 |
| 7 | The read committee is memoised in a field that `reset()` does not clear: every later blob, in every later epoch, reads from the committee chosen for the first one. | `client.mjs:397-400`, `:1360-1363` |
| 8 | Metadata from a single node is used unverified; its `unencoded_length` sizes the output buffer before any check. | `client.mjs:184-232`, `:159`; `wasm.mjs:32-38` |
| 9 | Quilt reads fetch each secondary sliver from one node and use it unverified; they also use the active committee rather than the read committee. | `client.mjs:233-248`; `files/readers/quilt.mjs:15-36`; `files/readers/blob.mjs:68-84` |
| 10 | `getBlobMetadata` gives up one node early: the first executor is shifted out of the array, but its failure is still counted against the shortened length. | `client.mjs:208`, `:227` |
| 11 | No retries except the metadata `PUT`; a sliver `PUT` or a confirmation `GET` that fails once fails the node. | `client.mjs:966-976`, `:941-955`, `:986-998` |
| 12 | Every `PUT` goes out at once (about `2n` sliver requests plus metadata), and the write waits for every node. | `client.mjs:1095-1113`, `:1131-1148` |
| 13 | Resuming at "uploaded" reuses the saved certificate without checking its epoch; after an epoch change the certify transaction aborts (M4). | `flows/write-blob.mjs:170-177`, `:210` |
| 14 | A crash between the register transaction and the caller persisting the step registers (and pays) again on resume. | `flows/write-blob.mjs:192-201` |
| 15 | `getSlivers` counts "not found" per request but skips a failed node's other shards with a generic error, so the not-found weight is undercounted. | `client.mjs:277`, `:293-294` |
| 16 | A relay's certificate is not verified before the certify transaction is built. | `upload-relay/client.mjs:47-54`; `flows/write-blob.mjs:79-88` |
| 17 | One bad sliver from one node makes a read fail with `InconsistentBlobError`, which is not retried; a node cannot be told apart from a badly encoded blob. | `client.mjs:159-160`; `error.mjs` (`InconsistentBlobError` is not retryable) |

## 3. Package layout

```
packages/walrus/
  package.json     @unconfirmed/walrus; exports { ".": "./src/index.ts", "./*": "./src/*.ts" }
                   dependencies: effect 4.1.6, @unconfirmed/bcs, @unconfirmed/sui, @unconfirmed/quorum (workspace:*; added by W5, it does not exist yet at W1),
                                 @mysten/walrus-wasm 0.3.1 (exact), @noble/hashes ^2.3.0
                   devDependencies: @noble/curves ^2.3.0 (tests sign as fake nodes; added by W3)
  sui-codegen.config.ts, scripts/codegen.ts
  src/
    BlobId.ts  Bft.ts  Encoding.ts  Merkle.ts  Messages.ts  Certificate.ts  Cost.ts  Status.ts  Errors.ts   pure
    generated/walrus/*.ts, generated/deps/**                                                     codegen output (committed)
    Config.ts  System.ts  Committee.ts                                                           chain state
    Encoder.ts                                                                                   WASM
    StorageNode.ts                                                                               node HTTP
    Read.ts  Recipes.ts  Write.ts                                                                flows
    UploadRelay.ts  Quilt.ts  QuiltRead.ts  Aggregator.ts  Publisher.ts
    Walrus.ts      the one-line layer
    index.ts       export * as X from "./X.ts" for each module
  test/            see §6
```

Rules: namespace subpath imports only; every module-level value is a `/* @__PURE__ */` call or a function; only `Encoder.ts` imports `@mysten/walrus-wasm`; only `Read.ts`, `Write.ts` and `QuiltRead.ts` import `@unconfirmed/quorum`. A program that only uses `Aggregator` or the pure modules ships neither the WASM glue nor the quorum code.

## 4. Public API

`Address` is `@unconfirmed/sui/Address`. Errors are `Schema.TaggedError`. `R` types name exactly what a function touches.

### 4.1 Pure core (no services)

```ts
// BlobId.ts
export type BlobId = string & Brand.Brand<"BlobId">                       // 43-char URL-safe base64 of 32 bytes
export const BlobId: Schema.Codec<BlobId, string>                         // decoding checks length and alphabet
export const fromBytes: (bytes: Uint8Array) => Result.Result<BlobId, InvalidBlobId>
export const toBytes: (id: BlobId) => Uint8Array
export const fromU256: (n: bigint) => BlobId                              // little-endian, as on chain (E6)
export const toU256: (id: BlobId) => bigint
export const derive: (encodingType: number, unencodedLength: bigint, merkleRoot: Uint8Array) => BlobId   // E5
export const fromString: (s: string) => Result.Result<BlobId, InvalidBlobId>
export const Bcs32: Bcs.BcsSchema<BlobId, Uint8Array>                     // the 32 raw bytes, for BCS structs
export class InvalidBlobId                                                // defined here (Errors.ts imports BlobId), re-exported by Errors.ts

// Bft.ts — T1..T5
export const maxFaulty: (n: number) => number        // f
export const minCorrect: (n: number) => number       // n - f: write and certificate threshold
export const quorum: (n: number) => number           // 2f + 1: read-side sampling
export const validity: (n: number) => number         // f + 1

// Encoding.ts — E2..E7
export const RS2 = 1
export const sourceSymbols: (n: number) => { readonly primary: number; readonly secondary: number }
export const symbolSize: (unencodedLength: number, n: number) => Result.Result<number, BlobTooLarge>
export const maxBlobSize: (n: number) => number
// sliverBytes, bcsSliverBytes, encodedLength (and Cost.cost) throw RangeError above maxBlobSize: check symbolSize first for untrusted lengths
export const sliverBytes: (unencodedLength: number, n: number) => { readonly symbolSize: number; readonly primary: number; readonly secondary: number }
export const bcsSliverBytes: (unencodedLength: number, n: number) => { readonly primary: number; readonly secondary: number }   // W3
export const encodedLength: (unencodedLength: number, n: number) => number
export const storageUnits: (encodedLength: number) => number
export const shardOfPair: (pairIndex: number, blobId: BlobId, n: number) => number
export const pairOfShard: (shard: number, blobId: BlobId, n: number) => number
export const pairOfSecondary: (sliverIndex: number, n: number) => number
export const rotationOffset: (blobId: BlobId, n: number) => number

// Merkle.ts
export const root: (leaves: ReadonlyArray<Uint8Array>) => Uint8Array      // E5; [] -> 32 zero bytes
export const leafHash, innerHash, rootOfLeafHashes, empty

// Messages.ts — BCS schemas built with @unconfirmed/bcs, and their checks
export const BlobMetadata, BlobMetadataWithId, SliverData, Confirmation, Certificate   // E9, M1, M2; TS field names camelCase
export const MerkleNode, EncodingType /* RedStuffRaptorQ | RS2 */, SliverPairMetadata, Symbols, Intent, PersistenceBcs, BLOB_CERT_INTENT
export interface VerifiedMetadata { readonly blobId: BlobId; readonly unencodedLength: number; readonly nShards: number
                                    readonly hashes: ReadonlyArray<{ readonly primary: Uint8Array; readonly secondary: Uint8Array }>
                                    readonly bytes: Uint8Array /* BCS BlobMetadata, for PUT */ }
/** Decode a node's metadata response and prove it belongs to `blobId`: embedded id, RS2, hash count, length <= max, derived id (E5).
 *  An `Empty` hash counts as 32 zero bytes, as in Rust. */
export const verifyMetadata: (blobId: BlobId, response: Uint8Array, nShards: number) => Result.Result<VerifiedMetadata, InvalidMetadata>
/** Header checks that need no WASM: BCS shape, sliver index, symbol size and data length for this blob. */
export const checkSliver: (bytes: Uint8Array, expected: { readonly index: number; readonly symbolSize: number; readonly symbols: number }) => Result.Result<void, InvalidSliver>
/** The header and a view (no copy) of the symbols; what `checkSliver` and the crafted-blob method (W6) build on. */
export const parseSliver: (bytes: Uint8Array) => Result.Result<{ readonly index: number; readonly symbolSize: number; readonly data: Uint8Array }, InvalidSliver>
export const confirmationMessage: (epoch: number, blobId: BlobId, persistence: Persistence) => Uint8Array
export type Persistence = { readonly _tag: "Permanent" } | { readonly _tag: "Deletable"; readonly objectId: Address }

// Certificate.ts
export interface Certificate { readonly epoch: number; readonly signers: ReadonlyArray<number>; readonly serializedMessage: Uint8Array; readonly signature: Uint8Array }
/** JSON form, byte fields in base64: this is §4.7's `CertificateSchema`. */
export const Certificate: Schema.Codec<Certificate, { epoch: number; signers: number[]; serializedMessage: string; signature: string }>
/** From wire parts (R4, or a built aggregate): checks the intent, reads the epoch, rejects duplicate signers, sorts them. */
export const fromParts: (parts: { signers; serializedMessage; signature }) => Result.Result<Certificate, CertificateInvalid>
export const signersBitmap: (signers: ReadonlyArray<number>, members: number) => Uint8Array   // M3; throws RangeError on an index >= members

// Cost.ts — C7, E4
export const cost: (unencodedLength: number, epochs: number, prices: { readonly storage: bigint; readonly write: bigint }, n: number)
  => { readonly encodedLength: number; readonly units: number; readonly storage: bigint; readonly write: bigint; readonly total: bigint }

// Status.ts — S1
export interface EventId { readonly txDigest: string; readonly eventSeq: string /* u64 as decimal */ }
export interface DeletableCounts { readonly countDeletableTotal: number; readonly countDeletableCertified: number }
export type BlobStatus =
  | { _tag: "Nonexistent" } | { _tag: "Invalid"; event: EventId }
  | { _tag: "Permanent"; endEpoch: number; isCertified: boolean; statusEvent: EventId; deletableCounts: DeletableCounts; initialCertifiedEpoch: number | null }
  | { _tag: "Deletable"; initialCertifiedEpoch: number | null; deletableCounts: DeletableCounts }   // all fields readonly
export const BlobStatus: Schema.Codec<BlobStatus, unknown>                // from the node's JSON, including the snake_case counts; encodes back to it
export const BlobStatusType: Schema.Codec<BlobStatus>                     // the decoded shape, for embedding in errors
export const toJson: (s: BlobStatus) => unknown
export const order: (a: BlobStatus, b: BlobStatus) => number              // the Rust `Ord` (api.rs:138-200)
export const canonical: (s: BlobStatus) => string                         // grouping key: fixed field order, no whitespace
export const certifiedEpoch: (s: BlobStatus) => number | undefined
```

### 4.2 Chain state

```ts
// Config.ts
export interface WalrusConfigService { readonly systemObjectId: Address; readonly stakingObjectId: Address }
export class WalrusConfig extends Context.Service<WalrusConfig, WalrusConfigService>()("@unconfirmed/walrus/WalrusConfig") {}
export const testnet: WalrusConfigService
export const mainnet: WalrusConfigService
export const layer: (config: WalrusConfigService) => Layer.Layer<WalrusConfig>

// System.ts
export interface SystemState {
  readonly epoch: number; readonly nShards: number
  readonly packageId: Address          // where Move calls go (C2)
  readonly typeOrigin: Address         // for `${typeOrigin}::blob::Blob`
  readonly storagePrice: bigint; readonly writePrice: bigint
  readonly members: ReadonlyArray<{ readonly nodeId: Address; readonly weight: number; readonly publicKey: Uint8Array }>
}
export class System extends Context.Service<System, {
  /** Cached; `refresh` drops the cache. */
  readonly state: Effect.Effect<SystemState, SystemError>
  readonly refresh: Effect.Effect<SystemState, SystemError>
  /** `Coin<T>`'s `T` in `system::reserve_space`'s `payment` parameter; cached for the layer's life. */
  readonly walType: Effect.Effect<string, SystemError>
}>()("@unconfirmed/walrus/System") {}
export const layer: Layer.Layer<System, never, WalrusConfig | Objects.Objects | Packages.Packages>
export type SystemError = RpcError | ObjectNotFound | ObjectDecodeError | UnsupportedSystemVersion

// Committee.ts
export interface StorageNode { readonly index: number; readonly nodeId: Address; readonly name: string; readonly url: string
                               readonly publicKey: Uint8Array /* 96 bytes, M5 */; readonly shards: ReadonlyArray<number> }
export interface Committee { readonly epoch: number; readonly nShards: number; readonly nodes: ReadonlyArray<StorageNode>
                             readonly nodeOfShard: (shard: number) => StorageNode }
export interface ActiveCommittees { readonly current: Committee; readonly previous: Committee | undefined; readonly transitioning: boolean }
export class Committees extends Context.Service<Committees, {
  readonly get: Effect.Effect<ActiveCommittees, CommitteeError>
  readonly refresh: Effect.Effect<ActiveCommittees, CommitteeError>
}>()("@unconfirmed/walrus/Committees") {}
export const layer: (options?: { readonly scheme?: "https" | "http"; readonly ttl?: Duration.Input /* default 1 minute */ })
  => Layer.Layer<Committees, never, WalrusConfig | Objects.Objects>
/** C6. */
export const readCommittee: (c: ActiveCommittees, certifiedEpoch: number | undefined) => Result.Result<Committee, BehindCurrentEpoch>
/** C5, checked rather than assumed: same epoch, same node ids in the same order, same weights. */
export const checkAgainstSystem: (committee: Committee, system: SystemState) => Result.Result<void, CommitteeMismatch>
export type CommitteeError = RpcError | ObjectNotFound | ObjectDecodeError | UnsupportedSystemVersion
```

Reading: the inner states are dynamic fields; compute their ids with `DynamicFields.deriveId(parent, "u64", bcs(version))` and read through the batched `Objects.get`, so loading a committee is three batched requests: the system and staking objects, then both inner fields (their ids depend on `version`), then every `StakingPool` of the current and previous committees. Decode with the generated schemas (`Move.Field(Bcs.u64, SystemStateInnerV1)`). A `version` whose inner type is not `…InnerV1` is `UnsupportedSystemVersion`.

### 4.3 Encoder (WASM)

```ts
// Encoder.ts
export interface EncodedBlob {
  readonly blobId: BlobId; readonly rootHash: Uint8Array; readonly unencodedLength: number; readonly nShards: number
  readonly metadata: Uint8Array                       // BCS BlobMetadata, the PUT body
  readonly primary: ReadonlyArray<Uint8Array>         // BCS SliverData, by pair index
  readonly secondary: ReadonlyArray<Uint8Array>       // BCS SliverData, by pair index (entry p carries sliver index n − 1 − p)
}
export const MIN_SHARDS = 4                           // W7; nShards outside [4, 65535] is an EncoderError before any WASM call
export type Axis = "primary" | "secondary"
export interface EncoderService {
  readonly encode: (nShards: number, blob: Uint8Array) => Effect.Effect<EncodedBlob, EncoderError>
  readonly blobId: (nShards: number, blob: Uint8Array) => Effect.Effect<{ readonly blobId: BlobId; readonly rootHash: Uint8Array }, EncoderError>
  /** From >= n - 2f distinct BCS primary slivers. Verifies nothing (W4). */
  readonly decode: (nShards: number, unencodedLength: number, primarySlivers: ReadonlyArray<Uint8Array>) => Effect.Effect<Uint8Array, EncoderError>
  /** The Merkle root of each given BCS SliverData, in order, by the crafted-blob method (W6). At most n - 2f primary or n - f secondary per call;
   *  each must carry `symbolSize` and the axis' symbol count, else EncoderError (run `Messages.checkSliver` first to blame a node). One WASM call. */
  readonly sliverRoots: (nShards: number, axis: Axis, symbolSize: number, slivers: ReadonlyArray<Uint8Array>)
    => Effect.Effect<ReadonlyArray<Uint8Array>, EncoderError>
  /** A malformed key or signature is an EncoderError (the WASM throws), not `false`. */
  readonly blsVerify: (signature: Uint8Array, publicKey: Uint8Array, message: Uint8Array) => Effect.Effect<boolean, EncoderError>
  readonly blsAggregate: (signatures: ReadonlyArray<Uint8Array>) => Effect.Effect<Uint8Array, EncoderError>
  readonly blsVerifyAggregate: (publicKeys: ReadonlyArray<Uint8Array>, message: Uint8Array, signature: Uint8Array) => Effect.Effect<boolean, EncoderError>
}
export class Encoder extends Context.Service<Encoder, EncoderService>()("@unconfirmed/walrus/Encoder") {}
export interface EncoderOptions { readonly wasmUrl?: string | URL }
/** The in-thread service; its `BlobEncoder`s are freed when the scope closes, and later calls fail with EncoderError. */
export const make: (options?: EncoderOptions) => Effect.Effect<EncoderService, EncoderError, Scope.Scope>
/** Initialises the module once per build; frees `BlobEncoder` instances when the layer's scope closes. `wasmUrl` is needed in browsers only (W2). */
export const layer: (options?: EncoderOptions) => Layer.Layer<Encoder, EncoderError>
```

Every WASM call sits in `Effect.try`, so a thrown `JsError` (or a trap) is a typed `EncoderError { operation, message }`, never a defect; a failed load is `EncoderError { operation: "init" }`. Arguments that would trap or throw `RangeError` (`nShards` outside `[4, 65535]`, a length above `maxBlobSize`) are rejected before the call. One `BlobEncoder` per `nShards` is kept in the service; one that traps is dropped from the cache (W7). All calls are synchronous and slow (W5); the service passes only numbers and `Uint8Array`s, so a worker-backed layer can replace this one later (open question 5).

`@mysten/walrus-wasm` is imported with a dynamic `import()` when the layer is built, not at module load, so importing `Encoder.ts` or the package index reads no `.wasm` until an `Encoder` is needed, and bundlers split the glue (about 17–23 KB) into its own chunk. What an app must do (W2):

| Runtime | What to do |
|---|---|
| Bun, Node, unbundled | Nothing. |
| Server bundle (any bundler) | Keep `@mysten/walrus-wasm` external, or copy `node_modules/@mysten/walrus-wasm/nodejs/walrus_wasm_bg.wasm` next to the output and emit CJS (esbuild's ESM output has no `__dirname`). A Bun bundle runs only on the machine that built it. |
| Browser, Vite / webpack 5 | Nothing, or pass `wasmUrl` from `import url from "@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url"` (Vite). |
| Browser, esbuild / Rolldown / Bun | Serve `web/walrus_wasm_bg.wasm` and pass its URL as `wasmUrl`, or copy it next to the chunk that holds the glue. |

### 4.4 Storage nodes

```ts
// StorageNode.ts
export class NodeError extends Schema.TaggedError<NodeError>()("NodeError", {
  node: Schema.String,                                   // the node's URL
  kind: Schema.Literals(["Unavailable", "Timeout", "RateLimited", "NotFound", "NotRegistered", "Blocked",
                         "ShardNotAssigned", "Rejected", "Malformed", "InvalidSignature"]),
  status: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(Schema.String),             // the server's ErrorInfo reason (N7)
  message: Schema.String
}) { get retryable(): boolean /* Unavailable | Timeout | RateLimited | NotRegistered */ }
export const retryable: (error: NodeError) => boolean     // the same, as a predicate for `while:` options
export const fromResponse: (node: string, operation: Operation, status: number, body: string) => NodeError   // the mapping below, pure

/** What a call needs: the base URL. Structural, so `Committee.StorageNode` fits without this module importing chain state. */
export interface Node { readonly url: string }
export interface StorageNodesOptions {
  readonly requestTimeout?: Duration.Input               // default 30 seconds, body included; a timeout is NodeError "Timeout"
  readonly tracerPropagation?: boolean                    // default false: nodes do not list trace headers for CORS
}
export class StorageNodes extends Context.Service<StorageNodes, {
  readonly metadata: (node: Node, blobId: BlobId) => Effect.Effect<Uint8Array, NodeError>            // N1, raw BCS
  readonly metadataStatus: (node: Node, blobId: BlobId) => Effect.Effect<"nonexistent" | "buffered" | "stored", NodeError>   // N4
  readonly sliver: (node: Node, blobId: BlobId, pairIndex: number, axis: "primary" | "secondary") => Effect.Effect<Uint8Array, NodeError>
  readonly status: (node: Node, blobId: BlobId) => Effect.Effect<BlobStatus, NodeError>              // N6
  readonly putMetadata: (node: Node, blobId: BlobId, metadata: Uint8Array) => Effect.Effect<"stored" | "alreadyStored", NodeError>
  readonly putSliver: (node: Node, blobId: BlobId, pairIndex: number, axis: "primary" | "secondary", sliver: Uint8Array) => Effect.Effect<"stored" | "alreadyStored", NodeError>
  readonly sliverStatus: (node: Node, blobId: BlobId, pairIndex: number, axis: "primary" | "secondary") => Effect.Effect<"nonexistent" | "buffered" | "stored", NodeError>
  /** The raw signed confirmation; the caller verifies it. */
  readonly confirmation: (node: Node, blobId: BlobId, persistence: Persistence) => Effect.Effect<{ readonly serializedMessage: Uint8Array; readonly signature: Uint8Array }, NodeError>
}>()("@unconfirmed/walrus/StorageNodes") {}
export const layer: (options?: StorageNodesOptions) => Layer.Layer<StorageNodes, never, HttpClient.HttpClient>
```

Mapping, decided once in this module (`fromResponse`): transport failure → `Unavailable`; timeout → `Timeout`; `429` → `RateLimited`; `5xx` → `Unavailable`; `404` → `NotFound`; `451` → `Blocked`; `4xx` with reason `NOT_REGISTERED` (or `METADATA_NOT_FOUND` on a sliver `PUT`) → `NotRegistered`; reason `SHARD_NOT_ASSIGNED` → `ShardNotAssigned`; other `4xx` → `Rejected`; any other non-2xx status (an unfollowed redirect) → `Malformed`; a 2xx body that does not decode → `Malformed`. A defect raised by the `HttpClient` becomes `Unavailable`, so nothing escapes as a defect (the quorum treats defects as fatal). `InvalidSignature` is never produced here; the write path uses it after checking a confirmation. A `PUT` answering `201` or `202` is `"stored"`, `200` is `"alreadyStored"` (N2; bodies are `{"success":{"code":201,"data":"sliver stored successfully"}}` and the like). The service does no retrying; the quorum's per-member schedule does, with `while: StorageNode.retryable`.

Not in the table but seen: a confirmation before every held sliver is stored is `400 MISSING_SLIVERS` → `Rejected` (not retried; the Rust node stores synchronously before answering `201`, so after a successful upload it means the node lost data). `CACHE_SATURATED` only occurs with `?pending=true`, which we never send.

Tests reuse `test/support.ts`: `scripted(route)` (a recording `HttpClient`; a route answers a reply, `"network-error"` or `"hang"`), `fakeNode({ url, nShards, shards, epoch, sign, intercept })` with `fakeNodes(nodes)` (an in-memory network implementing N1–N7 with the real bodies; seed `registered`, `blocked`, `statuses`; `intercept` injects failures per request), and the recorded fixtures in `test/fixtures/storage-node/`.

### 4.5 Read

```ts
// Read.ts
export interface ReadOptions {
  /** `"strict"` (default): re-derive the blob id from the decoded bytes. `"skip"`: trust the slivers. */
  readonly consistency?: "strict" | "skip"
  /** Refuse blobs whose (verified) metadata claims more than this. Default 1 GiB. The Rust client's cap is optional (`node_client.rs:1295-1304`). */
  readonly maxSize?: number
  /** Skip the status lookup during an epoch change when the caller already knows it. */
  readonly certifiedEpoch?: number
  readonly retry?: Schedule.Schedule<unknown, NodeError>     // per node; default exponential 200 ms .. 5 s, 4 retries
}
export type ReadServices = Committees | StorageNodes | Encoder
export const blob: (blobId: BlobId, options?: ReadOptions) => Effect.Effect<Uint8Array, ReadError, ReadServices>
export const metadata: (blobId: BlobId, options?: Pick<ReadOptions, "certifiedEpoch" | "retry">) => Effect.Effect<VerifiedMetadata, ReadError, Committees | StorageNodes>
export const status: (blobId: BlobId, options?: { readonly retry?: Schedule.Schedule<unknown, NodeError> }) => Effect.Effect<BlobStatus, StatusError, Committees | StorageNodes>

export type ReadError = BlobNotFound | BlobBlocked | InvalidBlob | InconsistentBlob | NotEnoughSlivers | NoMetadata
  | BlobTooLarge | BehindCurrentEpoch | StatusError | EncoderError
export type StatusError = StatusUnverified | CommitteeError
```

Algorithm of `blob`:

1. **Committee.** `Committees.get`. If not transitioning, read from `current`. If transitioning and no `certifiedEpoch` was given, get it from `status` (step 5's projection) and apply `readCommittee` (C6).
2. **Metadata.** `Quorum.run` over the read committee's nodes, `order: "shuffle"`, `weight: shards`, `threshold: 1`, `concurrency: 3`; a member is `StorageNodes.metadata` then `verifyMetadata` (a mismatch is `NodeError "Malformed"`). On `QuorumFailed`: with `nf` and `bl` the failed weight of `NotFound` and `Blocked`, if `nf + bl ≥ quorum(n)` fail with `BlobNotFound` when `nf > bl`, else `BlobBlocked`; otherwise `NoMetadata` (as `node_client.rs:2386-2456`). Then enforce `maxSize`.
3. **Slivers.** Members are the committee's shards (weight 1 each, `order: "shuffle"`), `threshold: n − 2f`, `concurrency: min(n − 2f, max(1, ⌊12.5 MB / primary sliver bytes⌋))`. A member is `StorageNodes.sliver(node, pairOfShard(shard), "primary")` then `checkSliver`. A per-node `Ref` makes later shards of a node fail at once after that node failed with a non-retryable error, keeping the first error's kind (so not-found weight is counted per shard, unlike item 15). Failure classification as in step 2, with `NotEnoughSlivers` as the fallback.
4. **Decode and check.** `Encoder.decode`; with `consistency: "strict"`, `Encoder.blobId` of the result must equal `blobId`.
5. **Blame, on mismatch only.** `Encoder.sliverRoots` over the slivers used; compare with the verified metadata's primary hashes (W6). If some differ: mark those nodes failed, fetch replacements (step 3, excluding them), decode again; at most 3 rounds, then `NotEnoughSlivers`. If none differ, the blob itself is wrongly encoded: `InconsistentBlob`. This is the Rust client's per-sliver verification, paid for only when something is wrong.
6. **Epoch change.** If the call fails with `NoMetadata`, `NotEnoughSlivers` or `BehindCurrentEpoch`, `Committees.refresh` and, if the epoch or state changed, retry the whole read (at most 2 times, 1 s then 5 s; the Rust client's `committee_change_backoff`).

`status`: `Quorum.agree` over the current committee's nodes with `weight: shards`, `key: Status.canonical`, `threshold: validity(n)`, `quorum: quorum(n)`, `prefer: Status.order`, unbounded concurrency. `AgreementFailed` becomes `StatusUnverified { blobId, groups: [{ status, weight }] }` after the call has been retried on a short schedule (answers converge as nodes process the same events). The read path uses a coarser key, `kind + initialCertifiedEpoch`, because that is all it needs and it agrees sooner.

### 4.6 Recipes (PTB)

Each is an ordinary recipe step (`README` "Transactions are Effects"), built on the generated call builders with `Effect.provideService(generated.Package, state.packageId)`.

```ts
// Recipes.ts
export type RecipeServices = Ptb.PtbBuilder | System
export const reserveSpace: (o: { readonly unencodedLength: number; readonly epochs: number; readonly payment?: Move.Argument }) => Effect.Effect<Move.Argument /* Storage */, RecipeError, RecipeServices>
export const registerBlob: (o: { readonly blobId: BlobId; readonly rootHash: Uint8Array; readonly unencodedLength: number; readonly epochs: number
                                 readonly deletable: boolean; readonly attributes?: Readonly<Record<string, string>>; readonly storage?: Move.Argument })
  => Effect.Effect<Move.Argument /* Blob */, RecipeError, RecipeServices>
export const certifyBlob: (o: { readonly blobObjectId: Address; readonly certificate: Certificate }) => Effect.Effect<void, RecipeError, RecipeServices>
export const deleteBlob: (blobObjectId: Address) => Effect.Effect<Move.Argument /* Storage */, RecipeError, RecipeServices>
export const extendBlob: (o: { readonly blobObjectId: Address; readonly storageSize: number; readonly epochs: number }) => Effect.Effect<void, RecipeError, RecipeServices>
export const burnBlob: (blobObjectId: Address) => Effect.Effect<void, RecipeError, RecipeServices>
export const blobType: Effect.Effect<string, SystemError, System>           // `${typeOrigin}::blob::Blob`
```

`registerBlob` without `storage` takes one `Ptb.coin({ amount: storage + write, type: walType })`, calls `reserve_space` and `register_blob` with it, then `0x2::coin::destroy_zero`. The amount is exact for the prices read at build time; a price change before execution aborts the transaction (nothing is spent but gas) and the step is retried. `attributes` adds `metadata::new`, `blob::add_metadata` and one `insert_or_update_metadata_pair` per entry. `certifyBlob` passes the system object as an immutable shared input and `signersBitmap(certificate.signers, state.members.length)`.

### 4.7 Write

A write is four idempotent steps. Each step's result is a JSON-serialisable value; saving it lets another process continue.

```ts
// Write.ts
export const Step = Schema.TaggedUnion({
  Encoded:    { blobId: BlobId, rootHash: Base64, unencodedLength: Schema.Number, nShards: Schema.Number, relayNonce: Schema.optionalKey(Base64) },
  Registered: { /* Encoded's fields, */ blobObjectId: Address, deletable: Schema.Boolean, endEpoch: Schema.Number, digest: Schema.optionalKey(Schema.String) },
  Uploaded:   { /* Registered's fields, */ certificate: CertificateSchema },
  Certified:  { blobId: BlobId, blobObjectId: Address, certifiedEpoch: Schema.Number, endEpoch: Schema.Number, deletable: Schema.Boolean, digest: Schema.optionalKey(Schema.String) }
})
export type Step = typeof Step.Type

/** How transactions are sent. The package depends on neither `Tx.run` nor `sui-lifecycle`; the caller picks. */
export interface Executor<E, R> {
  readonly sender: Address
  readonly execute: <A, E1, R1>(recipe: Effect.Effect<A, E1, R1>) => Effect.Effect<Transactions.Effects, E | E1, R | Exclude<R1, Ptb.PtbBuilder>>
}
/** `Tx.run` with this signer (a key or a wallet). */
export const viaTx: (signer: Signer.Signer | Signer.TransactionSigner) => Executor<TxRunError, TxRunServices>

export interface WriteOptions<E, R, E2 = never, R2 = never> {
  readonly epochs: number
  readonly deletable: boolean
  readonly executor: Executor<E, R>
  readonly owner?: Address                                   // default: the executor's sender
  readonly attributes?: Readonly<Record<string, string>>
  readonly via?: "nodes" | "relay"                           // default "nodes"; "relay" needs UploadRelay
  /** Continue from a saved step. The bytes must be the same blob: checked against `blobId`. */
  readonly resume?: Step
  /** Called after each step and awaited before the next one starts: persist here. */
  readonly onStep?: (step: Step) => Effect.Effect<void, E2, R2>
  readonly linger?: Duration.Input | ((elapsed: Duration.Duration) => Duration.Input)   // passed to Quorum.run; default: elapsed × 0.5 + 500 ms
  readonly retry?: Schedule.Schedule<unknown, NodeError>     // per node; default exponential 200 ms .. 10 s, 6 retries
  readonly maxInFlightBytes?: number                         // default 12_500_000
}
export type WriteServices = System | Committees | StorageNodes | Encoder | Objects.Objects
export const run: <E, R, E2 = never, R2 = never>(blob: Uint8Array, options: WriteOptions<E, R, E2, R2>)
  => Effect.Effect<Extract<Step, { _tag: "Certified" }>, WriteError | E | E2, WriteServices | R | R2>
/** The same as a pull-driven stream of steps: the next step runs when the consumer asks for it. */
export const stream: <E, R>(blob: Uint8Array, options: Omit<WriteOptions<E, R>, "onStep">) => Stream.Stream<Step, WriteError | E, WriteServices | R>

// The steps, for flows that stop in between (offline signing, sponsorship):
export const encode: (blob: Uint8Array) => Effect.Effect<{ readonly step: Extract<Step, { _tag: "Encoded" }>; readonly encoded: EncodedBlob }, WriteError, System | Encoder>
export const register: <E, R>(encoded: Extract<Step, { _tag: "Encoded" }>, o: Pick<WriteOptions<E, R>, "epochs" | "deletable" | "executor" | "owner" | "attributes">)
  => Effect.Effect<Extract<Step, { _tag: "Registered" }>, WriteError | E, System | Objects.Objects | R>
export const upload: (encoded: EncodedBlob, registered: Extract<Step, { _tag: "Registered" }>, o?: Pick<WriteOptions<never, never>, "linger" | "retry" | "maxInFlightBytes">)
  => Effect.Effect<Extract<Step, { _tag: "Uploaded" }>, WriteError, System | Committees | StorageNodes | Encoder>
export const certify: <E, R>(uploaded: Extract<Step, { _tag: "Uploaded" }>, o: { readonly executor: Executor<E, R> })
  => Effect.Effect<Extract<Step, { _tag: "Certified" }>, WriteError | E, System | Objects.Objects | R>

export type WriteError = NotEnoughConfirmations | CommitteeMismatch | ResumeMismatch | RegistrationFailed | CertificateStale
  | BlobTooLarge | SystemError | CommitteeError | EncoderError | RecipeError
```

In `Step`, `Base64` is a `Uint8Array` codec to a base64 string and `CertificateSchema` is `Certificate` with its byte fields in base64, so `Schema.encode(Step)` gives plain JSON. `TxRunError` and `TxRunServices` stand for the error and service types of `Tx.run`.

Each step first looks at the world, then acts ("ensure" semantics). That is what makes a crash anywhere safe, with or without a journal:

1. **Encoded.** `Encoder.encode(state.nShards, blob)`. Deterministic, never persisted in full; on resume the blob is encoded again and its id compared (`ResumeMismatch`).
2. **Registered.** Unless resuming with a `blobObjectId`: list the owner's objects of `blobType` (`Objects.listOwned`) and reuse one with the same `blob_id`, `deletable` and `size`, no `certified_epoch`, and `storage.end_epoch ≥ epoch + epochs` (this closes item 14; the Rust client does the same: `crates/walrus-sdk/src/node_client/resource.rs:298-321`, `resource/owned_registration.rs`). Otherwise execute `registerBlob` (transferring the `Blob` to `owner`) and take the created object whose type is `blobType` from `effects.changedObjects`; if the transport reports no types there, read the created objects. On resume, read the object: gone or expired is `RegistrationFailed`; already certified jumps to step 4's result.
3. **Uploaded.** Check `checkAgainstSystem(current, state)` (`CommitteeMismatch` → refresh once, then fail). `Quorum.run` over `current.nodes`, `weight: shards`, `threshold: minCorrect(n)`, `order: "shuffle"`, `schedule` + `while: retryable`, `linger`. One member, for its node:
   1. `putMetadata`; retried while `NotRegistered` (the node has not seen the registration event yet).
   2. `putSliver` for both slivers of each of its shards, under two semaphores: a global one of `max(1, ⌊maxInFlightBytes / primary sliver bytes⌋)` permits and a per-node one of 10. If `putMetadata` answered `alreadyStored` and a sliver is at least 5,560 bytes, ask `sliverStatus` first and skip `stored` / `buffered` ones (the Rust client's rule, `crates/walrus-sdk/src/node_client/communication/node.rs`, `check_and_store_sliver`).
   3. `confirmation`, then verify: `serializedMessage` is byte-equal to `confirmationMessage(current.epoch, blobId, persistence)` and `Encoder.blsVerify(signature, node.publicKey, message)`; otherwise `NodeError "InvalidSignature"`.

   The certificate is `{ epoch, signers: successes' node indices ascending, serializedMessage, signature: blsAggregate(…) }`. `QuorumFailed` becomes `NotEnoughConfirmations { blobId, weight, required, failures: [{ node, weight, kind, message }] }`. If the epoch moved during the upload (a confirmation carries another epoch), refresh and run the step again.
4. **Certified.** Read the `Blob`: if `certified_epoch` is set, done. If `certificate.epoch` is not the current epoch (M4), go back to step 3 (nodes that already hold the data answer quickly). Otherwise execute `certifyBlob` and read the object again for `certifiedEpoch`.

With the upload relay (`via: "relay"`), step 1 computes only the blob id (`Encoder.blobId`) and a 32-byte nonce (`Random`, saved as `relayNonce`); step 2's transaction also carries the relay's auth input and tip (§4.8), and when an existing registration is reused, a transaction with only the auth input and tip is sent instead; step 3 posts the blob and verifies the returned certificate.

Usage:

```ts
const certified = yield* Write.run(bytes, { epochs: 1, deletable: true, executor: Write.viaTx(signer) })

// Crash-safe on a server: journal the transactions, persist the steps.
const executor = { sender: signer.address, execute: (recipe) => Lifecycle.run(recipe, { signer }) }
yield* Write.run(bytes, { epochs: 5, deletable: false, executor, resume: yield* store.load(id), onStep: (s) => store.save(id, s) })
```

### 4.8 Upload relay

```ts
// UploadRelay.ts
export type TipConfig = { readonly _tag: "NoTip" } | { readonly _tag: "SendTip"; readonly address: Address; readonly kind: { readonly _tag: "Const"; readonly amount: bigint } | { readonly _tag: "Linear"; readonly base: bigint; readonly perEncodedKib: bigint } }
export class UploadRelay extends Context.Service<UploadRelay, {
  readonly tipConfig: Effect.Effect<TipConfig, RelayError>                     // cached
  readonly upload: (o: { readonly blob: Uint8Array; readonly blobId: BlobId; readonly nonce?: Uint8Array; readonly txDigest?: string; readonly deletableBlobObject?: Address })
    => Effect.Effect<Certificate, RelayError>
}>()("@unconfirmed/walrus/UploadRelay") {}
export const layer: (o: { readonly host: string; readonly maxTip?: bigint; readonly requestTimeout?: Duration.Input }) => Layer.Layer<UploadRelay, never, HttpClient.HttpClient>
export const tipAmount: (config: TipConfig, unencodedLength: number, nShards: number) => bigint                      // R1
/** Must be the first thing the register recipe does: the relay reads input 0 (R3). Then pays the tip in SUI. */
export const authAndTip: (o: { readonly blob: Uint8Array; readonly nonce: Uint8Array }) => Effect.Effect<void, RelayError | TipTooHigh, Ptb.PtbBuilder | UploadRelay | System>
/** Signers in range and distinct, weight >= n - f, message equal to the expected confirmation, aggregate signature valid. */
export const verifyCertificate: (certificate: Certificate, expectedMessage: Uint8Array, committee: Committee) => Effect.Effect<void, CertificateInvalid | EncoderError, Encoder>
```

The auth input is `Ptb.pure` of a 72-byte struct schema (`Bcs.bytes(32)`, `Bcs.bytes(32)`, `Bcs.u64`), which encodes with no length prefix. The implementer must confirm with an offline build that it is input 0 of the resolved transaction.

### 4.9 Quilts

```ts
// Quilt.ts (pure)
export interface QuiltEntry { readonly identifier: string; readonly contents: Uint8Array; readonly tags?: Readonly<Record<string, string>> }
export interface QuiltPatch { readonly identifier: string; readonly startIndex: number; readonly endIndex: number; readonly tags: Readonly<Record<string, string>> }
export const encode: (entries: ReadonlyArray<QuiltEntry>, nShards: number) => Result.Result<{ readonly quilt: Uint8Array; readonly patches: ReadonlyArray<QuiltPatch> }, QuiltError>
export const patchId: (quiltId: BlobId, patch: Pick<QuiltPatch, "startIndex" | "endIndex">) => string
export const parseId: (id: string) => Result.Result<{ readonly _tag: "Blob"; readonly blobId: BlobId } | { readonly _tag: "Patch"; readonly quiltId: BlobId; readonly startIndex: number; readonly endIndex: number }, QuiltError>
export const ATTRIBUTE = { _walrusBlobType: "quilt" } as const

// QuiltRead.ts
export interface QuiltFile { readonly identifier: string; readonly tags: Readonly<Record<string, string>>; readonly contents: Uint8Array }
export const index: (quiltId: BlobId, o?: QuiltReadOptions) => Effect.Effect<ReadonlyArray<QuiltPatch & { readonly id: string }>, ReadError | QuiltError, ReadServices>
export const patch: (id: string, o?: QuiltReadOptions) => Effect.Effect<QuiltFile, ReadError | QuiltError, ReadServices>
export const byIdentifier: (quiltId: BlobId, identifier: string, o?: QuiltReadOptions) => Effect.Effect<QuiltFile, ReadError | QuiltError, ReadServices>
export interface QuiltReadOptions extends ReadOptions {
  /** `"slivers"` (default) reads only the columns needed; `"blob"` reads the whole quilt. */
  readonly from?: "slivers" | "blob"
  /** Default `true`. `false` returns columns as the one node holding each served them: what `@mysten/walrus` does. */
  readonly verify?: boolean
}
```

The format is `walrus/dist/utils/quilts.mjs` and `crates/walrus-core/src/encoding/quilt_encoding.rs` (version byte 1, `u32` index length, BCS index; per patch a 6-byte header, `u16` identifier length, optional `u16` tags length and BCS map; data written column by column). Entries are sorted by identifier; identifiers are unique and at most 65,535 bytes; the index uses at most 10 columns. A BCS map is a vector of key/value pairs sorted by key (`@unconfirmed/bcs` has no `map`: use `Bcs.vector(Bcs.tuple([Bcs.string, Bcs.string]))` and sort).

Reading from slivers: get verified metadata; fetch each needed secondary sliver from the node holding shard `shardOfPair(pairOfSecondary(s))` in the **read** committee; `checkSliver`; then verify all fetched columns with one `Encoder.sliverRoots(…, "secondary", …)` call against `metadata.hashes[pair].secondary` (W6). A column that fails or cannot be fetched falls back to `from: "blob"` (a verified full read, sliced). Nothing unverified is returned unless the caller passes `verify: false` (closes item 9). The verification call costs one `encode` of a blob the quilt's size (W5), with no download beyond the columns; `verify: false` exists for very large quilts where that is too much. Writing a quilt is `Write.run(Quilt.encode(…).quilt, { attributes: Quilt.ATTRIBUTE, … })`.

### 4.10 Aggregator and publisher

Thin `HttpClient` wrappers for apps that trust a gateway; no WASM unless `verify` is set.

```ts
// Aggregator.ts
export const layer: (o: { readonly url: string }) => Layer.Layer<Aggregator, never, HttpClient.HttpClient>
//   blob(blobId): GET /v1/blobs/{id}          byObjectId(id): GET /v1/blobs/by-object-id/{id}
//   patch(patchId): GET /v1/blobs/by-quilt-patch-id/{id}    byIdentifier(quiltId, identifier): GET /v1/blobs/by-quilt-id/{id}/{identifier}
/** Check an aggregator's bytes against the id they were asked for. Needs Encoder and the shard count. */
export const verified: (blobId: BlobId) => Effect.Effect<Uint8Array, GatewayError | InconsistentBlob | EncoderError | SystemError, Aggregator | Encoder | System>
// Publisher.ts
//   store(bytes, { epochs?, permanent?, sendObjectTo? }): PUT /v1/blobs  ->  NewlyCreated | AlreadyCertified | MarkedInvalid (camelCase JSON)
```

Routes: `crates/walrus-service/src/client/daemon/routes.rs:85-108`; response type: `crates/walrus-sdk/src/node_client/responses.rs` (`BlobStoreResult`).

### 4.11 The one-line layer

```ts
// Walrus.ts
export interface WalrusOptions {
  /** One of the two. */
  readonly network?: "testnet" | "mainnet"
  readonly config?: WalrusConfigService
  readonly wasmUrl?: string | URL
  readonly nodes?: StorageNodesOptions
  readonly committees?: { readonly scheme?: "https" | "http"; readonly ttl?: Duration.Input }
}
export const layer: (options: WalrusOptions)
  => Layer.Layer<WalrusConfig | System | Committees | StorageNodes | Encoder, EncoderError, HttpClient.HttpClient | Objects.Objects | Packages.Packages>

// A program:
const layer = Walrus.layer({ network: "testnet" }).pipe(Layer.provideMerge(SuiGrpc.layer({ baseUrl })), Layer.provide(FetchHttpClient.layer))
const bytes = yield* Read.blob(blobId).pipe(Effect.provide(layer))
```

### 4.12 Errors not defined above

All of these live in `Errors.ts` (W1), so that the flows share one set of classes; `InvalidBlobId` is defined in `BlobId.ts` and re-exported. `NodeError` stays in `StorageNode.ts`. `Errors.Failure` is the `failures` element schema. `RelayError.status` and `GatewayError.status` are optional (absent when no HTTP answer arrived); `UnsupportedSystemVersion.version` is a `bigint`; `StatusUnverified.groups[].status` uses `Status.BlobStatusType`.

`InvalidBlobId { input }`, `InvalidMetadata { blobId, reason }`, `InvalidSliver { reason }`, `BlobTooLarge { size, max }`, `BlobNotFound { blobId }`, `BlobBlocked { blobId }`, `InvalidBlob { blobId }` (marked invalid on chain), `InconsistentBlob { blobId }`, `NoMetadata { blobId, failures }`, `NotEnoughSlivers { blobId, weight, required, failures }`, `NotEnoughConfirmations { blobId, weight, required, failures }`, `StatusUnverified { blobId, groups }`, `BehindCurrentEpoch { clientEpoch, certifiedEpoch }`, `CommitteeMismatch { stakingEpoch, systemEpoch, reason }`, `UnsupportedSystemVersion { objectId, version }`, `ResumeMismatch { expected, actual }`, `RegistrationFailed { blobObjectId, reason }`, `CertificateStale { certificateEpoch, epoch }`, `CertificateInvalid { reason }`, `EncoderError { operation, message }`, `RelayError { status, message }`, `TipTooHigh { tip, max }`, `QuiltError { reason }`, `GatewayError { status, message }`. `failures` is always `Schema.Array(Schema.Struct({ node, weight, kind, message }))`: a summary of the quorum's typed failures, never the raw objects.

## 5. Codegen

- `packages/walrus/sui-codegen.config.ts`: `{ output: "./src/generated", packages: [{ id: "<System.package_id on testnet>", network: "testnet", name: "walrus" }] }`, run by `packages/walrus/scripts/codegen.ts` (`Generate.run`). The output is committed.
- Used schemas: `System`, `SystemStateInnerV1`, `Staking`, `StakingInnerV1`, `StakingPool` (with `StorageNodeInfo`), `Blob`, `Storage`, `Metadata`, `events::{BlobRegistered, BlobCertified}`. Used calls: `system::{reserve_space, register_blob, certify_blob, delete_blob, extend_blob}`, `blob::{burn, add_metadata, insert_or_update_metadata_pair}`, `metadata::new`, `storage_resource::destroy`. Everything else tree-shakes.
- The generated `Package` default is the testnet id. **Library code never relies on it**: every call is wrapped with `Effect.provideService(Package, state.packageId)`. Generated `.type()` strings embed testnet's defining ids, so library code builds `Blob`'s type from `state.typeOrigin` instead.
- If the generator cannot express a Walrus type (candidates: `ExtendedField`, `group_ops::Element<UncompressedG1>`, the positional `Committee` struct, `EpochState`), fix the generator in `packages/sui-codegen` with a fixture; do not hand-write the binding.

## 6. Test plan

Conventions as in the other packages: `bun:test`; offline tests always run; live tests are skipped unless opted in; `@mysten/*` are dev-only oracles.

### 6.1 Unit (offline)

| File | Covers |
|---|---|
| `core.test.ts` | `Bft` tables for `n ∈ {1, 4, 5, 6, 7, 10, 100, 1000}` including the T4 cases; `Encoding` size formulas at boundaries (0, 1, one symbol, `maxBlobSize`, one over); `BlobId` round trips and rejections; `Merkle.root` for 0, 1, 2, 3 and 1000 leaves; `signersBitmap`; `Cost`. |
| `messages.test.ts` | `verifyMetadata` accepts a real metadata fixture and rejects a flipped hash, a wrong id, a wrong hash count, encoding type 0, an oversized length; `checkSliver`; `confirmationMessage` equals the live sample in M1. |
| `status.test.ts` | Decoding every `BlobStatus` shape including snake_case counts; `order` against a table transcribed from `api.rs:138-200`; `canonical` is insensitive to key order. |
| `encoder.test.ts` | Round trip for lengths 0, 1, 32, 100 kB (and `n` 4 and 7); `nShards` below 4 and lengths above the maximum rejected before the WASM; a trapped instance is replaced; every `BlobEncoder` freed on scope close; `decode` with too few or duplicate slivers is a typed `EncoderError`; `sliverRoots` equals the metadata hashes for random primary and secondary slivers (systematic and repair) and differs exactly for corrupted ones; BLS verify with 48- and 96-byte keys; aggregate equals `@noble/curves`. Slow (about 2.5 s per WASM call): keep `n = 1000` cases few and use `n = 10` elsewhere. |
| `storage-node.test.ts` | A scripted `HttpClient` (pattern of `packages/sui-enoki/test/support.ts`): request method, path, headers and body for every endpoint; every row of the error mapping in §4.4 from recorded bodies (`fixtures/storage-node/recorded.json`, GETs against a testnet node; `PUT`, `451`, `429` and `5xx` bodies, which reads cannot produce on demand, are built from the Rust node's messages in `synthesized.json`); timeout → `Timeout` under `TestClock`. |
| `committee.test.ts` | Building committees from recorded testnet objects (fixtures under `test/fixtures/`, written by `scripts/record-fixtures.ts`); `readCommittee` for the four cases of C6; `checkAgainstSystem` mismatches; cache and `refresh`. |
| `read.test.ts` | An in-memory network of fake nodes over a small committee (`n = 10`, real WASM): happy path; exactly `n − 2f` nodes answer; one node returns a corrupted sliver → blamed, replaced, read succeeds; a wrongly encoded blob → `InconsistentBlob`; quorum of 404 → `BlobNotFound`; quorum of 451 → `BlobBlocked`; mixed failures → `NotEnoughSlivers` with every node's failure; metadata from a lying node is rejected and another node's is used; previous committee during `EpochChangeSync`; `maxSize`. With `TestClock`: a hung node does not delay the result; retries follow the schedule. |
| `write.test.ts` | Fake nodes that sign with `@noble/curves` keys: certificate at exactly `n − f` weight by shards (few heavy nodes; many light nodes are not enough: item 5); linger collects late confirmations and the result's virtual time is `1.5t + 500 ms`; `NotRegistered` then success; a node signing the wrong message or epoch is a failure; fail fast above `f` failed weight; the global semaphore bounds in-flight `PUT`s; status check skips stored slivers. Steps: resume from each saved step; register reuses an existing uncertified `Blob`; a stale certificate goes back to upload; an already certified blob is not certified twice; `ResumeMismatch`. |
| `relay.test.ts`, `quilt.test.ts`, `gateway.test.ts` | Tip arithmetic; the auth input is input 0 and 72 bytes; `verifyCertificate` rejections; quilt layout edge cases (one entry, many entries, tags, index over 10 columns, duplicate identifiers); patch id round trip; sliver-based patch read with one corrupted column falls back; scripted aggregator and publisher. |

### 6.2 Parity with `@mysten/walrus` (offline unless noted)

Byte-for-byte where both sides are deterministic:

- `Encoding` sizes, `shardOfPair` / `pairOfShard`, `storageUnits`, `signersBitmap` against `walrus/dist/utils/index.mjs` over a property-based range.
- `BlobId` text and `u256` forms; BCS of `BlobMetadata`, `SliverData`, `Confirmation` (permanent and deletable), `Certificate`, quilt index and patch id against `walrus/dist/utils/bcs.mjs`.
- `Encoder.encode` against `getWasmBindings().encodeBlob` (`walrus/dist/wasm.mjs`): blob id, root hash, metadata bytes, every sliver buffer.
- `Quilt.encode` against `encodeQuilt` (`walrus/dist/utils/quilts.mjs`): the quilt bytes and the index, for random entry sets.
- Recipes: for a fixed system state, the commands and inputs of our register and certify transactions equal those of `registerBlobTransaction` / `certifyBlobTransaction`, compared through `TransactionJson` (the WAL payment is the same `CoinWithBalance` intent). The one intended difference, a single WAL coin instead of two, is asserted explicitly.
- Upload relay: request URL and body equal `UploadRelayClient.writeBlob`'s for the same inputs (captured `fetch`).
- Live: our `System` / `Committees` values equal `client.walrus.systemState()` / `stakingState()` for the same objects.

### 6.3 Live testnet, reads (`SUI_LIVE=1`, no funds)

`live.read.test.ts`:

1. Committees load; `checkAgainstSystem` passes; `nShards` is 1000.
2. Pick a blob at run time: the newest `BlobCertified` events through `Events.list({ filter: Events.eventType(`${typeOrigin}::events::BlobCertified`), descending: true })` whose `end_epoch` is at least two epochs away and whose registered size is under 1 MB.
3. `Read.status` is certified; `Read.metadata` verifies; `Read.blob` returns bytes whose id matches, and they equal both `@mysten/walrus` `readBlob` and the public aggregator's bytes (`https://aggregator.walrus-testnet.walrus.space`).
4. A random id: `Read.blob` fails with `BlobNotFound`; `Read.status` is `Nonexistent`.
5. The testnet relay's `tipConfig` decodes.

Expect each `Read.blob` to take 5–10 s, most of it WASM (W5); set test timeouts to 60 s.

### 6.4 Live testnet, writes (`WALRUS_LIVE=1`, spends funds)

`live.write.test.ts`. The signer is loaded from the Sui CLI keystore; the key never enters the environment, a log or the repo:

```ts
const active = /active_address:\s*"?(0x[0-9a-f]{64})/.exec(yield* readFile("~/.sui/sui_config/client.yaml"))![1]
const keys = yield* PrivateKey.decodeKeystore(yield* readFile("~/.sui/sui_config/sui.keystore"))
// for each key: build the signer for its scheme (Ed25519 here; Secp256k1 / Secp256r1 from their packages) and keep the one whose address === active
```

Errors from this block must be mapped to a fixed message before they reach `expect` (no key material in assertion output). The test first reads balances and skips with a clear message below 0.3 SUI or 0.01 WAL.

1. Direct: `Write.run` a 32-byte random blob, `epochs: 1`, `deletable: true`, collecting the steps; then `Read.blob` returns it and `Read.status` is certified; then `burnBlob`.
2. Resume: run `Write.register` only, drop all state, then `Write.run` with no `resume` (the crash case of item 14) → the registration is reused: one `Blob` object in total; `burnBlob`.
3. Relay: the same as case 1 through the testnet relay (`via: "relay"`); `burnBlob`.
4. Quilt: three small entries; read one patch by id from slivers and one by identifier; `burnBlob`.

**Cost per run**, from testnet on 2026-11-27 (recent register and certify transactions, `walrus info` prices):

| | SUI (MIST) | WAL (FROST) |
|---|---|---|
| One register | ≈ 4,000,000 net (computation 1,000,000; storage 116.7M less rebate 113.7M), of which ≈ 3,000,000 is the `Blob` object's refundable deposit | 63 units × (4724 × 1 epoch + 9421) = 891,135 |
| One certify | ≈ 1,030,000 net | — |
| Burn (cleanup) | ≈ 1,000,000, returns ≈ 3,000,000 | — |
| Relay tip | 105 | — |
| **Four writes with cleanup** | **≈ 0.012 SUI** (≈ 0.02 without cleanup) | **≈ 0.0036 WAL** |

The address holds about 1.15 SUI (in its address balance; gas resolves through `Resolve.auto`) and 0.93 WAL (two coins), so funds allow roughly 60–90 runs before SUI runs out and about 250 before WAL does. The register transaction's gas **budget** is about 0.12 SUI because the system state object is rewritten, so the balance must stay above that. Blobs are 32 bytes, deletable, one epoch.

### 6.5 Bundle report

Add to `scripts/bundle-report.ts`: "walrus: read via aggregator", "walrus: read a blob", "walrus: write a blob", and `@mysten/walrus` `readBlob` / `writeBlob` under Rolldown for comparison. Report JS only, and state the WASM asset size (358 KB) separately. Add the rows to the README table.

## 7. Risks

1. **About 20% of testnet weight is unreachable through `fetch`.** Probing all 99 nodes from Bun: 77 answered (795 of 1000 shards). The rest failed with expired certificates (92 shards), unresolvable hosts (37), refused connections (23–45), self-signed certificates (11) and one transport error (42). Reads need 334 and are comfortable. Writes need 667 of the reachable 795: a margin of 128 shards. The Rust client reaches more nodes because it pins network keys instead of using the web PKI. Fail-fast transport errors keep this cheap, but a few more bad nodes would make direct writes fail from JS runtimes; the relay is the fallback.
2. **WASM blocks the thread for about 2.5 s per call** (W5): a read costs two calls, a write one, a blame pass one more. Timers and other fibers stall meanwhile. Acceptable for scripts and CLIs; a server needs the worker layer (open question 5).
3. **Protocol drift.** The contracts are at version 4 with storage pools; a `V2` inner state would surface as `UnsupportedSystemVersion`, not as garbage. The parity suite and the live read test are the tripwires.
4. **Memory.** `encode` peaks at about 10× the blob size (W5): the blob, the sliver buffers and the WASM's expanded matrix. v1 has no streaming; `maxSize` guards reads, and writes of large blobs from memory-constrained runtimes should use the relay (which needs only the blob id, but the same `compute_metadata` time).

## 8. Work packages

One agent each. "Parallel" lists what can run at the same time.

| # | Scope | Depends on | Files | Acceptance |
|---|---|---|---|---|
| W1 | Scaffold and pure core: `BlobId`, `Bft`, `Encoding`, `Merkle`, `Messages`, `Certificate`, `Cost`, `Status`, the pure error classes. | — | `packages/walrus/{package.json,tsconfig.json}`, `src/{BlobId,Bft,Encoding,Merkle,Messages,Certificate,Cost,Status,Errors,index}.ts`, `test/{core,messages,status}.test.ts`, `test/parity.core.test.ts`, `test/oracle.ts` (typed handles on `@mysten/walrus` internals and a raw-WASM `wasmEncode` for real metadata and slivers; reuse it in later tests); root devDependency | Unit and parity tests of §6.1–6.2 for these modules pass; no service in any signature; typecheck clean. |
| W2 | Codegen and chain state: config, generated bindings, `Config`, `System`, `Committee`; fixture recorder. | W1 | `sui-codegen.config.ts`, `scripts/{codegen,record-fixtures}.ts`, `src/generated/**`, `src/{Config,System,Committee}.ts`, `test/committee.test.ts`, `test/fixtures/*`, `test/live.chain.test.ts`; generator fixes in `packages/sui-codegen` if needed | Generated schemas decode live testnet System, Staking, both inner states and a `StakingPool`; values equal `@mysten/walrus`'s (live parity); mainnet objects decode too; C5 check passes live; offline fixture tests pass. |
| W3 | `Encoder`. | W1 | `src/Encoder.ts`, `test/encoder.test.ts`, `test/parity.encoder.test.ts` | §6.1 encoder tests and the encode parity test pass; thrown WASM errors are typed; instances are freed on scope close. |
| W4 | `StorageNodes`. | W1 | `src/StorageNode.ts`, `test/storage-node.test.ts`, `test/support.ts` (scripted client, fake node) | Every endpoint and every error-mapping row is tested from recorded bodies; live smoke test (`SUI_LIVE=1`) reads a status and a metadata from one node. |
| W5 | Read path. | Q1, Q2, W2, W3, W4 | `src/Read.ts`, `test/read.test.ts`, `test/live.read.test.ts` | §6.1 read tests including blame and the `TestClock` cases; §6.3 passes on testnet. |
| W6 | Recipes. | W2 | `src/Recipes.ts`, `test/recipes.test.ts`, `test/parity.recipes.test.ts` | Command-level parity with `@mysten/walrus` for register and certify; every recipe builds offline given a `System` test layer; `R` is `PtbBuilder \| System`. |
| W7 | Write path over nodes. | Q1, W3, W4, W6 | `src/Write.ts`, `test/write.test.ts`, `test/live.write.test.ts` (cases 1–2) | §6.1 write tests; live cases 1–2 pass; measured SUI and WAL per run recorded in the test file header. |
| W8 | Upload relay. | W6, W7 | `src/UploadRelay.ts`, `Write.ts` (`via: "relay"`), `test/relay.test.ts`, live case 3 | Request parity with `UploadRelayClient`; certificate verification tests; live case 3 passes (this is also the first live check that an address-balance SUI payment satisfies the relay's tip check). |
| W9 | Quilts. | W1, W3 for `Quilt.ts`; W5, W7 for reads and the live case | `src/{Quilt,QuiltRead}.ts`, `test/quilt.test.ts`, `test/parity.quilt.test.ts`, live case 4 | `Quilt.encode` byte parity; verified sliver reads with fallback; live case 4 passes. |
| W10 | Gateways, the one-line layer, bundle report, README. | W1 (gateways); W5, W7 (layer, report) | `src/{Aggregator,Publisher,Walrus}.ts`, `test/gateway.test.ts`, `scripts/bundle-report.ts`, `README.md` | Scripted gateway tests; bundle rows for three bundlers; an aggregator-only program contains neither WASM glue nor quorum code. |

Order and parallelism:

```
Q1 ──► Q2 ─────────────────────────┐
W1 ──┬─► W2 ──┬─► W6 ──┐           │
     ├─► W3 ──┤        ├─► W7 ──► W8
     ├─► W4 ──┤        │     └──► W9 (reads need W5)
     │        └────────┴─► W5 ◄────┘
     └─► W10 (gateways now; layer, report and README last)
```

After W1: W2, W3, W4, the gateway half of W10, Q1 and the pure half of W9 all run in parallel. W5 and W6 run in parallel. W7 follows W6; W8 and W9 follow W7.

## 9. Open questions

1. **`sui-lifecycle` for the two transactions?** *Recommendation: no dependency; inject an `Executor`.* `Lifecycle.run` accepts key signers only, so depending on it would exclude wallets. The steps are safe on their own because each one checks the chain before acting; a server passes `Lifecycle.run` as the executor and gets the journal as well (§4.7 example).
2. **Sliver verification with stock WASM (W6), or our own WASM build of `walrus-core`?** *Recommendation: ship W6 now.* It needs nothing new and makes quilt reads and blame verifiable. Our own build could expose `verify_sliver`, cheaper checks than a full re-encode, and symbol recovery, and would cut the 2.5 s constant; it is a second Rust toolchain to own. Revisit after v1 with measurements.
3. **Default consistency.** *Recommendation: `"strict"`*, as `@mysten/walrus` does, with `"skip"` for callers that trust the writer. It costs one extra WASM call per read.
4. **Linger default for writes.** *Recommendation: the Rust client's `0.5 × elapsed + 500 ms`*, overridable, `0` to disable. It adds latency but more nodes hold the data before certification.
5. **Worker-backed `Encoder`.** *Recommendation: not in v1.* Keep the in-thread layer behind the `Encoder` service and add `EncoderWorker.layer` when a server needs it; nothing else changes.
6. **Status fallback to an on-chain event** (Rust `verify_blob_status_event`). *Recommendation: not in v1.* Retry until `f + 1` agree, then fail with `StatusUnverified` carrying the groups. The read path's coarser key rarely splits. Add the fallback when `Transactions` can return a transaction's events.
7. **Nodes with broken web-PKI certificates** (risk 1). *Recommendation: accept in v1 and report unreachable weight in `NotEnoughConfirmations`.* A pinned-key `HttpClient` layer for Bun and Node is possible later (the network key is on chain) but cannot work in browsers.
8. **Codegen source.** *Recommendation: generate from the testnet package on chain and commit the output*; a live test asserts that mainnet's package exposes the same signatures for the calls we use. Alternative: generate from `testnet-contracts/walrus` in the Rust repo, which needs a Move toolchain and a vendored copy.
9. **New node features: pending uploads and long-poll confirmations** (N8). *Recommendation: not in v1.* Pending uploads would let the upload overlap the register transaction; the Rust client still ships them disabled.
10. **Scope left out of v1:** storage pools, subsidies contracts, staking operations, shared blobs, streaming and byte-range reads, sliver recovery from symbols, the "already certified by someone else, skip the upload" shortcut. *Recommendation: leave out*; none is needed for read, write, relay or quilts. Blob attributes are in, because quilts need one.
11. **Environment flags.** *Recommendation: `SUI_LIVE=1` for everything that reads (as in the rest of the repo), `WALRUS_LIVE=1` in addition for tests that spend funds*, so that `bun run test:live` never spends WAL by accident.
