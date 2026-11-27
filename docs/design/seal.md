# `@unconfirmed/seal` — design

Status: design, 2026-11-27. Not implemented. Implementers: read this file, `docs/design/quorum.md` (with §10), `EXPLORATION.md` §6–7, and the README sections "How it composes" and "Importing".

A ground-up Seal client on `@unconfirmed/sui` and `@unconfirmed/quorum`: threshold identity-based encryption to key servers registered on Sui, session keys, key fetching, decryption. The crypto core is pure and usable offline; services start at I/O (chain reads, key server HTTP).

## 0. References and how to cite them

| Reference | Version | Where |
|---|---|---|
| `@mysten/seal` | 2.0.1 (root devDependency, exact) | `node_modules/@mysten/seal/dist/` — cited as `seal/dist/<file>:<line>` |
| Seal Rust repo | `MystenLabs/seal` at `024b523e` (2026-11-23), workspace version 0.6.16 | cited as `crates/...`, `move/...`, `docs/content/...`, `tests/...` |
| `@noble/curves` / `@noble/hashes` | 2.4.0 / ^2.3.0 (what `bun.lock` resolves today) | `packages/sui/node_modules/@noble/` |
| Testnet and mainnet, read 2026-11-27 | protocol version 144 on testnet | throwaway scripts (not kept in the repo): chain reads, `/v1/service`, `/v1/fetch_key` with throwaway keys, transaction simulation |

"Live-verified" means I observed it on 2026-11-27. No funds were spent and nothing was signed with the wallet: every key request used a fresh in-memory Ed25519 key.

### 0.1 Key servers found

Independent servers on testnet (`docs/content/Pricing.mdx`). All ten are still `KeyServerV1` on chain (`first_version = last_version = 1`); the docs list all of them as Open mode.

| On-chain name | Object id | URL (from chain) | `/v1/service` + PoP | `fetch_key` round trip |
|---|---|---|---|---|
| `mysten-v1-1` | `0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75` | `https://seal-key-server-testnet-1.mystenlabs.com` | ok, 0.6.16 | ok |
| `mysten-v1-2` | `0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8` | `https://seal-key-server-testnet-2.mystenlabs.com` | ok, 0.6.16 | ok |
| `ruby-nodes-free-testnet` | `0x6068c0acb197dddbacd4746a9de7f025b2ed5a5b6c1b1ab44dade4426d141da2` | `https://seal-testnet.api.rubynodes.io` | ok, 0.6.16 | ok |
| `Testnet-Nodeinfra-open` | `0x5466b7df5c15b508678d51496ada8afab0d6f70a01c10613123382b1b8131007` | `https://open-seal-testnet.nodeinfra.com` | ok, 0.6.16 | ok |
| `studio-mirai-open` | `0x164ac3d2b3b8694b8181c13f671950004765c23f270321a45fdd04d40cccf0f2` | `https://open.key-server.testnet.seal.mirai.cloud` | ok, 0.6.14 | ok |
| `overclock-open` | `0x9c949e53c36ab7a9c484ed9e8b43267a77d4b8d70e79aa6b39042e3d4c434105` | `https://seal-testnet-open.overclock.run` | no answer in 10 s | no answer in 20 s |
| `H2O Nodes` | `0x39cef09b24b667bc6ed54f7159d82352fe2d5dd97ca9a5beaa1d21aa774f25a2` | `https://seal-open.sui-testnet.h2o-nodes.com` | ok, 0.6.16 | ok |
| `triton-testnet-seal-1` | `0x4cded1abeb52a22b6becb42a91d3686a4c901cf52eee16234214d0b5b2da4c46` | `https://seal.testnet.sui.rpcpool.com` | ok, 0.6.16 | ok |
| `natsai-open-test` | `0x3c93ec1474454e1b47cf485a4e5361a5878d722b9492daf10ef626a76adc3dad` | `https://seal-open-test.natsai.xyz` | ok, 0.6.16 | ok |
| `Suiftly\|Mhax.io` | `0x6a0726a1ea3d62ba2f2ae51104f2c3633c003fb75621d06fde47f04dc930ba06` | `https://seal-testnet-open.suiftly.io` | `503`, HTML body | `503` |

So 8 of 10 were reachable from Bun `fetch`; a round trip took 0.35–1.2 s. The Mirai URL in the docs (`open.key-server-testnet…`) differs from the one on chain (`open.key-server.testnet…`): the object is the source of truth.

Committee (MPC) servers, both `KeyServerV2` with `ServerType::Committee`, `first_version = last_version = 2`:

| Network | Object id | Committee | Aggregator | Observed |
|---|---|---|---|---|
| Testnet | `0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98` | 3 of 5, version 0 | `https://seal-aggregator-testnet.mystenlabs.com` | `fetch_key` ok without an API key (0.9 s); `/v1/service` is `400 "Unsupported"` |
| Mainnet | `0x686098f1439237fff9f36b99c7329683c22979d2005c2465cb891acb012a7595` | 5 of 8, version 0 | `https://seal-aggregator-mainnet.mystenlabs.com` | `401 {"message":"No API key found in request",…}` (a gateway body, not Seal's) |

Mainnet independent servers are by arrangement with each provider (no public ids). I found no `KeyServerV2` *independent* server; that layout is covered by a synthesized fixture only.

Policy packages already on chain:

| | Testnet | Mainnet |
|---|---|---|
| Mysten's canary package (`tests/simple-seal-server.test.ts:25-28`; providers in permissioned mode are asked to allow it) | `0x58dce5d91278bceb65d44666ffa225ab397fc3ae9d8398c8c779c5530bd978c2` | `0x4852d0fde1fa84729b223045e8100adad5e801c593d45717030dc1aa96776fbc` |
| Seal package (`bf_hmac_encryption`, `key_server`), current / original (`move/seal/Published.toml`) | `0xdccbeb87…4112` / `0x4614e5da…f2e1` | `0x93173922…4e45` / `0x9636e0c7…4e23` |

The testnet canary is version 1 and contains the whole `move/patterns` set: `account_based`, `tle`, `private_data`, `whitelist`, `subscription`, `voting`, `key_request` (live-verified through GraphQL). That is what the live tests use (§6.3): **no package of our own needs publishing**.

## 1. Protocol facts

Each fact is something the implementation depends on.

### 1.1 Identities and the encrypted object

| # | Fact | Source |
|---|---|---|
| I1 | The full identity is `package id (32 bytes) ‖ inner id`. The package id is the **first version** of the policy package: a key server resolves the package in the request to its original id and derives keys for `original id ‖ inner id`. | `crates/crypto/src/lib.rs:293-295`; `crates/key-server/src/common.rs:48-70`; `crates/key-server/src/server.rs:564-568`, `:602` |
| I2 | BCS `EncryptedObject { version: u8, package_id: address, id: vector<u8>, services: vector<(address, u8)>, threshold: u8, encrypted_shares, ciphertext }`. `encrypted_shares` is an enum with one variant, `BonehFranklinBLS12381 { nonce: [u8; 96], encrypted_shares: vector<[u8; 32]>, encrypted_randomness: [u8; 32] }`. `ciphertext` is `Aes256Gcm { blob: vector<u8>, aad: Option<vector<u8>> }` \| `Hmac256Ctr { blob, aad, mac: [u8; 32] }` \| `Plain`. | `crates/crypto/src/lib.rs:48-80`; `seal/dist/bcs.mjs:5-36` |
| I3 | `services[i]` is `(key server object id, share index)`. A server with weight `w` appears `w` times, each time with its own share. Writers number shares `1..n` in list order, but readers must accept any distinct non-zero indices: the Rust test vector written by an older TS SDK uses 42, 194 and 30. | `seal/dist/encrypt.mjs:25-29`; `crates/crypto/src/tss.rs:47`; `crates/crypto/src/lib.rs:685` (decoded) |
| I4 | A valid object has `version = 0`, `1 ≤ threshold ≤ n`, as many encrypted shares as services, distinct non-zero indices, and no trailing bytes. The Move parser enforces all of it; the Rust library checks the version and the share count; the TS SDK checks only the share count. | `move/seal/sources/bf_hmac_encryption.move:392-441`; `crates/crypto/src/lib.rs:216-247`; `seal/dist/decrypt.mjs:23-28` |
| I5 | `n ≤ 255` and `threshold ≤ 255` (both `u8`; indices are `1..=n`). The TS SDK stops at 254. | `crates/crypto/src/tss.rs:37-47`; `seal/dist/encrypt.mjs:23` |

### 1.2 Cryptography

`G1` points are 48 bytes compressed, `G2` 96, scalars 32 bytes big-endian, all as `@noble/curves` `bls12_381` encodes them.

| # | Fact | Source |
|---|---|---|
| C1 | Domain separation tags: `H1(id)` uses `"SUI-SEAL-IBE-BLS12381-00"`, the share KDF `"SUI-SEAL-IBE-BLS12381-H2-00"`, key derivation `"SUI-SEAL-IBE-BLS12381-H3-00"`, proof of possession `"SUI-SEAL-IBE-BLS12381-POP-00"`. | `crates/crypto/src/lib.rs:31-40` |
| C2 | `gid = hashToG1(DST_ID ‖ fullId)`, hash-to-curve with the standard suite DST `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` (noble's default for `G1.hashToCurve`). Vector: `fullId = [0; 32] ‖ 01020304` gives `a2f2624f…81ee65d7` (verified with noble). | `crates/crypto/src/ibe.rs:186-188`; `lib.rs:481-487` |
| C3 | Key server key pair: master key `s`, public key `G2·s`. A derived (user secret) key is `usk = gid·s`. It is valid when `e(usk, G2) = e(gid, pk)`. | `ibe.rs:43-45`, `:69-84` |
| C4 | Encrypting shares: pick `r`, `nonce = G2·r`. Share `i` is XORed with `kdf(e(gid·r, pk_i), nonce, gid, objectId_i, index_i)`. Decrypting uses `e(usk_i, nonce)`, the same GT element. | `ibe.rs:116-158` |
| C5 | `kdf = sha3_256(DST_KDF ‖ GT (576 bytes) ‖ nonce (96) ‖ gid (48) ‖ object id (32) ‖ index (1))`. | `ibe.rs:191-205`; `seal/dist/kdf.mjs:27-39` |
| C6 | **GT bytes are fastcrypto's, not noble's.** Take noble's `Fp12.toBytes` (576 bytes) as six 96-byte pairs and reorder them `[0, 3, 1, 4, 2, 5]`. Verified against the Rust vector `89befdfd…f088ea87` (`r = 12345`, `gid = H1([0])`, object id 0, index 42): the permuted bytes match, the unpermuted do not. | `seal/dist/bls12381.mjs:81-100`; `ibe.rs:239-253` |
| C7 | `deriveKey(purpose, baseKey, encryptedShares, threshold, objectIds) = sha3_256(DST_DERIVE_KEY ‖ baseKey ‖ purpose ‖ threshold (1) ‖ every encrypted share ‖ every object id)`, purpose `0x00` for the randomness key, `0x01` for the DEM key. Object ids are listed with multiplicity, in `services` order. | `lib.rs:318-338`; `seal/dist/kdf.mjs:62-77` |
| C8 | `encrypted_randomness = r (32 bytes BE) XOR deriveKey(0, …)`. After combining shares a reader recovers `r` and checks `G2·r = nonce`; that check is what detects wrong keys. `r` must be a canonical scalar (`< order`); **noble's `Fr.fromBytes` reduces instead of rejecting** (`bls12-381.js:125`), so convert with an explicit range check. | `ibe.rs:208-218`, `:161-166`; `lib.rs:378-403` |
| C9 | Legacy ciphertexts may carry `r` little-endian; the TS SDK accepts both with `checkLEEncoding`. The Rust library accepts big-endian only. | `seal/dist/ibe.mjs:135-172` |
| C10 | Share consistency (optional, needs every service's public key): interpolate the polynomial from the decrypted shares, re-derive **all** shares from `r` (`e(gid·r, pk_i)`), and require each to lie on the polynomial. It guarantees every set of `t` servers decrypts to the same plaintext. The Rust SDK always does it; the TS SDK only on request. | `lib.rs:344-373`, `:406-454`; `crates/seal-sdk/src/lib.rs:142-146`; `seal/dist/decrypt.mjs:41-44` |
| C11 | Shamir over GF(2⁸) (the AES field, generator `0x03`), one polynomial of degree `t − 1` per secret byte, constant term the secret byte, shares evaluated at the index. Secrets are any length (the base key is 32). Index 0 and duplicate indices are invalid. Vector: three base64 shares of `"My super secret message"`, 2 of 3. | `crates/crypto/src/tss.rs:37-63`, `:68-115`, `:233-257`; `crates/crypto/src/gf256.rs`; `seal/dist/shamir.mjs:563-727` |
| C12 | AES-256-GCM with a **fixed 16-byte IV** `8a3799fdc62e79dba0805907d69c94dc` (the key is never reused); the 16-byte tag is appended to `blob`. `aad` absent means empty. WebCrypto accepts a 16-byte IV (the TS SDK runs on it; works in Bun 1.4.4). Effect's `Aead` does not (`AesGcm.nonceLength: 12`). | `crates/crypto/src/dem.rs:21-47`; `seal/dist/dem.mjs:9-71` |
| C13 | HMAC-SHA3-256 CTR: block `i` (32 bytes) is XORed with `hmac(key, "HMAC-CTR-ENC" ‖ u64le(i))`; `mac = hmac(key, "HMAC-CTR-MAC" ‖ u64le(len(aad)) ‖ aad ‖ ciphertext)`. One key for both. This is the only mode Move can decrypt. | `dem.rs:58-125`; `seal/dist/dem.mjs:80-131`; `bf_hmac_encryption.move:426-428` |
| C14 | `Plain`: no data; "decrypting" returns the DEM key. Used by `seal-cli` to derive a key. The TS SDK cannot write it and refuses to read it. | `dem.rs:138`, `:151`; `seal/dist/decrypt.mjs:46-48` |
| C15 | The key returned next to the encrypted object is the **DEM key**, not the base key. | `lib.rs:167-187`; `seal/dist/encrypt.mjs:27-41` |
| C16 | ElGamal on G1 for responses: the client picks `sk`, sends `enc_key = G1·sk` and `enc_verification_key = G2·sk`; a server answers `(c0, c1) = (G1·k, enc_key·k + usk)`; the client computes `usk = c1 − c0·sk`. | `crates/crypto/src/elgamal.rs:31-53`; `seal/dist/elgamal.mjs` |
| C17 | Proof of possession: `pop = hashToG1(DST_POP ‖ pk (96) ‖ object id (32))·s`, verified as a min-sig BLS signature (`bls12_381.shortSignatures.verify`). Live-verified on 8 servers. | `ibe.rs:224-230`; `seal/dist/key-server.mjs:119-124` |
| C18 | `@noble/curves` `Point.fromBytes` checks curve and subgroup membership but accepts the point at infinity. A public key at infinity makes its share readable by anyone; a derived key at infinity verifies against it. | `@noble/curves` `abstract/weierstrass.js:337-339`, `bls12-381.js:490`, `:518` |

Reference vectors usable offline: C2, C6, C11, AES-GCM and HMAC-CTR regressions (`dem.rs:193-207`, `:235-257`, message and AAD at `:163-164`), and a full object written by the TS SDK with its three master keys (`lib.rs:666-712`; I decoded and decrypted it with `@mysten/seal`: 2 of 3, AES, AAD `01020304`, plaintext `"My super secret message"`).

### 1.3 Key servers on chain

| # | Fact | Source |
|---|---|---|
| K1 | `KeyServer { id: UID, first_version: u64, last_version: u64 }`. The data is a dynamic field named by the version (`u64`): `KeyServerV1 { name, url, key_type: u8, pk: vector<u8> }` at 1, `KeyServerV2 { name, key_type, pk, server_type }` at 2. `server_type` is `Independent { url }` \| `Committee { version: u32, threshold: u16, partial_key_servers: vector<{ name, url, partial_pk: vector<u8>, party_id: u16 }> }`. `key_type` 0 is Boneh-Franklin BLS12-381; `pk` is 96 bytes. | `move/seal/sources/key_server.move:29-85`; `seal/dist/bcs.mjs:40-82` |
| K2 | A V1 object can gain a V2 field (`upgrade_v1_to_independent_v2`), giving `first = 1, last = 2`. The TS SDK reads the highest version it knows within `[first, last]`. | `key_server.move:121-136`; `seal/dist/key-server.mjs:11`, `:36-39` |
| K3 | The owner of an independent server can change its URL at any time (`update`); a committee can change members, threshold and member URLs. The public key never changes. | `key_server.move:156-190`, `:220-234` |
| K4 | **The object's type does not identify a key server.** The eleven testnet objects come from five different packages (`0x0f16e84a…`, `0x62c79dfe…`, `0xe3d7e7a0…`, `0x73bba649…`, `0x4614e5da…`), and the committee's `KeyServerV2` type lives at a sixth address. Some objects are shared, some owned by an address, the committees are owned by another object. Trust comes from the configured object id alone; anyone can create a `KeyServer`. | live |
| K5 | A committee server's on-chain public key is the committee's aggregated key. The aggregator returns one ElGamal-encrypted key per id which verifies against that public key like any independent server's (C3), so the aggregator needs no trust. The URL to call is not on chain: it is configuration. | `docs/content/Aggregator.mdx`; `crates/key-server/src/aggregator/server.rs:326-546`; live |

### 1.4 Key server HTTP API

| # | Fact | Source |
|---|---|---|
| H1 | Routes: `POST /v1/fetch_key`, `GET /v1/service?service_id=<object id>`. Request body limit 180 KiB. | `crates/key-server/src/server.rs:101`, `:1418-1419` |
| H2 | `Client-Sdk-Version` is required and must be semver (`400 MissingRequiredHeader` / `InvalidSDKVersion`). `Client-Sdk-Type` selects the version rule: `typescript` (default `>=0.4.5`; `426 DeprecatedSDKVersion` below it), `rust`, `python`, `aggregator`; anything else, or no header, is not checked. **The aggregator accepts only `typescript`, `rust` and `python`** and answers `400 InvalidSDKType` otherwise (its default for TypeScript is `>=0.10.0`). All live-verified. | `server.rs:1138-1208`; `crates/key-server/src/common.rs:73-94`, `:145-154`; `crates/key-server/src/key_server_options.rs:315-317`; `crates/key-server/src/aggregator/server.rs:61-63`, `:163-219` |
| H3 | The TS SDK sends `Content-Type`, `Request-Id` (a UUID), `Client-Sdk-Type: typescript`, `Client-Sdk-Version`, and the API key header if configured. Mysten's canary checks that gateways allow exactly these for CORS, so a browser client should send no others. | `seal/dist/key-server.mjs:172-183`; `tests/simple-seal-server.test.ts:33-40` |
| H4 | Every response carries `X-KeyServer-Version`. The TS SDK requires `>= 0.4.1` and fails when the header is missing. Gateways in front of a server answer without it (the mainnet aggregator's `401`, a `503` from a load balancer). | `common.rs:187-203`; `seal/dist/key-server.mjs:16`, `:131-135`; live |
| H5 | `fetch_key` request, JSON: `{ ptb: base64(BCS ProgrammableTransaction), enc_key: base64 (48), enc_verification_key: base64 (96), request_signature: base64 (64), certificate: { user: "0x…", session_vk: base64 (32), creation_time: number (ms), ttl_min: number, signature: base64 (a serialized Sui signature), mvr_name?: string } }`. | `crates/seal-sdk/src/types.rs:28-45`; `seal/dist/key-server.mjs:162-168`; live |
| H6 | `fetch_key` response: `{ decryption_keys: [{ id: number[] (the full id), encrypted_key: [base64 c0, base64 c1] }] }`, one entry **per command of the PTB**, in order; two commands with the same id give two entries (live). The ids come from the PTB, not from a request field. | `crates/seal-sdk/src/types.rs:16-25`; `server.rs:605-626`; `crates/key-server/src/valid_ptb.rs:132-157` |
| H7 | Errors are `{ error: <name>, message }`. `403`: `InvalidPTB`, `InvalidPackage`, `NoAccess`, `InvalidCertificate`, `InvalidSignature`, `InvalidSessionSignature`, `InvalidParameter`, `InvalidMVRName`. `400`: `InvalidSDKType`, `InvalidSDKVersion`, `InvalidServiceId`, `UnsupportedPackageId`, `MissingRequiredHeader`. `426`: `DeprecatedSDKVersion`. `503`: `Failure`. `NoAccess` and `InvalidParameter` carry detail in `message` (the Move abort location and code; the fullnode's complaint). | `crates/key-server/src/errors.rs:41-118`; live for 9 of them |
| H8 | `Failure` (`503`) covers fullnode errors and staleness (the server prepends a clock check to the PTB; "Fullnode is stale" beyond 2 minutes by default): retry. `InvalidParameter` is the fullnode answering `InvalidArgument` or `NotFound` for an input, typically an object it has not indexed yet: retry after a moment. | `server.rs:440-474`, `:498-516`; `crates/key-server/src/seal_package.rs:76-117`; `key_server_options.rs:303-305`; `docs/content/UsingSeal.mdx` ("If a key server request fails with an `InvalidParameter` error…") |
| H9 | Open mode serves any package: asking Mysten's server, NodeInfra's and the testnet aggregator for `0x2::coin::seal_approve` got past the package check and failed in the dry run (`InvalidPTB: The seal_approve function was not found on the module`), where a permissioned server answers `UnsupportedPackageId`. A package that does not exist is `InvalidPackage`. | `crates/key-server/src/master_keys.rs:226-237`; `common.rs:59-66`; live |
| H10 | `GET /v1/service` answers `{ service_id, pop: base64 (48) }`; an unknown id is `400 InvalidServiceId`. The aggregator does not implement it (`400`, text body `Unsupported`). | `server.rs:1059-1085`; `aggregator/server.rs:320-322`; live |
| H11 | Mysten's testnet servers sit behind a gateway limiting to 10 requests per second per source (`ratelimit-limit: 10`). I did not provoke a `429`; treat any `429` as rate limiting whatever its body. | live (response headers) |

### 1.5 Session certificates and requests

| # | Fact | Source |
|---|---|---|
| R1 | The user signs, as a Sui personal message, the UTF-8 text `Accessing keys of package <name> for <ttl> mins from <YYYY-MM-DD HH:MM:SS> UTC, session key <base64 of the 32-byte Ed25519 public key>`. The time is `creation_time` truncated to seconds. `<name>` is the MVR name if the certificate has one, else the **first** package id as `0x` + 64 lower-case hex digits. Vectors in the Rust tests. | `crates/seal-sdk/src/lib.rs:28-44`, `:163-192`; `server.rs:370-375`, `:590`; `seal/dist/session-key.mjs:72-76` |
| R2 | The server rejects (`InvalidCertificate`) a TTL above its maximum (30 minutes by default), a `creation_time` later than its own clock, and an expired certificate. **Any amount of client clock lead fails**: a certificate dated 5 s ahead was refused (live). The TS SDK allows 1–30 minutes. | `server.rs:344-368`; `crates/key-server/src/time.rs:19-24`; `key_server_options.rs:299-301`; `seal/dist/session-key.mjs:27` |
| R3 | The signer must be `user` or one of its on-chain address aliases. Signatures that are or contain zkLogin are verified through the server's fullnode, the others locally (Ed25519, Secp256k1, Secp256r1, multisig, passkey). Failure is `InvalidSignature`; so is a message naming the wrong package (live). | `server.rs:147-183`, `:381-416`; `crates/key-server/src/sui_rpc_client.rs:386-402` |
| R4 | The session key signs, with plain Ed25519 (no intent, no hashing), BCS `{ ptb: vector<u8>, enc_key: vector<u8>, enc_verification_key: vector<u8> }` where `ptb` is the BCS `ProgrammableTransaction`. Vector in the Rust tests. | `crates/seal-sdk/src/lib.rs:46-64`, `:194-220`; `server.rs:419-428`; `seal/dist/session-key.mjs:9-13`, `:108-124` |
| R5 | The policy runs with `sender = certificate.user`, an empty gas payment and a budget of 55,000 computation units. | `server.rs:447-458`, `:596` |

### 1.6 The `seal_approve` transaction

| # | Fact | Source |
|---|---|---|
| P1 | The PTB has 1–100 commands and at least one input. Every command is a `MoveCall` to the **same package** whose function name starts with `seal_approve`. Every argument is an `Input` (no results, no gas coin). The first argument of every call is a pure input holding BCS `vector<u8>`: the inner id. | `crates/key-server/src/valid_ptb.rs:17-118` |
| P2 | What is sent and signed is the `ProgrammableTransaction` alone. `@mysten/sui` builds `TransactionKind` bytes and the TS SDK drops the first byte (the enum tag) without looking at it. | `valid_ptb.rs:121-129`; `seal/dist/key-server.mjs:163`; `seal/dist/session-key.mjs:114` |
| P3 | The package in the PTB may be any version of the policy package; the namespace is its first version (I1). | `server.rs:564-571` |
| P4 | Object inputs must be well-formed (owned or shared, with the right mutability) but the server strips their version and digest and lets the fullnode resolve current state. A resolved PTB therefore stays usable while the objects' ownership does not change. | `crates/key-server/src/sui_rpc_client.rs:225-236`, `:306-308` |
| P5 | Conventions for policy authors: first parameter `id: vector<u8>`, abort to deny, no side effects, prefer non-public `entry`. A missing function is `InvalidPTB`, an abort is `NoAccess`. | `docs/content/UsingSeal.mdx` ("Access control management"); `server.rs:518-544` |

### 1.7 Where the Rust code and `@mysten/seal` disagree

| Topic | Rust | `@mysten/seal` 2.0.1 | We follow |
|---|---|---|---|
| Object validity (I4) | version and counts checked; Move checks everything | share count only; trailing bytes and any version accepted (verified: a vector with `version = 9` and one with 3 trailing bytes both decrypt) | Move's rules |
| Share consistency (C10) | always, in the SDK | opt-in | opt-in, default off (cost: `n` pairings), documented |
| `r` encoding (C9) | big-endian | both, on request | big-endian; little-endian on request |
| `aad` absent | `None` | writes `Some([])` (`dem.mjs:54`, `:93`) | write what the TS SDK writes (byte parity); read both |
| `Plain` (C14) | supported | not supported | core supports it; `Seal.encrypt` does not offer it |
| Limits (I5) | 255 | 254 | 255 |
| Which servers decrypt | caller passes responses | the client's configured weights must equal the object's (`client.mjs:108-114`) | weights come from the object; configuration says who may be asked (§4.7) |
| `NoAccess` / `InvalidParameter` detail | in `message` | dropped (`error.mjs:14`, `:21`) | kept |
| `InvalidCertificate` | time or TTL | reported as "Session key has expired" (`error.mjs:17`) | its own kind |
| Retries | — (aggregator: none either) | none | per server, transient kinds only |

### 1.8 Measured

Bun 1.4.4, x64, `@noble/curves` 2.4.0: one pairing 6.9 ms; two pairings sharing a final exponentiation (`pairingBatch`) 6.4 ms; hash to G1 1.4 ms; G2 decode 1.3 ms; G2 multiply 2.0 ms. So encrypting to `n` shares costs about `7n` ms, verifying one derived key 6.4 ms (the TS SDK spends 13.8 ms: two full pairings, `seal/dist/ibe.mjs:52-56`), decrypting `t` shares about `7t` ms. Minified bundle (esbuild): noble's BLS12-381 with pairing and hash-to-curve is 73 KB / 26.5 KB gzip; `@mysten/seal` alone is 174 / 63 KB, with a `SuiGrpcClient` 428 / 128 KB.

## 2. Behaviour in `@mysten/seal` 2.0.1 that must not be ported

Line numbers are in `seal/dist/`. The first column says where the item comes from: `E` is a claim of `EXPLORATION.md` §6, with my verdict.

| # | From | Behaviour | Evidence |
|---|---|---|---|
| 1 | E, confirmed | The docs describe a `seal()` `$extend` factory; the package exports none. They also say `verifyKeyServers` defaults to `true`; it is `false`. | `seal/docs/index.md:18-37`, `:47`; `index.mjs:7`; `client.mjs:28` |
| 2 | E, corrected | Key servers are memoised as a promise for the client's life. There is **no** reset (the exploration says "manual reset"): only a failed load clears it. A URL changed on chain (K3) is never picked up. | `client.mjs:115-121` |
| 3 | E, confirmed | Expiry and creation time use `Date.now()`. | `session-key.mjs:31`, `:60` |
| 4 | E, confirmed (reproduced) | `getCertificate` checks, awaits the signer, then stores: three concurrent calls prompted the wallet three times. | `session-key.mjs:88-92`; called per fetch at `client.mjs:195` |
| 5 | E, confirmed | `export()` returns the secret key as a plain string in a plain object (only `toJSON` throws); `import` validates nothing beyond the constructor's checks and does not check the signature. | `session-key.mjs:128-145`, `:150-164` |
| 6 | E, confirmed | On failure only the "majority" error (by class name) is thrown; the others are dropped. | `error.mjs:132-146`; `client.mjs:237` |
| 7 | new (reproduced) | **`fetchKeys` can `throw undefined`.** When servers answer `200` but the threshold is not met (an invalid key, or an id that the PTB does not cover), `errors` is empty and `toMajorityError([])` returns `errors[0]`. | `client.mjs:219-228`, `:237`; `error.mjs:134` |
| 8 | E, confirmed | No retry anywhere: one `fetch` per server. | `key-server.mjs:161-191`; `client.mjs:199-235` |
| 9 | E, confirmed | An invalid derived key is `console.warn` and skipped. | `client.mjs:219-222` |
| 10 | E, confirmed, and worse | The derived-key cache is unbounded, never cleared, and keyed by `fullId:server` only. `fetchKeys` returns from the cache before it looks at the session key, so an expired session, or another user's session on the same client, decrypts from it. | `client.mjs:17`, `:189-194`, `:223` (expiry is only checked at `:196`) |
| 11 | E, confirmed | Committee servers use the configured aggregator URL; configuration mistakes are `InvalidClientOptionsError`, but only when the servers are first loaded, not at construction. | `key-server.mjs:53`, `:64`, `:80`; `client.mjs:24-25` |
| 12 | new | `checkShareConsistency` loads unknown servers' public keys through the same function, which demands an `aggregatorUrl` for a committee server although only the key is needed: objects naming a committee the client is not configured for cannot be checked. It also silently disables `checkLEEncoding`. | `client.mjs:91-97`, `:129-136`; `key-server.mjs:64` |
| 13 | new | `SealAPIError.assertResponse` does not pass the HTTP status on: `GeneralError.status` is `undefined` for every unknown error name (for example `MissingRequiredHeader`, which the SDK does not know). A body that is not Seal's JSON keeps the status but loses the body. | `error.mjs:10-41` |
| 14 | new (reproduced) | The package id goes into the personal message as the caller wrote it. `isValidSuiObjectId` accepts upper case and a missing `0x`; the server rebuilds the message with the canonical form (R1), so such a session fails everywhere: both spellings got `InvalidSignature` from a live server. | `session-key.mjs:26`, `:65-68`; `@mysten/sui` `utils/sui-types.mjs:112-117` |
| 15 | new | `txBytes.slice(1)` is unchecked (P2): passing full transaction bytes sends garbage; and the ids are a separate argument that nothing compares with the PTB (item 7). | `key-server.mjs:163`; `session-key.mjs:114`; `client.mjs:185` |
| 16 | new | `encrypt` reads the package object from the node on every call, uncached. | `client.mjs:46-47` |
| 17 | new | A session for one package used with an object of another fetches keys for the wrong ids and then fails with a plain `Error("Not enough shares. Please fetch more keys.")`. Malformed objects raise plain `Error`s from the Shamir and KDF code. | `client.mjs:185`; `decrypt.mjs:24-26`; `shamir.mjs:687-691`; `kdf.mjs:63-68` |
| 18 | new (observed) | A timeout surfaces as the runtime's `DOMException`, not a `SealError`. | `key-server.mjs:169-183` |
| 19 | new | A response without `X-KeyServer-Version` fails even when the keys in it are valid (H4). | `key-server.mjs:131-135`, `:186` |
| 20 | new | A derived key is checked with two full pairings (§1.8) and nothing rejects the point at infinity (C18). | `ibe.mjs:52-56`; `bls12381.mjs:15-21` |
| 21 | new | Object validity (§1.7, first row). | `decrypt.mjs:23-28` |

## 3. Package layout

```
packages/seal/
  package.json   @unconfirmed/seal; type module; sideEffects false; exports { ".": "./src/index.ts", "./*": "./src/*.ts" }
                 dependencies: effect 4.1.6, @unconfirmed/bcs, @unconfirmed/sui, @unconfirmed/quorum (workspace:*),
                               @noble/curves ^2.3.0, @noble/hashes ^2.3.0, @scure/base ^2.3.0
  tsconfig.json  { "extends": "../../tsconfig.base.json", "include": ["src", "test", "scripts"] }
  scripts/record-chain.ts  scripts/record-key-server.ts
  src/
    Bls.ts  Shamir.ts  Kdf.ts  Ibe.ts  ElGamal.ts  Dem.ts  EncryptedObject.ts  Envelope.ts  Entropy.ts  Errors.ts   pure
    Config.ts  KeyServer.ts                                                                            chain state
    KeyServerApi.ts                                                                                    key server HTTP
    SessionKey.ts  Approval.ts  Keys.ts                                                                sessions and key fetching
    Seal.ts        encrypt, decrypt, the one-line layer
    index.ts       export * as X from "./X.ts" for each module
  test/            see §6
```

Rules: namespace subpath imports only (`import * as Effect from "effect/Effect"`), never the `"effect"` barrel; every module-level value is a `/* @__PURE__ */` call or a function (the GF(2⁸) tables are built by a pure call, not written out); only `Bls.ts` imports `@noble/curves/bls12-381.js`; only `Keys.ts` imports `@unconfirmed/quorum`; `Shamir`, `Dem` and `EncryptedObject` import no curve code, so a program that only parses objects ships no BLS. Root `package.json` gains the devDependency `@unconfirmed/seal: workspace:*`.

## 4. Public API

`Address` is `@unconfirmed/sui/Address`. Errors are `Schema.TaggedError` (§4.9). Synchronous pure functions return `Result`; `R` names exactly what a function touches.

### 4.1 Pure primitives

```ts
// Bls.ts — the only module that imports @noble/curves/bls12-381.js
export type G1 = /* noble G1 point */; export type G2 = /* noble G2 point */; export type Scalar = bigint
export const G1_BYTES = 48, G2_BYTES = 96, GT_BYTES = 576, SCALAR_BYTES = 32
/** Compressed encodings. Rejects bad length, off-curve, wrong subgroup, and the point at infinity (C18). */
export const g1FromBytes: (bytes: Uint8Array) => Result.Result<G1, InvalidEncoding>
export const g2FromBytes: (bytes: Uint8Array) => Result.Result<G2, InvalidEncoding>
export const g1ToBytes: (p: G1) => Uint8Array
export const g2ToBytes: (p: G2) => Uint8Array
/** Canonical only: 32 bytes, value < group order (C8). */
export const scalarFromBytes: (bytes: Uint8Array, endian?: "be" | "le") => Result.Result<Scalar, InvalidEncoding>
export const scalarToBytes: (s: Scalar) => Uint8Array                    // 32 bytes BE
/** A uniform non-zero scalar from 48 random bytes (noble's `mapHashToField`). */
export const scalarFromEntropy: (bytes48: Uint8Array) => Scalar
export const hashToG1: (message: Uint8Array) => G1                       // C2 without the Seal DST
export const g1Generator: G1; export const g2Generator: G2
export const pairingBytes: (p: G1, q: G2) => Uint8Array                  // e(p, q) in fastcrypto's layout (C6)
/** e(a1, a2) == e(b1, b2), with one final exponentiation. */
export const pairingsEqual: (a: readonly [G1, G2], b: readonly [G1, G2]) => boolean
export class InvalidEncoding extends Schema.TaggedError<InvalidEncoding>()("InvalidEncoding", { what: Schema.String, reason: Schema.String }) {}

// Shamir.ts — C11
export interface Share { readonly index: number; readonly share: Uint8Array }
/** `coefficients` holds `secret.length × (threshold − 1)` bytes: byte i's coefficients for x¹..x^(t−1) at [i(t−1), (i+1)(t−1)). Shares get indices 1..total. */
export const split: (secret: Uint8Array, threshold: number, total: number, coefficients: Uint8Array) => Result.Result<ReadonlyArray<Share>, InvalidShares>
export const combine: (shares: ReadonlyArray<Share>) => Result.Result<Uint8Array, InvalidShares>
export const interpolate: (shares: ReadonlyArray<Share>) => Result.Result<(index: number) => Uint8Array, InvalidShares>
export class InvalidShares /* { reason }: empty, unequal lengths, duplicate or zero index, threshold out of range, wrong coefficient count */

// Kdf.ts — C1, C2, C5, C7
export const DST_ID, DST_KDF, DST_DERIVE_KEY, DST_POP: Uint8Array
export const fullId: (packageId: Address, id: Uint8Array) => Uint8Array
export const gid: (fullId: Uint8Array) => Bls.G1
export const kdf: (gt: Uint8Array, nonce: Uint8Array, gid: Uint8Array, objectId: Address, index: number) => Uint8Array
export const deriveKey: (purpose: "EncryptedRandomness" | "Dem", baseKey: Uint8Array, encryptedShares: ReadonlyArray<Uint8Array>, threshold: number, objectIds: ReadonlyArray<Address>) => Uint8Array

// Ibe.ts — C3, C4, C8, C10, C17
export interface Service { readonly objectId: Address; readonly index: number }
export const encryptShares: (r: Bls.Scalar, shares: ReadonlyArray<Uint8Array>, publicKeys: ReadonlyArray<Bls.G2>, fullId: Uint8Array, services: ReadonlyArray<Service>)
  => { readonly nonce: Uint8Array; readonly encryptedShares: ReadonlyArray<Uint8Array> }
export const decryptShare: (nonce: Bls.G2, userSecretKey: Bls.G1, encryptedShare: Uint8Array, fullId: Uint8Array, service: Service) => Uint8Array
/** Every share, from the randomness (for the consistency check). */
export const decryptAllShares: (r: Bls.Scalar, encryptedShares: ReadonlyArray<Uint8Array>, publicKeys: ReadonlyArray<Bls.G2>, fullId: Uint8Array, services: ReadonlyArray<Service>) => ReadonlyArray<Uint8Array>
export const verifyUserSecretKey: (userSecretKey: Bls.G1, fullId: Uint8Array, publicKey: Bls.G2) => boolean   // Bls.pairingsEqual
export const verifyNonce: (nonce: Bls.G2, r: Bls.Scalar) => boolean
export const verifyProofOfPossession: (pop: Uint8Array, publicKey: Uint8Array, objectId: Address) => boolean
/** A key server's side, for tests and local servers. */
export const publicKey: (masterKey: Bls.Scalar) => Uint8Array
export const extract: (masterKey: Bls.Scalar, fullId: Uint8Array) => Bls.G1
export const proofOfPossession: (masterKey: Bls.Scalar, objectId: Address) => Uint8Array

// ElGamal.ts — C16
export interface KeyPair { readonly secret: Bls.Scalar; readonly publicKey: Uint8Array /* 48 */; readonly verificationKey: Uint8Array /* 96 */ }
export const keyPair: (secret: Bls.Scalar) => KeyPair
export const generate: Effect.Effect<KeyPair>                                                   // 48 bytes of Entropy
export const decrypt: (secret: Bls.Scalar, ciphertext: readonly [Uint8Array, Uint8Array]) => Result.Result<Bls.G1, Bls.InvalidEncoding>
export const encrypt: (publicKey: Uint8Array, message: Bls.G1, k: Bls.Scalar) => Result.Result<readonly [Uint8Array, Uint8Array], Bls.InvalidEncoding>   // tests, local servers

// Dem.ts — C12..C14
export type Input =
  | { readonly _tag: "AesGcm256"; readonly data: Uint8Array; readonly aad?: Uint8Array }
  | { readonly _tag: "Hmac256Ctr"; readonly data: Uint8Array; readonly aad?: Uint8Array }
  | { readonly _tag: "Plain" }
export const AES_IV: Uint8Array
export const encrypt: (input: Input, key: Uint8Array) => Effect.Effect<EncryptedObject.Ciphertext, CryptoUnavailable>
export const decrypt: (ciphertext: EncryptedObject.Ciphertext, key: Uint8Array) => Effect.Effect<Uint8Array, DecryptionFailed | CryptoUnavailable>
/** The synchronous half, also usable on its own. */
export const hmacCtr: {
  readonly encrypt: (key: Uint8Array, data: Uint8Array, aad: Uint8Array) => { readonly blob: Uint8Array; readonly mac: Uint8Array }
  readonly decrypt: (key: Uint8Array, blob: Uint8Array, mac: Uint8Array, aad: Uint8Array) => Result.Result<Uint8Array, DecryptionFailed>
}

// Entropy.ts — the one source of randomness
/** Default: `crypto.getRandomValues`. Replace with `Effect.provideService(Entropy, seeded)` in tests. Nothing in `R`. */
export const Entropy: Context.Reference<(length: number) => Uint8Array>   // key "@unconfirmed/seal/Entropy"
export const bytes: (length: number) => Effect.Effect<Uint8Array>
```

AES-GCM runs on `crypto.subtle` (`Effect.tryPromise`); a runtime without it (a browser page not served over HTTPS) gets `CryptoUnavailable`, and HMAC-CTR still works there. The MAC comparison is constant-time. `aad` absent is written as `Some(empty)` (§1.7).

### 4.2 Encrypted objects and the envelope

```ts
// EncryptedObject.ts — I2..I5
export const IbeEncryptions /* Bcs.enum({ BonehFranklinBLS12381: Bcs.struct({ nonce: Bcs.bytes(96), encryptedShares: Bcs.vector(Bcs.bytes(32)), encryptedRandomness: Bcs.bytes(32) }) }) */
export const Ciphertext     /* Bcs.enum({ Aes256Gcm: struct { blob, aad: option(byteVector) }, Hmac256Ctr: struct { blob, aad, mac: bytes(32) }, Plain: null }) */
export const EncryptedObjectBcs /* the struct of I2; `services` is Bcs.vector(Bcs.tuple([Address, Bcs.u8])) */
export interface EncryptedObject { readonly version: 0; readonly packageId: Address; readonly id: Uint8Array
                                   readonly services: ReadonlyArray<readonly [Address, number]>; readonly threshold: number
                                   readonly encryptedShares: typeof IbeEncryptions.Type; readonly ciphertext: typeof Ciphertext.Type }
/** Decode and apply every rule of I4. */
export const parse: (bytes: Uint8Array) => Result.Result<EncryptedObject, InvalidCiphertext>
export const serialize: (object: EncryptedObject) => Uint8Array
export const fullId: (object: EncryptedObject) => Uint8Array
/** How many shares each server holds. */
export const weights: (object: EncryptedObject) => ReadonlyMap<Address, number>

// Envelope.ts — encryption and decryption with no I/O
export interface Recipient { readonly objectId: Address; readonly publicKey: Uint8Array }     // one entry per share: repeat a server for weight
export interface Randomness { readonly baseKey: Uint8Array /* 32 */; readonly coefficients: Uint8Array /* 32 × (t − 1), as Shamir.split */; readonly r: Bls.Scalar }
/** 32 + 32(t − 1) + 48 bytes of Entropy. */
export const randomness: (threshold: number) => Effect.Effect<Randomness>
export const seal: (o: { readonly packageId: Address; readonly id: Uint8Array; readonly recipients: ReadonlyArray<Recipient>; readonly threshold: number
                         readonly input: Dem.Input; readonly randomness: Randomness })
  => Effect.Effect<{ readonly object: EncryptedObject; readonly bytes: Uint8Array; readonly key: Uint8Array /* the DEM key, C15 */ }, InvalidEncryption | CryptoUnavailable>
export const open: (o: { readonly object: EncryptedObject
                         /** Verified derived keys by server (48-byte G1). */
                         readonly keys: ReadonlyMap<Address, Uint8Array>
                         /** One per `services` entry: turns on the consistency check (C10). */
                         readonly publicKeys?: ReadonlyArray<Uint8Array>
                         /** Also accept a little-endian `r` (C9). */
                         readonly legacyNonce?: boolean })
  => Effect.Effect<Uint8Array, NotEnoughKeys | InvalidCiphertext | DecryptionFailed | CryptoUnavailable>
```

`seal`: check `1 ≤ threshold ≤ n ≤ 255`, key and id sizes; `Shamir.split(baseKey, …)`; `Ibe.encryptShares`; `encrypted_randomness`; DEM key; `Dem.encrypt`. `open`: use every service entry whose server has a key (at least `threshold`, else `NotEnoughKeys`); decrypt those shares; `combine`; recover `r` and `verifyNonce` (a mismatch, or a non-canonical `r`, is `InvalidCiphertext`: wrong keys or a corrupt object); optionally C10; DEM key; `Dem.decrypt`. `open` assumes the keys were verified (`Keys.fetch` does); feeding it unverified keys can only produce `InvalidCiphertext` or `DecryptionFailed`, never a wrong plaintext, except in `Plain` mode.

### 4.3 Configuration and key servers

```ts
// Config.ts
export interface ServerConfig {
  readonly objectId: Address
  /** A positive integer: shares given to this server when encrypting, and its weight toward a threshold when no object says otherwise. */
  readonly weight: number
  readonly apiKey?: { readonly name: string; readonly value: Redacted.Redacted<string> }
  /** Required for a committee server, refused for an independent one (K5). */
  readonly aggregatorUrl?: string
}
export interface SealConfigService { readonly servers: ReadonlyArray<ServerConfig> }
export class SealConfig extends Context.Service<SealConfig, SealConfigService>()("@unconfirmed/seal/SealConfig") {}
export interface ServerInput { readonly objectId: string; readonly weight?: number /* 1 */; readonly apiKeyName?: string
                               readonly apiKey?: string | Redacted.Redacted<string>; readonly aggregatorUrl?: string }
/** Normalises ids; refuses duplicates, a weight that is not a positive integer, a total above 255, half an API key, a URL that is not http(s). */
export const make: (servers: ReadonlyArray<ServerInput>) => Result.Result<SealConfigService, InvalidConfig>
export const layer: (servers: ReadonlyArray<ServerInput>) => Layer.Layer<SealConfig, InvalidConfig>
export const testnet: { readonly mysten1: ServerInput; readonly mysten2: ServerInput; readonly committee: ServerInput /* with the aggregator URL */ }
export const mainnet: { readonly committee: ServerInput /* needs an API key */ }

// KeyServer.ts
export const KeyServerBcs, KeyServerV1Bcs, KeyServerV2Bcs, ServerTypeBcs, PartialKeyServerBcs       // K1, hand-written (open question 6)
export interface OnChain {
  readonly objectId: Address; readonly name: string; readonly publicKey: Uint8Array /* 96 */
  readonly layout: 1 | 2                                  // which versioned field was read
  readonly type:
    | { readonly _tag: "Independent"; readonly url: string }
    | { readonly _tag: "Committee"; readonly version: number; readonly threshold: number
        readonly members: ReadonlyArray<{ readonly name: string; readonly url: string; readonly partyId: number; readonly partialPublicKey: Uint8Array }> }
}
/** One read of the object and one of its versioned field (highest of 2, 1 within [first, last]), both through the batched `Objects.get`. */
export const read: (objectId: Address) => Effect.Effect<OnChain, KeyServerLoadError, Objects.Objects>
export interface KeyServer { readonly objectId: Address; readonly name: string; readonly publicKey: Uint8Array
                             readonly type: "Independent" | "Committee"
                             /** Where to send requests: the on-chain URL, or the configured aggregator. Absent for a server that is not configured for requests. */
                             readonly url: string | undefined
                             readonly apiKey: { readonly name: string; readonly value: Redacted.Redacted<string> } | undefined }
export class KeyServers extends Context.Service<KeyServers, {
  /** Cached. Works for any object id; `url` is set only for configured servers (and independent ones). */
  readonly get: (objectId: Address) => Effect.Effect<KeyServer, KeyServerLoadError>
  readonly refresh: (objectId: Address) => Effect.Effect<KeyServer, KeyServerLoadError>
}>()("@unconfirmed/seal/KeyServers") {}
export const layer: (options?: { readonly ttl?: Duration.Input /* 10 minutes; failures are not cached */ }) => Layer.Layer<KeyServers, never, SealConfig | Objects.Objects>
/** Also checks each configured independent server's proof of possession on first use (C17, H10); committee servers are skipped. */
export const layerVerified: (options?: { readonly ttl?: Duration.Input }) => Layer.Layer<KeyServers, never, SealConfig | Objects.Objects | KeyServerApi>
/** Fixed servers: pinned public keys, tests, offline encryption. */
export const layerFromServers: (servers: ReadonlyArray<KeyServer>) => Layer.Layer<KeyServers>
export type KeyServerLoadError = InvalidKeyServer | Objects.ObjectNotFound | RpcError
```

Reading: get the object, decode `KeyServerBcs`; pick the version; field id `DynamicFields.deriveId(objectId, "u64", bcs(version))`; get it, decode `Move.Field(Bcs.u64, KeyServerV{1,2}Bcs)`. `InvalidKeyServer { objectId, reason }` for: the object's type is not `…::key_server::KeyServer` or the field's value type not `…::key_server::KeyServerV{n}` (module and name only, K4); no supported version; `key_type ≠ 0`; a public key that `Bls.g2FromBytes` refuses (including infinity, C18); a configured committee server without `aggregatorUrl`, or a configured independent server with one (a committee that is not configured is fine: it has a public key and no `url`); a proof of possession that does not verify or names another id. The cache is per object id (`Cache`, capacity 256) with a TTL because URLs change (K3, item 2).

### 4.4 Key server HTTP

```ts
// KeyServerApi.ts
export const KeyServerErrorKind = Schema.Literals([
  "Unavailable", "Timeout", "RateLimited", "Unresolved",                                          // no verdict
  "NoAccess", "InvalidPtb", "InvalidPackage", "InvalidParameter", "InvalidSignature",            // the server's verdicts (H7)
  "InvalidSessionSignature", "InvalidCertificate", "InvalidMvrName",
  "InvalidServiceId", "UnsupportedPackage", "SdkRejected", "Unauthorized", "Rejected",           // this server will not serve us
  "Malformed", "InvalidKey", "MissingKey", "UnsupportedServerVersion"                            // what we concluded from an answer
])
export class KeyServerError extends Schema.TaggedError<KeyServerError>()("KeyServerError", {
  server: Schema.String,                       // object id
  url: Schema.optionalKey(Schema.String),
  kind: KeyServerErrorKind,
  status: Schema.optionalKey(Schema.Number),   // absent when no HTTP answer arrived
  error: Schema.optionalKey(Schema.String),    // the server's error name, verbatim
  requestId: Schema.optionalKey(Schema.String),
  message: Schema.String                       // the server's message (H7), or ours; never contains an API key
}) {
  /** Asking again may help: Unavailable | RateLimited | InvalidParameter. */
  get retryable(): boolean
  /** The request itself was judged; another honest server will say the same:
   *  NoAccess | InvalidPtb | InvalidPackage | InvalidSignature | InvalidSessionSignature | InvalidCertificate | InvalidMvrName. */
  get definitive(): boolean
}
export const retryable: (e: KeyServerError) => boolean
export const definitive: (e: KeyServerError) => boolean
/** The mapping below, pure. */
export const fromResponse: (server: Endpoint, status: number, body: string) => KeyServerError

export interface Endpoint { readonly objectId: Address; readonly url: string; readonly apiKey?: { readonly name: string; readonly value: Redacted.Redacted<string> } }
export interface Certificate { readonly user: Address; readonly sessionVk: Uint8Array; readonly creationTime: number; readonly ttlMin: number
                               readonly signature: Uint8Array; readonly mvrName?: string }
export interface FetchKeyRequest { readonly ptb: Uint8Array; readonly encKey: Uint8Array; readonly encVerificationKey: Uint8Array
                                   readonly requestSignature: Uint8Array; readonly certificate: Certificate }
export interface EncryptedKey { readonly fullId: Uint8Array; readonly ciphertext: readonly [Uint8Array, Uint8Array] }
/** The exact JSON of H5, same field order as `@mysten/seal`, `mvr_name` omitted when absent. Exported for parity tests. */
export const requestBody: (request: FetchKeyRequest) => string
export interface KeyServerApiOptions {
  readonly requestTimeout?: Duration.Input        // default 10 seconds, body included
  readonly sdkType?: string                       // default "typescript" (H2, open question 2)
  readonly sdkVersion?: string                    // default "2.0.1"
  readonly minServerVersion?: string              // default "0.4.1"; a missing header is accepted (H4)
  readonly tracerPropagation?: boolean            // default false (H3)
}
export class KeyServerApi extends Context.Service<KeyServerApi, {
  readonly fetchKey: (server: Endpoint, request: FetchKeyRequest) => Effect.Effect<ReadonlyArray<EncryptedKey>, KeyServerError>
  readonly service: (server: Endpoint) => Effect.Effect<{ readonly serviceId: Address; readonly pop: Uint8Array; readonly version: string | undefined }, KeyServerError>
}>()("@unconfirmed/seal/KeyServerApi") {}
export const layer: (options?: KeyServerApiOptions) => Layer.Layer<KeyServerApi, never, HttpClient.HttpClient>
```

Mapping, decided once in this module: transport failure → `Unavailable`; our timeout → `Timeout`; `429` → `RateLimited`; a JSON body with `error`: `NoAccess`, `InvalidPackage`, `InvalidParameter`, `InvalidSignature`, `InvalidSessionSignature`, `InvalidCertificate`, `InvalidServiceId` → the same kind; `InvalidPTB` → `InvalidPtb`; `InvalidMVRName` → `InvalidMvrName`; `UnsupportedPackageId` → `UnsupportedPackage`; `InvalidSDKType`, `InvalidSDKVersion`, `DeprecatedSDKVersion`, `MissingRequiredHeader` → `SdkRejected`; `Failure` → `Unavailable`. Without such a body: `401` or `403` → `Unauthorized`; `5xx` → `Unavailable`; any other non-2xx → `Rejected`. A 2xx body that does not decode → `Malformed`; a version header below `minServerVersion` → `UnsupportedServerVersion`. A defect raised by the `HttpClient` becomes `Unavailable`, because the quorum treats defects as fatal. `InvalidKey`, `MissingKey` and `Unresolved` are produced by `Keys.fetch`. The service never retries. `Timeout` is deliberately not retryable: a server that took 10 s once is not worth a second wait.

Headers sent: `Content-Type: application/json`, `Request-Id` (`crypto.randomUUID()`), `Client-Sdk-Type`, `Client-Sdk-Version`, and the API key header if configured; nothing else (H3).

### 4.5 Session keys

```ts
// SessionKey.ts
/** A key signer, or anything that signs personal messages itself: `@unconfirmed/sui-wallet`'s `WalletSigner` fits as it is. */
export type MessageSigner =
  | Signer.Signer
  | { readonly address: Address
      readonly signPersonalMessage: (message: Uint8Array) => Effect.Effect<{ readonly signature: Uint8Array }, { readonly _tag: string; readonly message?: string }> }

export interface Options {
  /** The first version of the policy package. Normalised (item 14). */
  readonly packageId: string
  readonly signer?: MessageSigner
  /** Default: the signer's address. Give it when the signer is an alias of the user (R3), or when there is no signer. */
  readonly address?: string
  readonly mvrName?: string
  /** Whole minutes, 1 to 30 (R2). Default 10 minutes. */
  readonly ttl?: Duration.Input
  /** Date the certificate this far in the past, so a client clock that runs ahead does not invalidate it (R2). Default 10 seconds (open question 3). */
  readonly clockSkew?: Duration.Input
  /** Derived keys kept for this session. Default 1024. */
  readonly cacheCapacity?: number
}

export interface SessionKey {
  readonly address: Address
  readonly packageId: Address
  readonly mvrName: string | undefined
  readonly createdAt: number                       // ms, what the certificate says
  readonly ttlMinutes: number
  readonly expiresAt: number                       // createdAt + ttl
  readonly publicKey: Uint8Array                   // the session's Ed25519 verification key
  readonly personalMessage: Uint8Array             // R1
  /** Signs at most once: concurrent callers share one prompt, a failure is not remembered. Fails when expired. */
  readonly certificate: Effect.Effect<KeyServerApi.Certificate, SessionKeyExpired | SignatureRequired | Signer.SigningError>
  /** True from 10 s before `expiresAt` (the margin `@mysten/seal` uses). */
  readonly isExpired: Effect.Effect<boolean>
}
export const make: (options: Options) => Effect.Effect<SessionKey, InvalidSessionKey>
/** For flows where the signature arrives from elsewhere (a popup, another device). Checks its shape, not its validity. */
export const withSignature: (session: SessionKey, signature: Uint8Array) => Effect.Effect<SessionKey, InvalidSessionKey>
/** Sign a key request (R4). */
export const signRequest: (session: SessionKey, ptb: Uint8Array, encKey: Uint8Array, encVerificationKey: Uint8Array) => Effect.Effect<Uint8Array, SessionKeyExpired>
/** Check the certificate's signature locally with the installed schemes. A signer that is an on-chain alias of `address` (R3) fails here. */
export const verify: (session: SessionKey) => Effect.Effect<Verify.Verified, SessionKeyExpired | SignatureRequired | Signer.SigningError | SignatureScheme.VerifyError, SignatureScheme.SignatureSchemes>

/** The same field names as `@mysten/seal`'s `ExportedSessionKey`; `sessionKey` is a `suiprivkey1…` string. */
export const Exported = Schema.Struct({
  address: Schema.String, packageId: Schema.String, mvrName: Schema.optionalKey(Schema.String),
  creationTimeMs: Schema.Number, ttlMin: Schema.Number,
  personalMessageSignature: Schema.optionalKey(Schema.String),          // base64
  sessionKey: Schema.RedactedFromValue(Schema.String)                   // decodes a plain string into Redacted; encoding reveals it
})
export type Exported = typeof Exported.Type
export const toExported: (session: SessionKey) => Effect.Effect<Exported>
export const fromExported: (exported: Exported, options?: { readonly signer?: MessageSigner; readonly cacheCapacity?: number })
  => Effect.Effect<SessionKey, SessionKeyExpired | InvalidSessionKey>
```

- Time comes from `Clock` (`createdAt = now − clockSkew`), so `TestClock` drives expiry.
- `certificate` is `Effect.cachedInvalidateWithTTL(sign, exit => success ? infinity : zero)` (the pattern in `packages/walrus/src/System.ts:150-160`). A key `Signer` signs through `Signer.signPersonalMessage`; a wallet through its own `signPersonalMessage`. A failure that is not a `SigningError` (a wallet's `UnsupportedFeature`) becomes `SigningError { reason: "unavailable" }`, as `Wallet.signer` already does for transactions. Without signer or signature: `SignatureRequired { message: personalMessage }`.
- The session secret is a `Redacted<Uint8Array>` held in the closure; it appears only in `toExported`. The request signature is raw Ed25519 over the bytes of R4 (`@noble/curves/ed25519.js` directly: a `Signer` hashes an intent message, which is not what the server verifies).
- `fromExported` decodes through the schema, normalises ids, rejects a session that is expired, a TTL outside 1–30, or a secret that is not an Ed25519 `suiprivkey`. A session exported by `@mysten/seal` imports here and the reverse.
- `make` does no I/O. Whether `packageId` is a first version is checked by `Seal.session` (§4.8).
- Each session owns a derived-key cache (§4.7), reachable only through `SessionKey.keyCache(session)` (marked `@internal`, used by `Keys`). It is not exported with the session and dies with it.

### 4.6 The approval transaction

```ts
// Approval.ts
export interface Approval {
  /** The package the calls go to: any version of the policy package (P3). */
  readonly packageId: Address
  /** The inner ids, one per command. */
  readonly ids: ReadonlyArray<Uint8Array>
  readonly ptb: T.ProgrammableTransaction
  /** BCS of `ptb`: what is sent and what the session key signs (P2). */
  readonly bytes: Uint8Array
}
/** One `seal_approve*` call with `id` as its first argument. A recipe step like any other. */
export const call: (o: { readonly target: `${string}::${string}::${string}`; readonly id: Uint8Array
                         readonly arguments?: ReadonlyArray<T.Argument>; readonly typeArguments?: ReadonlyArray<string> })
  => Effect.Effect<void, Ptb.InvalidPureValue, Ptb.PtbBuilder>
/** Build the recipe, resolve its object inputs (`Resolve.inputs`), check P1. */
export const fromRecipe: <A, E, R>(recipe: Effect.Effect<A, E, R>)
  => Effect.Effect<Approval, E | InvalidApproval | Objects.ObjectNotFound | RpcError, Exclude<R, Ptb.PtbBuilder> | Objects.Objects | Packages.Packages>
/** The same for a recipe with no unresolved objects (pure inputs, `Ptb.sharedObject`, `Ptb.objectArg`): no services. */
export const fromRecipeOffline: <A, E, R>(recipe: Effect.Effect<A, E, R>) => Effect.Effect<Approval, E | InvalidApproval, Exclude<R, Ptb.PtbBuilder>>
export const fromProgrammable: (ptb: T.ProgrammableTransaction) => Result.Result<Approval, InvalidApproval>
/** What `@mysten/sui`'s `build({ onlyTransactionKind: true })` returns. Checks the kind tag instead of dropping it; full transaction bytes are refused (item 15). */
export const fromTransactionKindBytes: (bytes: Uint8Array) => Result.Result<Approval, InvalidApproval>
```

`InvalidApproval { reason }` reproduces every rule of P1 with the server's wording, so a bad PTB fails before any request. Generated call builders (`@unconfirmed/sui-codegen`) work as recipes too: their first argument is the id.

### 4.7 Fetching keys

```ts
// Keys.ts — the only module that imports @unconfirmed/quorum
export interface DerivedKey { readonly server: Address; readonly fullId: Uint8Array; readonly key: Uint8Array /* 48-byte G1, verified */ }
export interface FetchOptions {
  readonly session: SessionKey
  readonly approval: Approval
  /** Who may be asked and what each counts for. */
  readonly servers: ReadonlyArray<{ readonly objectId: Address; readonly weight: number }>
  readonly threshold: number
  /** Per server. Default: exponential from 250 ms, capped at 2 s, 3 retries. */
  readonly retry?: Schedule.Schedule<unknown, KeyServerApi.KeyServerError>
  /** How long to keep waiting for other servers once denials weigh `threshold` (§5). Default 2 seconds. */
  readonly denialGrace?: Duration.Input
}
/** Keys for every id of the approval from servers weighing `threshold`, cached keys included. */
export const fetch: (options: FetchOptions) => Effect.Effect<ReadonlyArray<DerivedKey>, FetchError, KeyServers | KeyServerApi.KeyServerApi>
/** What the session already holds for a full id. */
export const cached: (session: SessionKey, fullId: Uint8Array) => Effect.Effect<ReadonlyArray<DerivedKey>>
export const forget: (session: SessionKey) => Effect.Effect<void>
export const defaultRetry: () => Schedule.Schedule<unknown, KeyServerApi.KeyServerError>
export type FetchError = ThresholdNotMet | SessionKeyExpired | SignatureRequired | Signer.SigningError
```

Algorithm of `fetch`:

1. `session.isExpired` → `SessionKeyExpired`, **before the cache is consulted** (item 10).
2. Full ids are `session.packageId ‖ id` for each id of the approval, duplicates removed (H6).
3. A server is *complete* when the session's cache holds its key for every full id. `cachedWeight` is the weight of complete servers. If `cachedWeight ≥ threshold`: return from the cache; no certificate, no request.
4. `session.certificate` (one prompt at most), a fresh `ElGamal.generate`, `SessionKey.signRequest`. One request body serves every server.
5. `Quorum.run` over the incomplete servers: `weight` as given, `threshold: threshold − cachedWeight`, unbounded concurrency, `schedule: retry`, `while: KeyServerApi.retryable`, and `giveUp: { when: KeyServerApi.definitive, weight: threshold, grace: denialGrace }` (§5). One member:
   1. `KeyServers.get(objectId)`. A retryable `RpcError` is `KeyServerError "Unavailable"`; any other load failure, or a server with no `url`, is `"Unresolved"`.
   2. `KeyServerApi.fetchKey`.
   3. For each returned key: `ElGamal.decrypt`, `Bls` decoding (rejecting infinity), `Ibe.verifyUserSecretKey` against the server's public key. Any failure is `KeyServerError "InvalidKey"` for the whole server (item 9). Entries for ids we did not ask for are ignored.
   4. Every full id must be present, else `"MissingKey"` (item 7).
   5. Store the keys in the session's cache.
6. Success: the keys of complete servers. `QuorumFailed` becomes `ThresholdNotMet` (§4.9) carrying every server's `KeyServerError`. Its `reason` is computed from the failures, not copied from the quorum's: with `d` the weight of `definitive` failures, `denied` when `d ≥ threshold` or `total − d < threshold − cachedWeight`, else `unreachable`. (3 of 3 with one `NoAccess` is `denied` although the quorum stopped as unreachable; 2 of 3 with one `NoAccess` and two servers down is `unreachable`.)

The cache is an Effect `Cache` (bounded, default 1024 entries) keyed by `hex(fullId):server`, each entry living until the session expires. It belongs to the session value: another user, another package, or a new session starts empty. Verification of a key costs 6.4 ms (§1.8), so a response with `k` ids costs `6.4k` ms per server; it runs in the member's fiber after the HTTP response and before the member counts as a success.

### 4.8 Encrypt, decrypt, the layer

```ts
// Seal.ts
export interface EncryptOptions {
  readonly packageId: string                                  // first version; checked unless `checkPackage: false`
  readonly id: Uint8Array
  readonly data: Uint8Array
  readonly threshold: number
  readonly aad?: Uint8Array
  readonly dem?: "AesGcm256" | "Hmac256Ctr"                   // default "AesGcm256"
  /** Default: every configured server with its configured weight, in configuration order. */
  readonly servers?: ReadonlyArray<{ readonly objectId: string; readonly weight: number }>
  readonly checkPackage?: boolean                             // default true
}
export const encrypt: (options: EncryptOptions)
  => Effect.Effect<{ readonly encryptedObject: Uint8Array; readonly key: Redacted.Redacted<Uint8Array> }, EncryptError, SealConfig | KeyServers | Objects.Objects>

export interface DecryptOptions {
  readonly data: Uint8Array | EncryptedObject.EncryptedObject
  readonly session: SessionKey
  readonly approval: Approval
  readonly checkShareConsistency?: boolean                    // default false (C10)
  readonly legacyNonce?: boolean                              // default false (C9)
  readonly retry?: Schedule.Schedule<unknown, KeyServerApi.KeyServerError>
}
export const decrypt: (options: DecryptOptions) => Effect.Effect<Uint8Array, DecryptError, SealConfig | KeyServers | KeyServerApi.KeyServerApi>

/** One round of requests for several objects under one approval; afterwards `decrypt` of each makes no request. */
export const fetchKeys: (options: { readonly objects: ReadonlyArray<Uint8Array | EncryptedObject.EncryptedObject>; readonly session: SessionKey; readonly approval: Approval
                                    readonly retry?: Schedule.Schedule<unknown, KeyServerApi.KeyServerError> })
  => Effect.Effect<void, FetchError | InvalidCiphertext | ApprovalMismatch, SealConfig | KeyServers | KeyServerApi.KeyServerApi>
/** Verified derived keys weighing the object's threshold, for on-chain decryption (`bf_hmac_encryption::verify_derived_keys`). */
export const derivedKeys: (options: Omit<DecryptOptions, "checkShareConsistency" | "legacyNonce">)
  => Effect.Effect<ReadonlyArray<Keys.DerivedKey>, FetchError | InvalidCiphertext | ApprovalMismatch, SealConfig | KeyServers | KeyServerApi.KeyServerApi>
/** `SessionKey.make` after checking that `packageId` is a first version. */
export const session: (options: SessionKey.Options) => Effect.Effect<SessionKey, InvalidSessionKey | NotFirstVersion | Objects.ObjectNotFound | RpcError, Objects.Objects>
/** A package object at version 1 (I1). Cached: packages are immutable. */
export const checkFirstVersion: (packageId: string) => Effect.Effect<Address, NotFirstVersion | Objects.ObjectNotFound | RpcError, Objects.Objects>

export interface SealOptions { readonly servers: ReadonlyArray<Config.ServerInput>; readonly verifyKeyServers?: boolean /* false */
                               readonly keyServers?: { readonly ttl?: Duration.Input }; readonly api?: KeyServerApi.KeyServerApiOptions }
export const layer: (options: SealOptions) => Layer.Layer<SealConfig | KeyServers | KeyServerApi.KeyServerApi, InvalidConfig, HttpClient.HttpClient | Objects.Objects>

export type EncryptError = InvalidEncryption | NotFirstVersion | KeyServerLoadError | CryptoUnavailable
export type DecryptError = FetchError | InvalidCiphertext | ApprovalMismatch | NotEnoughKeys | DecryptionFailed | KeyServerLoadError | CryptoUnavailable
```

`encrypt`: check the package; `KeyServers.get` for each server (all must load: a missing key server means no encryption); recipients are each server repeated `weight` times in order (what `@mysten/seal` does, `client.mjs:147-155`); `Envelope.randomness`; `Envelope.seal`. A program with pinned keys uses `Envelope.seal` directly and needs no service at all.

`decrypt`:

1. `EncryptedObject.parse`.
2. `ApprovalMismatch` unless `object.packageId = session.packageId` and `object.id` is among `approval.ids` (items 15, 17).
3. Servers that may be asked: those in `object.services` that are also configured, each weighing its number of shares **in the object** (§1.7). Servers named by the object but not configured are never contacted: their URLs would come from objects an attacker can create, and the request discloses the user's address and policy. If the weight is below `object.threshold`, `Keys.fetch` fails at once with `ThresholdNotMet` (`reason: "insufficientWeight"`).
4. `Keys.fetch` with `threshold: object.threshold`.
5. `Envelope.open` with the fetched keys; with `checkShareConsistency`, `publicKeys` come from `KeyServers.get` for **every** service, configured or not (only the chain is read; closes item 12).

`fetchKeys` groups the objects by their set of (server, shares) and threshold and runs `Keys.fetch` once per group with the whole approval. Each answer covers every id (H6), so after the first group the next ones usually find their servers complete in the cache.

```ts
const layer = Seal.layer({ servers: [Config.testnet.mysten1, Config.testnet.mysten2, Config.testnet.committee] }).pipe(
  Layer.provideMerge(SuiGrpc.layer({ baseUrl })), Layer.provide(FetchHttpClient.layer))

const program = Effect.gen(function*() {
  const id = Bcs.encodeSync(Bcs.Address)(signer.address)                       // account_based: the id is the sender's address
  const { encryptedObject } = yield* Seal.encrypt({ packageId, id, data, threshold: 2 })
  const session = yield* Seal.session({ packageId, signer })                   // a key signer or a wallet signer
  const approval = yield* Approval.fromRecipe(Approval.call({ target: `${packageId}::account_based::seal_approve`, id }))
  return yield* Seal.decrypt({ data: encryptedObject, session, approval })     // one prompt, one round of requests
}).pipe(
  Effect.catchTag("ThresholdNotMet", (e) => e.reason === "denied" ? Effect.fail(new NotAllowed()) : Effect.fail(e)),
  Effect.provide(layer))
```

### 4.9 Errors

All in `Errors.ts` except `KeyServerError` (`KeyServerApi.ts`) and `InvalidEncoding` (`Bls.ts`), which `Errors.ts` re-exports.

```ts
export class ThresholdNotMet extends Schema.TaggedError<ThresholdNotMet>()("ThresholdNotMet", {
  /** insufficientWeight: the askable servers weigh less than the threshold; nothing was sent.
   *  denied: refusals of the request itself (`definitive` failures) explain the outcome on their own: they weigh the threshold,
   *  or what is left without them could not reach it.  unreachable: anything else (servers down, mixed failures). */
  reason: Schema.Literals(["insufficientWeight", "unreachable", "denied"]),
  threshold: Schema.Number,
  /** Weight obtained, cached keys included. */
  weight: Schema.Number,
  totalWeight: Schema.Number,
  /** Every server that failed for good, with its own typed error. */
  failures: Schema.Array(Schema.Struct({ weight: Schema.Number, error: KeyServerError })),
  /** Servers with no outcome when the call ended. */
  unsettled: Schema.Array(Schema.Struct({ server: Schema.String, weight: Schema.Number, started: Schema.Boolean }))
}) {
  /** Failed weight by kind, heaviest first: what `@mysten/seal` reduces to one "majority" error. */
  get kinds(): ReadonlyArray<readonly [KeyServerErrorKind, number]>
  /** e.g. "threshold 2 not met: 0 reached, denied by 2 (NoAccess), 1 unsettled (total 3)". No ids, no keys. */
  override get message(): string
}
```

`SessionKeyExpired { expiresAt, now }`, `InvalidSessionKey { reason }`, `SignatureRequired { message }` (the personal message to sign, base64), `InvalidApproval { reason }`, `ApprovalMismatch { reason }`, `NotFirstVersion { packageId, version }`, `InvalidCiphertext { reason }`, `DecryptionFailed { reason: "tag" | "mac" }`, `NotEnoughKeys { required, available }`, `InvalidEncryption { reason }`, `InvalidShares { reason }`, `CryptoUnavailable { message }`, `InvalidConfig { reason }`, `InvalidKeyServer { objectId, reason }`. From `@unconfirmed/sui`: `Signer.SigningError`, `Objects.ObjectNotFound`, `RpcError`, `Ptb.InvalidPureValue`, `SignatureScheme.VerifyError`.

No error carries key material, a session secret or an API key. `ThresholdNotMet` is serialisable as it stands (`KeyServerError` is a schema).

## 5. Quorum: what Seal uses, and the early stop

`Keys.fetch` is `Quorum.run` with the server's weight, `threshold − cachedWeight`, a per-member schedule and `while`. Success on the crossing answer, interruption of the rest, fail-fast when the threshold is unreachable, and the full failure set all come from the package. Seal never sets `linger`, `order` or `concurrency` (the member count is at most 255 and in practice under ten).

**Does Seal need the early stop that Walrus reads had to build (`walrus.md` §4.5, "As built (W5)")? Yes, for low thresholds.** `Quorum.run` fails only when failed weight exceeds `total − threshold`. With `t` close to `n` (2 of 3, 3 of 5) that happens as soon as it matters. With `2t ≤ total` (1 of 3, 2 of 4) a user who is simply not allowed gets `NoAccess` from the healthy servers in half a second and then waits for the slowest server to fail for good: one 10 s timeout at best. Live today two of ten testnet servers behave exactly like that (§0.1).

The condition that should end the wait: **failures that judge the request itself (`definitive`, §4.4) weigh at least `t`.** Seal's privacy assumption is that servers weighing less than `t` are compromised, so a set weighing `t` contains an honest server; honest servers evaluate the same policy on the same chain, so once one refuses, the others will. For `2t > total + 1` this rule never fires before "unreachable" does, so it changes nothing for high thresholds.

One refinement. Honest servers can disagree for a moment: fullnodes lag, and a user who has just bought access is the common case (`docs/content/UsingSeal.mdx`, "Limitations"). With `t = 1` a single lagging server's `NoAccess` would end a call that another server was about to satisfy. So the rule gets a short grace: after denials weigh `t`, keep going for `denialGrace` (default 2 s); a threshold reached in that window is a success. Healthy servers answer within it (0.35–1.2 s measured); a dead one no longer holds the answer for 10 s.

**Should it be a Quorum feature? Yes.** Two consumers now need "stop when failures matching a predicate weigh enough", and the Walrus version is a `Deferred` raced against the quorum, the kind of hand-rolled race the package exists to remove. `quorum.md` §3.7 rejected a give-up predicate on the grounds that "unreachable" coincides with what both consumers care about; W5 showed that false for Walrus, and the argument above shows it false for Seal. Proposed addition (work package Q3), `run` only:

```ts
export interface Options<M, A, E, R> extends Common<M, A, E, R> {
  // …
  /** Stop early on failures that make success pointless rather than impossible. */
  readonly giveUp?: {
    /** Which final failures count. */
    readonly when: (error: E, member: M) => boolean
    /** Fail once they weigh this much. */
    readonly weight: number
    /** Keep running this long after that point; reaching the threshold meanwhile still succeeds. Default: none. */
    readonly grace?: Duration.Input
  }
}
// QuorumFailed.reason: "insufficientWeight" | "unreachable" | "gaveUp"
```

Semantics: checked after every final failure (retries do not count until they are exhausted), after the success and unreachable checks. Without `grace` the call fails at once with `reason: "gaveUp"`. With it, the run continues unchanged until the threshold is reached (success), every member has settled, or the window (measured with `Clock`) ends; then `gaveUp`. `weight` not finite or `≤ 0`, or a negative or `NaN` grace, is a defect like the other argument checks. `Reached` and `QuorumFailed` are otherwise unchanged. In the engine this is one more branch in `run`'s `decide` plus the timer that `linger` already has. Walrus could then replace its tally with `giveUp: { when: notFoundOrBlocked, weight: 2f + 1 }` (not part of this work; its widening metadata window is a separate mechanism and stays).

Seal does not copy the quorum's reason: `ThresholdNotMet.reason` is derived from the failures (§4.7 step 6), so a denial reads the same whichever check ended the run. If Q3 is declined, `Keys.fetch` ships without it and the cost is bounded by the choices already made in §4.4: `Timeout` is not retried, so the worst case for a denied request under a low threshold is one `requestTimeout`.

## 6. Test plan

Conventions as in the other packages: `bun:test`; offline tests always run; `@mysten/seal` is a dev-only oracle loaded from its shipped build (`test/oracle.ts`, the pattern of `packages/walrus/test/oracle.ts`); time is `TestClock`; HTTP is a scripted `HttpClient` (`packages/walrus/test/support.ts` `scripted`).

`test/support.ts` provides: `seeded(seed)` (a deterministic `Entropy`), and `fakeKeyServers(servers)`: an in-memory world behind a scripted `HttpClient` in which each server has a real master key, an object id, a URL, optional API key, a policy function `(user, ids) => allow | error`, and `intercept` hooks (delay, hang, network error, status and body, wrong key, missing key). It implements H1–H10 with real crypto (`Ibe.extract`, `ElGamal.encrypt`), verifies the certificate text and both signatures the way R1–R4 say, resolves a package to a first version from a table (I1), and answers with the recorded bodies of `test/fixtures/key-server/`. It returns the scripted client and a list of servers shaped like `KeyServer.KeyServer`, ready for `KeyServer.layerFromServers`, so it depends on no chain code. `test/fixtures.ts` serves recorded chain objects as an `Objects` layer.

### 6.1 Unit (offline)

| File | Covers |
|---|---|
| `bls.test.ts` | C2 and C6 vectors; round trips; rejections (length, off-curve, infinity); `scalarFromBytes` refuses the group order and above, both endians; `pairingsEqual` agrees with two separate pairings on valid and invalid inputs. |
| `shamir.test.ts` | Field tables against a slow reference multiplication; C11 vector (23-byte secret, every 2-subset and all 3); property: any `t` of `n` shares recombine, `interpolate` reproduces every share; invalid inputs of `InvalidShares`; explicit coefficients give explicit shares. |
| `kdf.test.ts`, `ibe.test.ts`, `elgamal.test.ts` | C5/C6 vector; `deriveKey` purposes differ; encrypt/decrypt a share for one and several public keys; `verifyUserSecretKey` rejects another id, another server, a tweaked key; `decryptAllShares` equals per-server decryption; proof of possession round trip; ElGamal round trip. |
| `dem.test.ts` | AES-GCM and HMAC-CTR regression vectors (`dem.rs`); empty message and 1 MiB; `aad` absent equals empty; a flipped byte in blob, tag, mac or aad is `DecryptionFailed`; `Plain`; no `crypto.subtle` → `CryptoUnavailable` for AES only. |
| `encrypted-object.test.ts` | Parse the Rust vector (`lib.rs:685`) and re-serialise to the same bytes; each rule of I4 with a hand-made violation; `weights` with repeated servers; a 16 MiB blob round trips in under a second (BCS-as-Schema on a large `byteVector`, an unmeasured path today). |
| `envelope.test.ts` | Decrypt the Rust vector from its three master keys, with and without the consistency check; round trips for the three DEMs, thresholds 1, `n` and in between, repeated servers; every `t`-subset of keys opens, `t − 1` is `NotEnoughKeys`; a key for the wrong id is `InvalidCiphertext`; an object whose shares are not on one polynomial opens without the check and fails with it; little-endian `r` only with `legacyNonce`; limits (255 shares). |
| `config.test.ts`, `key-server.test.ts` | Every refusal of `Config.make`; decode recorded objects: V1 shared, V1 address-owned, V2 committee (testnet, mainnet), and synthesized V2 independent and V1+V2; version choice; every `InvalidKeyServer` reason; committee URL and API key come from configuration; cache: one read for concurrent `get`s, TTL and `refresh` under `TestClock`, failures not cached; `layerVerified` accepts the recorded live proofs (C17) and rejects a proof for another id. |
| `key-server-api.test.ts` | Request method, path, headers (exactly those of H3) and body for both endpoints; every row of the mapping in §4.4 from recorded bodies (`recorded.json`: `NoAccess`, `InvalidPTB` ×2, `InvalidPackage`, `InvalidCertificate`, `InvalidSignature`, `MissingRequiredHeader`, `InvalidSDKVersion`, `DeprecatedSDKVersion`, `InvalidSDKType`, the mainnet gateway's `401`, a load balancer's HTML `503`, the aggregator's text `400`; `synthesized.json` for `429`, `Failure`, `InvalidParameter`, `InvalidSessionSignature`, `InvalidMVRName`, `UnsupportedPackageId`, `InvalidServiceId`, built from `errors.rs`); timeout under `TestClock`; missing version header accepted, old version refused; an API key never appears in an error. |
| `session-key.test.ts` | R1 against both Rust vectors (hex id and MVR name); R4 against the Rust request vector; id normalisation (item 14); TTL bounds; `clockSkew`; expiry and the 10 s margin under `TestClock`; ten concurrent `certificate` calls prompt once; a rejected prompt is not remembered and the next call prompts again; key signer and wallet-shaped signer (`packages/sui-wallet/test/FakeWallet.ts`); a non-`SigningError` failure becomes `"unavailable"`; `withSignature`; `SignatureRequired`; `verify` with Ed25519 installed; export → JSON → import; importing an expired or malformed export. |
| `approval.test.ts` | Each rule of P1; `fromTransactionKindBytes` refuses full transaction bytes and a wrong tag; ids extracted in order; `fromRecipe` resolves an owned, a shared and the Clock input from recorded objects; a generated call builder as recipe. |
| `keys.test.ts` | With `fakeKeyServers` and `TestClock`: returns at the threshold and interrupts stragglers (virtual time asserted); weights; cached keys lower the threshold; everything cached → no request and no prompt; an expired session fails even when everything is cached (item 10); transient failures retried per server (`503` then `200`, `InvalidParameter` then `200`, `429`), `Timeout` and definitive errors not; a server returning a key for another id, or a key from another master key, is `InvalidKey` and the others are used (item 9); a missing id is `MissingKey`, never `undefined` (item 7); `ThresholdNotMet` lists every server's error and `kinds`, and its `reason` follows the table of cases in §4.7 step 6; `insufficientWeight` sends nothing; early stop: 1 of 3 with two `NoAccess` and one hung server fails at the grace, not at the timeout; a lagging denial followed by an approval inside the grace succeeds; 2 of 3 is unaffected; committee server: aggregator URL, API key header; an unloadable key server object is `Unresolved` and does not sink the fetch. |
| `seal.test.ts` | Encrypt then decrypt through the layer against `fakeKeyServers`; share order and multiplicity follow configuration; `NotFirstVersion`; `ApprovalMismatch` for another package and for an id the approval lacks; a second decrypt makes no request; `fetchKeys` over objects with two different server sets; `derivedKeys`; `checkShareConsistency` with an unconfigured committee server in the object (item 12). |

### 6.2 Parity with `@mysten/seal`

Byte for byte wherever both sides are deterministic.

- **Primitives.** `hashToG1`, `kdf`, `deriveKey`, GT bytes, `createFullId`, `verifyUserSecretKey` (valid and invalid), ElGamal decrypt, Shamir `combine` / `interpolate` on shares produced by the other side, both DEMs in both directions, over property-generated inputs.
- **BCS.** `EncryptedObject`, `KeyServerMove`, `KeyServerMoveV1`, `KeyServerMoveV2` (`seal/dist/bcs.mjs`): same bytes for the same value, and each side parses the other's output.
- **Encryption.** `seal/dist/encrypt.mjs` `encrypt()` is deterministic when called with an `encryptionInput` whose `generateKey` returns a chosen base key and with `crypto.getRandomValues` stubbed (verified). It draws, in order, `t − 1` bytes for each of the 32 secret bytes, then 48 bytes that noble maps to `r` with `mapHashToField`. The oracle records those draws; `Envelope.seal` with `Randomness { baseKey, coefficients: the 32 draws concatenated, r: Bls.scalarFromEntropy(the 48) }` must return the same bytes and the same key, for both DEMs, thresholds 1–5, repeated servers, with and without `aad`.
- **Decryption.** Objects from each side decrypt on the other; `checkShareConsistency` and `checkLEEncoding` agree on crafted objects.
- **Session.** For the same address, package, TTL and creation time: the personal message bytes; `toExported` of ours imports into `SessionKey.import` and the reverse.
- **Requests.** With `SessionKey.import` of a known session and the ElGamal draw stubbed, the JSON body captured from `SealClient`'s `fetch` option equals `KeyServerApi.requestBody` of the same request, and the headers match except `Request-Id`.
- **End to end.** `SealClient` (through its `fetch` option) and our layer against the same `fakeKeyServers` world: each decrypts the other's objects; the same key servers are loaded from the same recorded objects.
- **Live** (`SUI_LIVE=1`): `KeyServers.get` equals `SealClient.getKeyServers()` for the twelve objects of §0.1.

### 6.3 Live, without funds (`SUI_LIVE=1`)

Nothing here signs with the wallet or submits a transaction: users are fresh in-memory Ed25519 keys and the policies are Mysten's canary package (§0.1).

`live.chain.test.ts`: the twelve objects of §0.1 decode (ten V1, two committees); `layerVerified` passes for Mysten's two servers; the other independent servers are probed best effort (a warning, not a failure, when one is down); the testnet aggregator's `/v1/service` is `Rejected`; the mainnet aggregator's is `Unauthorized`.

`live.decrypt.test.ts`, servers `mysten1`, `mysten2` and the testnet committee unless stated:

1. `account_based`: encrypt to a fresh address with threshold 2 of 3, decrypt as that address; again with HMAC-CTR; again with `checkShareConsistency`.
2. The same object decrypts with `@mysten/seal`, and an object encrypted by `@mysten/seal` decrypts with ours.
3. Another address's id: `ThresholdNotMet`, `reason: "denied"`, every failure `NoAccess` with the abort in its message.
4. A second decrypt in the same session sends no request (counted at the `HttpClient`).
5. `tle` (`seal_approve(id, &Clock)`, id `bcs(u64 ms)`): a time in the past decrypts (a shared-object input, which the server's own clock check must coexist with, H8); a time in the future is denied.
6. Two ids in one approval (`tle` with two past times), `Seal.fetchKeys`, then both objects decrypt with no further request.
7. A wallet-shaped signer (`FakeWallet`) as the session's signer.
8. Availability: add a key server whose URL is replaced by an unroutable one (`layerFromServers`), threshold 2 of 4: decrypts; threshold 1 of 3 with a denied id and that server: fails within `denialGrace`, not `requestTimeout`.
9. Open mode: a request for `0x2::coin::seal_approve` comes back `InvalidPtb` from an independent server and from the aggregator (H9).

Budget: about 25 `fetch_key` requests per run, spaced to stay under Mysten's 10 per second (H11). Test timeout 60 s.

### 6.4 Live, with funds (`SEAL_LIVE=1` in addition to `SUI_LIVE=1`)

`live.owned.test.ts`. The signer is the Sui CLI's active address, loaded exactly as `packages/walrus/test/live.write.test.ts` does (`client.yaml` for the address, `PrivateKey.decodeKeystore` on `sui.keystore`, the scheme's `fromSecretKey`); any error while loading becomes one fixed message; the key is never printed, logged or written. The test reads the balance first and skips below 0.05 SUI.

1. `private_data::store_entry(nonce, data)` on the canary package creates an object owned by the wallet whose key id is `bcs(sender) ‖ nonce` (`move/patterns/sources/private_data.move:30-34`; the on-chain module has the same functions, but confirm the id format with the first run). Encrypt 32 bytes under that id, then at once decrypt with `private_data::seal_approve(id, &PrivateData)`: an owned-object input, the wallet's key signing the session's personal message, and, because the object is seconds old, the `InvalidParameter`-then-success path on servers whose fullnode lags.

Cost per run, simulated on testnet on 2026-11-27 with a 16-byte nonce and 32 bytes of data: computation 1,000,000 MIST and storage about 1,990,000. **About 0.003 SUI, not refundable**: the published canary predates `private_data::destroy` (it is in the repository's source, not in the on-chain module), so each run leaves one small object behind. The wallet's 1.1 SUI covers about 350 runs. The measured figures and digests go in the test file's header, as in the Walrus tests.

Not covered live: a policy package that has been upgraded (I1, P3), because no such package exists on testnet and publishing one is no longer cheap. **Publishing a package on testnet now costs about 1.045 SUI**: for a 1,138-byte module both the fullnode's simulation and `sui client publish --dry-run` (CLI 1.84.1) report computation 1,031,000,000 MIST and storage 13,436,800; devnet agrees; mainnet reports computation 1,000,000 for the same bytes, and testnet publishes from mid-2026 paid 1,000,000 (for example `5dbDEGeZ…`, 2026-07-28). A publish plus an upgrade would take about 2.1 SUI, twice the wallet. See open question 7.

### 6.5 Bundle report

Add to `scripts/bundle-report.ts`, for Bun, esbuild and Rolldown: "seal: parse an encrypted object" (expect no curve code), "seal: encrypt with pinned keys" (`Envelope.seal`; expect the Effect baseline plus about 80 KB of noble), "seal: encrypt + decrypt" (the layer, gRPC `Objects`, `FetchHttpClient`), and `@mysten/seal` with a `SuiGrpcClient` under Rolldown for comparison (esbuild today: 428 / 128 KB). Add the rows to the README table. Acceptance: the first program contains neither `bls12-381` nor `quorum`; the second contains neither `HttpClient` nor `quorum`.

## 7. Risks

1. **Third-party availability.** Two of ten testnet servers were down when probed. Live tests pin Mysten's two servers and the committee and treat the rest as best effort; applications should choose thresholds with this in mind.
2. **Pairing cost on the main thread.** About 7 ms per pairing (§1.8): encrypting to 10 shares blocks for 70 ms, verifying 20 ids from 3 servers for 380 ms. Fine for interactive use; a bulk job should batch ids per approval and, if needed, yield between verifications. No worker in v1.
3. **`@noble/curves` internals.** C6 depends on the layout of `Fp12.toBytes` and C2 on noble's default DST. Both are pinned by Rust vectors in the unit tests, so a noble upgrade that changes either fails offline.
4. **Server policy on SDK identity (H2).** We present as `typescript` 2.0.1. An operator may raise its minimum; `sdkVersion` is an option and the live tests are the tripwire.
5. **Protocol drift.** A `KeyServerV3`, a new DEM or IBE variant, or a new error name surfaces as `InvalidKeyServer`, `InvalidCiphertext` or `Rejected`/`Malformed` with the server's text, never as garbage. The parity suite follows `@mysten/seal` upgrades.
6. **Secrets in memory.** JavaScript cannot wipe memory reliably. The session secret, derived keys and DEM keys are kept out of errors, logs and spans and behind `Redacted` at the API boundary; that is the whole guarantee.

## 8. Work packages

One agent each. Files are under `packages/seal/` unless a path says otherwise.

| # | Scope | Depends on | Files | Acceptance |
|---|---|---|---|---|
| Q3 | `giveUp` for `Quorum.run` (§5); update `docs/design/quorum.md` §2, §3.2, §3.7, §10 and the README's Quorum section. | — | `packages/quorum/src/Quorum.ts`, `packages/quorum/test/run.test.ts`, `docs/design/quorum.md`, `README.md` | New tests under `TestClock`: fails at once without grace when matching failures reach the weight; non-matching failures do not count; a retrying member counts only when final; with grace, a threshold reached inside the window succeeds and the result's virtual time is asserted; the window ends in `gaveUp` at the exact time; "unreachable" still wins when it comes first; invalid `weight` or `grace` dies. Existing tests unchanged and green. Package size stays within 0.3 KB gzip of today's. |
| S1 | Scaffold and primitives: `Bls`, `Shamir`, `Kdf`, `Ibe`, `ElGamal`, `Dem`, `Entropy`. Also the declarations the later packages share, so that they can run in parallel: every error class of §4.9 in `Errors`, and in `KeyServerApi.ts` the types, `KeyServerError` with its two getters, and the service class (no `layer`, `requestBody` or `fromResponse` yet). | — | `package.json`, `tsconfig.json`, `src/{Bls,Shamir,Kdf,Ibe,ElGamal,Dem,Entropy,Errors,KeyServerApi,index}.ts`, `test/{bls,shamir,kdf,ibe,elgamal,dem}.test.ts`, `test/oracle.ts`, `test/support.ts` (`seeded`), `test/parity.primitives.test.ts`; root `package.json` devDependency | §6.1 rows for these modules and the "Primitives" parity bullet pass, including every Rust vector of §1.2; no service in any signature; only `Bls.ts` imports the curve; typecheck clean; no import from the `"effect"` barrel. |
| S2 | `EncryptedObject`, `Envelope`. | S1 | `src/{EncryptedObject,Envelope}.ts`, `test/{encrypted-object,envelope}.test.ts`, `test/parity.envelope.test.ts` | §6.1 rows; parity bullets "BCS" (encrypted object), "Encryption" (byte for byte under recorded randomness) and "Decryption"; the Rust TS-vector decrypts. |
| S3 | `Config`, `KeyServer` (BCS, `read`, `KeyServers` layers); a recorder for the objects of §0.1 and each reachable server's `/v1/service` answer. | S1 (`layerVerified` is written against S1's `KeyServerApi` class and tested with a stub) | `src/{Config,KeyServer}.ts`, `scripts/record-chain.ts`, `test/fixtures/{testnet,mainnet}.json`, `test/fixtures.ts`, `test/{config,key-server}.test.ts`, `test/live.chain.test.ts` | §6.1 rows; BCS parity for the three on-chain types; live: twelve objects decode and equal `@mysten/seal`'s view. |
| S4 | `KeyServerApi` (`layer`, `requestBody`, `fromResponse`); a recorder for error bodies (throwaway keys, as in §0); synthesized bodies; the fake key servers. | S1 | `src/KeyServerApi.ts`, `scripts/record-key-server.ts`, `test/key-server-api.test.ts`, `test/fixtures/key-server/{recorded,synthesized}.json`, `test/support.ts` (`fakeKeyServers`) | §6.1 row; every mapping row tested; `fakeKeyServers` round-trips a hand-built request (certificate and both signatures checked as R1–R4 say); live smoke (`SUI_LIVE=1`): `/v1/service` of one Mysten server. |
| S5 | `SessionKey` (including the per-session key cache that S6 fills), `Approval`. | S1 (declarations only) | `src/{SessionKey,Approval}.ts`, `test/{session-key,approval}.test.ts`, `test/parity.session.test.ts` | §6.1 rows including the Rust vectors of R1 and R4; "Session" parity bullet; one prompt for concurrent callers; `WalletSigner` from `@unconfirmed/sui-wallet` type-checks as a `MessageSigner` (a type test through the root devDependency; the package itself gains no dependency on `sui-wallet`). |
| S6 | `Keys`. | Q3, S3, S4, S5 | `src/Keys.ts`, `test/keys.test.ts` | §6.1 row, every case with virtual time asserted; the "Requests" parity bullet; only this file imports `@unconfirmed/quorum`. |
| S7 | `Seal` (encrypt, decrypt, `fetchKeys`, `derivedKeys`, `session`, layer); live tests; bundle report; README. | S2, S6 | `src/Seal.ts`, `test/seal.test.ts`, `test/parity.e2e.test.ts`, `test/live.decrypt.test.ts`, `test/live.owned.test.ts`, `scripts/bundle-report.ts`, `README.md` | §6.1 row; "End to end" parity; §6.3 passes on testnet; §6.4 passes once with `SEAL_LIVE=1` and its measured cost is recorded in the file header; bundle rows for three bundlers with the two containment checks of §6.5; README package row, a short section, and "Next:" updated. |

Order and parallelism:

```
Q3 ─────────────────────────┐
S1 ──┬─► S2 ───────────────┐│
     ├─► S3 ──┐            ││
     ├─► S4 ──┼─► S6 ◄─────┼┘
     └─► S5 ──┘     └──────┴─► S7
```

Q3 and S1 start together. After S1: S2, S3, S4 and S5 run in parallel (four agents). S6 needs S3–S5 and Q3; S7 needs S2 and S6. If Q3 is declined, S6 drops `giveUp` and its two early-stop tests and nothing else changes.

## 9. Open questions

1. **`giveUp` in Quorum (Q3).** *Recommendation: yes, with `grace`* (§5). It removes Walrus's hand-rolled tally as well, and without it a denied request under a low threshold waits for a dead server's timeout. Alternative: no change to Quorum and accept that wait (bounded at one `requestTimeout` because `Timeout` is not retried).
2. **What to send as `Client-Sdk-Type` / `Client-Sdk-Version`.** The aggregator refuses unknown types (H2), so a name of our own cannot reach committee servers. *Recommendation: `typescript` and `2.0.1`*, the version of the SDK whose wire protocol we match and test against, both overridable. Alternative: `rust` with our own version (accepted today at `>=0.0.0`, but it misreports the client in operators' metrics just the same).
3. **Backdating certificates.** A client clock even slightly ahead makes every server refuse the certificate (R2), and `@mysten/seal` reports that as an expired session. *Recommendation: `clockSkew` default 10 seconds* (the wallet prompt shows a time 10 s earlier; the session is usable for `ttl − 20 s`), `0` in parity tests.
4. **AES-GCM through WebCrypto, or `@noble/ciphers`?** *Recommendation: WebCrypto.* No bundle bytes, native speed on large payloads, and what the reference SDK does; the price is that `Envelope.seal` / `open` are Effects and that insecure browser contexts get `CryptoUnavailable` for AES. HMAC-CTR stays synchronous on noble.
5. **Randomness: our own `Context.Reference`, or `effect/crypto`'s `SecureRandom`?** *Recommendation: our own `Entropy` reference.* It needs nothing in `R` (a `SecureRandom` service would appear in every signature that encrypts or builds a request), and `effect/crypto` is marked unstable. A one-line bridge can be added if the repo adopts `SecureRandom` later.
6. **Hand-written BCS for the three on-chain key server types, or codegen?** *Recommendation: hand-written* (about 25 lines), against the Walrus rule. Key server objects come from at least five package deployments (K4), so generated type strings and a generated `Package` reference would be wrong for most of them, and there are no Move calls to generate. BCS parity with `@mysten/seal` and the live decode keep it honest.
7. **A policy package of our own on testnet.** Not needed for anything in §6.3–6.4, and it would cost about 1.045 SUI to publish, 2.1 SUI with the upgrade that is the one thing it would add (first-version namespace, I1 and P3, live). The wallet holds about 1.1 SUI. *Recommendation: do not publish; cover upgraded packages offline* (the fake servers resolve a package to its first version the way `common.rs` does), and revisit if the wallet is funded or the publish price returns to normal. If you do want it, the package is five `entry` functions (`seal_approve` by sender, by sender prefix, by allowlist object, by clock, and one that always aborts) and I have it building.
8. **Asking servers that the ciphertext names but the client does not configure.** *Recommendation: never in v1* (§4.8 step 3): the URLs would come from attacker-creatable objects (request forgery from a server-side app) and each request discloses who is asking for what. Their public keys are still read from chain for the consistency check.
9. **Sharing identical in-flight fetches.** Two concurrent `decrypt` calls for the same id both send requests (the wallet is still prompted once). *Recommendation: not in v1*; `Seal.fetchKeys` first is the documented way to batch. A `Cache` keyed by the request could be added later without an API change.
10. **`Plain` mode.** *Recommendation: support it in `Dem` and `Envelope` (Rust and `seal-cli` have it), do not offer it in `Seal.encrypt`.* Note that unverified keys in `Plain` mode yield a wrong key silently, which is why `Envelope.open` documents the assumption.
11. **Should the session be a scoped resource (as `EXPLORATION.md` §6 suggests)?** *Recommendation: a plain value.* The cache needs no scope, and wiping a `Uint8Array` on scope close is not a guarantee worth an extra `Scope` in every caller's `R` (risk 6). `Keys.forget` drops the derived keys on demand.
12. **A core type for personal-message signers.** `MessageSigner` (§4.5) is structural so that Seal does not depend on `sui-wallet`. *Recommendation: keep it in Seal for now*; if Enoki or another package needs the same shape, move it to `@unconfirmed/sui/Signer` as `PersonalMessageSigner`.
13. **Proof-of-possession verification by default?** *Recommendation: off* (`layerVerified` opts in), as the reference SDK since 1.3.0. It adds a request per server and protects only applications that take key server ids from users; derived keys are verified against the on-chain public key regardless.
14. **Left out of v1:** MVR name resolution or validation on the client (the server validates), building the on-chain decryption transaction (`bf_hmac_encryption`; `Seal.derivedKeys` supplies its inputs), key-server registration and committee operations, a worker for pairings, streaming DEMs for large payloads (use envelope encryption: seal a symmetric key). *Recommendation: leave out.*
