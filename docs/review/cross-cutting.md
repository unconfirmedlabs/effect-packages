# Cross-cutting review

Scope: concerns that span packages (bundle size, API consistency, dependency hygiene, test suite health, docs). Package internals are in the other review files.

## Summary

- **Health.** `bun run typecheck` passes (7.5 s). The offline suite passed three times in a row with identical counts (1026 pass, 82 skip, 0 fail, 164,069 expects, 49–50 s). The live suite (`SUI_LIVE=1` only) ran twice: 1100 pass / 1 fail, then 1101 pass / 0 fail (226–232 s).
- **The one live failure is a real bug**, not a flaky assertion: a descending `Events.list` silently returns an empty stream about 3% of the time on testnet (X-1).
- **Bundle.** The README table matches the current report. The two largest avoidable costs in our own code are whole-message protobuf descriptors (105 KB of the 389 KB transaction program) and missing `/* @__PURE__ */` annotations in `bcs` and the `sui` core, which keep `@scure/base` and unused schemas in every bundle.
- **Docs.** Three README examples do not compile or run as written. The "As built" notes are accurate: about 320 concrete claims checked across `walrus.md`, `seal.md` and `quorum.md`, with two wrong As-built notes and one code bug found through them.
- **Library imports are clean.** No `effect` barrel import and no workspace barrel import anywhere under `packages/*/src`.
- **Publishing** needs packaging work first (X-5).

Counts: 1 high, 6 medium, 9 low, 4 nit.

Not reproduced: the known flake in `packages/walrus/test/live.gateway.test.ts` passed in both live runs (10.4 s and 10.3 s); see the Walrus review.

## Findings

### X-1 · high · correctness · CONFIRMED
**`Events.list({ descending: true })` without `start` silently returns nothing when the pruning floor moves.**
`packages/sui/src/grpc/EventsGrpc.ts:50-70`, `packages/sui/src/grpc/scan.ts:83-99` (`pinned`).

- `pinned` reads `lowest_available_checkpoint` with `GetServiceInfo`, then sends it as `start_checkpoint`. The floor advances continuously on testnet (five different values in 60 calls, in steps of 10–30 checkpoints).
- If the floor passes the pinned start before `ListEvents` is served, the node answers `OUT_OF_RANGE`. `EventsGrpc.ts:69` turns every `OUT_OF_RANGE` into `Stream.empty`, including one on the first request with no item emitted.
- Measured on `fullnode.testnet.sui.io`: 2 of 60 `events.list({ descending: true }).pipe(Stream.take(1))` calls returned zero events; the same request by hand returned `OUT_OF_RANGE: requested data below earliest available; lowest available checkpoint is 405807407` in 2 of 60.
- This is what failed `packages/sui/test/extensions.live.test.ts:87` in live run 1 (`expect(filtered.length).toBeGreaterThan(0)`, received 0).
- Fix: on `OUT_OF_RANGE`, re-read the floor and resume from the last watermark with the new start; end the stream only when the watermark is at or below the new floor. Never swallow it before the first item. Effort S–M.

**Resolution:** fixed as proposed. `resumable` takes a recovery hook; a descending scan to the floor re-reads it on `OUT_OF_RANGE` and resumes from the last watermark with the new start, ending only when what is left is below the floor; without progress it fails typed after 3 tries. Other `OUT_OF_RANGE`s (an explicit start) are no longer swallowed. Offline tests in `core-review.test.ts`; live on testnet, 20 descending `take(1)` lists all returned an event, and the full live suite passed.

### X-2 · medium · docs · CONFIRMED
**Three README examples do not compile or run as written.** Checked by transcribing every README snippet into one file and running `tsc` under the repo's `tsconfig.base.json`; everything else compiled.

| README line | Problem | Fix |
|---|---|---|
| 46 | `import * as Quorum from "@unconfirmed/quorum"` then `Quorum.run`: TS2339. `packages/quorum/src/index.ts:1` is `export * as Quorum`, so the root namespace only has the key `Quorum`. | `import { Quorum } from "@unconfirmed/quorum"`, or make the index `export * from "./Quorum.ts"` like the other single-module packages (X-18). |
| 118 | `yield* Quilt.encode(entries, nShards)`: `Quilt.encode` returns a `Result` (`packages/walrus/src/Quilt.ts:90-93`). A `Result` is not yieldable in Effect 4.1.6: TS2345, and at runtime the fiber dies with `Not a valid effect: success(1)`. | `yield* Effect.fromResult(Quilt.encode(...))`. |
| 90 | "`onStep` receives each step as plain JSON". It receives the decoded `Write.Step` with `Uint8Array` fields (`packages/walrus/src/Write.ts:154`, `:846`), and `resume` takes the same type (`:152`). `JSON.stringify` in `onStep` then `JSON.parse` into `resume` breaks. | Say that `Schema.encode(Write.Step)` gives the JSON and `Schema.decode` gives it back. |

Also: line 205 (`const [coin] = yield* Ptb.splitCoins(...)` then `[coin]`) fails under `noUncheckedIndexedAccess`, which this repo uses; `splitCoins` (`packages/sui/src/Ptb.ts:182`) returns an array, not a tuple typed by `amounts`. Returning a mapped tuple would remove the `coin!` every caller writes. Effort S for all.

### X-3 · medium · bundle · CONFIRMED
**Module-level calls without `/* @__PURE__ */` in `bcs` and the `sui` core keep unused code in every bundle.**
Walrus and Seal annotate consistently; the older packages do not. 925 module-evaluation-time calls lack the annotation; the files that matter are `packages/bcs/src/Bcs.ts:86-122` (22), `packages/sui/src/Address.ts` (10), `TransactionData.ts` (52), `Signer.ts`, `Objects.ts`, plus `packages/walrus/src/Status.ts` (11) and `BlobId.ts` (5).

- Consequence: any program that touches `Bcs.ts` ships every primitive schema, and through `Bcs.Digest` all of `@scure/base` (3.1 KB), whether or not it uses base58.
- Measured by annotating a scratch copy (KB minified / gzip, change against today):

| Program | `Bcs.ts` only (23 annotations) | `bcs` + `sui` | every package |
|---|---|---|---|
| Read one object | bun −6.2/−2.3, esbuild −5.1/−1.9, rolldown −10.6/−3.6 | −6.8/−2.5, −6.9/−2.4, −11.1/−3.8 | same |
| Verify, Ed25519 only | −2.8/−0.8, −1.7/−0.5, −3.2/−0.8 | −5.0/−1.6, −3.8/−1.2, −5.4/−1.6 | same |
| Walrus: read via aggregator | −4.9/−1.8 all three | −5.2/−1.9 | −12.7/−4.3, −12.5/−4.4, −14.0/−4.7 |
| Seal: encrypt + decrypt | 0 | −4.6/−1.6, −4.5/−1.5, −1.6/−1.0 | −5.1/−1.7, −4.9/−1.6, −1.6/−1.0 |

- With barrel imports under esbuild the aggregator program drops 33.8 KB.
- Caveat: Rolldown keeps annotation comments in minified output (X-14), so annotating every nested call adds up to 3 KB raw there. Annotate module-level declarations and class `extends`, as `walrus/src/Errors.ts` does.
- Fix: annotate `Bcs.ts` first, then the `sui` core and `walrus/Status.ts`, `BlobId.ts`. Effort S.

**Resolution (`bcs` and `sui`):** module-level declarations and `class … extends` calls annotated in `bcs` and every non-generated `sui` source (Walrus files left to the Walrus fix). Measured against the same tree with the annotations stripped (KB min / gzip, Bun / esbuild / Rolldown): read one object −6.6/−2.4, −5.5/−2.1, −11.3/−3.8; verify Ed25519 only −4.6/−1.4, −3.4/−1.0, −5.2/−1.4; `TransactionData` decode −4.4/−1.3, −4.2/−1.3, −3.9/−1.3; Bcs u64 decode −1.8/−0.6, −1.0/−0.4, −6.1/−2.1; the full transaction program −2.4/−0.7, −2.4/−0.7, +0.5/−0.2.

### X-4 · medium · bundle · CONFIRMED (cost), prototype measured (saving)
**Protobuf descriptors are the largest part of our own code, and most of them describe fields nothing reads.**
`packages/sui/src/grpc/generated/rpc.ts`, `packages/sui/src/grpc/Rpc.ts`, `packages/sui/scripts/codegen-grpc.ts`.

- `rpc.ts` is 104.9 KB of the 388.7 KB "build + resolve + sign + execute" program (27%). A chunk is a whole message, so a handle ships every field its messages reach.
- `ChainGrpc` ships 20.5 KB (`Epoch` → `SystemState` → `ValidatorSet` → `Validator` …) to read three scalars. `TransactionsGrpc` ships 61.4 KB to read `digest` and three `effects` paths.
- `SuiGrpc.layer` adds every capability. The same program with only the layers `Tx.run` needs (Chain, Packages, Transactions, Coins, Objects) is 361.2 / 107.5 instead of 388.7 / 112.4 (bun).
- Prototype: pruning the descriptors of four handles (`GetEpoch`, `GetTransaction`, `ExecuteTransaction`, `SimulateTransaction`) to the fields in their read masks and requests. Offline tests still pass and `packages/sui/test/live.test.ts` executed on devnet with it.

| Program (bun, KB min / gzip) | Today | Pruned | Change |
|---|---|---|---|
| `Tx.run` with only the needed layers | 361.2 / 107.5 | 317.3 / 101.4 | −43.9 / −6.1 |
| `TransactionsGrpc` only | 328.6 / 100.8 | 292.2 / 95.8 | −36.4 / −5.0 |
| `ChainGrpc` only | 285.9 / 94.2 | 268.8 / 91.8 | −17.1 / −2.4 |
| `SuiGrpc.layer` (everything) | 388.7 / 112.4 | 377.0 / 110.6 | −11.7 / −1.8 |

- The last row moves little because checkpoint handles still reach the full `ExecutedTransaction` graph; they need the same treatment.
- Fix: have `codegen-grpc.ts` emit per-handle pruned chunks from each service's read-mask paths (protobuf decoders skip unknown fields), and document the minimal layer set for `Tx.run` in the README. Effort M.

**Resolution:** done for all 15 handles the services call, checkpoint ones included, checked at encode time; `SuiGrpc.layerCore` recommended in the README. Bun, comments stripped: `Tx.run` 388.3 / 112.3 → 310.9 / 101.0 (`layerCore`), 337.8 / 105.6 (`SuiGrpc.layer`); read one object 205.8 → 198.7.

### X-5 · medium · publishing · CONFIRMED
**Nothing here can be published as it stands.** Every `packages/*/package.json`.

- `exports` point at `./src/*.ts`. There is no build, no `types`, no `files`. Node refuses to strip types under `node_modules`, and a consumer's `tsc` typechecks our sources under their own flags (`skipLibCheck` does not cover `.ts`).
- `effect` is an exact `dependencies` entry (`4.1.6`) in all 17 packages. An app on any other Effect version gets two runtimes (about 35 KB for `Effect` + `Layer` alone, more with `Schema`) and two sets of service tags. It should be a `peerDependency`.
- No `files`: tests, fixtures (`packages/walrus/test/fixtures/*.json`, `packages/sui-codegen/test/`), scripts and `sui-codegen.config.ts` would ship.
- `"./*": "./src/*.ts"` makes internals public: `@unconfirmed/walrus/internal/gateway`, `@unconfirmed/sui/grpc/scan`, `@unconfirmed/sui/grpc/generated/rpc`.
- `version` is `0.0.0`; no `repository`, `description` or per-package `LICENSE` file; `sui-codegen`'s `bin` is a `.ts` file with a `bun` shebang.
- Fix: a build step (or an explicit "TypeScript source, bundlers only" contract), `peerDependencies` for `effect`, `files`, and an `exports` map that excludes `internal/` and `generated/`. Effort M.

### X-6 · medium · api · CONFIRMED
**79 of 94 error classes have an empty `message`.**

- A `Schema.TaggedError` takes its `message` from a field of that name. 15 classes have one. The rest put the explanation in `reason` (34 classes), `issue` (6) or `description` (2), or have none.
- Result: `String(new InvalidSliver({ reason: "bad header" }))` is `"InvalidSliver"`, `e.message` is `""`, and `Cause.pretty` prints `ObjectNotFound: `. An `Effect.runPromise` rejection, a log line or an error tracker shows the tag and nothing else.
- Related hazard: these constructors validate their fields and throw `Schema validation failed` on a mismatch (`new BlobNotFound({ blobId: "x" as BlobId })`, `new RpcError({ ..., message: undefined })`). The call sites I checked guard their inputs (`GrpcWeb.ts:53`, `StorageNode.ts:94`, `KeyServerApi.ts:170`, `EnokiHttp.ts:57`), so this is a note, not a bug.
- Fix: one convention. Either name the free-text field `message` everywhere, or add `override get message()` that renders the fields. Effort M (mechanical, touches public field names).

### X-7 · medium · correctness · CONFIRMED (code read; reproduced by the delegated doc audit)
**`ThresholdNotMet.reason` is `"unreachable"` instead of `"denied"` when a server's keys are cached.**
`packages/seal/src/Keys.ts:142` and `:277`.

- `reasonOf` computes `askableWeight - denied < threshold - cachedWeight`, but line 277 passes `totalWeight`, which includes the cached servers (`:194`). The cached weight is subtracted twice.
- Scenario: 3 of 3, one server cached, one `NoAccess`, one slow. `3 − 1 < 3 − 1` is false, so the reason is `"unreachable"`. Without the cache the same case is `"denied"`, as `docs/design/seal.md:646` says it should be.
- Fix: compare `totalWeight - denied < threshold`, or pass the uncached weight. Effort S. (Seal internals; listed here because the doc check found it.)

### X-8 · low · api · CONFIRMED
**`SuiGrpc.layer` hides `GrpcWeb`, so everything else that needs it builds a second transport.**
`packages/sui/src/grpc/index.ts:59-68` ends in `Layer.provide(GrpcWeb.layer(options))`.

- `ZkLoginVerifierGrpc.layer`, `sui-lifecycle`'s `EvidenceGrpc.layer` and the README's escape hatch (`grpc.unary(Rpc.NameService_LookupName, …)`, line 280) all require `GrpcWeb`. With `SuiGrpc.layer` in place they fail with `Service not found: @unconfirmed/sui/GrpcWeb` until the caller adds `GrpcWeb.layer({ baseUrl })` again, repeating `baseUrl` and `headers`.
- Fix: `Layer.provideMerge`, with `Services | GrpcWeb` in the type. Same for `SuiGraphQL.layer` and `GraphQLProtocol`. Effort S.

### X-9 · low · api · CONFIRMED
**Transport options differ by package for the same concepts.**

| Concept | Names in use |
|---|---|
| Endpoint | `baseUrl` (`GrpcWeb`), `url` (`SuiGraphQL`, `Aggregator`, `Publisher`), `host` (`UploadRelay`, though it is a full URL), `apiUrl` (`EnokiHttp`) |
| Request timeout | `requestTimeout` in Walrus and Seal (10–60 s defaults); none in `GrpcWeb`, `SuiGraphQL`, `EnokiHttp` |
| Trace headers | `tracerPropagation` (default off) in Walrus, Seal, Enoki; no option in `GrpcWeb` or `SuiGraphQL`, which send `b3` and `traceparent` on every call |
| Extra headers | `headers` on gRPC, GraphQL and the gateways; none on `UploadRelay` |
| Per-member retry | `schedule` + `while` (`Quorum`), `retry` (Walrus, Seal), `gapRetry` as a duration (`CheckpointData.follow`) |
| `maxEpoch` | `bigint \| number \| string` (`sui-zklogin`), `number` (`sui-enoki`) |

- A hung full node hangs `Tx.run` forever unless the caller adds a timeout. Mysten's public endpoints answer preflights with `access-control-allow-headers: *` (checked on testnet gRPC and both GraphQL hosts), so the trace headers only break browsers against providers with a strict allow-list (PLAUSIBLE for those).
- `RpcError.retryable` exists but only `sui-lifecycle` and Seal's key-server lookup act on it. Walrus `System` / `Committee` reads and the `Resolve` pipeline fail on the first `UNAVAILABLE` or 429.
- Fix: one `TransportOptions` shape (`url`, `headers`, `requestTimeout`, `tracerPropagation`) shared by every HTTP layer. Effort M.

### X-10 · low · deps · CONFIRMED
**Dependency lists do not match the imports.**

- Unused: `@noble/hashes` in `packages/sui-secp256k1`, `packages/sui-secp256r1` and `packages/sui-zklogin` (no import in `src` or `test`).
- Type-only: `@wallet-standard/base` in `packages/sui-wallet` (`import type` only) belongs in `devDependencies` or `peerDependencies`.
- Undeclared test dependencies that resolve only because the root lists every workspace package: Seal tests import `sui-wallet`, `sui-secp256k1`, `sui-secp256r1`; Walrus tests and scripts import `sui-codegen`, `sui-secp256k1`, `sui-secp256r1`; `sui-mnemonic` tests import `sui-mldsa65` and both secp packages; `sui-mldsa65`, `sui-passkey` and `sui-zklogin` tests import `sui-multisig`. Only `sui-multisig` and `walrus` declare any `devDependencies`.
- Every `src` import is declared. Pins are consistent: `effect` 4.1.6 everywhere, `^2.3.0` for noble and scure, exact for `@mysten/walrus-wasm` and `poseidon-lite`.
- Effort S.

### X-11 · low · simplification · CONFIRMED
**The same byte helpers are written per package, and three encoder families are in use.**

- `sameBytes`: 9 copies (`sui/Tx.ts:69`, `sui/grpc/scan.ts:23`, `sui-multisig/index.ts:77`, `sui-passkey/Passkey.ts:92`, `sui-zklogin/ZkLogin.ts:55`, `sui-enoki/Sponsor.ts:84`, `walrus/Write.ts:249`, `walrus/Read.ts:374`, `walrus/QuiltRead.ts:260`).
- Hex: hand-written in `bcs/Bcs.ts:330`, `sui/Address.ts:13`, `sui/CoinReservation.ts:41`, `sui-zklogin/PublicIdentifier.ts:16`; `@noble/hashes/utils` in Seal.
- Base64: `@scure/base` (`sui`, `sui-wallet`, `seal`), `effect/encoding/Base64` (`walrus/UploadRelay.ts`), `Schema.Uint8ArrayFromBase64` (`sui-graphql/convert.ts:35`), `btoa` / `atob` (`sui-enoki/EnokiHttp.ts:39`, `sui-zklogin/Jwt.ts:60`, `sui-graphql/convert.ts:299`), hand-written base64url in `walrus/Quilt.ts:430`.
- `concat`: `seal/Kdf.ts:29`, `seal/Dem.ts:72`, `sui-passkey/Passkey.ts:133`, `sui/grpc/GrpcWeb.ts:76`.
- Size: `effect/encoding/Base64` + `Hex` is 2.0 KB and already ships with `Schema`; `@scure/base` is 3.2 KB for base58 alone and 8.0 KB with base64, bech32 and base64url. Using Effect's base64 and hex and keeping `@scure/base` for base58 and bech32 saves up to about 3 KB in programs that use `PrivateKey`, `TransactionJson` or a wallet.
- Fix: one `Bytes` module (in `@unconfirmed/bcs`, which everything already depends on). Effort S.

### X-12 · low · tests · CONFIRMED
**Test support is duplicated or shared through relative paths into other packages.**

- `recordObject`, `restoreObject`, `objectsLayer`, `loadFixture`, `fixturesDir`, `BIGINT_OWNER_FIELDS` are in both `packages/walrus/test/fixtures.ts` and `packages/seal/test/fixtures.ts`; `mystenBcs` / `mystenUtils` in both `oracle.ts` files; `recorded`, `synthesized`, `scripted` in two or three `support.ts` files.
- The Sui CLI keystore loader (`client.yaml` regex plus `PrivateKey.decodeKeystore`) is copied between `packages/walrus/test/live.write.test.ts:98-100` and `packages/seal/test/live.owned.test.ts:66-68`.
- Eight packages import `../../sui/test/support.ts` (`live`, `faucet`, `grpcLayer`); Seal imports `../../sui-wallet/test/FakeWallet.ts`; Enoki imports `../../sui-zklogin/test/fixtures.ts`.
- `const run =` is defined in 22 test files, `ok` and `failure` in 12 each, `b64` in 11.
- `faucet` (`packages/sui/test/support.ts:65`) has no timeout and no retry on 429, and a live run calls it about 17 times from one IP. It did not fail in two runs, but it is the obvious next flake.
- Fix: a private workspace package (`packages/test-support`) with the recorded-`Objects` layer, the oracle helpers, the keystore loader and a faucet with retry. Effort M.

### X-13 · low · tests · CONFIRMED
**A quarter of the offline suite's time is one file stepping virtual time 10 ms at a time.**

- `packages/seal/test/keys.test.ts`: 12.3 s of 49 s. It steps `TestClock` in 10 ms increments through 10 s timeouts (`:48`, `:72-92`); "Timeout and definitive errors are not retried" alone takes 4.4 s.
- Other slow files are inherent: `walrus/test/encoder.test.ts` 7.9 s (WASM at n = 1000), `seal/test/envelope.test.ts` 6.9 s (255 shares, 3.5 s), `seal/test/parity.envelope.test.ts` 3.0 s, `walrus/test/messages.test.ts` 2.6 s.
- `packages/bcs/test/` is empty. BCS is covered only through `packages/sui/test/parity.test.ts` and its users.
- Fix: step to the next scheduled wake-up instead of a fixed 10 ms (or use larger steps outside the asserted windows). Effort S.

### X-14 · low · bundle · CONFIRMED
**The Rolldown column counts `/* @__PURE__ */` comments, which Rolldown keeps in minified output.**
`scripts/bundle-report.ts` (`rd.generate({ format: "esm", minify: true })`).

- The write-through-nodes bundle contains 1,017 such comments, 14.2 KB of its 455.5 KB.
- With `comments: false`: build + sign + execute is 379.0 / 108.1 (table: 392 / 109) against `@mysten` 373.3 / 104.8 (table: 383 / 106). The Seal program is 473.9 against 460.1, so "20 KB larger" (README:400) becomes 13.8 KB.
- Our code carries more annotations than Mysten's, so the column overstates our size relative to theirs by about 6 KB.
- Fix: pass `comments: false` (or `{ annotation: false }`) and regenerate the table. Effort S.

**Resolution:** `scripts/bundle-report.ts` strips comments under every bundler (Rolldown `comments: false`, esbuild `legalComments: "none"`, Bun's `/*! */` legal comments removed after bundling); core and generic README rows regenerated.

### X-15 · low · docs · CONFIRMED (found by the delegated doc audits, each reproduced with a script or pinned to a line)
**Design-doc and README statements the code contradicts.**

- `README.md:160`: "A short or unprefixed id is refused". `packages/seal/src/Config.ts:51,60` accepts 64 hex digits without `0x` for configured servers (`seal.md:420` says so).
- `docs/design/seal.md:566` (As built S5): "every function given one dies". `SessionKey.verify` (`packages/seal/src/SessionKey.ts:354-364`) accepts a spread copy.
- `docs/design/seal.md:655` (As built S6): "every askable server is in `unsettled`". `packages/seal/src/Keys.ts:202` omits servers whose keys are cached.
- `docs/design/walrus.md:191`: `QuiltRead.ts` is listed as importing `@unconfirmed/quorum`; only `Read.ts:23` and `Write.ts:30` do.
- `README.md:135` and `docs/design/walrus.md:787`: "32-byte blobs"; `packages/walrus/test/live.write.test.ts:314-358` also writes a 445,556-byte quilt.
- Everything else checked in the As-built notes was correct (about 170 Walrus claims, about 150 Seal and Quorum claims).

### X-16 · low · performance · CONFIRMED
**`Chain` over gRPC calls `GetEpoch` twice for one resolve.**
`packages/sui/src/grpc/ChainGrpc.ts:13-30`: `info` asks for `epoch, first_checkpoint` and `referenceGasPrice` asks for `epoch, reference_gas_price` separately. The live log shows both in one `Tx.run` (`GetEpoch`, `GetBalance`, `GetServiceInfo`, `GetEpoch`). One request with both paths, cached once, saves a round trip per cold resolve. Effort S.

### X-17 · nit · docs · CONFIRMED
**Small inaccuracies in the README bundle section.**

- WASM size: "358 KB" (lines 133, 399) is decimal; the report prints 349.4 KB with the `/1024` every other figure uses.
- Line 407: "26 KB for a bare `Effect.runPromise`" under "Measured with Rolldown"; Rolldown gives 22.2, esbuild 26.1.
- Line 401: "esbuild grows by ~40 KB per program" with barrel imports; measured +3.4 to +88.3 KB (24–60 for most).
- Table rounding: write through nodes is 453.8 / 447.7 / 455.5 (table: 453 / 447 / 455); relay is 458.8 / 452.7 / 460.7 (table: 458 / 452 / 460).
- "Extra deps" column omits `@scure/base` for `sui`, `sui-passkey`, `sui-wallet`, `sui-zklogin`, and `@noble/hashes` for `sui-passkey`.

### X-18 · nit · api · CONFIRMED
**Package roots export in three shapes.**

- Namespaces only: `sui`, `walrus`, `seal`, `sui-lifecycle`, `sui-wallet`, `sui-codegen`, `bcs`, `quorum`.
- Flat: `sui-passkey`, `sui-secp256k1`, `sui-secp256r1`, `sui-multisig`, `sui-mnemonic`, `sui-mldsa65`.
- Mixed: `sui-zklogin` (`export * from "./ZkLogin.ts"` plus namespaces), `sui-enoki`.

So `import * as X from "@unconfirmed/<pkg>"` works for the flat ones and fails for `quorum` (X-2). Also `GrpcWeb.layer` is a static on the service class, imported by name, while every other layer is a module-level `layer`; `sui-zklogin`'s doc comment writes `GrpcWeb.GrpcWeb.layer`. Core capability services have no accessors (`Effect.flatMap(Effect.service(Objects.Objects), (o) => o.get(id))`), while Walrus and Seal export them (`Aggregator.blob(id)`).

### X-19 · nit · api · CONFIRMED
**`BcsDecodeError` is a `Data.TaggedError`** (`packages/bcs/src/Bcs.ts:461`) in a package that already ships `Schema`. Quorum's two `Data.TaggedError`s are justified (generic, no `Schema`); this one is not.

### X-20 · nit · tests · CONFIRMED
**`scripts/bundle-report.ts` is outside `bun run typecheck`, and nothing runs the checks automatically.**

- The root `tsconfig.json` includes `packages/*/{src,test,scripts}` only. Every other `.ts` file in the repo is covered (305 files). The script does typecheck clean when included.
- There is no CI configuration, so typecheck, tests and the Seal containment checks in the bundle report run only by hand.
- Fix: add `"scripts"` to `include`. Effort S.

## Optimizations

Measured, KB minified / gzip, bun unless stated.

| Change | Saving | Finding |
|---|---|---|
| Prune gRPC descriptors to read-mask fields (4 handles prototyped) | −43.9 / −6.1 on a `Tx.run` program with minimal layers; −17.1 / −2.4 for `ChainGrpc` alone | X-4 |
| Compose only the layers `Tx.run` needs instead of `SuiGrpc.layer` | −27.5 / −4.9 | X-4 |
| Annotate `Bcs.ts` module-level calls | −6.2 / −2.3 read one object; −4.9 / −1.8 aggregator; −1.7 / −0.5 Seal parse | X-3 |
| Annotate `bcs` + `sui` + Walrus `Status.ts` / `BlobId.ts` | −12.7 / −4.3 aggregator; −5.0 / −1.6 verify; −5.1 / −1.7 Seal full | X-3 |
| Strip annotation comments in the Rolldown measurement | −13 to −16 raw on the large programs, about −1 gzip (measurement only) | X-14 |
| Effect's base64 / hex instead of `@scure/base`'s | up to about −3 | X-11 |
| One `GetEpoch` per resolve | one round trip | X-16 |
| Adaptive `TestClock` stepping in `seal/test/keys.test.ts` | up to about 10 s of the 49 s offline suite | X-13 |

**`Schema` pulled in by a single error class.** In isolation the cost is real: one `Schema.TaggedError` is 73.9 / 25.1 against 13.7 / 5.1 for `Data.TaggedError`. In practice nothing is saved by switching, because every report program except `Quorum.run` and `Bft` + `Encoding` also reaches `Schema` through BCS, `Address` or `BlobId`. The one place a redesign would pay is the gateway path: an aggregator read with `HttpClient` and a `Data.TaggedError` is 88.5 / 29.8 against 144.0 / 48.5 today (131.3 / 44.2 after X-3). That needs `BlobId`, `Status` and `GatewayError` off `Schema`, which goes against the repo's convention; I list it as a trade-off, not a recommendation.

**README bundle table.** Current numbers match the table within rounding (X-17). The Effect-runtime figures hold: `Effect` + `Layer` 33.7 / 11.7, `HttpClient` +52 / +16, `Schema` +41 / +13 (Rolldown).
