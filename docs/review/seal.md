# Review: `packages/seal`

Reviewed 2026-11-27 against `docs/design/seal.md` (all "As built" notes), `@mysten/seal` 2.0.1 and Effect 4.1.6. Baseline: `bun test` in `packages/seal` is green (287 pass, 16 skipped live). Repro scripts and bundle probes are in `/tmp/claude-1001/-home-bl-misofm-effect-sdks/6c25a9ae-c121-4d02-bd1d-8bf08feb66d3/scratchpad/review-seal/` (`keys.repro.test.ts`, `crypto.repro.test.ts`, `seal.repro.test.ts`, `memo.bench.test.ts`, `scrub.ts`, `bundle.ts`, `three.ts`).

## Summary

No defect was found in the cryptographic core. The findings are one denial-of-service hole in key verification, one misleading bundle measurement (the known item), one wrong `ThresholdNotMet.reason`, and a set of low-severity robustness, performance and hygiene items.

- **Counts:** 0 high, 2 medium, 7 low, 6 nit.
- **Known bundle item, resolved:** the extra weight is not Seal. The measured program (and the README example) provides `SuiGrpc.layer`, which ships every gRPC capability. Seal needs only `Objects` and `Packages`. With those two layers the same program is 380–386 KB minified and 128–133 KB gzip, which is 85–89 KB (7–8 KB gzip) smaller than `@mysten/seal` + `SuiGrpcClient` (SEAL-2).

Checked and found sound (no finding):

- **BLS12-381 decoding.** Bad length, off-curve, wrong subgroup (three on-curve points outside G1 tried) and infinity are all rejected.
- **Scalar range.** `scalarFromBytes` is canonical-only in both endians; `r = 0` can never match a finite nonce.
- **GT layout and KDF domain separation.** Pinned by the Rust vectors in the unit tests.
- **DEMs.** The MAC is checked before decryption with a constant-time compare; an absent `aad` reads as empty; the AES IV and key handling match the reference.
- **`EncryptedObject.parse`.** Hostile ULEB lengths (2³²−1, overflow) return `InvalidCiphertext` in under 1 ms with no large allocation.
- **Sessions.** The cache refuses reads of an expired session before touching anything; export and import keep the secret in `Redacted`.
- **One prompt.** Effect 4.1.6's `cachedWithTTL` and `Cache` count awaiters, so an interrupted first caller does not interrupt the others.
- **Server selection.** `Seal.decrypt` asks only servers that the object names and the configuration lists, weighted by the object's share counts.
- **HTTP.** Effect's `HttpClient` aborts a response whose body read is interrupted (our timeout) and releases one that is never read.
- **Test stability.** `keys.test.ts`, which steps a virtual clock between real macrotasks, passed 72 of 72 runs started at once on 32 cores.

## Findings

### SEAL-1: a key server can block the event loop with duplicate keys
medium · security · CONFIRMED · `packages/seal/src/Keys.ts:307-317`, `packages/seal/src/KeyServerApi.ts:229-244`

**What is wrong.** `Keys.verify` verifies every entry of an answer whose id was asked for, duplicates included (design §4.7 "As built (S6)": "Duplicate entries for one id are each verified"). Nothing caps the number of entries or the body size. Verification is a synchronous loop that runs after `KeyServerApi.fetchKey` returns, so `requestTimeout` does not cover it and no fiber can interrupt it.

**Failure scenario.** One configured server (weight below the threshold) answers a one-id request with the same valid entry repeated. Measured with the fake servers: 200 entries (37 KB body) take 2.9 s; 1,000 entries (186 KB) take 14.0 s, during which nothing else runs (the other servers' answers, timers, the UI). A 20 MB body would block for about 25 minutes. A single server can therefore stall a decryption that the threshold model says it cannot affect.

**Fix.** In `verify`, skip an id that is already verified (the first entry decides). Also treat `answer.length > approval.ids.length` as `Malformed`, since H6 guarantees one entry per command (at most 100). Consider a response size cap in `KeyServerApi`.

**Effort.** S.

**Resolution.** Fixed. `Keys.verify` refuses an answer with more entries than the approval has commands (`Malformed`, before decoding anything), lets the first entry per id decide and skips later copies undecoded, checks one server's keys with one batched pairing (SEAL-9), and yields between keys. `KeyServerApi` gained `maxResponseBytes` (default 1 MiB; `Content-Length` and the body read). So verification is bounded by the request (≤ 100 distinct ids), whatever the server sends. Regression tests in `keys.test.ts`: 1,000 copies of a valid entry fail as `Malformed` at once (was ~14 s), a garbage duplicate within the command count is skipped, a wrong key among several is caught; `key-server-api.test.ts`: oversized body.

### SEAL-2: the Seal bundle row and README example ship every Sui RPC
medium · bundle · CONFIRMED · `scripts/bundle-report.ts:112-127`, `README.md:146-149`, `README.md:397`, `README.md:400`, `docs/design/seal.md` §6.5

**What is wrong.** The "seal: encrypt + decrypt" program and the README example use `SuiGrpc.layer(...)`. That layer merges all nine capability layers, so `packages/sui/src/grpc/generated/rpc.ts` contributes 104.9 KB of the 481 KB esbuild output. Seal's facade needs `Objects` only; `Approval.fromRecipe` adds `Packages`. With those two, `rpc.ts` contributes 15.7 KB.

**Measurement** (KB minified / gzip; Bun, esbuild, Rolldown):

| Program | Bun | esbuild | Rolldown |
|---|---|---|---|
| Ours as reported (`SuiGrpc.layer`) | 486.7 / 149.9 | 481.1 / 149.7 | 490.2 / 144.7 |
| `@mysten/seal` + `SuiGrpcClient` | 471.0 / 141.1 | 468.7 / 141.2 | 470.2 / 135.5 |
| Ours with `ObjectsGrpc.layer` + `PackagesGrpc.layer` | 385.1 / 133.3 | 379.8 / 133.1 | 385.7 / 128.4 |
| Same with `Approval.fromRecipeOffline` (no `Packages`) | 378.2 / 131.0 | 373.0 / 130.9 | 379.0 / 126.4 |

The two-layer program type-checks with the same requirements as the original (`three.ts`, `probe/v1_min_layers.ts`).

**Fix.** In the bundle report and the README example, compose `Layer.mergeAll(ObjectsGrpc.layer, PackagesGrpc.layer).pipe(Layer.provide(GrpcWeb.layer({ baseUrl })))`. Update the README row and the sentence "20 KB larger than `@mysten/seal`", and design §6.5.

**Effort.** S.

**Resolution.** Fixed. New `SealGrpc` module: `SealGrpc.layer({ ...SealOptions, grpc: { baseUrl } })` = `Seal.layer` + `ObjectsGrpc.layer` + `PackagesGrpc.layer` over `GrpcWeb` (`SealGrpc.chain` for the two alone). The bundle-report program and the README example use it; `packages/sui` is untouched. Re-measured (KB min / gzip; Bun, esbuild, Rolldown): 388.9/134.8, 383.6/134.6, 389.6/129.8 vs `@mysten/seal` + `SuiGrpcClient` 471.0/141.1, 468.7/141.2, 470.2/135.5, i.e. 80–85 KB (6–7 KB gzip) smaller. README rows and sentence, design §4.8 and §6.5 updated. (About 4 KB above the reviewer's two-layer probe: the spans, `Retry-After` and size checks added below.)

**Resolution (core bundle):** separately, core descriptor pruning took the `SuiGrpc.layer` Seal program from 486.0 to 435.5 KB (Bun, comments stripped); with `SealGrpc.layer` the program uses only the Objects and Packages services.

### SEAL-3: `ThresholdNotMet.reason` is `unreachable` instead of `denied` when some keys are cached
low · correctness · CONFIRMED · `packages/seal/src/Keys.ts:135-143`, `packages/seal/src/Keys.ts:277`

**What is wrong.** `reasonOf` tests `askableWeight - denied < threshold - cachedWeight`, but the caller passes `totalWeight`, which already includes the cached servers. The cached weight is subtracted on one side only, so the "what is left without the denials could not reach it" branch under-fires whenever `cachedWeight > 0`.

**Failure scenario.** Three servers of weight 1, threshold 3. A's key is cached from an earlier fetch, B answers `NoAccess`, C is fine. The result is `reason: "unreachable"` ("failed 1 (NoAccess)"). The same situation with nothing cached gives `"denied"`. An application that maps `denied` to "not allowed" shows "servers down" instead. Reproduced in `keys.repro.test.ts`.

**Fix.** Pass `totalWeight - cachedWeight`, or simplify the test to `denied >= threshold || totalWeight - denied < threshold`. Add the case to the reason table in `keys.test.ts`.

**Effort.** S.

**Resolution.** Fixed as suggested: `denied` when `d ≥ threshold || totalWeight − d < threshold` (cached weight counted once). Test: cached A, denying B, healthy C at 3 of 3 is now `denied`.

### SEAL-4: `Request-Id` is drawn eagerly from `crypto.randomUUID()`
low · correctness · CONFIRMED · `packages/seal/src/KeyServerApi.ts:303`, `packages/seal/src/Keys.ts:247-249`

**What is wrong.** `call` runs `crypto.randomUUID()` when `fetchKey` or `service` is called, not when the effect runs. `crypto.randomUUID` exists only in secure contexts, so on a page not served over HTTPS (where the design promises that HMAC-CTR "still works") the call throws synchronously. Consequences:

- In `Keys.ask` the throw becomes a defect, which is mapped to a *retryable* `Unavailable`. Every server is retried three times and the call ends as `ThresholdNotMet` "unreachable".
- In `KeyServer.verify` (`layerVerified`) the throw is an uncaught defect.
- Separately, a caller who retries the effect that `fetchKey` returned reuses one `Request-Id` for every attempt.

**Failure scenario.** With `crypto.randomUUID` removed, a two-server fetch ends after 1.77 s with two failures reading `Unavailable: unexpected defect: TypeError: crypto.randomUUID is not a function`.

**Fix.** Wrap `call` in `Effect.suspend`, and build the UUID from 16 bytes of `Entropy` (which also makes it deterministic in tests). Do not map defects to a retryable kind.

**Effort.** S.

**Resolution.** Fixed. The `Request-Id` is a v4 UUID built from 16 bytes of `Entropy` inside the effect: no `crypto.randomUUID` needed, deterministic in tests, a new id for each run of the same effect. A runtime with no random source at all gets a typed `KeyServerError` ("no random source"), not a defect. Defects inside a `Keys` member are still reported as `Unavailable` (so they cannot sink the quorum) but are no longer retried. Tests: fetch without `crypto.randomUUID`, Request-Id per run, throwing `Entropy`, a defect not retried.

### SEAL-5: one pairing and one G2 decode per share, not per server
low · performance · CONFIRMED · `packages/seal/src/Ibe.ts:51`, `:64-65`, `:81`, `packages/seal/src/Envelope.ts:105`, `:193`, `:218`

**What is wrong.** For a server of weight `w`:

- `encryptShares` and `decryptAllShares` compute `e(gid·r, pk)` `w` times.
- `Envelope.prepare` and the consistency check decode the same 96-byte key `w` times (3.3 ms each).
- `decryptShare` recomputes both `e(usk, nonce)` and `Kdf.gid(fullId)` (1.2 ms hash-to-curve) for every share.

`@mysten/seal` does the same, so this is headroom rather than a regression.

**Measurement.** A scratch clone that memoises per server produces identical bytes (`memo.bench.test.ts`):

| Case | `seal` | `open` | `open` + consistency |
|---|---|---|---|
| 3 servers × weight 5, t = 10 | 137 → 33 ms | 97 → 21 ms | 208 → 48 ms |
| 2 × weight 2 + 1, t = 3 | 46 → 31 ms | 30 → 22 ms | 77 → 51 ms |

Unweighted objects are unchanged.

**Fix.** Memoise the GT bytes by public key in `Ibe`, decode each distinct public key once in `Envelope`, and compute `gid` once per `open`.

**Effort.** S.

**Resolution.** Fixed. `Envelope` decodes each distinct public key once; `Ibe.encryptShares` / `decryptAllShares` pair each distinct point once; `open` does `Ibe.decap` once per server and `Ibe.unmask` per share, with `gid` once. Bytes unchanged: all parity tests pass. Measured on bun (before → after): 3 × weight 5, t = 10: `seal` 127 → 31 ms, `open` 89 → 19 ms, `open` + consistency 230 → 49 ms; 2 × weight 2 + 1, t = 3: 40 → 30, 26 → 18, 66 → 52 ms; unweighted unchanged. `Ibe.decap` / `unmask` exported and tested against `decryptShare`.

### SEAL-6: `layerVerified` turns a transient `/v1/service` failure into a permanent one
low · correctness · CONFIRMED · `packages/seal/src/KeyServer.ts:294-312`, `:342-345`, `:371-380`, `packages/seal/src/Keys.ts:230-236`

**What is wrong.**

- A failed proof-of-possession request becomes `InvalidKeyServer`. `Seal.encrypt` then fails outright, although it needs only the on-chain key.
- `Keys.ask` maps `InvalidKeyServer` to `Unresolved`, which is not retryable. The same 503 from `fetch_key` would be retried.
- The proof is requested again on every cache load (every `ttl`, 10 minutes), although it covers only `(pk, objectId)`, neither of which can change (K3).

**Failure scenario.** One 503 from `/v1/service` of one configured server: `Seal.encrypt` fails with `InvalidKeyServer` (reproduced in `seal.repro.test.ts`). A decrypt in the same window counts that server as lost without a retry.

**Fix.** Remember a verified `(objectId, publicKey)` for the life of the layer. Map a retryable `KeyServerError` from the proof request to something `Keys` retries (keep the kind, or use `RpcError`-like retryability).

**Effort.** S–M.

**Resolution.** Fixed. `layerVerified` remembers each verified `(object id, public key)` for the layer's life (TTL reloads and `refresh` re-read the chain but do not re-ask `/v1/service`). A failed proof request is `InvalidKeyServer` with the request's `kind` and a `retryable` getter; `Keys.fetch` maps a retryable one to a `KeyServerError` of that kind and retries it. `Seal.encrypt` still fails on it (the layer promises verified keys), now with a typed, retryable error. Tests in `key-server.test.ts` and `seal.test.ts` (decrypt retries past a transient 503).

### SEAL-7: an API key can still reach an error or a span
low · security · CONFIRMED (first item), PLAUSIBLE (second) · `packages/seal/src/KeyServerApi.ts:201-210`, `:315-322`

**What is wrong.**

1. `fromResponse` scrubs `message` but copies the body's `error` field verbatim. `{"error":"invalid key SECRET"}` yields `KeyServerError.error = "invalid key SECRET"` (`scrub.ts`), which contradicts "never contains an API key" (§4.4 "As built").
2. The key is sent as a plain header under a caller-chosen name. Effect's `HttpClient` writes request headers to span attributes when `TracerHeaderFilter` admits them, and redacts only `authorization`, `cookie`, `set-cookie` and `x-api-key`. An application that traces headers records a key sent under any other name.

Also, `message` from a JSON body is unbounded (a 2 MB message is kept whole); only the non-JSON fallback is cut at 500 characters.

**Fix.** Scrub `error` as well and cap `message`. Provide `Headers.CurrentRedactedNames` extended with `apiKey.name` around `http.execute`.

**Effort.** S.

**Resolution.** Fixed. `error` is scrubbed like `message`, and both are scrubbed before they are cut (`error` 100, JSON `message` 2000, other bodies 500 characters), so a cut cannot leave half a key. Requests run with `Headers.CurrentRedactedNames` extended by the API key's header name. Tests: echoed key in `error`, a key straddling the cut, a 2 MB message, and a tracer with `TracerHeaderFilter` recording `<redacted>` for a custom header name.

### SEAL-8: cold paths make sequential round trips that could be one batch
low · performance · CONFIRMED (from code) · `packages/seal/src/KeyServer.ts:228-239`, `packages/seal/src/Seal.ts:173-176`

**What is wrong.** `KeyServer.read` gets the object, then the versioned field, although both field ids (`fieldId(id, 2)`, `fieldId(id, 1)`) are derivable before the first read. `Seal.encrypt` awaits `checkFirstVersion` before loading servers. A first `encrypt` is therefore three sequential batches (package, objects, fields). The first key request to each server waits for two.

**Fix.** In `read`, request the object and both candidate fields together (one batch through the batched `Objects.get`; a missing field is just absent), then choose. In `encrypt`, run the package check and the server loads concurrently. That makes the cold path one round trip instead of three.

**Effort.** M.

**Resolution.** Fixed. `KeyServer.read` requests the object and both candidate fields in one batch and then chooses; `Seal.encrypt` runs the package check and the server loads concurrently, so a cold `encrypt` is one round trip. (The read test now expects the three ids, each read once.)

### SEAL-9: key verification costs about 14 ms per (server, id)
low · performance · CONFIRMED (measured) · `packages/seal/src/Keys.ts:296-322`, `packages/seal/src/Ibe.ts:86-88`

**What is wrong.** The design budgets 6.4 ms per key. Measured per key on this machine:

| Step | Cost |
|---|---|
| `pairingsEqual` | 8.0 ms |
| `g2FromBytes(server.publicKey)`, per server per fetch | 3.3 ms |
| `ElGamal.decrypt` | 2.1 ms |
| `Kdf.gid` | 1.2 ms |

`gid` is recomputed for every server although it depends only on the id, and the server key is decoded again on every fetch.

**Fix.** Compute `gid` once per full id before the quorum and pass it in. Keep the decoded G2 point with the cached `KeyServer`. For approvals with many ids, verify one server's `k` keys with a single randomised check, `e(Σ ρᵢ·uskᵢ, G2) = e(Σ ρᵢ·gidᵢ, pk)`. From the measured costs this is roughly 8 + 1.5·k ms instead of 9·k ms (not prototyped).

**Effort.** S for the first two, M for the batch.

**Resolution.** Improved, and the doc's budget corrected. `gid` is computed once per full id per fetch, the decoded G2 key is kept with the cached `KeyServer` value, and one server's keys are checked with the randomised batch `e(Σ ρᵢ·uskᵢ, G2) = e(Σ ρᵢ·gidᵢ, pk)` (128-bit `ρᵢ` from `Entropy`; `Ibe.verifyDerivedKeys`, tested against per-key checks). Measured per (server, id), stubbed API, fixed per-fetch costs included: 3 servers × 1 id 19 → 15 ms, 1 × 10 ids 14 → 7.2 ms, 3 × 10 ids 13 → 5.9 ms. A single key alone still costs ~10–11 ms (one pairing check is 8–9 ms here, plus `ElGamal.decrypt`), so §1.8/§4.7's 6.4 ms was unreachable for one key; the design now says ~10 ms for one key and `9 + 3k` ms for `k` keys of one server.

### SEAL-10: a hand-built object with a non-integer threshold is a defect in `Seal.decrypt`
nit · correctness · CONFIRMED · `packages/seal/src/EncryptedObject.ts:94`

**What is wrong.** `validate` checks `threshold < 1 || threshold > n` but not that it is an integer. `{ ...object, threshold: 1.5 }` passes, `Envelope.open` succeeds (it behaves as 1), and `Seal.decrypt` dies with `Keys.fetch: threshold must be a positive integer`.

**Fix.** Add `Number.isInteger(object.threshold)` to `validate`.

**Effort.** S.

**Resolution.** Fixed: `EncryptedObject.validate` requires `Number.isInteger(threshold)`; `Seal.decrypt` of such an object is `InvalidCiphertext`. Tests in `encrypted-object.test.ts` and `seal.test.ts`.

### SEAL-11: configuration and session inputs that are accepted but cannot work
nit · api · CONFIRMED · `packages/seal/src/Config.ts:64-73`, `:106-113`, `packages/seal/src/SessionKey.ts:293-298`

- An `aggregatorUrl` with a query or fragment is accepted. Requests then go to `https://agg/base?token=abc/v1/fetch_key`.
- An `apiKey` containing CR or LF is accepted. `fetch` throws on the header, which surfaces as a retried `Unavailable`.
- `apiKeyName` may be `Content-Type` or `Client-Sdk-Version`, silently replacing a protocol header.
- `SessionKey.make({ ttl: "1 minute", clockSkew: "50 seconds" })` returns a session that is already expired; it fails only on first use.

**Fix.** Refuse each in `Config.make` and `SessionKey.make`.

**Effort.** S.

**Resolution.** Fixed. `Config.make` refuses an aggregator URL with `?` or `#`, an API key value that is not a valid header value (CR, LF, NUL, edge whitespace), and an API key name the protocol sets itself (`Content-Type`, `Content-Length`, `Request-Id`, `Client-Sdk-Type`, `Client-Sdk-Version`, `Host`, `Connection`, `Transfer-Encoding`; any case). `SessionKey.make` refuses `clockSkew + 10 s ≥ ttl`. Tests in `config.test.ts` and `session-key.test.ts`.

### SEAL-12: `Envelope.Randomness` does not say it must never be reused
nit · docs · CONFIRMED (from code) · `packages/seal/src/Envelope.ts:42-49`, `:58`

**What is wrong.** The DEM key is a function of `(baseKey, r, id, recipients, threshold)`. Sealing two payloads with the same `Randomness` and the same id and recipients reuses the AES-GCM key under the fixed IV, or the HMAC-CTR keystream. `seal` takes the randomness as an argument (needed for parity tests), but neither the interface nor `seal` warns about reuse.

**Fix.** One sentence on `Randomness` and `seal`: draw a fresh value with `Envelope.randomness` for every call.

**Effort.** S.

**Resolution.** Fixed: `Randomness` and `seal` say a randomness must never be reused and to draw a fresh one with `Envelope.randomness` per call.

### SEAL-13: duplicated id validation with different strictness, duplicated helpers, a dead check
nit · simplification · CONFIRMED

- **Six id patterns.** `Config.normalizeObjectId` (`0x` optional), `SessionKey.normalizeId`, `Seal.strictId`, `EncryptedObject.ADDRESS`, `Envelope.ADDRESS` and `KeyServerApi.isAddress`. As a result `Config.make` and `Keys.fetch` accept an id without `0x`, while `Seal.encrypt({ servers })` and sessions refuse it.
- **Duplicated helpers.** `concat` (Kdf, Dem), `xor` (Ibe, Envelope), `utf8` (Kdf, Dem), and `hexOf` in SessionKey next to noble's `bytesToHex`.
- **Dead check.** The cache owner test at `SessionKey.ts:515-517` can never fail: every `CacheState` is built with the session's own address and package.

**Fix.** One internal `ids.ts` and `bytes.ts`; drop the dead branch.

**Effort.** S.

**Resolution.** Fixed. Internal `ids.ts` (`strictId`, `normalizeObjectId`, `isCanonical`) and `bytes.ts` (`concat`, `xor`, `utf8`) replace the six patterns and the duplicated helpers; `hexOf` is gone (`bytesToHex`). The rule is now one per kind of id: package and user ids strict (`0x` required, they are signed), key server ids lenient (`0x` optional) everywhere, which changes only `Seal.encrypt({ servers })` (it now accepts what `Config` accepts). README "Strict ids" updated. The dead owner check and `CacheState`'s owner fields are removed.

### SEAL-14: only `KeyServerApi` has spans; no `Effect.fn`
nit · api · CONFIRMED · `packages/seal/src/Seal.ts`, `Keys.ts`, `KeyServer.ts`

**What is wrong.** `Seal.encrypt`, `decrypt`, `fetchKeys`, `Keys.fetch` and `KeyServer.read` have no span, so a trace shows the quorum and HTTP spans without the operation that caused them. `packages/sui` has 11 `withSpan` and 4 `Effect.fn`; Seal has one `withSpan`.

**Fix.** `Effect.fn("Seal.decrypt")` and the like on the public effects. Put no ids of secrets in attributes; the server count and threshold are enough.

**Effort.** S.

**Resolution.** Fixed with `Effect.withSpan` (not `Effect.fn`, to avoid bundle weight): `Seal.encrypt`, `Seal.decrypt`, `Seal.fetchKeys`, `Seal.derivedKeys`, `Keys.fetch`, `KeyServer.read`. Attributes are counts and thresholds only.

### SEAL-15: smaller robustness gaps in key requests
nit · correctness · PLAUSIBLE · `packages/seal/src/KeyServerApi.ts:313-349`, `packages/seal/src/Keys.ts:230-245`

- A response body is read whole, bounded only by the 10 s timeout (see SEAL-1 for the cap).
- A `429` is retried on the fixed 250 ms schedule; `Retry-After` is ignored.
- When an independent server's URL changes on chain (K3), requests fail as `Unavailable` until the 10-minute TTL ends. `Keys.ask` could call `KeyServers.refresh` once after a transport failure with no HTTP answer.

**Effort.** S each.

**Resolution.** Fixed. Body size: `maxResponseBytes` (SEAL-1). `Retry-After` on a `429`/`503` is parsed (seconds or HTTP date, capped at an hour) into `KeyServerError.retryAfter`, and `Keys.defaultRetry` waits at least that long (capped at 10 s, `Keys.MAX_RETRY_AFTER`). A transport failure with no HTTP answer makes `Keys` reload the server once per fetch (`KeyServers.refresh`) and, if its URL changed, ask the new URL at once. Tests for each in `keys.test.ts` and `key-server-api.test.ts`.

## Test gaps

- Duplicate or oversized `decryption_keys` (SEAL-1).
- `reason` with `cachedWeight > 0` (SEAL-3).
- No `crypto.randomUUID` (SEAL-4).
- A weighted-server benchmark (SEAL-5).
- A transient `/v1/service` failure under `layerVerified` (SEAL-6).
- An API key echoed in the body's `error` field (SEAL-7).
- A hand-built non-integer threshold (SEAL-10).

## Optimizations (measured)

**Bundle, encrypt + decrypt, esbuild minified, with the two-layer program (379.8 KB):**

| Part | KB |
|---|---|
| Effect (core 118, Schema 47.5, http 21.8, Stream 8) | 195 |
| noble + scure (BLS12-381 43, other curves 32, hashes 23, scure 5) | 103 |
| `seal` (`@mysten/seal` is 29.4) | 37.3 |
| `sui/grpc` (`rpc.ts` 15.7) | 21.3 |
| sui core | 11.6 |
| bcs | 5.9 |
| quorum | 4.7 |

- Seal adds 14 KB of Effect beyond "read one object" (SchemaAST 3.1, `Cache` 1.9, `Schedule` 2.1, `Duration` 1.7), all of it used.
- `@noble/curves` and `@noble/hashes` resolve to one copy (2.4.0), the same weight as in Mysten's bundle.
- Swapping `@scure/base`'s `base64` in `KeyServerApi` and `SessionKey` for `effect/encoding/Base64` (already bundled through `HttpClientRequest`) saves 1.7 KB minified, 0.6 KB gzip (measured in a clone). `@scure/base` stays for sui core's bech32 and base58.
- `@noble/curves/abstract/bls.js` (7.7 KB, the signature API) is unused but not tree-shakeable.
- Nothing else in `packages/seal` is worth cutting; the 100 KB is SEAL-2.

**Runtime:**

- Weighted servers: 4× faster `seal` and `open` (SEAL-5).
- Key verification: about 14 ms per (server, id) today; `gid` reuse saves 1.2 ms per extra server, a cached G2 point 3.3 ms per server per fetch, batch verification most of the pairing cost for many ids (SEAL-9).
- Cold encrypt: three round trips to one (SEAL-8).
