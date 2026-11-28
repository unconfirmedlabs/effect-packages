# effect-sdks

Ground-up Effect implementations of the Mysten SDKs. Sui first. See [EXPLORATION.md](EXPLORATION.md) for the reasoning; `spike/` is the original proof of concept.

## Packages

| Package | What | Extra deps |
|---|---|---|
| `@unconfirmed/bcs` | BCS declared as Effect Schemas | `@scure/base` |
| `@unconfirmed/sui` | Core: addresses, type tags, transaction data, PTB builder (incl. address-balance withdrawals, deposits and coin/balance intents), resolver (address-balance gas by default), `TransactionJson` (Mysten `toJSON()` / `Transaction.from` interop), `Signer` / `TransactionSigner`, the signature-scheme registry, Ed25519, `PrivateKey` (`suiprivkey`, `sui.keystore`). Capability services: Chain, Objects, Coins, Packages, Transactions (+ `waitFor`), Checkpoints, DynamicFields, Events, CheckpointData (+ `follow`) | `@noble/hashes`, `@noble/curves` (ed25519 only), `@scure/base` |
| `@unconfirmed/sui/grpc` | Every capability over gRPC-web (`HttpClient` + `effect/protobuf`) | — |
| `@unconfirmed/sui-graphql` | Every capability over Sui GraphQL (`effect/graphql`), including SSE subscriptions; mixable with gRPC per service | — |
| `@unconfirmed/sui-lifecycle` | Crash-safe submission: outcomes (applied / not_applied / unknown), identical-bytes resubmission, reconcile from on-chain evidence (`Evidence` over gRPC or GraphQL for the expiry rule), versioned journal (memory / any KeyValueStore, plus IndexedDB and OPFS stores), sender lock (in-process or Web Locks) | — |
| `@unconfirmed/sui-secp256k1` | Secp256k1 scheme and signers | `@noble/curves` |
| `@unconfirmed/sui-secp256r1` | Secp256r1 scheme and signers | `@noble/curves` |
| `@unconfirmed/sui-mldsa65` | ML-DSA-65 (post-quantum) scheme and signers; works as a multisig member | `@noble/post-quantum` |
| `@unconfirmed/sui-multisig` | Multisig scheme, `signer`, `combine` | — |
| `@unconfirmed/sui-passkey` | Passkey (WebAuthn) scheme (also as a multisig member), signer over a pluggable authenticator (browser `navigator.credentials`, or in-memory for tests and servers), public-key recovery for returning users | `@noble/curves`, `@noble/hashes`, `@scure/base` |
| `@unconfirmed/sui-mnemonic` | BIP39 mnemonics; Ed25519 / ML-DSA-65 (SLIP-0010) and Secp256k1 / r1 (BIP32) derivation on Sui's paths | `@scure/bip39`, `@scure/bip32` |
| `@unconfirmed/sui-zklogin` | zkLogin scheme (verification needs a `ZkLoginVerifier`; gRPC layer provided), signer, addresses, nonce, JWT | `poseidon-lite`, `@scure/base` |
| `@unconfirmed/sui-enoki` | Enoki client, sponsored transactions (verifies sponsor bytes before signing), zkLogin flow | — |
| `@unconfirmed/sui-wallet` | Wallet-standard Sui wallets: discovery, connect, accounts and chains, a wallet `TransactionSigner` for `Tx.run` / `Tx.execute`, `signAndExecuteTransaction`, `signPersonalMessage` | `@wallet-standard/app`, `@scure/base` (+ types from `@wallet-standard/base`) |
| `@unconfirmed/quorum` | Weighted first-threshold-of-n: `Quorum.run` (stop once enough weight succeeded) and `Quorum.agree` (stop once enough weight agrees on one answer), with per-member retry, a concurrency cap, (weighted) shuffled start order, an optional linger window and an optional early give-up. Knows nothing about Sui; used by Walrus and Seal | — |
| `@unconfirmed/sui-codegen` | Move codegen: typed BCS schemas and call builders from `sui move summary` output or an on-chain package (gRPC); a config file and a CLI. Generated code needs only `effect`, `@unconfirmed/bcs` and `@unconfirmed/sui` (runtime: `@unconfirmed/sui/Move`) | — (dev-time) |
| `@unconfirmed/walrus` | Walrus: read blobs from the storage nodes (verified, bad slivers blamed and replaced), write them (certified at `n − f` shards, resumable steps), the upload relay, aggregator and publisher gateways, quilts. Erasure coding and BLS through `@unconfirmed/walrus-wasm`, loaded on first use | `@noble/hashes` |
| `@unconfirmed/walrus-wasm` | Our WebAssembly build of `walrus-core` 1.62.0 with SIMD: RS2 encode/decode, direct per-sliver Merkle roots, BLS12-381; byte-identical to `@mysten/walrus-wasm` 0.3.1 and about 5× faster. Built artifacts committed; `bun run build` reproduces them | — |
| `@unconfirmed/seal` | Seal: threshold identity-based encryption to key servers registered on Sui (independent and committee), session keys (key or wallet signer, one prompt), `seal_approve` approvals, key fetching over `Quorum` with every key verified, decryption. The crypto core (BLS12-381, Shamir, KDF, DEMs, the encrypted object) is pure and usable offline | `@noble/curves`, `@noble/hashes`, `@scure/base` |

### BCS

`@unconfirmed/bcs` declares BCS layouts as Effect Schemas: one declaration is the TypeScript type, the validator and the codec.

```ts nocheck
const Head = Bcs.struct({ version: Bcs.u8, packageId: Bcs.Address, id: Bcs.byteVector })
Bcs.decode(Head)(bytes)          // Result<Head, BcsDecodeError | SchemaError>; trailing bytes are an error
Bcs.decodePrefix(Head)(bytes)    // Result<{ value, rest }>: the head of a larger value, and the bytes after it
```

`Bcs.Address` (account addresses and object ids) is a `0x` + 64 lowercase hex string, branded `"Address"`.

### Passkeys

```ts
import * as Passkey from "@unconfirmed/sui-passkey"

const provider = Passkey.browserProvider("My app", { rp: { id: location.hostname } })
const signer = yield* Passkey.create(provider)    // first visit: creates a passkey; store signer.publicKey.bytes
const again = yield* Passkey.recover(provider)    // returning user: two prompts, the public key common to both
yield* Tx.run(recipe, { signer })                 // a passkey signer is just a Signer (also inside MultiSig.signer)

SignatureSchemes.layer(Ed25519.scheme, Passkey.scheme, MultiSig.scheme)   // verify passkeys, alone or as members
```

A cancelled prompt is `SigningError` with reason `"rejected"`, no WebAuthn is `"unavailable"`. `Passkey.softwareProvider()` is an in-memory authenticator with the same interface, for tests and non-browser runtimes.

### Quorum

```ts
import * as Quorum from "@unconfirmed/quorum"   // or "@unconfirmed/quorum/Quorum"

const { successes } = yield* Quorum.run(committee.nodes, {
  weight: (node) => node.shards.length,
  threshold: nShards - maxFaulty,
  run: storeAndConfirm,                            // one attempt at one member
  retry: nodeRetry, retryWhile: (e) => e.retryable,  // per-member retry
  concurrency: 50, order: "weightedShuffle",
  linger: (elapsed) => Duration.sum(Duration.times(elapsed, 0.5), Duration.millis(500))  // wait for stragglers
})

const { winner } = yield* Quorum.agree(nodes, { weight, run: getStatus, key: canonical, threshold: f + 1, quorum: 2 * f + 1 })
```

- It returns on the success that crosses the threshold and fails fast (`QuorumFailed`, `reason: "unreachable"`) the moment failures leave too little weight; everything still in flight is interrupted and awaited before it returns.
- Results and errors carry every success, failure (with its typed error) and unsettled member, so callers can classify failures (`Quorum.failedWeight`).
- `giveUp: { when, weight, grace? }` (`run` only) stops early once final failures matching `when` weigh `weight` (`reason: "gaveUp"`), for failures that make success pointless rather than impossible: Walrus metadata stops at `2f + 1` not-found weight instead of waiting for every node; Seal stops once denials weigh `t`. An optional `grace` keeps going for a moment, and a threshold reached in it still succeeds.
- `concurrency` is a number, `"unbounded"`, or a function of progress so far, asked whenever a slot may open: `(p) => 3 + p.failed` starts with three and widens by one per final failure (Walrus metadata reads). Members never started are reported `started: false`.
- A defect in a member fails the whole call; it is not counted as a member failure. Once the threshold is reached the call is a success whatever happens next: a defect during the linger window ends the window and is logged, and results that settled in the same turn as the deciding one are kept. Timeouts go inside `run` (per attempt) or around the call (overall).
- `QuorumFailed` / `AgreementFailed` are `Data.TaggedError`s (generic in your member and error types, no `Schema`); convert them at your boundary. Design: [docs/design/quorum.md](docs/design/quorum.md).

### Walrus

```ts
import * as Read from "@unconfirmed/walrus/Read"
import * as Walrus from "@unconfirmed/walrus/Walrus"
import * as Write from "@unconfirmed/walrus/Write"
import * as SuiGrpc from "@unconfirmed/sui/grpc"

// System, committees, storage nodes and the encoder for one network; needs an HttpClient and a Sui client.
const layer = Walrus.layer({ network: "testnet" }).pipe(          // or { config: { systemObjectId, stakingObjectId } }
  Layer.provideMerge(SuiGrpc.layer({ url: "https://fullnode.testnet.sui.io:443" })),
  Layer.provideMerge(FetchHttpClient.layer)
)

const bytes = yield* Read.blob(blobId)                            // straight from the storage nodes, verified
const status = yield* Read.status(blobId)                         // { _tag: "Permanent", endEpoch, isCertified, ... }, f + 1 shards agreeing

// Write through the nodes: encode, register, upload, certify (two transactions, signed by `signer`).
const certified = yield* Write.run(bytes, { epochs: 5, deletable: true, executor: Write.viaTx(signer) })
// { _tag: "Certified", blobId, blobObjectId, certifiedEpoch, endEpoch, deletable, digest }
```

- **Reads** verify the metadata against the blob id before using it, check each sliver's shape, decode from `n − 2f` shards and re-derive the blob id (`consistency: "strict"`, the default). If the bytes don't match, the slivers are checked one by one: a node that served a bad one is blamed and replaced. Only a blob the writer encoded wrongly is `InconsistentBlob`. A blob unknown to `2f + 1` shards is `BlobNotFound` (`BlobBlocked` for blocked blobs), typically within seconds; a read that fails while the nodes call the blob `Nonexistent` (deleted meanwhile) is `BlobNotFound` too. During an epoch change the read committee is chosen per blob from its certified epoch (the current one when no status gathers enough agreement). `consistency: "skip"` drops the final check, and slivers are then only header-checked: any one node that served a sliver can change the bytes, so use it only when the bytes are verified another way. Reads prefer asking another node to retrying a slow one, and a body larger than the expected size is refused.
- **Writes** count weight in shards, as the chain does. The certificate is built at `n − f` (`@mysten/walrus` counts nodes, so it can refuse a valid certificate or build one the chain rejects). Each confirmation's signature is checked. In-flight sliver bytes are capped (12.5 MB), retries are per request, and the write lingers `0.5 × elapsed + 500 ms` after the quorum for stragglers, as the Rust client does. Upload timeouts grow with the bytes in flight (`requestTimeout + bytes / minUploadRate`, default 1 Mbit/s), so a slow uplink delays a large write instead of timing it out. `owner` (default: the executor's sender) receives the `Blob` in the certify transaction: the sender holds it until then, since only an object's owner can certify it. The system state (prices, package id) is cached for a minute, and a register transaction that aborts because the prices or the package moved is rebuilt once. [docs/design/walrus.md](docs/design/walrus.md) §1.8 and §2 list what differs from `@mysten/walrus` and why.
- **Steps are resumable.** `onStep` receives each `Write.Step` (with `Uint8Array` fields, so not JSON as is): persist `Schema.encodeSync(Write.Step)(step)`, which is plain JSON, and pass `Schema.decodeSync(Write.Step)(saved)` as `resume` to continue in another process. Each step checks the chain before acting, so a crash between register and persist reuses the registration rather than paying again. For the transactions themselves, any `Executor` works: `Write.viaTx(signer)` (a key or a wallet), or `sui-lifecycle`'s `Lifecycle.run` for a journal.
- **Through the upload relay** the blob goes to a relay that encodes and stores it for a tip in SUI. The relay's certificate is verified before the certify transaction is built. The tip amount and address come from the relay, so `maxTip` (MIST per blob) is required: a higher tip is `TipTooHigh` before anything is signed, and `tipAddress` optionally pins the recipient. Only relay writes need the relay layer (`via: "relay"` adds `UploadRelay` to the requirements):

  ```ts
  const layer = Layer.mergeAll(
    Walrus.layer({ network: "testnet" }),
    UploadRelay.layer({ url: UploadRelay.TESTNET_URL, maxTip: 1_000n })   // required; `0n` accepts only relays that want no tip
  ).pipe(Layer.provideMerge(SuiGrpc.layer({ url })), Layer.provideMerge(FetchHttpClient.layer))
  yield* Write.run(bytes, { epochs: 5, deletable: true, executor: Write.viaTx(signer), via: "relay" })
  ```

- **Gateways**, for apps that trust an aggregator or publisher, have their own layers and ship neither WASM nor quorum code:

  ```ts
  const gateways = Layer.mergeAll(
    Aggregator.layer({ url: Aggregator.TESTNET_URL }),
    Publisher.layer({ url: Publisher.TESTNET_URL })            // `headers` for a publisher behind JWT auth
  ).pipe(Layer.provide(FetchHttpClient.layer))
  const bytes = yield* Aggregator.blob(blobId)                 // also byObjectId, patch, byIdentifier
  const result = yield* Publisher.store(bytes, { epochs: 5 })  // NewlyCreated | AlreadyCertified | MarkedInvalid
  const checked = yield* Aggregator.verified(blobId)           // re-derives the id locally: needs Encoder and System
  ```

  A gateway failure is `GatewayError { status?, message }` (`status: 404` for an unknown blob).
- **Quilts** pack many small files into one blob (a 445 KB quilt costs the same WAL as a 32-byte blob) and read them back one at a time:

  ```ts
  const { nShards } = yield* Effect.flatMap(Effect.service(System.System), (s) => s.state)
  const { quilt, patches } = yield* Effect.fromResult(Quilt.encode(entries, nShards))   // a Result; entries: { identifier, contents, tags? }[]; byte-identical to @mysten/walrus
  const certified = yield* Write.run(quilt, { epochs: 5, deletable: true, attributes: Quilt.ATTRIBUTE, executor: Write.viaTx(signer) })
  const file = yield* QuiltRead.patch(Quilt.patchId(certified.blobId, patches[0]!))   // or QuiltRead.byIdentifier(blobId, "hello.txt")
  ```

  A patch read fetches only that file's columns, each from the node holding its shard, and verifies them together (one WASM call; `byIdentifier` verifies the index and the patch together in one) before returning anything; any missing or mismatching column falls back to `Read.blob`. `@mysten/walrus` trusts one node's unverified sliver here. `verify: false` skips the check.
- Every failure is a typed `Schema.TaggedError` (`BlobNotFound`, `NotEnoughSlivers`, `NotEnoughConfirmations`, `EncoderError`, ...). Nothing a node, gateway or the WASM throws escapes as a defect. (`Walrus.layer` called without `network` or `config`, which TypeScript rejects, is a defect rather than a silent testnet.)

**The WASM.** Erasure coding, sliver verification and BLS run in `@unconfirmed/walrus-wasm` (`packages/walrus-wasm`): `walrus-core` 1.62.0 compiled with WebAssembly SIMD, plus SIMD BLAKE2b for the Merkle trees and a SIMD Reed-Solomon engine. It produces the same bytes as `@mysten/walrus-wasm` 0.3.1 (the parity tests compare blob ids, metadata, every sliver and decoded blobs). Calls are synchronous; at testnet's 1000 shards (Bun 1.4.4, x64, blob sizes 1 KB to 10 MB):

| Call at `n = 1000` | `@unconfirmed/walrus-wasm` | `@mysten/walrus-wasm` 0.3.1 |
|---|---|---|
| encode | 0.50–0.54 s | 2.57–2.62 s |
| blob id (`compute_metadata`) | 0.49–0.50 s | 2.55 s |
| decode from repair slivers | 0.57 s | 2.32 s |
| decode from systematic slivers | 9–15 ms | 12–15 ms |
| roots of 334 slivers (a read's blame pass) | 0.11 s | 2.6 s (crafted-blob re-encode) |
| BLS: verify an aggregate of 667 | 12 ms | 29 ms |

Node, `n = 10` and `100`, and the sizes are in `packages/walrus-wasm/README.md` (`bun packages/walrus/scripts/bench-wasm.ts`). A read costs two calls, a write one; a read yields to the event loop between its calls. The module is imported only when an `Encoder` layer is built, so importing the package costs nothing until then. How to load it depends on the runtime:

| Runtime | What to do |
|---|---|
| Bun, Node (unbundled) | Nothing. |
| Server bundle | Keep `@unconfirmed/walrus-wasm` external (`--external @unconfirmed/walrus-wasm`). A Bun bundle that inlines it works only on the machine that built it, and esbuild's ESM output fails (no `__dirname`). |
| Browser, Vite / webpack 5 | Nothing (they emit both `.wasm` builds; one is fetched), or pass `wasmUrl` / `wasmFallbackUrl` from `import wasmUrl from "@unconfirmed/walrus-wasm/web/walrus_wasm_bg.wasm?url"` and `…/web/walrus_wasm_nosimd_bg.wasm?url` (Vite). |
| Browser, esbuild / Rolldown / Bun | Serve `packages/walrus-wasm/web/walrus_wasm_bg.wasm` (261 KB, 98 KB gzip) and, for engines without WebAssembly SIMD, `walrus_wasm_nosimd_bg.wasm` (248 KB), and pass their URLs: `Walrus.layer({ network, wasmUrl: "/walrus_wasm_bg.wasm", wasmFallbackUrl: "/walrus_wasm_nosimd_bg.wasm" })` (or `Encoder.layer({ … })`). The fallback is picked with `WebAssembly.validate`; every current browser takes the SIMD build. |

**Live tests.** `SUI_LIVE=1 bun test packages/walrus` reads testnet without spending anything: committees, a recently certified blob through the nodes and through the public aggregator, and a random id. Add `WALRUS_LIVE=1` to also write. That signs with `SUI_LIVE_PRIVATE_KEY` (a `suiprivkey1…` key of a funded testnet account holding SUI and WAL): direct, resumed and relay writes of 32-byte blobs and one 445 KB quilt, each burned afterwards, about 0.003–0.005 SUI and 0.0009 WAL per write.

### Seal

```ts
import * as Approval from "@unconfirmed/seal/Approval"
import * as Config from "@unconfirmed/seal/Config"
import * as Seal from "@unconfirmed/seal/Seal"
import * as SealGrpc from "@unconfirmed/seal/SealGrpc"

// Configuration, key servers read from chain, the key server HTTP client, and the two chain reads Seal needs
// (Objects, Packages) over gRPC-web; needs an HttpClient.
const layer = SealGrpc.layer({
  servers: [Config.testnet.mysten1, Config.testnet.mysten2, Config.testnet.committee],
  grpc: { url: "https://fullnode.testnet.sui.io:443" }
}).pipe(Layer.provideMerge(FetchHttpClient.layer))
// A program that also builds transactions: Seal.layer({ servers }).pipe(Layer.provideMerge(SuiGrpc.layer({ url })), ...).
// SuiGrpc.layer ships every service's RPCs (about 60 KB more than Seal needs).

const id = Bcs.encodeSync(Bcs.Address)(signer.address)                       // account_based: the id is the user's address
const { encryptedObject } = yield* Seal.encrypt({ packageId, id, data, threshold: 2 })   // or dem: "Hmac256Ctr", aad

const session = yield* Seal.session({ packageId, signer })                   // a key Signer or a wallet's WalletSigner
const approval = yield* Approval.fromRecipe(Approval.call({ target: `${packageId}::account_based::seal_approve`, id }))
const plaintext = yield* Seal.decrypt({ data: encryptedObject, session, approval })      // one prompt, one round of requests
```

- **Weights come from the ciphertext.** `decrypt` asks the servers the object names that are also configured, each counting for its number of shares in the object. `@mysten/seal` requires the client's configured weights to equal the object's. Servers the object names but the configuration lacks are never contacted: their URLs come from objects anyone can create, and a request tells the server who is asking for what. Their public keys are still read from chain when `checkShareConsistency: true`.
- **Strict ids.** Package and user ids are `0x` + 64 hex digits; key server ids are exactly 64 hex digits, `0x` optional. A short or unprefixed package or user id is refused up front; `@mysten/seal` signs it as given and every server then rejects the session. `decrypt` checks that the object, the session and the approval belong together (`ApprovalMismatch`) before sending anything. `Seal.session` checks that the package is a first version, which `SessionKey.make` doesn't.
- **One wallet prompt per session.** Concurrent callers share the prompt; a rejected prompt isn't remembered. `@mysten/seal` prompts once per concurrent call.
- **The derived-key cache belongs to the session** and is checked after the session's expiry. `@mysten/seal` keeps one unbounded cache per client and returns from it before looking at the session, so an expired session, or another user's session on the same client, decrypts from it. `Seal.fetchKeys({ objects, session, approval })` fetches keys for many objects in one round; after that, `decrypt` sends nothing. Every key is verified against the server's on-chain public key before it is cached or used.
- **`ThresholdNotMet` lists every server's failure**, each a typed `KeyServerError` (`NoAccess` with the Move abort, `InvalidPtb`, `Timeout`, `RateLimited`, ...), plus `reason: "denied" | "unreachable" | "insufficientWeight"`. `@mysten/seal` throws one "majority" error, or `undefined` when servers answer with unusable keys. Transient failures are retried per server.
- **Early stop.** Once refusals of the request itself weigh the threshold, the call waits `denialGrace` (2 s) and gives up, rather than waiting for a dead server's 10 s timeout. Under a low threshold (1 of 3), a user who isn't allowed finds out in about 2 s. An approval that arrives inside the window still wins.
- `Seal.derivedKeys` gives verified keys for on-chain decryption. Committee (MPC) servers go through their aggregator (`aggregatorUrl`, `apiKeyName` / `apiKey` on mainnet). With pinned public keys, `Envelope.seal` / `Envelope.open` encrypt and decrypt with no service at all. Design and every difference from `@mysten/seal`: [docs/design/seal.md](docs/design/seal.md) §1.7 and §2.

**Live tests.** `SUI_LIVE=1 bun test packages/seal` runs against testnet without spending anything: key server objects and proofs, and decryption with fresh in-memory keys under Mysten's canary policies (`account_based`, `tle`). That covers interop with `@mysten/seal`, a denial, `fetchKeys`, a wallet signer, an unreachable server and open-mode errors. Add `SEAL_LIVE=1` to also run the owned-object policy (`private_data`) signed with `SUI_LIVE_PRIVATE_KEY` (a funded testnet key). That creates one small object per run, about 0.003 SUI, not refundable.

## How it composes

**1. Capabilities are separate services.** Instead of one client with 30 methods there are `Chain`, `Objects`, `Coins`, `Packages`, `Transactions` and `Checkpoints`. A function's type says what it touches:

```ts nocheck
Resolve.inputs   // Effect<Plan, ObjectNotFound | RpcError | InvalidTransaction, Objects | Packages>
Resolve.budget   // Effect<Plan, ..., Transactions | Chain>
Resolve.coins    // Effect<Plan, ..., Coins>
```

A test provides only those services. A transport can implement a subset, and the compiler tells you what's missing. Transports can also be mixed, e.g. gRPC for execution and GraphQL for history, with `Layer.merge`.

```ts
import * as SuiGrpc from "@unconfirmed/sui/grpc"
SuiGrpc.layerCore({ url })                              // Chain, Objects, Coins, Packages, Transactions: all Tx.run needs
DynamicFieldsGrpc.layer.pipe(Layer.provideMerge(SuiGrpc.layerCore({ url })))  // core + one more (layerCore also provides GrpcWeb)
ObjectsGrpc.layer.pipe(Layer.provide(GrpcWeb.layer({ url })))  // just Objects
SuiGrpc.layer({ url })                                  // all nine, adding Checkpoints, CheckpointData, Events, DynamicFields
```

Prefer `layerCore` or an explicit composition: a program ships the RPCs of the layers it provides, and `SuiGrpc.layer` adds about 28 KB of checkpoint, event and dynamic-field code that a transaction never calls.

**2. Signature schemes are plugins.** The core dispatches on the flag byte but knows only the schemes you install:

```ts
SignatureSchemes.layer(Ed25519.scheme, Secp256k1.scheme, MultiSig.scheme)
```

- A signature from an uninstalled scheme is a typed `UnsupportedScheme`, and that scheme's code isn't in your bundle.
- A scheme that needs services (zkLogin needs chain state) passes those requirements on to the layer. The program doesn't compile until they're provided (see `schemes.test.ts`).
- Multisig verifies each member through the registry, so it supports exactly the member schemes you installed.

**3. Signers are values.** `Signer = { address, publicKey, sign(intentMessage) }`. An in-memory key, a hardware wallet, a KMS and `MultiSig.signer(pk, [a, b])` are all the same type, and anything that takes a `Signer` (`Tx.run`, `Signer.signPersonalMessage`) works with all of them.

A browser wallet never signs raw intent messages: it signs a whole transaction and may change it first (re-resolving gas). That is a `TransactionSigner = { address, signTransaction(data) => { bytes, signature } }`. `Tx.execute` and `Tx.run` take either kind, and submit exactly the bytes the wallet signed. With several signers, wallets sign first; key signers then sign the final bytes. A wallet may re-pick only gas terms it pays for: a changed sender, command, input or gas owner, changed gas terms a key signer (a sponsor) pays for, or a changed expiration when a key signer is the sender or sponsor, is a `SigningError` before any key signs.

**4. Transactions are Effects; resolution is a pipeline of steps.**

```ts
const recipe = Effect.gen(function*() {                     // R = PtbBuilder: buildable offline
  const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
  yield* Ptb.transferObjects([coin], yield* Ptb.address(to))
})
yield* Tx.run(recipe, { signer })                           // address-balance gas
yield* Tx.run(recipe, { signer, payment: Resolve.coins })   // coin selection
// or by hand: Ptb.build -> Resolve.inputs -> gasPrice -> budget -> <your step> -> finish
```

A payment strategy is just a step (`Plan -> Effect<Plan, E, R>`), and so is a sponsor, a policy check or an intent resolver.

Online, `Tx.build` / `Tx.run` resolve on the node by default, as `@mysten/sui` does: one `SimulateTransaction` with gas selection (`Resolve.server`, gRPC or GraphQL) fills object versions, gas price, budget and payment, and the answer is verified before use (commands, ids, shared mutability, gas coins owned by the gas owner, budget cap, sender and gas owner). A custom payment strategy, a sponsored transaction that uses the gas coin, or `resolve: "client"` runs the client-side steps instead.

**Address balances are the default way to pay and send.**

```ts
// Gas: Resolve.auto (the default) pays from the address balance when it covers the
// budget and the gas coin isn't used, otherwise with coins. If commands use the gas
// coin, every SUI coin pays (plus a coin reservation of the address balance), so the
// gas coin can cover what they split off it; too little is InsufficientGas before signing.
yield* Tx.run(recipe, { signer })
yield* Tx.run(recipe, { signer, payment: Resolve.addressBalance })  // only the address balance, or InsufficientGas before signing

// Assets: intents sourced from the address balance, topped up from owned coins
const coin = yield* Ptb.coin({ amount: 1_000n, type, useGasCoin: false })   // Coin<T>
const bal = yield* Ptb.balance({ amount: 500n, type })                       // Balance<T>
yield* Ptb.sendBalance(bal, yield* Ptb.address(to), type)                    // into `to`'s address balance

// Under an allowance: spent from the funder's address balance, never the sender's
const paid = yield* Ptb.coin({ amount: 1_000n, allowance: allowanceId })      // Coin<SUI>
const app = yield* Ptb.balance({                                             // app-bound: A's SpendPermit<A>
  amount: 50n, type,
  allowance: { objectId: appAllowanceId, app: { type: `${pkg}::app::APP`, permit: yield* Ptb.moveCall({ target: `${pkg}::app::permit` }) } }
})

// Or by hand: withdrawals and deposits
const w = yield* Ptb.withdrawal({ amount, type, from: "sender" })           // or "sponsor" / { allowance, funder }
yield* Ptb.sendFunds(yield* Ptb.redeemCoin(w, type), yield* Ptb.address(to), type)
```

- `Resolve.balances` resolves intents the way `@mysten/sui`'s `tx.coin` / `tx.balance` do, with byte-identical output.
- Allowance intents (`0x2::allowance`) become a `SenderAllowance` withdrawal plus `allowance::balance_spend` (or `app_balance_spend`), as in `@mysten/sui`. The resolver reads the allowance first and refuses with a typed error what the chain would abort: the wrong type, funder, app or permit, a sender that isn't the spender, a spend outside the start/expiration window, a spend over the lifetime cap or rate limit, or a funder whose address balance is short. Proven on devnet.
- The transaction's own withdrawals are counted against the address balance before choosing how to pay gas.
- Coin reservation refs match `@mysten/sui`'s encoding and are proven on devnet.
- `Resolve.unchecked` (empty payment, no balance check) is for simulation and for bytes whose payer is funded later.

**Transaction JSON interop with `@mysten/sui`.** `TransactionJson` reads and writes the v2 JSON that `Transaction.toJSON()` / `Transaction.from(json)` use, unresolved or resolved:

```ts
import * as TransactionJson from "@unconfirmed/sui/TransactionJson"

const { draft } = yield* Ptb.build(recipe)
const json = yield* TransactionJson.encode({ sender, draft })   // Ptb.coin / Ptb.balance become CoinWithBalance (or, with `allowance`, AllowanceBalance) intents
const json2 = yield* TransactionJson.encode(data)                // resolved TransactionData (with its digest)
// Transaction.from(json) in @mysten/sui builds the same bytes our resolver does.

const tx = yield* TransactionJson.decode(yield* Effect.promise(() => mystenTx.toJSON({ supportedIntents: ["CoinWithBalance", "AllowanceBalance"] })))
const resolved = yield* TransactionJson.resolve(tx)              // the default pipeline, keeping the JSON's gas fields
const offline = yield* TransactionJson.toTransactionData(tx)     // already fully resolved: no network
```

An intent other than `CoinWithBalance` / `AllowanceBalance`, an `UnresolvedPure` that needs a Move signature, or an unknown command or input kind is a typed `UnsupportedTransactionJson`, never dropped.

**Wallets.** `@unconfirmed/sui-wallet` makes wallet-standard Sui wallets signers:

```ts
import * as Wallet from "@unconfirmed/sui-wallet/Wallet"

const wallet = yield* Wallet.find("Slush")                       // or Wallet.wallets / Wallet.changes (a Stream)
const accounts = yield* Wallet.connect(wallet)                   // ConnectionError("rejected") if the user refuses
const signer = yield* Wallet.signer(wallet, { chain: "sui:testnet" })
yield* Tx.run(recipe, { signer })                                // we resolve, the wallet signs, we execute its bytes
yield* signer.signAndExecuteTransaction({ draft })               // or: the wallet resolves and submits
                                                                // (a failure after the wallet may have submitted is ExecutionUnconfirmed: check before retrying)
yield* signer.signPersonalMessage(new TextEncoder().encode("hi"))
```

A missing feature is `UnsupportedFeature`; a user rejection is `SigningError` with reason `"rejected"`. For `signAndExecuteTransaction`, only a coded refusal (wallet-standard `4001000`, EIP-1193 `4001`) is a rejection: any other failure (a timeout waiting for effects, an RPC error) or a bad answer is `ExecutionUnconfirmed`, with the digest when the wallet reported one. Only accounts on a `sui:` chain are used, so a multi-chain wallet's EVM account is never picked.

**5. The transport ships only the RPCs you call, and only the fields it reads.** The generated code has one descriptor constant per protobuf message and one handle per RPC that references only what it reaches. The capability services use pruned handles (`generated/lean.ts`, generated from `packages/sui/scripts/grpc-lean.ts`) whose descriptors carry just the fields in their read masks; the rest of a response is skipped as unknown fields. `grpc.unary(Rpc.NameService_LookupName, …)` is the escape hatch for anything the capability services don't cover, with full descriptors.

**GraphQL.** `@unconfirmed/sui-graphql` implements every capability over Sui GraphQL. `CheckpointData.subscribe` and `list` fetch up to 16 checkpoints ahead concurrently and deliver them in order, so `CheckpointData.follow` keeps up with mainnet and testnet: measured over 30 s, it stays about 5 checkpoints behind the light `Checkpoints.subscribe`. One request at a time fell 34 (testnet) to 74 (mainnet) behind and kept losing ground. Open-ended `list` calls are pinned to the indexer's tip at the time of the call, as over gRPC. When the indexer answers null where a value must exist (current epoch, latest checkpoint, gas price), the call fails with `RpcError` `UNAVAILABLE`; it never substitutes a default.

**6. Crash-safe submission (`@unconfirmed/sui-lifecycle`).**

```ts
import * as EvidenceGrpc from "@unconfirmed/sui-lifecycle/EvidenceGrpc"   // or EvidenceGraphQL
import { JournalKeyValueStore, Lifecycle } from "@unconfirmed/sui-lifecycle"

const layer = Layer.mergeAll(
  EvidenceGrpc.layer.pipe(Layer.provideMerge(SuiGrpc.layer({ url }))),   // same backend (and GrpcWeb) as Transactions
  JournalKeyValueStore.layer().pipe(Layer.provide(myKeyValueStore))
)
yield* Lifecycle.reconcileAll()               // at startup: settle what a crash left, 8 at a time
const effects = yield* Lifecycle.run(recipe, { signer })
```

- Every failure lands on one axis: `applied` (`ExecutionFailed`), `not_applied` (`NotApplied`, `JournalError`) or `unknown` (`SubmissionUnknown`, which carries the signed bytes to `resubmit`). Only `not_applied` is safe to rebuild.
- **The expiry rule needs `Evidence`, and it is off without it.** `NotApplied{expired}` means the transaction's epoch window has closed and it is not on chain. It is concluded only when one `Evidence` backend reports, in a single consistent observation taken twice around a recheck, that its epoch is past the window, that it does not have the transaction, and that its history covers the window. `Transactions.get` must also miss each time. `SuiGrpc.layer` and `SuiGraphQL.layer` do not include `Evidence`. Without it, a transaction that never reached the network stays `SubmissionUnknown` (and unresolved in the journal) until you `resubmit` it or `Journal.remove` it. Point `Evidence` at the same backend as `Transactions`. Behind a load balancer of mixed nodes, set `SubmitConfig` `expiryEvidence: "never"`.
- `NotApplied{refused}` (`INVALID_ARGUMENT` on the first send) means only that this process will not send those bytes again on its own. Some refusals depend on time (an unfunded address balance, for example). `Lifecycle.resubmit(signed, { retryRefused: true })` re-sends them on request. Bytes built for another chain are never sent.
- **Journal.** The durable journal stores each entry as versioned JSON (`{"v":1,…}`) and still reads entries written before versioning. An entry it cannot read does not fail the listing: it is reported in `listUnresolved().corrupt` and as `{ _tag: "Corrupt" }` from `reconcileAll`. `Journal.remove(digest)` drops any entry, unresolved or corrupt. The in-memory default keeps the latest 10 000 settled entries.
- `reconcileAll({ concurrency, resubmit })` makes one lookup per entry, without polling, and keeps the time each unknown entry was first sent and its last send error. `reconcile(digest)` uses the signed bytes the journal holds for that digest.

**Which layers on which platform.** `JournalKeyValueStore.layer()` runs over any Effect `KeyValueStore`; the sender lock is a separate choice.

| Platform | `KeyValueStore` under the journal | `SenderLock` |
|---|---|---|
| CLI / server | `KeyValueStore.layerFileSystem(dir)` (with the platform's `FileSystem` and `Path`) or `KeyValueStore.layerSql()` | the in-process default (one process per sender), or your own distributed lock |
| Web (recommended) | `KeyValueStoreIndexedDb.layer()`: asynchronous, strict durability on writes, survives other tabs upgrading or deleting the database | `SenderLockWebLocks.layer` |
| Web, alternative | `KeyValueStoreOpfs.layer()`: a file per key, written atomically through `createWritable` (Chromium, Firefox 111+, Safari 26+; older Safari fails typed) | `SenderLockWebLocks.layer` |
| Web, small | `KeyValueStore.layerStorage(() => localStorage)`: synchronous (blocks the main thread on every write), about 5 MB per origin, bytes stored as Base64 | `SenderLockWebLocks.layer` |
| Tests | `KeyValueStore.layerMemory`, or `Journal.layerMemory` for no store at all | `SenderLock.layerMemory` |

```ts
import * as KeyValueStoreIndexedDb from "@unconfirmed/sui-lifecycle/KeyValueStoreIndexedDb"
import * as SenderLockWebLocks from "@unconfirmed/sui-lifecycle/SenderLockWebLocks"

const browser = Layer.mergeAll(
  EvidenceGrpc.layer.pipe(Layer.provideMerge(SuiGrpc.layer({ url }))),
  JournalKeyValueStore.layer().pipe(Layer.provide(KeyValueStoreIndexedDb.layer())),  // one connection per layer scope
  SenderLockWebLocks.layer                                                           // fails typed without navigator.locks
)
const program = Effect.gen(function*() {
  yield* Lifecycle.reconcileAll()             // this tab settles what any tab left unresolved
  return yield* Lifecycle.run(recipe, { signer })
}).pipe(Effect.provide(browser))
```

- **The journal is safe across tabs; the lock needs Web Locks.** Every journal key is written whole and nothing is read-modify-written, so tabs sharing one store never lose each other's entries. That holds over any store with per-key get, set and remove. The default sender lock lives in one tab, though, and two tabs running for one address can then build on the same gas coin and equivocate. `SenderLockWebLocks` holds an exclusive Web Lock per address (`@unconfirmed/sui-lifecycle/sender/<address>`), taken in ascending address order like the memory lock. Interrupting the run, or closing the tab, releases it. Without `navigator.locks` (outside a secure context, for example) the layer fails with `SenderLockUnavailable` rather than quietly falling back to a lock other tabs can't see. `SenderLockWebLocks.layerWith({ ifUnavailable: "memory" })` opts into the fallback.
- Every store failure (quota, a blocked upgrade, private-mode refusals, an aborted transaction) is a `KeyValueStoreError`, which the journal reports as `JournalError`. Each store is its own subpath, so an app bundles only the one it uses.

## Keys

**Import and export** use the `suiprivkey1…` strings the Sui CLI and wallets exchange. The core can't build a signer for a scheme it doesn't ship, so decoding gives bytes and the scheme package makes the signer:

```ts
import * as PrivateKey from "@unconfirmed/sui/PrivateKey"

const { flag, scheme, secretKey } = yield* PrivateKey.decode(s)           // InvalidKey on a bad string
const signer = yield* Secp256k1.fromSecretKey(secretKey)
const ed = yield* Ed25519.fromSecretKey((yield* PrivateKey.decode(s, Ed25519.FLAG)).secretKey)  // insist on a scheme

// `generate` gives a Signer only; to keep the key, generate the secret:
const sk = yield* Ed25519.generateSecretKey                               // also Secp256k1/r1, MlDsa65
const exported = yield* PrivateKey.encode({ flag: Ed25519.FLAG, secretKey: sk })

// The CLI's ~/.sui/sui_config/sui.keystore (JSON array of base64 flag || secret)
const keys = yield* PrivateKey.decodeKeystore(json)                       // and encodeKeystore(keys)
```

**Mnemonics** live in `@unconfirmed/sui-mnemonic`, so the BIP39 wordlist never reaches the core. Derivation gives secret keys (the package doesn't depend on the scheme packages), plus an Ed25519 `Signer` shortcut:

```ts
import * as Mnemonic from "@unconfirmed/sui-mnemonic/Mnemonic"
import * as Bip32 from "@unconfirmed/sui-mnemonic/Bip32"

const m = yield* Mnemonic.generate()                                        // 12 words; 24 with generate(24)
const signer = yield* Mnemonic.ed25519Signer(m)                             // m/44'/784'/0'/0'/0'
const k1 = yield* Secp256k1.fromSecretKey(yield* Bip32.secp256k1SecretKey(m, { account: 1 }))     // m/54'/784'/1'/0/0
const seed = yield* Mnemonic.toSeed(m)                                      // derive many keys without re-running PBKDF2
const pq = yield* MlDsa65.fromSecretKey(yield* Mnemonic.mldsa65SecretKey(seed, "m/94'/784'/0'/0'/3'"))
```

Errors are typed: `InvalidMnemonic` (word count, unknown word, checksum, seed length) and `InvalidPath` (each scheme accepts only its own purpose and hardening). Every scheme derives the same keys as `@mysten/sui`. Ed25519 and ML-DSA-65 (SLIP-0010) are in `Mnemonic`, which never imports `@scure/bip32`; Secp256k1/r1 (BIP32) are in `Bip32`. The package root re-exports both, so importing it loads BIP32 in an unbundled runtime (bundlers drop it either way).

**Without Effect.** Derivations that can't wait on anything also come as `…Result`: the same checks, returning Effect's `Result` instead of an `Effect`, for code that only derives keys and addresses. The Effect versions stay (`fromSecretKey` is `Effect.fromResult(fromSecretKeyResult(sk))`); a `…Sync` name, as in `Bcs.encodeSync`, throws instead.

```ts
import * as Result from "effect/Result"
import * as PublicIdentifier from "@unconfirmed/sui-zklogin/PublicIdentifier"
import * as Passkey from "@unconfirmed/sui-passkey"

const ed = Result.getOrThrow(Ed25519.fromSecretKeyResult(sk))             // also Secp256k1/r1.fromSecretKeyResult
const multi = MultiSig.publicKeyResult({ members: [{ publicKey: ed.publicKey, weight: 1 }], threshold: 1 })
const zk = Result.map(PublicIdentifier.makeResult(addressSeed, iss), PublicIdentifier.toPublicKey)  // flag 0x05
const passkey = Passkey.publicKeyResult(storedPasskeyKey)                 // flag 0x06, from the 33-byte compressed key
const ok = Ed25519.verifyRaw(ed.publicKey.bytes, message, signature)      // over the raw message, as Move's ed25519_verify
```

`verifyRaw` is for signatures over bytes that aren't a Sui intent message (a Nautilus enclave's, say); transactions and personal messages verify through the schemes.

**ML-DSA-65** (`@unconfirmed/sui-mldsa65`, flag `0x07`) is FIPS 204 post-quantum signing: 1952-byte public keys, 3309-byte signatures, over the same `blake2b256(intentMessage)` the other schemes sign. Install it like any scheme, and it works as a multisig member. Devnet executes both kinds of transaction (`packages/sui-mldsa65/test/live.devnet.test.ts`).

```ts
SignatureSchemes.layer(Ed25519.scheme, MlDsa65.scheme, MultiSig.scheme)
const signer = yield* MlDsa65.fromSecretKey(seed32)                         // or MlDsa65.generate
const pk = yield* MultiSig.publicKey({ members: [{ publicKey: ed.publicKey, weight: 1 }, { publicKey: signer.publicKey, weight: 1 }], threshold: 1 })
```

## Move codegen

`sui-codegen.config.ts`:

```ts
import { defineConfig } from "@unconfirmed/sui-codegen/Config"

export default defineConfig({
  output: "./src/generated",
  packages: [
    { path: "./move/counter", packageId: "0x…" },                  // local: runs `sui move summary`
    { id: "0x…", network: "testnet", name: "deepbook" },           // on-chain, over gRPC GetPackage
    { path: "./move/counter", package: "sui", modules: ["coin"] }  // framework modules, same summaries
  ]
})
```

```sh
bun packages/sui-codegen/src/bin.ts generate     # or Generate.run(config) from code
```

This writes `src/generated/<package>/<module>.ts` (schemas, type strings and call builders), `<package>/$package.ts`, and `deps/<address>/<module>.ts` (dependency types, pruned to what layouts reach). A generated call is an ordinary recipe step:

```ts nocheck
import * as counter from "./generated/counter/counter.ts"

const recipe = Effect.gen(function*() {
  const [c] = yield* counter.create()                                  // results: a tuple, one per Move return
  yield* counter.increment({ arguments: { counter: c, by: 5n } })      // or positional: [c, 5n]
  const [a, b] = yield* pool.swap({ arguments: [poolId, coin], typeArguments: [SUI, USDC] })  // arity-checked
  yield* Ptb.transferObjects([c, a, b], yield* Ptb.address(me))
})
yield* Tx.run(recipe, { signer }).pipe(Effect.provide(Layer.succeed(counter.Package, testnetId)))  // R needs no Package by default
const value = yield* counter.Counter.get(id)   // Objects.getAs with the generated schema
counter.Counter.type()                         // "0x<packageId>::counter::Counter" (`0x0` without packageId/originalId)
```

- **Package ids.** Each package has one `Package` (`Context.Reference<string>`) defaulting to the id it was generated from, so calls need nothing in `R`; point them elsewhere with `Layer.succeed` / `Effect.provideService`. Type strings use each type's defining (type-origin) id, which survives upgrades.
- **Local packages.** `sui move summary` lists an unpublished package at `0x0` and carries no type origins, so give the published ids: `packageId` (calls) and `originalId` (type strings; default `packageId`, right until the first upgrade), plus `typeOrigins: { "module::Type": id }` for types an upgrade added. `.type()` is synchronous and built at generation time, so providing `Package` at run time does not change it. Without either id, calls and type strings say `0x0`. Several unpublished packages can share one config (each is keyed by its name).
- **Names.** A Move name that would clash in TypeScript is renamed deterministically: a struct named `Move`, `Bcs` or `Package` is bound as `Move_` and still exported as `Move` (a module exporting a type `Package` then leaves the `Package` reference in `$package.ts`); of `foo_bar` and `fooBar` the camelCase one keeps its name and the other keeps its Move name; an argument key taken by an auto-filled object or an earlier argument keeps its Move name if that differs, else gets a numeric suffix (`random: u64` next to `&Random` is `random2`). Functions with a `signer` parameter are skipped with a comment.
- **Writing.** `generate` replaces `<output>/<package>` and `<output>/deps` only when they hold nothing but generated files (otherwise it fails and writes nothing), and fails when two packages would be written to one path. Directories of packages removed from the config are left in place.
- **Schemas.** Structs and enums are BCS Schemas (`_tag` enums, positional structs as tuples). Generic types are functions of their non-phantom parameters' schemas (`Pair(Bcs.u8, Bcs.u64)`); `.type(...)` takes every type argument. Framework types use built-ins (`Move.UID`, `Coin`, `Balance`, `Table`, `VecMap`, `TypeName`, ...).
- **Arguments.** Objects take an id or an argument; pure values take plain TS values (`bigint` for u64+, `string` for addresses, `Uint8Array` for `vector<u8>`, `Option` / bare value / `undefined` for `Option<T>`) or an argument; a generic `T` is encoded by its type argument. `&mut TxContext` is dropped; `Clock`, `Random`, `DenyList`, `SuiSystemState` and `AccumulatorRoot` are filled in as `@mysten/sui` does, and can be overridden by name.
- **Tree-shaking.** Every top-level definition is a `/* @__PURE__ */` call over a thunk, so an unused one disappears under every bundler: one generated call adds ~0.6 KB min / 0.3 KB gzip over a hand-written `Ptb.moveCall` (Mysten's generated module adds ~5.5 / 1.8; both of ours are rows in the bundle report).
- Tests check byte parity with `@mysten/codegen`'s generated types and call builders (`packages/sui-codegen/test/parity.test.ts`) and publish the fixture to devnet (`live.test.ts`).

## Importing

Following [Effect's guidance](https://effect.website/docs/v4/getting-started/importing-effect), every package imports Effect and each other as namespaces from subpaths:

```ts
import * as Effect from "effect/Effect"
import * as Address from "@unconfirmed/sui/Address"
import * as ObjectsGrpc from "@unconfirmed/sui/grpc/ObjectsGrpc"
```

The barrels (`import { Address } from "@unconfirmed/sui"`) exist for convenience. Only bundlers with deep scope analysis (Rolldown, Rollup, Webpack 5+; Bun in practice) shake them well. esbuild doesn't.

**One copy of Effect.** `effect` is a peer dependency (`^4.1.6`) of every package, and so are the `@unconfirmed/*` packages whose services, schemas and errors cross package boundaries (`bcs`, `sui`, `quorum`, `sui-graphql`, `sui-zklogin`): a second copy would make `Context` services and tagged errors from one copy invisible to the other. The app installs them once.

**Strict consumers.** The packages ship their `.ts` sources, so they compile under the consumer's flags. `bun run typecheck:strict` (in CI) checks every package's `src/` with `noUnusedLocals` and `noUnusedParameters` on top of the base config's `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.

## Conventions

Every layer uses the same option names for the same thing. New packages should follow them.

- **Endpoint: `url`.** A layer's main endpoint is `url`: a base URL that request paths are appended to, trailing slashes stripped (`GrpcWeb`, `SuiGrpc.layer`, `EnokiHttp`, Walrus `Aggregator` / `Publisher` / `UploadRelay`). Known endpoints are constants named `TESTNET_URL` / `MAINNET_URL`. One exception: `SuiGraphQL`'s `url` is the GraphQL endpoint itself. Queries are POSTed to it, and subscriptions go to `subscriptionUrl`, which defaults to `url` + `/subscriptions`.
- **Timeouts: `requestTimeout?: Duration.Input`.** It applies to each request, body included, and failing it gives the layer's typed, retryable error. The default depends on the layer: 30 s for a full node, GraphQL, Enoki and storage nodes (15 s inside `Walrus.layer`), 10 s for Seal key servers, 60 s for the aggregator and the upload relay, and 5 min for the publisher. Server streams and subscriptions are never bounded.
- **Retries: `retry?: Schedule.Schedule<unknown, E>`.** This is the schedule for another attempt. Which errors are retried is the operation's own decision (e.g. `StorageNode.retryable`). A generic combinator can't know which errors to retry, so it also takes `retryWhile?: (error: E) => boolean` (`Quorum`). A retry of one particular step gets a prefix (`CheckpointData.follow`'s `gapRetry`). The lifecycle's re-send of signed bytes is a policy (`SubmitConfig.resubmit`), not a per-call option.
- **Headers: `headers?: Readonly<Record<string, string>>`.** These are sent with every request by each layer that has one configured endpoint (the layers above, plus `SuiGraphQL`). The layer's own headers (an API key, the content type) take precedence. Layers that fan out to many servers (storage nodes, Seal key servers) have no `headers` option, since a credential would reach every server. Seal sets `apiKeyName` / `apiKey` for each server instead.
- **Tracer propagation: `tracerPropagation?: boolean`, default `false` everywhere.** Spans are recorded either way. The `traceparent` / `b3` headers are sent only on request, because browsers preflight them and providers with a strict CORS allow-list refuse them.
- **Chain integers keep their width.** A u64 on chain (Sui epochs including `maxEpoch`, object versions, MIST amounts) is a `bigint` in the API, even where a wire format carries a JSON number. Smaller integers, such as Walrus epochs (u32), are `number`.

## What ships (`bun scripts/bundle-report.ts`)

KB minified / minified+gzip, browser target, the app using namespace imports, comments stripped under every bundler (Rolldown otherwise keeps each `@__PURE__` annotation). Add `--named` to compare barrel imports, or `--detail` for a per-package breakdown.

| Program | Bun | esbuild | Rolldown | `@mysten/*` (Rolldown) |
|---|---|---|---|---|
| Effect baseline (HttpClient + Schema) | 128 / 43 | 125 / 43 | 122 / 40 | — |
| `Quorum.run`, three members (no Schema) | 66 / 23 | 65 / 23 | 62 / 21 | — |
| Verify, Ed25519 only | 143 / 51 | 142 / 51 | 140 / 49 | 129 / 44 (ships every scheme) |
| Verify, Ed25519 + k1 + r1 + multisig | 179 / 64 | 176 / 64 | 173 / 61 | — |
| Read one object | 196 / 65 | 196 / 66 | 187 / 62 | 289 / 76 (ships all 30 RPCs) |
| Build + resolve + sign + execute (`SuiGrpc.layerCore`) | 315 / 103 | 311 / 103 | 307 / 99 | 373 / 105 |
| The same with `SuiGrpc.layer` (all nine services) | 343 / 108 | 339 / 108 | 334 / 104 | — |
| The same over GraphQL (`SuiGraphQL.layer`) | 310 / 107 | 304 / 106 | 297 / 101 | — |
| `Lifecycle.run` (`SuiGrpc.layer`, KeyValueStore journal) | 375 / 119 | 370 / 119 | 362 / 113 | — |
| `Lifecycle.run` in a browser (IndexedDB journal, Web Locks) | 380 / 121 | 375 / 120 | 367 / 115 | — |
| The same over OPFS | 379 / 120 | 373 / 120 | 366 / 114 | — |
| Hand-written `Ptb.moveCall` | 82 / 28 | 84 / 29 | 79 / 26 | — |
| One generated call (Walrus `blob.burn`) | 82 / 28 | 85 / 29 | 79 / 27 | — |
| Walrus: read via the aggregator | 139 / 47 | 139 / 47 | 133 / 45 | — |
| Walrus: `Bft` + `Encoding` sizes only | 0.5 / 0.3 | 0.5 / 0.3 | 0.5 / 0.3 | — |
| Walrus: read a blob from the nodes | 341 / 107 | 335 / 106 | 332 / 102 | 401 / 110 (`readBlob`) |
| Walrus: write a blob through the nodes | 417 / 134 | 411 / 134 | 403 / 127 | 446 / 127 (`writeBlob`) |
| Walrus: write a blob through the relay | 422 / 136 | 416 / 135 | 409 / 129 | — |
| Seal: parse an encrypted object | 91 / 31 | 89 / 31 | 93 / 31 | — |
| Seal: encrypt with pinned keys (`Envelope.seal`) | 176 / 63 | 175 / 63 | 177 / 62 | — |
| Seal: encrypt + decrypt (`SealGrpc.layer`, `FetchHttpClient`) | 386 / 135 | 381 / 135 | 375 / 129 | 460 / 135 (`SealClient` + `SuiGrpcClient`) |
| zkLogin: `Nonce.generate` | 97 / 40 | 98 / 41 | 95 / 41 | — |
| zkLogin: `ZkLoginAddress.fromJwt` | 148 / 72 | 148 / 72 | 145 / 72 | — |
| zkLogin: `ZkLogin.signer` | 139 / 49 | 138 / 49 | 140 / 49 | — |
| Mnemonic: Ed25519 signer (`Mnemonic`) | 136 / 52 | 138 / 53 | 135 / 50 | — |
| Mnemonic: Secp256k1 secret key (`Bip32`) | 148 / 56 | 149 / 56 | 146 / 54 | — |

- **zkLogin.** The nonce and the default address-seed path load only the Poseidon arities the circuit uses (1, 2, 4, 5) from `poseidon-lite` subpaths; `@mysten/sui` imports all sixteen (~590 KB minified). The generic `Poseidon.hash` still loads every arity, and so does a non-default claim length (pass `poseidon: Poseidon.hashUnsafe`).
- **Walrus.** JS only, our WASM glue included. Programs that read or write from the nodes also fetch one WASM asset, which no bundler counts: ours is 261 KB / 98 KB gzip (SIMD build; the scalar fallback is 248 KB), `@mysten/walrus`'s 349 KB / 182 KB gzip. The report checks each Walrus bundle for the WASM glue and the quorum code: the aggregator-only and pure-core programs contain neither, under all three bundlers and also with barrel imports. `@mysten/*` is `@mysten/sui` 3.0.1 / `@mysten/walrus` 2.0.1.
- **Seal.** The report checks each Seal bundle for BLS12-381, the quorum code and `HttpClient`. Parsing an encrypted object ships none of them (BCS and `Schema` only). Encrypting with pinned keys ships BLS12-381 (noble, ~80 KB) but neither `HttpClient` nor the quorum, under all three bundlers. The full program, with only the `Objects` and `Packages` gRPC capabilities Seal needs, is 86 KB smaller than `@mysten/seal` 2.0.1 with `@mysten/sui` 3.0.1 (5 KB gzip, Rolldown); providing `SuiGrpc.layer` instead adds about 58 KB, the RPCs of the services Seal doesn't use.
- **Mnemonics.** The report fails if the Ed25519 program ships `@scure/bip32` under any bundler; BIP32 (Secp256k1/r1 derivation) adds ~12 KB / 4 KB gzip.
- **With barrel imports in the app,** esbuild grows by 4–84 KB per program (24–60 KB for most; `--named`); before the library itself switched to namespace imports, it grew ~3×.
- **The Effect runtime dominates** (73–95% of our bundles). Measured with Rolldown:
  - `Effect` + `Layer`: 34 KB min / 12 KB gzip.
  - `HttpClient` (which brings `Stream`): +52 / +16.
  - `Schema` (from `Schema.TaggedError` errors and BCS-as-Schema): +40 / +13.
  - The protobuf codec: ~20 KB.
  - `Quorum.run` is 62 KB against 22 KB for a bare `Effect.runPromise(Effect.succeed(1))`: the quorum code itself is ~6.8 / 2.7 KB (both entry points); the rest is the Effect modules it uses (`Schedule` via retry, spans, `Queue`, `Scope`, `Duration`), which an app with `HttpClient` already ships.
- **For an app already on Effect,** that cost is shared, and the Sui-specific code is a small part of these numbers.

## Develop

```sh
bun install
bun run typecheck     # also compiles examples/: every ```ts README block is checked against them (packages/test-support/test/readme.test.ts)
bun run typecheck:strict  # package src/ only, under the consumer-strict flags (noUnusedLocals, noUnusedParameters)
bun run test          # offline: parity with @mysten/sui (BCS, built tx bytes, signatures, multisig)
bun run test:live     # + testnet reads, devnet Ed25519 / coin-selection / multisig / wallet-standard executions
bun run codegen       # protoc -> descriptor chunks + types from packages/sui/proto/src (sui-apis)
```

Tests read their settings from environment variables only; nothing reads the Sui CLI's config:

| Variable | Effect |
|---|---|
| `SUI_LIVE=1` | Live tests that read testnet and execute on devnet with faucet funds (`bun run test:live`) |
| `SUI_FUNDED_ADDRESS` | A testnet address holding SUI, for live tests that only build (nothing is signed); they skip without it. Also the sender for `packages/sui/bench/build-vs-mysten.ts` |
| `WALRUS_LIVE=1`, `SEAL_LIVE=1` | With `SUI_LIVE=1`, the funded Walrus writes and the Seal owned-object test. These spend testnet SUI and WAL |
| `SUI_LIVE_PRIVATE_KEY` | The `suiprivkey1…` key those funded tests sign with. Never printed or logged; a missing or bad key fails with a fixed message |
| `SUI_BROWSER=1` | The optional real-browser smoke test for the lifecycle's browser stores (Playwright, browsers already installed) |

`@mysten/sui` and `@mysten/codegen` are dev dependencies, used only as reference implementations in parity tests. After changing the codegen fixture, `bun packages/sui-codegen/scripts/fixtures.ts` regenerates its summaries and the golden output.

## Writing a scheme extension

```ts nocheck
export const scheme: SignatureScheme.SignatureScheme</* services it needs */> = {
  name: "MyScheme",
  flag: 0x08,
  verify: (body, intentMessage, registry) => /* Effect<PublicKey, VerifyError, R> */,
  verifyMember: (publicKey, signature, intentMessage, registry) => /* optional: as a multisig member */,
  address: (publicKey) => /* optional: if not blake2b256(flag || publicKey) */
}
export const fromSecretKey = (sk: Uint8Array): Effect.Effect<Signer.Signer, Signer.InvalidKey> => ...
```

`packages/sui/src/Ecdsa.ts` is a complete example (~100 lines; `sui-secp256k1` and `sui-secp256r1` are that module over their noble curve).

## License

[Apache-2.0](LICENSE)
