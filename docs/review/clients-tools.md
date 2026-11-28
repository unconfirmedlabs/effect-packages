# Review: `sui-graphql`, `sui-lifecycle`, `sui-codegen`

> **Package names changed on 2026-11-28.** The 17 packages became six; the README's [migration table](../../README.md#migrating-from-the-old-package-names) maps every old import. This review predates the change: it names the packages as they were (`sui-zklogin` is now `@unconfirmed/effect-sui/zklogin`, `sui-secp256k1` is `@unconfirmed/effect-sui/Secp256k1`, `walrus-wasm` is `@unconfirmed/effect-walrus/wasm`, and so on), and its line numbers refer to the files as they were then. Import specifiers and paths were updated mechanically.

Scope: `packages/sui-graphql`, `packages/sui-lifecycle`, `packages/effect-sui-codegen`, plus the codegen runtime (`packages/effect-sui/src/Move.ts`) and the generated Walrus bindings as a sample. Read-only on source; every CONFIRMED item was reproduced with a throwaway script or test (scratch dir `review-clients`, file named per finding) or is certain from the code.

## Summary

- Baseline is healthy: offline tests pass (115), live tests pass (`SUI_LIVE=1 bun test packages/sui-graphql packages/sui-lifecycle`: 110 pass in 45 s), imports are namespace subpaths throughout, regenerating the Walrus bindings from testnet gives a zero diff (4 requests, 0.6 s).
- GraphQL parity with gRPC is good for values and error codes (a refused `execute` is `INVALID_ARGUMENT` on both transports, checked on testnet). The one serious problem is throughput: `CheckpointData.subscribe` over GraphQL cannot keep up with the chain.
- Lifecycle: the taxonomy and interruption handling hold up under the existing tests and my own. The weak points are around the edges: the durable journal stops working on one bad entry, `reconcileAll` is slow by construction, the expiry rule is off in every default wiring and, when on, joins observations that nothing ties to one node.
- Codegen: output is correct for the fixture and Walrus (type origins across four package versions, tree-shaking under all three bundlers). The gaps are in local (unpublished) packages, config merging and name collisions.

Counts: 1 high, 8 medium, 14 low, 3 nit.

## Findings

### CT-1 · high · performance · CONFIRMED — `CheckpointData.subscribe` over GraphQL falls behind the chain and never recovers
`packages/effect-sui/src/graphql/CheckpointDataGraphQL.ts:189-191` (subscribe), `:26`, `:170-187` (list)

`subscribe` maps each subscription edge through `getIndexed` with the default concurrency of 1, and one `GetCheckpoint` costs more than one checkpoint interval. Measured from this machine against Mysten's endpoints (`cp.ts`, `sub.ts`):

| | checkpoint interval | one `get` | delivered in 30 s | produced in 30 s | behind after 30 s |
|---|---|---|---|---|---|
| mainnet | ~250 ms | 0.6–1.4 s | 48 | 124 | 74 |
| testnet | ~220 ms | 0.22–0.7 s | 102 | 136 | 34 |

The lag grows linearly for as long as the stream runs, so `CheckpointData.follow` is not a live feed on either network. `list` (4 at a time) reads 100 mainnet checkpoints in 21.7 s (4.6/s against ~4/s produced), so `follow`'s history phase barely gains on the tip either. gRPC serves the same stream in one server stream.

Fix: `Stream.mapEffect(getIndexed, { concurrency: 8+ })` in `subscribe` (it stays ordered), raise `LIST_CONCURRENCY` to 16, and consider a lighter first query (50 tx × 50 changes × 50 events is the slow part). Add a live test that asserts the lag stays bounded. Effort S.

**Resolution:** fixed. `subscribe` and `list` now run `getIndexed` 16 at a time, still delivered in order. `list` no longer pages `ListCheckpointNumbers`: it enumerates the consecutive numbers, and its open ends come from one `Tip` query (the tip and the retention floor). Measured with `sub.ts` from this machine, against the light `Checkpoints.subscribe`. Before: mainnet 79 and testnet 53 behind after 30 s, still growing. After: 5 behind on both after 30 s, and after 60 s 7 behind on mainnet (240 delivered, 249 produced) and 5 on testnet, so the lag no longer grows. A lighter first query was not needed. New live test: `CheckpointData.subscribe keeps up with the chain` (20 s on testnet; asserts no gaps and fewer than 20 behind). New offline test: concurrent, in-order fetching.

### CT-2 · medium · correctness · CONFIRMED — one undecodable `entry:` key disables the durable journal
`packages/effect-sui/src/lifecycle/JournalKeyValueStore.ts:64-72`, `:120-135`, `:136`, `:193`

`listUnresolved` reads every unmarked entry with `readEntry`, which fails on a value that does not decode or does not match its key, and `Effect.forEach` fails the whole listing. `reconcileAll`, `pruneSettled` and `layer({ onUnresolved: "fail" })` then all fail with `JournalError`, and every other unresolved submission is stranded. Reproduced (`lifecycle1.test.ts` A): one valid `Signed` entry plus `entry:somethingElse = {"v":0}` → all three fail. Ways to get there: a truncated write, a store shared without `prefix` that has its own `entry:*` keys, or any future change to `JournalEntry` (entries carry no version). The corrupt-entry branch in `reconcileAll` (`Lifecycle.ts:711-721`) is unreachable with this journal.

Fix: decode per entry into a `Result`; return the good ones and surface the bad ones (a `corrupt` list, or a log plus skip); add a version field to the stored JSON. Effort S/M.

**Resolution:** fixed. Each entry is decoded on its own.
- `Journal.listUnresolved` now returns `{ entries, corrupt }`, where `corrupt` is `CorruptEntry { key, reason }`, and logs a warning when `corrupt` is non-empty.
- `reconcileAll` reports each unreadable entry as `Reconciled { _tag: "Corrupt" }`. `pruneSettled` skips them. `onUnresolved: "fail"` names them. The new `Journal.remove` deletes them.
- Stored JSON now carries `"v": 1` (`JournalKeyValueStore.VERSION`). An entry without `v` is read as version 1. Any other version is reported as corrupt ("unknown journal schema version").
- Breaking change: custom `JournalService` implementations must return the new listing shape and implement `remove`.
- Test: `journal.test.ts` "unreadable entries are reported, never strand the others; unversioned entries still read".

### CT-3 · medium · correctness · PLAUSIBLE (rule confirmed against the stub) — `expired` joins observations nothing ties to one node
`packages/effect-sui/src/lifecycle/Lifecycle.ts:232-237`, `:245-260`, `:289-300`, `:313-318`

`NotApplied{expired}` is concluded from `Chain.info.epoch` (cached 30 s), two `Transactions.get` misses and `Evidence`. These are three independent services. If the service answering `get` is behind the one answering `Chain`/`Evidence`, a transaction that landed at the end of its window is judged never applied. `mixed.test.ts`: Chain at epoch 12, window 10..11, transaction landed, `get` not yet serving it → `NotApplied{expired}`, `outcome` = `not_applied`; a moment later `reconcile` finds it executed. Real wirings that produce this: `Transactions` over GraphQL (indexer seconds behind, more during incidents) with `Chain` + `EvidenceGrpc` over gRPC, which the README's "mix transports per service" invites; or a load-balanced fullnode endpoint at an epoch boundary, where nodes finish reconfiguration at different times. The second case is acknowledged (`expiryEvidence: "never"`), but the default is `"epochThenMiss"`. It needs a transaction executing in the last seconds of its window (a late `resubmit`, or a short explicit expiration), so it is rare; the cost is a false `not_applied`, which the taxonomy tells callers to rebuild.

Fix: let one provider vouch for the whole observation, e.g. `Evidence.absent(digest, window)` that reads the tip epoch, the lookup and the retention floor from the same backend (one GraphQL query can do this at one checkpoint), and document that `Evidence` must be the backend of `Transactions`. Effort M.

**Resolution:** fixed.
- `EvidenceService` is now a single method, `observe(digest, fromEpoch)`. It returns one backend's `{ epoch, found, gap }`, read in a consistent order: epoch, then lookup, then retention floor. `EvidenceGraphQL` reads all of it in one query at one checkpoint.
- `expired` now requires both rounds (around the recheck) to see a `Transactions.get` miss *and* an `Evidence` observation that is past the window and missing the digest, with its history covering the window. `Chain.info` is only a cheap gate before the rounds.
- When the evidence backend serves the digest but `Transactions` does not yet, or the backend is still inside the window, the result is `SubmissionUnknown` with that reason.
- The reviewer's `mixed.test.ts` scenario now gives `SubmissionUnknown`: test "a lagging Transactions index never turns a late landing into expired". Further tests cover a backend still inside the window and an unreported history.
- `EvidenceGrpc` makes separate calls. Behind a load balancer, `expiryEvidence: "never"` is still the answer; this is documented.

### CT-4 · medium · api · CONFIRMED — the expiry rule is off in every default wiring, and unresolved entries can never be dropped
`packages/effect-sui/src/lifecycle/Evidence.ts:32-40`, `src/Journal.ts:22-27`, `README.md:13`

`Evidence` defaults to "cannot tell"; `SuiGrpc.layer` cannot include `EvidenceGrpc`; there is no GraphQL implementation (the data is there: `serviceConfig.availableRange`, `epoch.checkpoints`); the README never mentions it. So `Lifecycle.run`'s default transactions (address-balance gas, nothing pinned, `ValidDuring` "so the expiry rule can settle the bytes") can never settle `NotApplied`: one that never reached the network stays `Signed`/`Unknown` forever. `pruneSettled` never deletes unresolved entries and the journal has no other removal, so each one is re-polled by every `reconcileAll` (CT-5).

Fix: ship `EvidenceGraphQL`, document `EvidenceGrpc.layer` next to the lifecycle in the README, and add an explicit `Journal.abandon(digest)` (or let `pruneSettled` take `{ unresolvedOlderThan }` for entries whose window closed long ago). Effort M.

**Resolution:** fixed on the package side.
- Added `EvidenceGraphQL` (`@unconfirmed/effect-sui/lifecycle/EvidenceGraphQL`; `sui-lifecycle` now depends on `sui-graphql` for that subpath only).
- Added `Journal.remove(digest)`, which drops any entry: unresolved, settled or corrupt.
- `Evidence.ts`, the README (new section "6. Crash-safe submission") and the `SubmissionUnknown` reason ("no Evidence service is provided, so the expiry rule is off") now say that the expiry rule is off without an `Evidence` layer, and show the wiring.
- Not changed: the default wiring. `SuiGrpc.layer` lives in core, and core cannot depend on the lifecycle. Including `Evidence` by default would need the lifecycle to ship its own transport bundle, e.g. a `Lifecycle.layerGrpc({ baseUrl })`. I did not add that, to keep one way of wiring.

### CT-5 · medium · performance · CONFIRMED — `reconcileAll` is sequential and polls the full `lookupTimeout` per missing entry
`packages/effect-sui/src/lifecycle/Lifecycle.ts:704-732`, `:285`

Each entry runs `recover`, which polls `Transactions.get` every `lookupInterval` until `lookupTimeout` (5 s, 11 lookups) before anything else, and entries run one at a time. Measured (`lifecycle1.test.ts` B): 5 missing entries with `lookupTimeout: 400 ms` take 1.53 s; with defaults that is 25 s, and 100 entries is over 8 minutes at startup, before the 2 s recheck of entries whose window closed. Entries left over from a crash are old; polling for a just-sent transaction is the wrong tool.

Fix: `reconcileAll({ concurrency })` (bounded, default ~8) and a single lookup per entry there (`lookupTimeout: 0`). Effort S.

**Resolution:** fixed. `reconcileAll({ concurrency })` (default 8) runs each entry with `lookupTimeout: 0`, so one lookup instead of 5 s of polling; the recheck now overlaps across entries. Test: 20 missing entries under the default config make 20 lookups and finish well under 2 s. Before, this took about 100 s.

### CT-6 · medium · correctness · CONFIRMED — local packages get `0x0` type strings; `packageId` only redirects calls
`packages/effect-sui-codegen/src/Summary.ts:155`, `:163`, `:271-279`; `src/Config.ts:28-29`; `README.md:347-352`

For a package generated from `sui move summary`, a datatype's origin is the summary address, which is `0x0` until the summaries carry a published address. `Thing.type()` is then `0x000…0::fixture::Thing` (golden output, `parity.test.ts:133`), and `packageId` changes only `$package.ts` (`v.test.ts` V1: default `0x…999`, type origin `0x…0`). There is no option to give the original id, and `.type()` is synchronous so `Layer.succeed(Package, id)` cannot help. The README example (`{ path: "./move/counter" }`, then `counter.Counter.type() // "0x<defining id>::…"`) does not produce what the comment says; type arguments and `listOwned({ type })` built from it fail on chain. The live test works around it with `` `${pkg}::fixture::Thing` ``. A local package that was upgraded has the same problem for types added later (local summaries have no type origins). `@mysten/codegen` resolves the name at build time instead.

Fix: `LocalPackage.originalId` (default: `packageId`) used as the address and default origin when the summary says `0x0`, plus optional `typeOrigins`; say in the README what local packages get. Effort M.

**Resolution:** fixed.
- New `LocalPackage.originalId` (default `packageId`) is used as the address and default type origin of a root that the summaries list at `0x0`, so `.type()` returns the published id.
- Optional `typeOrigins: { "module::Type": id }` covers types added by an upgrade.
- An `originalId` that contradicts a published address in the summaries is a `CodegenError`.
- The README comment and `Config` docs are corrected. The live test now asserts `Thing.type()` against the published id instead of working around it.

### CT-7 · medium · correctness · CONFIRMED — one config cannot hold two unpublished local packages, or one with an unpublished local dependency
`packages/effect-sui-codegen/src/Generate.ts:49-54`, `:70-73`; `src/Summary.ts:248-256`

Unpublished packages all resolve to `0x0`. Two config entries → `CodegenError: two configured packages resolve to 0x000…0` (`codegen1.ts` E1). Inside one summary directory two `0x0` labels → `packages A and B both resolve to …`. `merge` keys by address, so they would collapse anyway. Splitting into two configs does not help if they share an output directory: each run deletes `deps/`.

Fix: give unpublished packages a synthetic identity (the label) in the model and keep `0x0` only as the rendered address; fixed together with CT-6. Effort M.

**Resolution:** fixed. In the model, an unpublished package has the synthetic identity `unpublished:<label>` (`M.unpublished`); it still renders as `0x0`. Several can coexist, in one config or in one summary directory, and their dependencies go to `deps/<label>/`. Tests are in `edge.test.ts`.

### CT-8 · medium · correctness · CONFIRMED — a configured root that an earlier entry loaded as a dependency loses its `name` and `packageId`
`packages/effect-sui-codegen/src/Generate.ts:49-54`

`merge` keeps the first copy of each package. `codegen1.ts` E2: `[{ path }, { path, package: "sui", name: "framework", packageId: "0x999", modules: ["clock"] }]` writes `sui/$package.ts` with default `0x…2`; reversing the two entries writes `framework/$package.ts` with `0x…999`. Calls silently go to the wrong id depending on entry order. Two on-chain roots that link different versions of a shared dependency are also resolved by order.

Fix: in `merge`, a model's root copy wins over a dependency copy. Effort S.

**Resolution:** fixed. In `Generate.merge`, a model's root copy wins over any dependency copy, whatever the entry order. Between two dependency copies, the one with more datatypes wins, then config order. Tested in both entry orders.

### CT-9 · medium · correctness · CONFIRMED — argument keys collide: a value parameter named like an auto-filled object, or two names with one camelCase form
`packages/effect-sui-codegen/src/Render.ts:623-626`, `:648-655`, `:687-688`

Uniqueness is checked on the raw Move names, not on the emitted keys, and not against the auto keys (`clock`, `random`, `denyList`, `system`, `accumulatorRoot`). `fun draw(random: u64, rnd: &Random)` renders (`codegen1.ts` E4):

```ts
readonly random: Move.Input<bigint>
readonly random?: Move.ObjectInput        // duplicate property (TS2300)
…
Move.random(Move.isTuple(a) ? undefined : a.random)   // the u64 is passed as the Random object
```

`fun f(foo_bar: u64, fooBar: u64)` renders two `fooBar` keys and reads `a.fooBar` for both (E4b).

Fix: compute the final keys (camelCased values plus auto names), and on any duplicate fall back to positional arguments or suffix the later key. Effort S.

**Resolution:** fixed. Keys are now computed after camelCasing, and the auto-filled objects keep their documented names. When a value's key is already taken, it keeps its Move name if that differs, otherwise it gets a numeric suffix:
- `random: u64` next to `&Random` becomes `random2`;
- `foo_bar` with `fooBar` gives `fooBar` and `fooBar2`.

Two parameters of the same auto type share one key. Tests build the generated calls.

### CT-10 · low · correctness · CONFIRMED — `JournalError` from `submit` is classified `not_applied` even when the bytes are already out
`packages/effect-sui/src/lifecycle/Lifecycle.ts:625-634`, `src/Outcome.ts` (taxonomy comment)

`submit` passes `firstSend: true`, so a failed `Journal.get` is a `JournalError`. `submit` documents that it may be called on bytes the journal already holds; if that second call hits a journal read failure the caller gets `JournalError`, `outcome()` says `not_applied`, and the taxonomy says rebuild, while the first send can still land (`lifecycle1.test.ts` C). True for `run` (fresh bytes), not for `submit`.

Fix: make a read failure in `submit` a `SubmissionUnknown` unless the caller says the bytes are new (`run` does), or narrow the doc to `run`. Effort S.

**Resolution:** fixed.
- In `submit`, a journal read failure is now `SubmissionUnknown`: nothing is sent, and the bytes may have been sent before.
- `run`, whose bytes are fresh, still gets `JournalError` (internal `submitFresh`).
- The `JournalError` and taxonomy docs are narrowed to match.
- Test: "submit with an unreadable journal is SubmissionUnknown and sends nothing".

### CT-11 · low · correctness · PLAUSIBLE — `NotApplied{refused}` is a heuristic recorded as proof
`packages/effect-sui/src/lifecycle/Lifecycle.ts:486`, `:590-595`, `:640-641`

Any `INVALID_ARGUMENT` on a first send becomes terminal `NotApplied`. Refusals are often time-dependent: on testnet, both transports answer an unfunded address-balance transaction with `INVALID_ARGUMENT` "Insufficient address balance … requires 5000000 but only 0 is available" (`refuse.ts`); the same bytes are valid once the address is funded, until their window closes, and the node that refused them holds them. "Provably never applied and never will" holds only while nothing re-sends them. Also `lifecycle1.test.ts` D: a first `submit` to an endpoint on the wrong chain is journalled `NotApplied`, and `resubmit` on the right chain then refuses without sending (`resend` checks the chain id, the first send does not). The lock-conflict carve-out is a regex over node message text.

Fix: check the chain id before the first send; document `refused` as "this process will not send them again" rather than a chain proof; let `resubmit` override a `refused` entry on request. Effort S.

**Resolution:** fixed.
- The first send now checks the chain id: bytes for another chain are not sent and are not journalled, giving `SubmissionUnknown` with "nothing was sent".
- `NotApplied{refused}` is documented as "this process will not send them again", not as proof from the chain.
- New `resubmit(signed, { retryRefused: true })` re-sends a `refused` entry, writing `Signed` over it first.
- The lock-conflict regex is unchanged; it is the only signal the node gives.
- Tests: wrong chain then right chain (one send), and `retryRefused`.

### CT-12 · low · api · CONFIRMED — `Checkpoints.list()` without `end` is not pinned to the tip over GraphQL
`packages/effect-sui/src/graphql/CheckpointsGraphQL.ts:66-79`

gRPC pins the open end before the first request (`grpc/scan.ts` `pinned`); `EventsGraphQL` and `CheckpointDataGraphQL` do the same with a `Tip` query; `CheckpointsGraphQL.list` sends no `beforeCheckpoint`, so it chases the moving tip and ends wherever it catches up.

Fix: pin with `Tip` as the other two do (and share one `Tip` operation; it is declared twice). Effort S.

**Resolution:** fixed. `Checkpoints.list` pins an open end with `Tip`. There is now one shared `Tip` operation (`src/tip.ts`), used by Checkpoints, Events and CheckpointData. A tip of null is `UNAVAILABLE`; before, it ended the listing at 1. There is an offline test.

### CT-13 · low · correctness · CONFIRMED — `Chain` over GraphQL invents values when the indexer answers null
`packages/effect-sui/src/graphql/ChainGraphQL.ts:56-57`, `:66`; `src/CheckpointDataGraphQL.ts:154`

`epoch ?? 0n`, `checkpointHeight ?? 0n`, `referenceGasPrice ?? 1000n`, checkpoint `epoch ?? 0n`. A null `epoch` yields a `ValidDuring{0,1}` expiration and a 1000 MIST gas price: the build succeeds and the node refuses it. These should be `RpcError` (`UNAVAILABLE`), not data. gRPC does the same in `ChainGrpc.ts`.

Effort S.

**Resolution:** fixed for GraphQL. In `ChainGraphQL`, a null epoch, checkpoint or gas price is now `RpcError` `UNAVAILABLE`. In `CheckpointData.get`, a null epoch is `DATA_LOSS`. There are offline tests for both. Not changed: `ChainGrpc` in core (`epoch ?? 0n`, `checkpoint_height ?? 0n`, `reference_gas_price ?? 1000n`). Core change needed: fail with `RpcError` `UNAVAILABLE` when those fields are absent.

### CT-14 · low · correctness · CONFIRMED — throws that escape as defects in the GraphQL layers
- `CoinsGraphQL.ts:58`: `TypeTag.normalizeString(coinType)` runs eagerly; `coins.list(owner, "0x2::sui::SUI<")` is a defect (`v.test.ts` V2: `Die`). `:62` `decodeCoin` throws inside `Stream.map`.
- `CheckpointDataGraphQL.ts:155`: `BigInt(Date.parse(timestamp))` throws `RangeError` on an unparsable timestamp.
- `DynamicFieldsGraphQL.ts:135`: `Address.fromBytes(value.subarray(0, 32))` on a short value.
- `EventsGraphQL.ts:140`: `Address.normalize` on a filter address, inside `Stream.filter`.

Fix: `Effect.try` to `RpcError` (`INVALID_ARGUMENT` for caller input, `DATA_LOSS` for responses). `CoinsGraphQL` and `CoinsGrpc` are the same code over `Objects`; one `Coins.fromObjects` in core fixes both. Effort S.

**Resolution:** fixed for every GraphQL site:
- Coins: a malformed coin type is `INVALID_ARGUMENT`; an undecodable coin is `DATA_LOSS`.
- CheckpointData: an unparsable timestamp is `DATA_LOSS`.
- DynamicFields: a short object-field value is `DATA_LOSS`.
- Events: an invalid sender address is rejected in `plan` as `INVALID_ARGUMENT`, before any request.

There are offline tests. Not changed: `CoinsGrpc` in core has the same two throws. Core change needed: add `Coins.fromObjects(objects)` in core, which normalizes the coin type with `Effect.try` → `INVALID_ARGUMENT` and decodes with `Effect.try` → `DATA_LOSS`, and use it from both `CoinsGrpc` and `CoinsGraphQL`.

### CT-15 · low · correctness · PLAUSIBLE — GraphQL `execute` can fail after the transaction executed
`packages/effect-sui/src/graphql/TransactionsGraphQL.ts:77-82`, `:115`

For a transaction with more than 1024 object changes, `execute` pages the rest by digest after the mutation returned. If that paging fails (20 s of "not indexed", or a transport error) the whole call fails with `OUT_OF_RANGE`/`UNAVAILABLE` and no digest. Under the lifecycle this reconciles; under `Tx.execute` it reads as a failed submission of a transaction that landed.

Fix: put the digest in the error message at least; better, a distinct typed failure the core can map to "executed, effects incomplete". Effort S.

**Resolution:** partly fixed. The failure after the mutation now says `transaction <digest> executed, but its object changes could not be read: …`, and keeps its code. Not changed: a distinct typed failure needs core. Core change needed: add an error to `Transactions.execute`'s channel, for example `ExecutedEffectsIncomplete { digest }`, that `Tx.execute` maps to "executed, reconcile by digest" instead of a failed submission.

### CT-16 · low · performance · CONFIRMED — `inputEvidence` reads pinned objects one at a time
`packages/effect-sui/src/lifecycle/Lifecycle.ts:200-205`

The loop awaits each `Objects.get`, so the batching resolver never sees two at once: 10 pinned refs are 10 sequential round trips (`v.test.ts` V4: max concurrency 1), plus one `Transactions.get` per moved object.

Fix: fetch all pinned objects with `Effect.forEach(..., { concurrency: "unbounded" })` (one `BatchGetObjects`), then walk the results. Effort S.

**Resolution:** fixed. All pinned objects are fetched with `Effect.forEach(..., { concurrency: "unbounded" })` before the walk. Test: two pinned refs are read concurrently.

### CT-17 · low · performance · CONFIRMED — 8 store operations per successful submit with the KeyValueStore journal
`packages/effect-sui/src/lifecycle/JournalKeyValueStore.ts:74-78`, `:107-118`; `src/Lifecycle.ts:509-514`, `:625`

Counted (`lifecycle1.test.ts` E): 3 `get`, 3 `set`, 2 `has`. `sendConsultingJournal` and `journalBeforeSend` read the same entry back to back; `clearMarker` does `has` then `remove` twice where a bare `remove` of a missing key is a no-op. Five operations would do.

Effort S.

**Resolution:** fixed, at 7 operations (2 `get`, 3 `set`, 2 `remove`; no `has`) instead of 8. The send path passes the entry it just read to the `Signed` write, and the marker is cleared with a bare `remove`, which is a no-op on a missing key in every `KeyValueStore`. The remaining two are kept on purpose:
- the marker clear before the unresolved write (crash safety when overwriting a settled entry);
- the re-read after the settled marker (the race described in the module doc).

Getting to 5 would need compare-and-set. There is a test that counts the operations.

### CT-18 · low · api · CONFIRMED — `reconcile(digest)` ignores signed bytes the journal holds for that digest
`packages/effect-sui/src/lifecycle/Lifecycle.ts:404-416`, `:425-442`

With a `Signed` entry in the journal, `reconcile(signed.digest)` answers "the signed bytes are not available" while `reconcile(signed)` proves `NotApplied` (`lifecycle1.test.ts` H). Same for `resubmit` of a `SubmissionUnknown` without bytes.

Fix: on a bare digest, load the unresolved entry and use its `signed`. Effort S.

**Resolution:** fixed. A bare digest, and a `SubmissionUnknown` without bytes in `reconcile` and `resubmit`, now use the signed bytes of the journal's unresolved entry, after checking their digest. Test: `reconcile(signed.digest)` proves `NotApplied{expired}`.

### CT-19 · low · performance · CONFIRMED — the in-memory defaults grow without bound
`packages/effect-sui/src/lifecycle/SenderLock.ts:31-37`, `src/Journal.ts:35-55`

`SenderLock.makeMemory` keeps one `Semaphore` per address forever; the default `Journal` keeps every `Executed` entry until someone calls `pruneSettled`, and nothing does. Both are process-wide defaults, so a long-lived service leaks per sender and per transaction.

Fix: delete a lock when it has no holder or waiter; cap or auto-prune the memory journal's settled entries. Effort S.

**Resolution:** fixed.
- `SenderLock.makeMemory` counts the users of each address and deletes the semaphore when nobody holds or waits for it. Test: `size()` is 0 after concurrent runs.
- The memory journal keeps every unresolved entry and the latest 10 000 settled ones (`makeMemory({ maxSettled })`); the oldest settled are dropped. There is a test.

### CT-20 · low · correctness · CONFIRMED — legal Move that aborts the whole generation
`packages/effect-sui-codegen/src/Render.ts:310-312`, `:592-594`, `:712-716`

A struct named `Move`, `Bcs` or `Package` (`Option` and `Schema` are aliased, these are not; `struct Move` is plausible in a game), two functions that camelCase alike (`foo_bar`, `fooBar`), or a public function with a `signer` parameter each throw `CodegenError` for the whole run (`codegen1.ts` E3, E7, E8), including when the module is only a dependency.

Fix: alias the runtime imports on a clash, keep the snake_case name for the second function, skip an unsupported function with a comment. Effort S.

**Resolution:** fixed. A struct named `Move`, `Bcs` or `Package` is bound as `Move_` and exported under its own name. In a module that exports a type named `Package`, the module no longer re-exports the `Package` reference; it is still in `$package.ts`. Of two functions that camelCase alike, the one already in camelCase keeps the name and the other keeps its Move name. A function with a `signer` or other unsupported parameter is skipped with a comment, instead of failing the run. Tests in `edge.test.ts` import and call the generated module.

### CT-21 · low · correctness · CONFIRMED — codegen throws that surface as defects
- `packages/effect-sui-codegen/src/Summary.ts:232` → `Model.ts:115-119`: any directory in the summaries that is not in `address_mapping.json` (a stray `.cache`) makes `normalizeAddress` throw inside `Effect.gen`: `Die`, and the CLI prints a fiber failure instead of `CodegenError: …` (`codegen1.ts` E5).
- `packages/effect-sui/src/Move.ts:229`: `Move.param` calls `TypeTag.parse(typeArgument)`, which throws on a malformed type argument, inside a function typed to fail with `InvalidPureValue` (E6: `Die`).

Fix: `Effect.try` at both sites; ignore unmapped directories in `Summary.load`. Effort S.

**Resolution:** codegen part fixed. Summary directories that are neither in `address_mapping.json` nor an address are ignored. Address parsing and model conversion run under `Effect.try`, so bad input is a `CodegenError`, not a defect. Not changed: `Move.param` in core. Core change needed in `packages/effect-sui/src/Move.ts` (`Move.param`): wrap `TypeTag.parse(typeArgument)` in `Effect.try` and fail with `InvalidPureValue` carrying the parse message.

### CT-22 · low · correctness · CONFIRMED (from code; E9 run) — `Generate.write` deletes directories it does not own, and same-named roots overwrite each other
`packages/effect-sui-codegen/src/Generate.ts:86-89`; `src/Render.ts:239`

`write` runs `rm -rf <output>/<top>` for every top-level directory it is about to write (package names and `deps`) with no check that the contents are generated: `output: "./src"` with a Move package named `app` or `utils` removes `./src/app`. Two roots with the same `name` render to the same paths (E9: `pkg/$package.ts` twice) and the later one silently wins. Directories of packages removed from the config are left behind.

Fix: delete only files that start with the generated header (or refuse when a directory holds anything else); fail on duplicate output paths. Effort S.

**Resolution:** fixed. `write` refuses, and writes nothing, when a directory it would replace holds a file that does not start with the generated header (`Render.HEADER`). Two outputs at one path fail in both `render` and `write`. A root name that is not a safe directory name also fails. Not changed: directories of packages removed from the config are left in place, by design, since the generator cannot know they were its own.

### CT-23 · low · performance · CONFIRMED — avoidable requests and dead selections in the GraphQL layers
- `ChainGraphQL.ts:16-17`, `:30-33`: `ChainInfo` and `ReferenceGasPrice` are two queries over the same `epoch` (both appear in the live devnet trace of one `Tx.run`); one query can feed both caches.
- `ChainGraphQL.ts:59-60`: `lowestAvailableCheckpoint` and `epochFirstCheckpoint` are read by no code in the repo (the lifecycle uses `Evidence`), yet `ChainInfo` selects `epoch.checkpoints(first:1)` and `serviceConfig.availableRange` for them, and `ChainGrpc` pays a whole extra `GetEpoch` per refresh. Drop the fields or build `Evidence` on them.
- `CheckpointDataGraphQL.ts:176-186`: `list` pages `ListCheckpointNumbers` to enumerate consecutive integers (2 extra requests per 100 checkpoints, measured 102 for 100).
- `PackagesGraphQL.ts:20`: every `GetMoveFunction` also resolves `object(address)` only to choose an error code; ask on the failure path instead.
- `ObjectsGraphQL.ts:18`: batches of 50 where the server takes 200.

Effort S each.

**Resolution:** fixed except the dead `ChainInfo` fields.

**Resolution (dead fields, final batch):** removed. Nothing read `lowestAvailableCheckpoint` or `epochFirstCheckpoint` (the lifecycle's expiry rule uses `Evidence`, which makes its own `GetServiceInfo` / `GetEpoch` calls). `Chain.ChainInfo` is now `chainId`, `chain`, `epoch`, `checkpointHeight`; the GraphQL `ChainInfo` query no longer selects `epoch.checkpoints(first:1)` or `serviceConfig.availableRange`; over gRPC `info` is `GetServiceInfo` alone and the gas price `GetEpoch` with `reference_gas_price` only. The lean spec (`scripts/grpc-lean.ts`, regenerated with `bun run codegen`) prunes `Epoch` to that one field. Lifecycle test world, gRPC/GraphQL offline and live tests updated.
- `ChainInfo` now also selects `referenceGasPrice`, and one query feeds both caches (30 s for info, 1 min for the gas price); `ReferenceGasPrice` is removed. Test: two failures then one success serve both members.
- `CheckpointData.list` enumerates numbers (CT-1): 0 listing requests where there were 2 per 100.
- `GetMoveFunction` no longer selects `object(address)`. A separate `ObjectExists` query runs only when there is no package.
- `MultiGetObjects` batches 200, which is `maxMultiGetSize` on mainnet and testnet, checked live.
- Not changed: `lowestAvailableCheckpoint` and `epochFirstCheckpoint` are still selected, because they are fields of core's `Chain.ChainInfo`. The lifecycle now uses `Evidence.observe` instead of them. Core change needed: drop both fields from `Chain.ChainInfo` and the extra `GetEpoch` from `ChainGrpc`; `ChainGraphQL` can then drop `epoch.checkpoints(first:1)` and `serviceConfig.availableRange`.

### CT-24 · nit · performance · CONFIRMED — codegen does serial work it could share
`packages/effect-sui-codegen/src/Generate.ts:23-29`, `:67`; `src/FromGrpc.ts:90-102`

`sui move summary` runs once per config entry even for the same path (the README's own example runs it twice; ~1 s each with warm dependencies). Config entries, and an on-chain package's dependencies, are loaded one after another.

**Resolution:** fixed. `sui move summary` runs once per directory, however many entries read it. Config entries load 4 at a time, keeping order. Each dependency level of an on-chain package is fetched 8 at a time.

### CT-25 · nit · simplification
- `packages/effect-sui/src/Move.ts:181-189`: `PURE_STRUCTS` has computed keys that call `Address.normalize` at module scope, so it, `pureSchemaOf` and `address` stay in every bundle that imports `Move` (0.7 KB min, plus 0.3 KB of `Address`), even for one schema. Build the table lazily.
- `packages/effect-sui-codegen/src/Render.ts:742`: `safeKey` emits a field named `__proto__` unquoted, which sets the prototype instead of a key (`codegen1.ts` E10).
- `packages/effect-sui/src/graphql/merge.ts:35-48`: `mergeSorted` emits one-item chunks.
- `packages/effect-sui/src/lifecycle/Lifecycle.ts:469-475`: every `reconcileAll` rewrites an `Unknown` entry's `at` and `lastError`, losing when it was first sent and why.

**Resolution:** three of the four bullets fixed; the `Move.ts` one is core.
- `safeKey`: fixed. `__proto__` is emitted as the computed key `["__proto__"]`, because the plain and the quoted forms both set the prototype. However, `Bcs.struct` itself cannot round-trip a field named `__proto__` ("Missing key"). Change needed in `@unconfirmed/effect-bcs` (not core): use own-property access (`Object.hasOwn`, `Object.defineProperty`) in the struct encoder and decoder.
- `mergeSorted`: fixed. It emits the run of the leading source that sorts no later than every other head as one chunk. There is a test.
- `reconcileAll` and `at` / `lastError`: fixed. An `Unknown` entry keeps its first `at`, and its `lastError` when the round has none (CT-25 test).
- `PURE_STRUCTS` in `packages/effect-sui/src/Move.ts`: not changed (core). Core change needed: build the table lazily, e.g. a memoised function, instead of computed keys calling `Address.normalize` at module scope.

### CT-26 · nit · tests
- `scripts/bundle-report.ts` has no program for a generated call, the GraphQL layers or the lifecycle, though the README quotes "~2.6 KB min / 0.8 KB gzip" for a generated call.
- No test for: subscribe throughput (CT-1), a journal listing with a foreign or corrupt key (CT-2), `Checkpoints.list()` with an open end (CT-12), codegen key and name collisions (CT-9, CT-20), two local packages or root-versus-dependency merging (CT-7, CT-8).

**Resolution:** fixed.
- `scripts/bundle-report.ts` gains programs for a hand-written `moveCall`, one generated call (Walrus `blob.burn`), `Tx.run` over GraphQL, and `Lifecycle.run` with the KeyValueStore journal. Rows are added to the README; a generated call adds 2.6 KB min / 1.0 KB gzip, and the README now says 1.0.
- Tests added for every case listed:
  - subscribe throughput: offline, plus a live lag test;
  - a corrupt or foreign journal key;
  - `Checkpoints.list()` with an open end;
  - codegen key and name collisions;
  - two local packages;
  - root-versus-dependency merging.
- One existing live test changed: the GraphQL `CheckpointData` parity check now compares failure statuses without their abort text. gRPC sends the node's debug form and GraphQL sends a sentence; the command and abort code are still compared. It failed on a testnet checkpoint containing an aborted transaction.

## Optimizations and measurements

Bundles, KB minified / gzip (`bundle.ts`, same method as `scripts/bundle-report.ts`):

| Program | Bun | esbuild | Rolldown |
|---|---|---|---|
| Hand-written `Ptb.moveCall` | 88.6 / 30.3 | 89.7 / 31.0 | 92.8 / 30.3 |
| One generated call (Walrus `blob.burn`) | 91.2 / 31.3 | 92.2 / 31.9 | 95.5 / 31.3 |
| Hand-written `Bcs.struct` decode | 82.5 / 28.1 | 81.4 / 28.1 | 89.9 / 29.2 |
| One generated schema (Walrus `Blob`) | 91.0 / 30.9 | 89.7 / 30.9 | 96.3 / 31.4 |
| Read one object, gRPC | 205.8 / 67.2 | 204.6 / 67.8 | 210.2 / 65.9 |
| Read one object, GraphQL | 206.7 / 70.4 | 201.8 / 70.1 | 206.1 / 67.2 |
| `Tx.run`, gRPC (`SuiGrpc.layer`) | 388.7 / 112.4 | 383.9 / 112.2 | 392.3 / 109.0 |
| `Tx.run`, GraphQL (`SuiGraphQL.layer`) | 308.0 / 105.8 | 302.0 / 105.3 | 305.6 / 100.6 |
| `Tx.run`, GraphQL, only the 5 services it needs | 292.1 / 101.1 | 286.2 / 100.8 | 289.7 / 96.4 |
| `Lifecycle.run`, gRPC | 415.7 / 121.6 | 410.3 / 121.5 | 415.9 / 116.7 |
| `Lifecycle.run` + KeyValueStore journal | 421.0 / 123.3 | 415.6 / 123.2 | 421.3 / 118.2 |

- A generated call adds 2.6 KB min / 1.0 KB gzip (README says 2.6 / 0.8). Unused datatypes of the same module are gone under all three bundlers, so the `/* @__PURE__ */` thunks work.
- A generated schema alone adds about 5 KB min over a hand-written one, mostly the Effect modules behind `Move.get`/`Move.call`, which an Effect app already ships.
- GraphQL and gRPC cost the same for one object; for a full `Tx.run` GraphQL is 80 KB smaller (no protobuf descriptors).
- The lifecycle adds 27 KB min / 9 KB gzip to `Tx.run`: its own code is ~37 KB unminified, `Schedule` 12 KB, the rest small Effect additions. The KeyValueStore journal adds 5 KB.

Round trips and latency:
- `CheckpointData.get` over GraphQL: 1 request for a testnet checkpoint, 1–2 on mainnet (more than 50 transactions); 0.22–0.7 s testnet, 0.6–1.4 s mainnet (CT-1).
- `CheckpointData.list` of 100: testnet 102 requests, 9.7 s; mainnet 115 requests, 21.7 s.
- One GraphQL `Tx.run` with coin gas on devnet: `MultiGetObjects` ×2, `ReferenceGasPrice`, `ChainInfo`, `SimulateTransaction`, `ListOwnedObjects`, `ExecuteTransaction`; merging the two chain queries saves one (CT-23).
- KeyValueStore journal: 8 operations per successful submit, 5 achievable (CT-17).
- `reconcileAll`: 11 lookups and 5 s per missing entry at defaults, sequential (CT-5).
- Codegen from chain: Walrus package and its dependencies in 4 requests, 0.6 s, identical to the committed output.
