# Review: `packages/quorum` and `packages/walrus`

Reviewed 2026-11-27 against `docs/design/quorum.md`, `docs/design/walrus.md` (all "As built" notes), `@mysten/walrus` 2.0.1 and the Walrus Rust repo at `2bd352b6`. `src/generated` was not reviewed line by line. Offline suites pass (quorum 51, walrus 326 + 14 skipped). Scratch scripts and probes are under the session scratchpad, `review-walrus/` (`q/`, `dyn/`, `probe/`, `bundle/`).

## Summary

The Quorum engine holds up: threshold, unreachable, `giveUp` with grace, linger, interruption (also inside an uninterruptible caller), retries holding slots, ordering and defects all behave as designed; I found two small information-loss/doc issues and no correctness bug. Walrus reads and certificate handling are sound (metadata, sliver blame, signer weight, message and signature checks all verified by reading and by the existing tests).

The real problems are at the edges of the write path and in defaults:

- 1 high: the relay tip is unbounded unless the caller sets `maxTip`.
- 5 medium: `owner` other than the sender makes certify impossible after the registration is paid; `System` state is cached forever so register breaks after a price change; the live "recent blob" tests pick blobs that testnet bots delete seconds later; the WASM blocks the thread 2.6 s per call (4.9 s back to back in a strict read); fixed timeouts include the upload body.
- 8 low, 6 nit.

Counts: high 1, medium 5, low 8, nit 6.

## Findings

### WAL-1 · high · security · CONFIRMED
`packages/walrus/src/UploadRelay.ts:140`, `:306`

**What.** `maxTip` is optional and its default is "no limit". `authAndTipWith` takes the tip amount and the tip address from the relay's `/v1/tip-config` answer and adds `Ptb.coin({ amount: tip })` + `transferObjects` to the register transaction. With a key signer nothing else bounds it.

**Scenario.** `UploadRelay.layer({ host })` without `maxTip`, `Write.run(..., { via: "relay", executor: Write.viaTx(key) })`. The relay (or whoever controls its endpoint) answers `{"send_tip":{"address":"0xattacker","kind":{"const":900000000000}}}`: the write signs and sends 900 SUI, or the whole balance if a linear tip is tuned to it. The module header says the relay "is trusted with availability only"; this is the exception. `@mysten/walrus` does not allow it: an automatic tip needs `sendTip: { max }` (`types.d.mts:46-48`, `client.mjs:582`).

**Fix.** Make `maxTip` required in `UploadRelayOptions` (or default it to a small constant such as 0.01 SUI and document it). **Effort S.**

**Resolution.** Fixed. `UploadRelayOptions.maxTip` is required (an untyped caller without it gets `0n`, so any tip is `TipTooHigh`); new optional `tipAddress` pins the recipient and a tip config naming another address is a `RelayError` before anything is signed. (The address used is always the one the tip config declares, so pinning is the only check possible.) Tests in `relay.test.ts`; README and design §4.8 updated.

### WAL-2 · medium · correctness · CONFIRMED (certain from code and Sui's ownership rule; not executed, it would spend funds)
`packages/walrus/src/Write.ts:147`, `:387-406`, `:677`

**What.** `owner` transfers the `Blob` to another address inside the register transaction. Step 4 then calls `certify_blob(&System, &mut Blob, …)` through the same executor. An address-owned object can only be an input of a transaction sent by its owner, so with `owner !== executor.sender` certify can never execute. `findRegistration` also searches `owner`'s objects, so a resume "reuses" a registration the sender cannot touch.

**Scenario.** `Write.run(bytes, { owner: user, executor: Write.viaTx(serverKey), … })`: register succeeds (WAL and gas paid, object now owned by `user`), upload succeeds, certify fails at input resolution, every resume fails the same way. `write.test.ts` passes because its fake chain does not model ownership and uses `sender === OWNER`.

**Fix.** Keep the `Blob` with the sender until it is certified and transfer in the certify transaction (`certify_blob` then `transferObjects`), as the Rust client's `PostStoreAction::TransferTo` does after certification (`crates/walrus-sui/src/client.rs:430-434`). Search the sender's objects in `findRegistration`. Add ownership to the fake chain. **Effort M.**

**Resolution.** Fixed. Register transfers the `Blob` to the executor's sender; `certify(uploaded, { executor, owner? })` transfers it to `owner` in the certify transaction; `findRegistration` searches the sender; a certified `Blob` the sender still holds is transferred on its own. The fake chain in `write.test.ts` now aborts on inputs the sender does not own and applies transfers; the new owner tests fail against the old `Write.ts`.

### WAL-3 · medium · correctness · CONFIRMED
`packages/walrus/src/System.ts:150-161`; users: `Recipes.ts` (`registerBlob`, `reserveSpace`, `extendBlob`), `Write.ts:268`, `:388`, `Aggregator.ts` (`verified`)

**What.** `System.state` is cached with an infinite TTL. Prices, `packageId`, `nShards` and `epoch` are read once per layer. `Write.encode` and `register` use the cached state and never refresh; only `upload` (on a committee mismatch), `checkRegistered` and `certify` do, and they run after register.

**Scenario.** A long-lived process; the storage or write price changes at an epoch boundary. `registerBlob` pays `units × cachedPrice` exactly; the contract splits the current price from the coin (`system_state_inner.move:445`, `:344`), so a higher price aborts in `balance::split` and a lower one in our own `coin::destroy_zero`. Every new write fails at register until the process restarts. Reproduced with a stale `System` and an aborting executor: three registers in a row built the same stale payment and `refresh` was called 0 times (`q/stale.test.ts`). A package upgrade (`packageId`) fails the same way.

**Fix.** Give `System.state` the committee's TTL (1 minute), or refresh and rebuild once when a register transaction aborts. Recipes' doc already promises "the step can be rebuilt"; nothing does it. **Effort S.**

**Resolution.** Fixed. `System.state` has a 1-minute TTL (`System.STATE_TTL`), and a failed register transaction refreshes `System` and is rebuilt once when prices, package id, epoch, shard count or shared version moved (otherwise the original error). Tests: TTL in `committee.test.ts`; price change and unexplained abort in `write.test.ts` (fake chain checks the exact WAL payment).

### WAL-4 · medium · tests · measured, mechanism PLAUSIBLE (not caught in the act)
`packages/walrus/test/live.gateway.test.ts:37-42`, `live.read.test.ts:62-67` (as reviewed; both cases are now one test in `live.read.test.ts`)

See "Investigated item 1" below for the measurements. The candidate filter keeps deletable blobs; on testnet 73% of the newest certified blobs are deleted 11–104 s after certification, and the metadata pre-check passes as long as one node still has the metadata. **Fix.** Filter `!c.deletable` (the helper already decodes it), take `recentCertified(200)` (only ~10% are permanent), and on a failed candidate log the failure kinds and try the next one. **Effort S.**

**Resolution.** Fixed (tests), plus the optional check. Live tests take `recentCertified(200)` filtered to permanent, non-extension blobs (`readableCandidates`), log each failed candidate with its failure kinds (`describeReadFailure`) and try the next (up to 20). `Read.blob` / `Read.locate` ending in `NotEnoughSlivers` or `NoMetadata` ask the status once and return `BlobNotFound` when it is `Nonexistent`. `SUI_LIVE=1` gateway test passed 4 of 4 runs. (The gateway test has since been merged into `live.read.test.ts`, which now reads through `Walrus.layer` and compares with `Aggregator.verified`.)

### WAL-5 · medium · performance · CONFIRMED (measured)
`packages/walrus/src/Encoder.ts:143-144` (every call), `Read.ts:478-483`

See "Investigated item 3". Each WASM call blocks the thread 2.3–2.65 s at `n = 1000`; a strict read runs decode and `blobId` back to back in one fiber with no yield (4.9 s; a blame pass adds 2.6 s). **Fix.** A worker-backed layer (M), and as a stop-gap a 1 ms `Effect.sleep` between consecutive WASM calls (S).

**Resolution.** Stop-gap applied. `Read.wasmBreak` (a real `setTimeout(0)`, so it does not wait on a `TestClock`; `Effect.sleep(1)` would hang `TestClock` tests) runs between `decode`, `blobId` and each `sliverRoots` batch. Measured at `n = 1000`, 1 MB blob from repair slivers: longest timer gap 4.93 s → 2.57 s, total unchanged (4.91 s). Worker-backed encoder not built (out of this batch).

### WAL-6 · medium · correctness/performance · PLAUSIBLE (arithmetic, not run)
`packages/walrus/src/StorageNode.ts:210-213`, `Walrus.ts:46-55`, `UploadRelay.ts:205`, `Write.ts:625`

**What.** One fixed timeout covers a request including its body. `Walrus.layer` lowers it to 15 s for every node call, `PUT`s included (the As-built note says it was chosen for reads). The relay `POST` of the whole blob has 60 s and is retried twice on timeout.

**Scenario.** Up to 12.5 MB of sliver `PUT`s are in flight at once. On an uplink below 12.5 MB / 15 s = 6.7 Mbit/s, any blob over about 2.8 MB (4.49× encoded) cannot drain the window in time: `PUT`s time out, each is retried 6 times and re-sent, and the write ends in `NotEnoughConfirmations`. Through the relay, a 75 MB blob at 10 Mbit/s needs 60 s for the body alone: three full uploads, three timeouts.

**Fix.** A separate write timeout (default 30 s or more), or scale by body size (`base + bytes / minRate`) for `putSliver`, `putMetadata` and the relay `POST`. **Effort S.**

**Resolution.** Fixed. `StorageNode.scaledTimeout(base, bytes, rate)`; uploads time out after `requestTimeout + max(body, sharedBytes) / minUploadRate` (default 125,000 B/s, option on `StorageNodesOptions` and `UploadRelayOptions`). `Write` passes `sharedBytes` = the bytes that can be in flight at once; the relay `POST` scales with the blob. A full 12.5 MB window at the 15 s base gets 115 s; a 75 MB relay upload 660 s. Arithmetic and TestClock timeouts tested in `storage-node.test.ts`.

### WAL-7 · low · correctness · PLAUSIBLE
`packages/walrus/src/Read.ts:230`, `:186-187`

**What.** During `EpochChangeSync` without `certifiedEpoch`, the read needs the status agreement; `StatusUnverified` fails the read and is not an "epoch error", so nothing retries. The Rust client continues with the current epoch when no status can be verified (`node_client.rs:480-494`, `continue_on_no_valid_status_received`).

**Scenario.** An epoch change in which fewer than `f + 1` shards agree on `kind + initialCertifiedEpoch` for a few seconds (nodes at different event heights): every read fails with `StatusUnverified` where the Rust client reads normally. **Fix.** On `StatusUnverified` in `chooseCommittee`, use `active.current` (and let the existing retry handle a miss). **Effort S.**

**Resolution.** Fixed. `chooseCommittee` falls back to the current committee on `StatusUnverified`; a miss is an epoch error that `withCommitteeRetry` handles. Test in `read.test.ts`.

### WAL-8 · low · security (hardening) · PLAUSIBLE
`packages/walrus/src/StorageNode.ts:198-209`

**What.** Response bodies are buffered whole with no size limit, although every expected size is known exactly (metadata 66,044 bytes at `n = 1000`, a sliver `bcsSliverBytes`, status a few hundred bytes). **Scenario.** One committee member answers sliver `GET`s with an endless body: a read has up to 334 requests in flight and a node receives one per shard it holds, each buffering for the full timeout. **Fix.** Reject on `content-length` above the expected size and cap the streamed read. **Effort S–M.**

**Resolution.** Fixed. `StorageNodes.metadata` / `sliver` take `{ maxBytes }`; bodies are read as a stream with the cap and checked against `content-length` first (`Malformed` when larger). `Read` passes `66n + 64` for metadata and the exact BCS sliver size; defaults 1 MiB (JSON), 8 MiB (metadata), 256 MiB (slivers). Tests in `storage-node.test.ts`.

### WAL-9 · low · correctness · CONFIRMED
`packages/walrus/src/Encoder.ts:299`

**What.** `sliverRoots` allocates the crafted blob outside `attempt`. **Scenario.** `n = 1000`, symbol size 20,000 (a blob over 4 GiB, reachable with a raised `maxSize`, in a blame pass or a verified quilt read): `new Uint8Array(4.46e9)` throws `RangeError: Out of memory`, which leaves as a defect, not an `EncoderError` (`q/small.test.ts`). The README promises no defects from the WASM path. **Fix.** Build the blob inside the `attempt`. **Effort S.**

**Resolution.** Fixed. The crafted blob is allocated inside `attempt`, so a failed allocation is an `EncoderError`. Test in `encoder.test.ts` (n = 1000, symbol size 20,000).

### WAL-10 · low · performance · CONFIRMED (from code)
`packages/walrus/src/Write.ts:482-489`

**What.** The global in-flight permit wraps the whole retried `PUT`, so it is held through backoff sleeps (up to 12.6 s in total) and all 7 attempts. **Scenario.** A large blob leaves few permits (500 MB: 8). One node that accepts metadata and then stalls on slivers holds all of them through its timeouts and backoffs and starves every other node. **Fix.** Take the permit per attempt: `withRetry(Semaphore.withPermit(global)(nodes.putSliver(…)))`. **Effort S.**

**Resolution.** Fixed. The global permit wraps each `PUT` attempt (`withRetry(Semaphore.withPermit(global)(putSliver))`). No dedicated test (the existing in-flight bound test still holds).

### WAL-11 · low · performance · CONFIRMED (from code)
`packages/walrus/src/Read.ts:346-351`, `:419`

**What.** Reads retry the same node 4 times (`Timeout` included) before moving on, and for metadata the retry runs inside the lane. The Rust client makes one attempt per node on reads and relies on the other nodes. **Scenario.** A hung node holds a metadata lane for 5 × 15 s + 3 s = 78 s (153 s with `StorageNode.layer`'s 30 s default); the window only widens on a final failure. If the three first picks hang, the first metadata answer is 78 s late although 96 other nodes were never asked. **Fix.** No retry (or `RateLimited` only) for metadata; do not retry `Timeout` on sliver reads. **Effort S.**

**Resolution.** Fixed. Metadata requests retry only `RateLimited` (another node is asked instead); sliver requests do not retry `Timeout`. Test in `read.test.ts`; the default-schedule timing test now exercises sliver retries.

### WAL-12 · low · docs/api · CONFIRMED (from code)
`packages/walrus/src/Read.ts:59-61`, `:479`; design §9.3

**What.** `consistency: "skip"` is documented as "trust the slivers" / "callers that trust the writer". Slivers are only header-checked, so it trusts every node that served one of the 334 slivers: one node can change the bytes returned. The Rust default check verifies each sliver against the metadata, so its cheap mode does not have this property. **Fix.** Say so in the option's doc and the README. A sliver-verified mode would cost the same one WASM call as `strict`, so there is nothing cheaper to offer. **Effort S.**

**Resolution.** Fixed (docs). `ReadOptions.consistency`, the README and design §4.5 say `"skip"` trusts every node that served a sliver.

### WAL-13 · low · correctness · PLAUSIBLE
`packages/walrus/src/Read.ts:404-426`

**What.** A node is marked failed for the whole read on any non-retryable error, including the per-shard ones (`ShardNotAssigned`, `SLIVER_NOT_FOUND`). **Scenario.** A stale committee during an epoch change: node A still holds 29 of its 30 listed shards; the moved one is asked first, A answers `SHARD_NOT_ASSIGNED`, and A's 29 good shards fail at once. The committee refresh then usually recovers. **Fix.** Poison a node only on node-level errors; let `ShardNotAssigned` fail that shard alone. **Effort S.**

**Resolution.** Fixed. `ShardNotAssigned` and `NotFound` on a sliver fail that shard only; other final failures still fail the node's other shards. Test in `read.test.ts`.

### QRM-1 · low · docs/correctness · CONFIRMED
`packages/quorum/src/Quorum.ts:346-348`, design §3.4 point 3 against §3.6

**What.** §3.4 says "the result is a success whatever happens in the window". A straggler that dies or interrupts itself during the linger (or grace) window fails or interrupts a call whose threshold was already reached. **Scenario.** Threshold reached at 1,000 ms, `linger: "1 second"`, another member dies at 1,200 ms: the call fails with the defect and the collected quorum is lost (`q/edge.test.ts`, case D). For a Walrus write that would discard a valid set of confirmations. **Fix.** Decide and document it. Surfacing the defect is defensible; then §3.4 should say so. **Effort S.**

**Resolution.** Fixed, as quorum.md §3.4 says: after the threshold is reached, a defect or self-interruption ends the linger window, is logged at warning level, and the call succeeds with what it has. During a `giveUp` grace (no quorum) a defect still fails the call. §3.4 and §3.6 updated; tests in `quorum/test/engine.test.ts`.

### QRM-2 · nit · correctness · CONFIRMED
`packages/quorum/src/Quorum.ts:356-365`, `:407-417`

Settlements already queued when the deciding one is taken are dropped: four `Effect.sync` members with threshold 1 all complete, the result has one success and three `unsettled` with `started: true` (`q/small.test.ts`). Harmless for the current callers; a write with `linger: 0` can lose confirmations that arrived in the same turn. **Fix.** Drain the queue without blocking before closing the scope on `done`. **Effort S.**

**Resolution.** Fixed. After `done`, settlements already queued are drained with `Queue.poll` (no yield: a yield let freshly forked members send requests only to be interrupted, seen in the read tests). Under `TestClock`, sleeps ending at the same instant still settle in separate turns, so only same-turn settlements are kept. Tests in `engine.test.ts` (four `Effect.sync` members all succeed; `agree` groups them).

### WAL-14 · nit · api
`packages/walrus/src/Write.ts:582-588`: the second `EpochMoved` round reports `NotEnoughConfirmations` with `weight: 0` and one synthetic failure, dropping the real per-node failures of that round.

**Resolution.** Fixed. `EpochMoved` carries the round's weight and failures; the second round reports them. Test in `write.test.ts`.

### WAL-15 · nit · api
`packages/walrus/src/Walrus.ts:51`: an untyped caller that passes neither `network` nor `config` silently gets testnet. Fail instead.

**Resolution.** Fixed. Without `network` or `config` (or an unknown network) `Walrus.layer` dies with an `IllegalArgumentError` (a caller bug TypeScript already rejects, like Quorum's validation defects). Test in `gateway.test.ts`.

### WAL-16 · nit · correctness
`packages/walrus/src/Write.ts:330-351`: a reused registration is not checked for `attributes`. A `Blob` registered elsewhere without `_walrusBlobType: "quilt"` is reused for a quilt write and stays unmarked.

**Resolution.** Fixed. A reused registration gets the requested `attributes` via the new `Recipes.setAttributes` (`insert_or_update_metadata_pair`, idempotent), in the relay auth-only transaction or a small transaction of its own. Test in `write.test.ts`.

### WAL-17 · nit · api
`packages/walrus/src/Read.ts:207`: when `committees.refresh` fails inside `withCommitteeRetry`, its `RpcError` replaces the original `NotEnoughSlivers` / `NoMetadata`.

**Resolution.** Fixed. A failed refresh inside `withCommitteeRetry` keeps the read's own error. Test in `read.test.ts`.

### WAL-18 · nit · tests
`packages/walrus/test/write.test.ts:150-200`: the fake chain checks epoch, weight and signature but not object ownership or the payment amount, which is why WAL-2 and WAL-3 pass the suite.

**Resolution.** Fixed with WAL-2/3: the fake chain models ownership, transfers, the exact WAL payment at current prices, attributes, and a caching `System`. The new tests fail (8 of them) against the old `Write.ts`.

## Investigated items

### 1. Flaky "Walrus.layer reads a recent blob" (`NotEnoughSlivers`, 259 of 334)

**Not a "not stored yet" problem, so `Read.blob` should not retry not-found slivers longer.** Evidence (testnet, read-only, 2026-11-27):

- Five freshly certified blobs read through an instrumented `StorageNodes` (`consistency: "skip"`): all five reads succeeded in 3.7–4.4 s. Per-node outcome by shard weight: served 709–731, unreachable through `fetch` 163–185, `SLIVER_NOT_FOUND` only 30–52 (`probe/fresh.ts`).
- A certificate needs `n − f = 667` signers, so at most `f = 333` shards can lack a fresh blob. To make 334 unreachable, 667 shards must fail; with about 185 unreachable that needs at least 482 not-found, which a certified, undeleted blob cannot produce.
- The storage node serves a sliver as soon as the blob is registered and the sliver is stored (`crates/walrus-service/src/node.rs:3717-3734`, `:2968-2980`); certification is not a condition.
- Of the newest 400 `BlobCertified` events (a 92-minute window), 362 are deletable and 291 (73%) have a `BlobDeleted` event for the same object 11.5–104 s after certification (median 28 s), from 285 distinct senders (`probe/deleted2.ts`). In the first probe the four newest certified blobs were already `BlobNotFound`.
- Both live tests take the newest non-extension candidate whose metadata can still be read, and metadata needs one node. A blob in its deletion window passes that check and loses slivers node by node during the read: exactly "some weight reached, then unreachable".
- The Rust client makes one attempt per sliver and never waits for not-found slivers (`node_client.rs:2237-2355`, `communication/node.rs:252-273`). What it does differently is race the read against a status check (`race_read_with_status_check`, `:587-613`), so a deleted blob is reported as `BlobIdDoesNotExist`.

I did not catch a deletion in the act: two blobs followed for 150 s were never deleted, and no `BlobDeleted` event appeared in a further 200 s (the deletions are bursty; the newest was 15 minutes old). So the mechanism is reasoned from the measurements above, not reproduced.

**Recommendation.** Test only (WAL-4): permanent blobs, a larger event window, and print failure kinds on a failed candidate so the next occurrence settles it. Optional for `Read.blob`: when a read ends in `NotEnoughSlivers` or `NoMetadata`, ask `status` once and return `BlobNotFound` if it is `Nonexistent` (the Rust client's behaviour, paid only on the failure path).

### 2. Should Quorum support the widening metadata window?

**Yes, but as polish, not as a fix.** A function-valued `concurrency` expresses it exactly: `concurrency: (p) => 3 + p.failed`. Prototype in a scratch copy (`dyn/src/Quorum.ts`): four changed lines in `prepare`/`drive`, all 51 existing tests pass, the window widens as in `Read.ts` and unstarted members are reported `started: false`; `Quorum.ts` grows 6,775 → 6,911 bytes minified (2,700 → 2,747 gzip). (My new test's start-order assertion was off by one member and needs correcting: failures settle before the success in the same tick.)

What it buys: `unsettled[].started` becomes true to its name (today all ~99 nodes are forked and parked on the semaphore, so every one reports `started: true`), start order no longer depends on semaphore fairness, and `Read.ts` loses the resizable semaphore. It does not shrink a bundle: `effect/Semaphore` (1.7 KB) is already pulled in by `Channel`.

The alternative is the Rust client's shape: a fixed window of 3 plus a concurrent status check that settles absent blobs in about a second. That costs ~99 small requests on every read, and also gives item 1's better error. If that is adopted, the widening window is not needed at all.

### 3. Worker-backed Encoder

**Measured (Bun 1.4.4, this machine, `n = 1000`, 32 B to 10 MB):** `encode` 2.59–2.65 s, `blobId` 2.56–2.58 s, `decode` 2.29–2.43 s, `sliverRoots` 2.59–2.64 s. A 50 ms ticker fiber stalls 2.64 s during one `blobId`. Consecutive calls do not yield: a `setInterval` saw one 30.5 s gap across 15 calls. `Effect.yieldNow` between two blocking calls does not let a timer fire on Bun; `Effect.sleep(1)` does (`q/yield.ts`).

**Worth it now for browsers and servers, not for CLIs.** A strict read freezes the tab or the server for 4.9 s (decode + `blobId`), a write for 2.6 s. On a server, node timeouts are wall-clock: four overlapping reads block for 19.6 s, longer than the 15 s request timeout, so requests whose answers were already waiting can be reported as `Timeout` (reasoned from the measurements, not reproduced).

**What it takes (M):**

1. A worker entry (`src/internal/encoderWorker.ts`) that builds `Encoder.make` and answers `{ id, op, args }` messages.
2. `EncoderWorker.layer({ spawn, wasmUrl? })` implementing `EncoderService` over `postMessage`: pending map, typed `EncoderError` on worker error or crash, `terminate()` in the finalizer. An interrupted call cannot stop the WASM: drop the result, or terminate and respawn.
3. `spawn` is injected, because bundlers must see `new Worker(new URL(…, import.meta.url), { type: "module" })` in app code, and Node needs `worker_threads` instead. `effect/workers` has the protocol, but its platform layers live in `@effect/platform-*`, which this repo does not depend on; a hand-rolled adapter is about 100 lines.
4. Transfer: copy inputs (10 MB is a few ms against 2.6 s); return `encode`'s 2n slivers as views over two transferred buffers instead of 2,000 allocations.
5. Forward `wasmUrl` to the worker; run `encoder.test.ts` against both layers; add a "ticker keeps ticking during encode" test.

A side benefit: terminating an idle worker releases the WASM heap, which otherwise never shrinks (665 MB after a 60 MiB encode, W5).

**Stop-gap (S):** `Effect.sleep(1)` between the WASM calls in `Read.readSlivers` halves the longest stall (4.9 s → 2.6 s).

## Optimizations

| # | What | Measurement | Effort |
|---|---|---|---|
| O1 | `QuiltRead.byIdentifier` verifies twice (index, then patch). Decode the index unverified (`decodeIndex` already checks every length), fetch the patch columns, verify all columns in one `sliverRoots` call, fall back on mismatch as today. | 2 × 2.6 s → 1 × 2.6 s per call | S–M |
| O2 | `decode` is all-or-nothing on systematic slivers: with all 334 systematic primary slivers it takes 12–26 ms; with a single repair sliver, 2.3 s. Asking the systematic shards first would make healthy-network reads one WASM call. | No gain on testnet today (16–19% of weight unreachable, so the full systematic set is never available); worth it only where every node answers. | M |
| O3 | A fresh `Write.run` re-reads what it just read: `checkRegistered` right after `register` (1 object read + a 2-request system reload), then `certify` repeats both. Skip the first when the `Registered` step was produced in this run. | 3 of ~6 extra round trips per write | S |
| O4 | `findRegistration` collects every owned `Blob` page before matching (`Write.ts:340`). Filter and take the first match. | O(owned blobs) per write for publisher-like accounts; the no-match case still scans | S |
| O5 | Quorum function-valued `concurrency` (item 2). | +136 B min / +47 B gzip | S |
| O6 | Read bundle (esbuild, minified): 378 KB, of which `packages/sui/src/grpc/generated/rpc.ts` is 107 KB (28%); walrus's own code is 24 KB + 4 KB generated, quorum 5.9 KB. Outside this review's area; passed on for the sui reviewer. | measured in `bundle/meta.json` | — |

**Resolution (optimizations).** O1 taken: `byIdentifier` decodes the index unverified only to find the patch, then verifies index and patch columns in one `sliverRoots` call; anything unexpected takes the verified path. One call at `n = 1000` measured 2.60 s, so about 5.2 s → 2.6 s of WASM per call (test in `quilt.test.ts`). O2 not taken (M, no gain on testnet today). O3 taken: the `Registered` → upload chain re-read is skipped right after a register in the same run (`certify` still reads). O4 taken: `findRegistration` stops at the first match (`Stream.filterMap` + `runHead`). O5 taken (function-valued `concurrency`, used by `Read.ts` metadata). O6 is for the sui reviewer. `Quorum.ts` grew 6,775 → 7,538 bytes minified (2,722 → 2,992 gzip) with O5 and the QRM-1/QRM-2 fixes.

## Checked and found sound

- Quorum inside `Effect.uninterruptible`: losers are still interrupted and the call returns at the threshold (forks are interruptible). `linger` returning `NaN`, a negative or zero duration: no window. A throwing `giveUp.when` or a `run` that throws synchronously: a defect, members cleaned up. Fractional weights `0.1 × 3` against `0.3`: success.
- `Status.order` matches the Rust `Ord` (`api.rs:138-200`), including the reversed optional epoch; `readCommittee` matches `active_committees.rs:153-167`.
- Certificate path: weight in shards at `n − f`, message byte-equality (epoch, blob id, persistence), per-confirmation BLS check against the system object's key, signer bitmap over the system committee; relay certificates go through `verifyCertificate` before certify.
- Metadata is verified against the blob id before any length is used; sliver blame attributes only slivers whose Merkle root differs.
- Namespace subpath imports only; no `effect` barrel import in either package's `src`.
