# A ground-up Effect implementation of the Sui, Walrus and Seal SDKs

Exploration, 2026-11-26. Grounded in a working spike (`spike/`, ~1,650 lines, 15 passing tests including live testnet reads and a devnet transaction executed end to end) and a read-through of `@mysten/sui` 3.0.1, `@mysten/walrus` 2.0.1, `@mysten/seal` 2.0.1, `effect` 4.1.6 and `@unconfirmed/sui-effect` 0.6.0.

## TL;DR

- **It's feasible now in a way it wasn't a year ago.** Sui 3.0 deleted the JSON-RPC transport, so the whole read/write surface is gRPC(-web) plus GraphQL. Effect 4.1.5+ ships `effect/protobuf` (descriptor-driven protobuf codec), `effect/graphql`, `effect/crypto` (WebCrypto Ed25519/P-256), `HttpClient`, `RequestResolver` and `Codegen`. A ground-up SDK needs only `effect`, `@noble/hashes`, `@noble/curves` and `@scure/base`/`bip39`/`bip32`, plus `@mysten/walrus-wasm` for erasure coding. None of `@mysten/sui`, `@protobuf-ts/*`, `valibot`, `gql.tada`, `graphql` or `dataloader` is needed.
- **The spike proves the risky parts.** BCS declared as Effect Schemas serializes `TransactionData` byte-for-byte like `@mysten/sui`. gRPC-web over `HttpClient` + `effect/protobuf` works against a live full node, server-streaming included. A builder where *a PTB is an Effect* produces bytes identical to `Transaction.build`. Concurrent object reads coalesce into one `BatchGetObjects`. The Ed25519 signer produces identical signatures. A real transaction executed on devnet.
- **What changes compared with `sui-effect`.** `sui-effect` puts Effect *around* a Promise SDK: the SDK owns the program's shape, and Effect owns the edges. Built from the ground up, Effect owns the shape. Batching, caching, cancellation, retries, streams, typed errors and test seams are Effect features in every layer, not adapters bolted onto the outside.
- **Keep the best of `sui-effect`.** Its outcome taxonomy (`applied` / `not_applied` / `unknown`), crash-safe journal, reconcile logic and "objects, not history, are evidence" rules are good domain design. They port unchanged onto the new core. The criticism is of where the boundary sits, not of that domain work.
- **Walrus and Seal benefit most.** Both SDKs hand-roll weighted-quorum races with mutable counters, `AbortController`s and `new Promise`. Both have real bugs because of it (hangs, double settles, no retries, unbounded caches). One shared `quorum` combinator plus `Schedule`/`Cache`/scoped resources replaces all of it.

---

## 1. Why `sui-effect` reads as a wrapper

`sui-effect` 0.6.0 states its purpose plainly: *"a light wrapper around the official `@mysten/sui` 2.x SDK … The SDK keeps doing BCS, transaction building, signing and transport."* Given that scope it is carefully done. But the scope itself is the ceiling.

| Concern | In `sui-effect` | Consequence |
|---|---|---|
| Transport | `Effect.tryPromise` around `client.core.*`, forwarding an `AbortSignal` | Retries and timeouts are layered *over* the SDK's own transport behaviour. `requestTimeout` exists because "the SDK's own `timeout` only sets a gRPC header and bounds nothing on a hung connection". |
| Errors | `mapSdkError` reverse-engineers SDK exceptions. It walks `cause` chains for gRPC status names, HTTP codes and `TypeError`s, and special-cases `SimulationError` wrapping transport failures | The error taxonomy is a *guess* about another library's internals. It breaks when that library changes. (3.0 already changed fetch failures from `INTERNAL` to `UNAVAILABLE`.) |
| Types | SDK types (`SuiClientTypes.*`) plus parallel branded Schemas, with converters between them | Two models of every object. The "BCS bridge" re-serializes parsed values to detect trailing bytes. |
| Transactions | The SDK's mutable `Transaction` class, its plugin chain and `tx.add(asyncThunk)` | Recipes compose by mutating a shared object. Their chain-data needs and failure modes are invisible to the type system. |
| Batching and caching | None of its own. (The SDK has none either; Walrus brings `dataloader`.) | N independent object reads mean N round trips. |
| Testing | `ScriptedSuiCore` subclasses the SDK's `CoreClient` so the SDK's resolver runs over scripted answers | Tests are bound to the SDK's internal call pattern. |
| Breadth | A 1:1 mirror of `TransportMethods`, with a type test enforcing completeness | The surface tracks Mysten's API decisions rather than the program's needs. |

None of this is a quality problem; it is a boundary problem. As long as `@mysten/sui` sits underneath, Effect can only decorate calls, not structure the program.

## 2. What changed in the ecosystem

1. **`@mysten/sui` 3.0 removed JSON-RPC** (`f43f64d`): "Use `SuiGrpcClient` … or `SuiGraphQLClient`." The transport problem shrinks to gRPC-web (binary protobuf over HTTP POST, server streaming for `List*`/`Subscribe*`) plus GraphQL (with SSE subscriptions).
2. **The gRPC API is described by `.proto` files** in `MystenLabs/sui-apis`. `protoc` compiles them to a 70 KB `FileDescriptorSet`.
3. **Effect 4.1.5 added `effect/protobuf`.** It takes the descriptor set and encodes/decodes plain objects with no code generation. It already handles proto3 presence, oneofs as `{ _tag, value }`, 64-bit as `bigint` and unknown fields.
4. **Effect 4.x ships the rest of the platform.** `HttpClient` (interruption, middleware, tracing), `RequestResolver` (batching, dedup, caching), `effect/graphql` (typed operations, cursor pagination, an aliased-batching resolver), `effect/crypto` (Ed25519, ECDSA P-256 via WebCrypto, `SecureRandom`), `Codegen` (a TypeScript module builder plus Schema-to-code), `SchemaBinary` (a precedent for AST-derived binary codecs) and `KeyValueStore`.
5. **What Effect doesn't cover** is exactly the curve and hash primitives: BLAKE2b, SHA3, secp256k1, BLS12-381 and Poseidon (for zkLogin). Those stay on `@noble/*`. They are primitives, not SDKs, so depending on them doesn't make the result a wrapper.

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│ @x/walrus           @x/seal               your app / codegen'd packages    │
│  WalrusClient        SealClient            Move bindings = BCS Schemas +   │
│  (quorum, encode)    (threshold, IBE)      typed PTB recipes               │
├────────────────────────────────────────────────────────────────────────────┤
│ @x/sui/tx      Ptb (builder-as-Effect) · Tx.resolve · sign · execute ·     │
│                lifecycle/journal/reconcile (ported from sui-effect)        │
├────────────────────────────────────────────────────────────────────────────┤
│ @x/sui/client  SuiClient service: domain types out, typed errors,          │
│                Request batching + caching, Streams for List*/Subscribe*    │
├───────────────────────────────┬────────────────────────────────────────────┤
│ @x/sui/grpc  GrpcWeb          │ @x/sui/graphql  effect/graphql operations  │
│ (HttpClient + effect/protobuf)│                                            │
├───────────────────────────────┴────────────────────────────────────────────┤
│ @x/sui/core (pure, sync, no services): Bcs · Types · TypeTag · digests ·   │
│ intents · addresses · signature schemes · keys                             │
├────────────────────────────────────────────────────────────────────────────┤
│ @x/quorum (shared): weighted first-k-of-n with interruption, per-member    │
│ Schedule, typed per-member failure set. Used by Walrus and Seal.           │
└────────────────────────────────────────────────────────────────────────────┘
          effect · @noble/hashes · @noble/curves · @scure/* · walrus-wasm
```

Rules that hold in every layer:

- **The core is pure and synchronous.** BCS, digests and transaction data are plain functions returning `Result`, usable without a runtime. Effect services start at I/O.
- **One model per concept.** The BCS Schema *is* the TypeScript type, the validator and the wire format. Domain classes come from `Schema.decodeTo`, not hand-written converters.
- **Errors are decided where they happen.** The transport knows its status code, and `retryable` is computed once from that code. Nothing downstream parses messages or walks causes.
- **Every seam is a Layer.** `HttpClient` → `GrpcWeb` → `SuiClient` → `Tx`. A test replaces any one of them.
- **No Promises and no `AbortSignal` in the public API.** Interruption is the cancellation mechanism. A thin `ManagedRuntime` facade can offer Promises to non-Effect users.

## 4. Key design decisions (all exercised in the spike)

### 4.1 BCS is Schema (`spike/src/bcs/Bcs.ts`)

```ts
export const ObjectRef = Bcs.struct({ objectId: Bcs.Address, version: Bcs.u64, digest: Bcs.Digest })
export const Command = Bcs.enum({
  MoveCall: Bcs.struct({ package: Address, module: Bcs.string, function: Bcs.string,
                         typeArguments: Bcs.vector(TypeTag), arguments: Bcs.vector(Argument) }),
  TransferObjects: Bcs.struct({ objects: Bcs.vector(Argument), address: Argument }),
  ...
})
type Command = typeof Command.Type
// { _tag: "MoveCall"; package: Address; module: string; ... } | { _tag: "TransferObjects"; ... } | ...
```

- Each combinator returns a real `Schema` and attaches the byte layout as a `bcs` annotation. The reader/writer is compiled from the layout, never from walking an arbitrary AST.
- Because these are Schemas, you also get validation (a `u8` of 300 is a typed failure, not truncated bytes), JSON, equality, Arbitrary for property tests, and composition: `Bcs.bytesOf(MyStruct)` is a `Schema.Codec<MyStruct, Uint8Array>` you can drop into a protobuf field or a `KeyValueStore`.
- Representation choices: `u64`/`u128`/`u256` → `bigint` (never `string | number | bigint` unions); `option` → `Option`; enums → `_tag` unions. A variant whose payload is a struct is flattened, so commands read naturally.
- Verified: `TransactionData` with shared objects, nested generic type tags, `MakeMoveVec(Some(vector<Coin<SUI>>))` and a `ValidDuring` expiration encodes byte-for-byte like `@mysten/sui`, and decodes `@mysten/sui`'s bytes.
- **Not yet measured: throughput.** Validation on encode costs something. `encode` validates once, then the writer is a tight loop. A benchmark against `@mysten/bcs` is the first follow-up. An `unsafeEncode` that skips validation is the escape hatch if it matters.

### 4.2 gRPC-web without a protobuf runtime (`spike/src/grpc/GrpcWeb.ts`, 183 lines)

- Framing is 5 bytes: a flag and a big-endian length. Trailers arrive as a final frame with flag `0x80`, or as headers on a trailers-only response. Messages are encoded and decoded by `effect/protobuf` from the embedded descriptor set.
- Requests are plain objects (`{ object_id: "0x6", read_mask: { paths: [...] } }`).
- Server streaming is `res.stream` → incremental frame parser → `Stream<Message, GrpcError>`. `ListCheckpoints`, `ListTransactions` and `ListEvents` (all server-streaming in sui-apis) and `Subscribe*` become `Stream`s with backpressure. Interrupting the stream closes the HTTP request.
- One error type: `GrpcError { method, code, message }` with a `retryable` getter over `UNAVAILABLE | DEADLINE_EXCEEDED | RESOURCE_EXHAUSTED`. Network failures are `UNAVAILABLE` by construction, so there's no cause-chain archaeology.
- Next step: codegen typed request/response interfaces from the descriptor set with `effect/Codegen` (or `SchemaRepresentation`), so `unary` is keyed by method name and fully typed. The spike uses plain objects plus Schema decoding at the client layer, which is enough to prove the transport.

### 4.3 Batching and caching come from `Request` (`spike/src/sui/SuiClient.ts`)

```ts
class GetObject extends Request.Class<{ objectId: Address }, SuiObject, ObjectNotFound | GrpcError | MalformedResponse> {}
const resolver = RequestResolver.make<GetObject>(/* one BatchGetObjects for all entries */)
  .pipe(RequestResolver.batchN(50), RequestResolver.withSpan("SuiClient.getObject.resolver"))
const getObject = (objectId) => Effect.request(new GetObject({ objectId }), resolver)
```

- Any concurrent `getObject` anywhere in the program coalesces into one `BatchGetObjects` and duplicates are removed: the resolver, Walrus committee reads, your code. The live test fires 4 reads (one duplicate) and asserts exactly **one** HTTP request.
- `getFunction` (immutable package metadata) uses `RequestResolver.withCache`. Chain identity and gas price use `Effect.cachedWithTTL`.
- Walrus's `dataloader` + `ClientCache` + private-field memo, and Seal's two hand-rolled `Map`s, all collapse into this one mechanism. Cache keys that include the epoch make epoch-change invalidation structural rather than a manual `reset()`.

### 4.4 A PTB is an Effect (`spike/src/tx/Ptb.ts`)

```ts
const payTwo = (to: Address, a: bigint, b: bigint) => Effect.gen(function*() {
  const coins = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(a), yield* Ptb.u64(b)])
  yield* Ptb.transferObjects(coins, yield* Ptb.address(to))
})
//    ^? Effect<void, InvalidPureValue, PtbBuilder>

const { draft } = yield* Ptb.build(Effect.gen(function*() {
  const clock = yield* Ptb.object("0x6")
  yield* payTwo(recipient, 100n, 200n)
  return yield* Ptb.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [clock] })
}))
const data = yield* Tx.resolve(draft, { sender })          // R = SuiClient
const { digest } = yield* Tx.execute(data, signer)
```

- **Composition is plain Effect composition:** `yield*`, `Effect.forEach` over recipients, `Effect.all`. There is no `tx.add(thunk)` and no plugin registry.
- **Requirements are in the type.** A recipe that reads chain state (Walrus fetching its system object for storage prices) has `R = PtbBuilder | WalrusSystem`. A recipe with only `PtbBuilder` is *guaranteed* buildable offline. Today, `Transaction.build()` throws at runtime: "No sui client passed … but transaction data was not sufficient to build offline."
- **Failures are in the type**, e.g. `InvalidPureValue` when a value doesn't fit its BCS type.
- **Pure arguments are typed by their BCS Schema at the call site** (`Ptb.pure(Bcs.u64, 5n)`, or codegen'd wrappers). The `UnresolvedPure` phase disappears, and so do round trips to fetch a function signature just to serialize a number. (Mysten removed untyped pure values in 3.0 too.)
- **The resolver is a function, not a plugin chain.** It fetches every object and function signature concurrently (one batched request each), infers shared-object mutability from `&`/`&mut`/by-value parameters, handles `Receiving<T>`, picks the gas price, and estimates the budget by dry run. Live test: `0x6` passed to `clock::timestamp_ms(&Clock)` resolves as an **immutable** shared input. The resolve step issues `GetEpoch`, `GetServiceInfo`, `GetFunction` and `BatchGetObjects` in parallel.
- Sponsorship, intents (`coinWithBalance`) and policy checks become `Draft → Effect<Draft>` or `TransactionData → Effect<TransactionData>` functions composed with `pipe`.
- Verified: builder output plus our BCS equals `@mysten/sui` `Transaction.build()` bytes for a merge/split/transfer/moveCall transaction.

### 4.5 Signers are values with an effectful `sign` (`spike/src/crypto/Signer.ts`)

```ts
interface Signer {
  address: Address; scheme: Scheme; publicKey: Uint8Array
  signDigest(digest: Uint8Array): Effect<Uint8Array, SigningError>
}
```

- In-memory keys, Ledger, KMS, browser wallets, passkeys and multisig co-signing are all the same type, which keeps `sui-effect`'s "a Signer is a value, not a service" insight.
- Ed25519 runs on `effect/crypto` (WebCrypto), so `SecureRandom` is injectable and key generation is deterministic in tests. secp256k1, BLS and Poseidon come from `@noble`.
- Verified: same address and the same signature bytes as `Ed25519Keypair` for the same seed.

### 4.6 Errors

- **Per-layer closed unions.** Transport: `GrpcError` (status-coded, `retryable`). Client: adds domain errors such as `ObjectNotFound` and `MalformedResponse` (a node answered with something that doesn't decode). Tx: adds `GasEstimationFailed`, `ExecutionFailed`, `SigningError`.
- The spike shows typed retry where a narrow condition is real: `client.getObject(id).pipe(Effect.retry({ while: e => e._tag === "ObjectNotFound", ... }))` waits for a faucet transfer to land. No other failure is retried by accident.
- Port `sui-effect`'s **outcome axis** (`applied` / `not_applied` / `unknown` for submissions), `SubmissionUnknown`, `NotApplied` evidence and `describe`. These are about Sui semantics, not about the wrapper, and they're the most valuable part of that codebase.

### 4.7 Testing

- **Pure core:** table and property tests (Schema gives Arbitrary for free) plus a **parity suite against `@mysten/sui` as a dev-only reference**. The spike already does this for BCS, the builder and signatures. This suite is the main defence against drift when Sui ships protocol changes.
- **Transport and client:** replace the `HttpClient` layer with a recorded/scripted one, or replace `GrpcWeb` with a scripted message handler. There's no need to subclass someone else's `CoreClient`.
- **On-chain behaviour:** localnet suites, as `sui-effect` does today. Its "nothing pretends to be a chain" rule is right.

## 5. Walrus on top

From reading `@mysten/walrus` 2.0.1. All of `client.mjs`'s logic lives in one 1,483-line class mixing Sui reads, tx builders, node fan-out, quorum logic and WASM.

**Pure protocol core** (plain functions, unit-tested):
- Quorum math (`f = ⌊(n−1)/3⌋`, quorum `> 2f`, validity `> f`), source symbols (primary `n−2f`, secondary `n−f`), shard/pair rotation by blob id, encoded length and storage units.
- BCS messages (`BlobMetadata`, `SliverData`, `StorageConfirmation`, the certificate), quilt layout (a binary search over symbol size), and patch ids.
- Certificate assembly: verify each confirmation, require quorum, aggregate the BLS signatures.

**Services:**
- `WalrusEncoder`: a `Layer.scoped` around `@mysten/walrus-wasm` (init once, buffers as scoped resources). This replaces the module-global WASM cached in a cache that `reset()` clears.
- `StorageNode`: `HttpClient` with Schema-decoded responses and a per-request `Schedule`. It retries 429, 5xx, timeouts and `BlobNotRegistered`; today only the last is retried, three times with a fixed delay.
- `Committee`: a `Cache` keyed by `(epoch, kind)` built from the System/Staking objects via the batched `getObject`. The read committee during `EpochChangeSync` is a function of the blob's certified epoch, not a memo of whichever blob was read first.
- Contract bindings: codegen'd BCS Schemas plus recipes that are Effects over `PtbBuilder | WalrusSystem` (§4.4), so `registerBlob` composes into your own PTB.

**Flows:**
- **Write:** encode → register (tx) → upload → certify (tx), modelled as a `Stream` of typed steps so a caller can persist and resume.
  - The upload is `quorum({ weight: shards, threshold: n − f })` over nodes, with a global `Semaphore` on sliver PUTs. Today all ~2 × n_shards PUTs go out at once.
  - It **stops and interrupts stragglers once 2f+1 confirmations arrive**. Today it waits for every node, up to the 30 s timeout.
- **Read:** metadata and slivers via `quorum` with weighted shuffling. Decode in WASM, re-derive the blob id, and fail with `InconsistentBlob` on mismatch.

**Bugs not to port** (all rooted in hand-rolled `new Promise` + mutable counters):
- `getSlivers` resolves only on the success *after* reaching the threshold. It always makes one extra request and can hang forever.
- In `getVerifiedBlobStatus`, `finally` can reject after quorum was reached.
- `chunk(x, 0)` with fewer than 10 nodes.
- The certificate signer bitmap silently assumes the staking and BLS committees list nodes in the same order.
- Quorum counts nodes in one place and shard weight in another.

## 6. Seal on top

From reading `@mysten/seal` 2.0.1. Note that its docs describe a `seal()` `$extend` factory that the 2.0 code no longer exports, and `verifyKeyServers` actually defaults to `false`.

**Pure crypto core:**
- Boneh-Franklin IBE over BLS12-381, Shamir over GF(2⁸), ElGamal on G1, DEMs (AES-256-GCM, HMAC-SHA3-CTR), the KDF with its domain-separation tags, and the `EncryptedObject` BCS layout.
- Keep the fastcrypto-compatible `GTElement` byte permutation `[0,3,1,4,2,5]`.
- Randomness goes through an injectable `SecureRandom`, so encryption is reproducible in tests.

**Services:**
- `KeyServers`: a `Cache` keyed by object id, read on chain (versioned dynamic field → `KeyServerV1`/`V2`), with optional `/v1/service` PoP verification. This replaces the promise memo with manual reset.
- `SessionKey`: a **scoped resource**. Expiry runs on `Clock`, not `Date.now()`. The personal-message certificate is `Effect.cached`, so concurrent decrypts can't double-prompt the wallet (a race today). The exported secret is `Redacted`, and import decodes through a Schema.
- `fetchKeys`: the same `quorum` combinator, weighted by server weight up to threshold `t`, interrupting the remaining requests once `t` is reached.
  - Failure is `ThresholdNotMet { failures: Record<serverId, SealServerError> }`. Today the code picks the "majority error class name" and drops the rest.
  - Per-server retry for `InternalError`, `InvalidParameter` (fresh object not yet indexed) and 5xx/network. Today there are no retries anywhere.
  - An invalid derived key is a typed per-server failure instead of `console.warn`.
- Derived-key cache: a `Cache` scoped to the session key's lifetime. Today it is unbounded and lives forever.
- Committee (MPC) servers go through the aggregator URL. Pre-flight validation (client weights vs. ciphertext services, aggregator presence) gives typed `InvalidClientOptions`.

## 7. The shared primitive: `quorum`

Walrus (metadata, slivers, confirmations, status) and Seal (key shares) are all the same operation:

```ts
quorum<M, A, E, R>(members: Iterable<M>, options: {
  weight: (m: M) => number
  threshold: number                       // succeed when accumulated weight >= threshold
  attempt: (m: M) => Effect<A, E, R>      // each member retried on its own Schedule
  concurrency?: number
  order?: "given" | "shuffle" | "weightedShuffle"
}): Effect<ReadonlyArray<[M, A]>, QuorumFailed<M, E>, R>
// QuorumFailed carries every member's typed failure; fails fast once the threshold is unreachable;
// interrupts outstanding attempts on success or failure.
```

Built on `FiberSet`/`Deferred` (or `Stream.mergeAll` + `Stream.scan` + `takeUntil`), it is ~80 lines, tested once with `TestClock`, and it removes every hand-rolled race in both SDKs. The bug list in §5 stops being possible.

## 8. What the spike proves

| Claim | Evidence (`spike/test/`) |
|---|---|
| BCS-as-Schema matches the reference byte for byte | `bcs.test.ts`: `TransactionData` encode/decode parity, type tags, range and trailing-byte failures |
| Builder-as-Effect produces identical transactions | `ptb.test.ts`: bytes equal `Transaction.build()` |
| Effect crypto signs like the reference | `ptb.test.ts`: same Ed25519 address and signature |
| gRPC-web + `effect/protobuf` works live | `live.testnet.test.ts`: `GetServiceInfo`, `GetObject`, `ListCheckpoints` as a `Stream`, `NOT_FOUND` as a typed error |
| Request batching works across call sites | 4 concurrent reads → 1 HTTP request |
| Resolver infers mutability from signatures | `&Clock` → immutable shared input; simulate returns `timestamp_ms`, decoded via `Bcs.u64` |
| End-to-end write path | `live.devnet.test.ts`: faucet → build → resolve (budget by dry run) → sign → execute |

Run: `cd spike && bun install && bun test` (offline), `SUI_LIVE=1 bun test` (live).

Gaps found and fixed along the way. They show what a real implementation has to get right:
- The budget dry run needs the reference SDK's trick: an empty payment plus a `ValidDuring` expiration, so the node mocks the gas coin. The node checks the gas coin's balance against the placeholder budget even with checks disabled.
- `@mysten/sui`'s `SharedObjectRef` JSON shape (`mutable` boolean) differs from the BCS enum. A Schema-first core avoids this second shape entirely.

## 9. Risks and open questions

- **`effect/protobuf` is `@stability experimental` (since 4.1.5).** Pin Effect tightly, and keep `GrpcWeb` small enough to swap the codec if needed. (`sui-effect` already pins `>=4.1.1 <4.2`.)
- **BCS performance is unmeasured.** Benchmark before committing. Large `Publish` modules and checkpoint decoding are the hot paths.
- **Typed protobuf surface.** Plain objects keyed by snake_case are fine internally. Public-facing typed request/response interfaces should be generated, not hand-written. `effect/Codegen` exists for this; how much it does out of the box is untested.
- **Breadth is the real cost.** Ground-up means owning zkLogin (Poseidon, JWK handling), passkeys, multisig, ML-DSA-65 (new in 3.0), MVR name resolution, GraphQL coverage, and parity with every protocol bump (e.g. `Validity` expirations, address balances, `FundsWithdrawal`). Mitigations:
  - The `@mysten/sui` parity suite as a dev dependency.
  - Ship signature schemes incrementally: Ed25519 → secp256k1/r1 → multisig → zkLogin → passkey.
  - Generate everything that can be generated: proto types, GraphQL operations, Move bindings.
- **Browser and proxy compatibility.** The 3.0 SDK switched gRPC-web to binary by default but keeps a `format: 'text'` fallback for proxies. Add the same option (base64 framing) to `GrpcWeb`.
- **Interop with the Mysten ecosystem** (dapp-kit, wallet-standard, packages that `$extend` a `SuiClient`). Offer a small adapter that exposes an Effect `SuiClient` as a `ClientWithCoreApi`. That is the *inverse* of `sui-effect`: Effect inside, Promise facade outside.
- **Effect 4 churn.** v4 is young: rc renames happened, and `@stability unstable` modules are common. Budget for upgrades.

## 10. Suggested path

1. **Core.** Promote `Bcs` and `Types` (all transaction kinds, effects, events, objects) with a benchmark and an exhaustive parity suite. Add addresses, type tags, digests, intents and the Ed25519/secp256k1/secp256r1 schemes.
2. **Transport.** `GrpcWeb` with generated typed methods, text-format fallback, headers/auth middleware and the retry policy. GraphQL via `effect/graphql` for queries gRPC doesn't serve (`@effect/graphql-generator` for operations).
3. **Client.** The full `SuiClient` read surface (objects, dynamic fields, coins and balances, transactions, events, checkpoints as `Stream`s, subscriptions), with batching and caches.
4. **Tx.** The builder plus resolver with feature parity: intents, `coinWithBalance`, address-balance gas, sponsorship. Then port `sui-effect`'s lifecycle (`Tx.run`, journal, reconcile, outcomes) onto it.
5. **Codegen.** Move package → BCS Schemas plus typed recipe functions. Needed by Walrus and Seal anyway.
6. **`@x/quorum`**, then **Seal** (smaller, pure crypto plus one fan-out), then **Walrus** (WASM encoder, storage nodes, quilts, upload relay).
7. A Promise facade and a `ClientWithCoreApi` adapter for interop.
