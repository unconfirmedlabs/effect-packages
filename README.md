# effect-sdks

Ground-up Effect implementations of the Mysten SDKs. Sui first. See [EXPLORATION.md](EXPLORATION.md) for the reasoning; `spike/` is the original proof of concept.

## Packages

| Package | What | Extra deps |
|---|---|---|
| `@unconfirmed/bcs` | BCS declared as Effect Schemas | `@scure/base` |
| `@unconfirmed/sui` | Core: addresses, type tags, transaction data, PTB builder (incl. address-balance withdrawals, deposits and coin/balance intents), resolver (address-balance gas by default), `TransactionJson` (Mysten `toJSON()` / `Transaction.from` interop), `Signer` / `TransactionSigner`, the signature-scheme registry, Ed25519, `PrivateKey` (`suiprivkey`, `sui.keystore`). Capability services: Chain, Objects, Coins, Packages, Transactions (+ `waitFor`), Checkpoints, DynamicFields, Events, CheckpointData (+ `follow`) | `@noble/hashes`, `@noble/curves` (ed25519 only) |
| `@unconfirmed/sui/grpc` | Every capability over gRPC-web (`HttpClient` + `effect/protobuf`) | — |
| `@unconfirmed/sui-graphql` | Every capability over Sui GraphQL (`effect/graphql`), including SSE subscriptions; mixable with gRPC per service | — |
| `@unconfirmed/sui-lifecycle` | Crash-safe submission: outcomes (applied / not_applied / unknown), identical-bytes resubmission, reconcile from on-chain evidence, journal (memory / KeyValueStore), sender lock | — |
| `@unconfirmed/sui-secp256k1` | Secp256k1 scheme and signers | `@noble/curves` |
| `@unconfirmed/sui-secp256r1` | Secp256r1 scheme and signers | `@noble/curves` |
| `@unconfirmed/sui-mldsa65` | ML-DSA-65 (post-quantum) scheme and signers; works as a multisig member | `@noble/post-quantum` |
| `@unconfirmed/sui-multisig` | Multisig scheme, `signer`, `combine` | — |
| `@unconfirmed/sui-passkey` | Passkey (WebAuthn) scheme (also as a multisig member), signer over a pluggable authenticator (browser `navigator.credentials`, or in-memory for tests and servers), public-key recovery for returning users | `@noble/curves` |
| `@unconfirmed/sui-mnemonic` | BIP39 mnemonics; Ed25519 / ML-DSA-65 (SLIP-0010) and Secp256k1 / r1 (BIP32) derivation on Sui's paths | `@scure/bip39`, `@scure/bip32` |
| `@unconfirmed/sui-zklogin` | zkLogin scheme (verification needs a `ZkLoginVerifier`; gRPC layer provided), signer, addresses, nonce, JWT | `poseidon-lite` |
| `@unconfirmed/sui-enoki` | Enoki client, sponsored transactions (verifies sponsor bytes before signing), zkLogin flow | — |
| `@unconfirmed/sui-wallet` | Wallet-standard Sui wallets: discovery, connect, accounts and chains, a wallet `TransactionSigner` for `Tx.run` / `Tx.execute`, `signAndExecuteTransaction`, `signPersonalMessage` | `@wallet-standard/app` (+ types from `@wallet-standard/base`) |
| `@unconfirmed/quorum` | Weighted first-threshold-of-n: `Quorum.run` (stop once enough weight succeeded) and `Quorum.agree` (stop once enough weight agrees on one answer), with per-member retry, a concurrency cap, (weighted) shuffled start order, an optional linger window and an optional early give-up. Knows nothing about Sui; used by Walrus and Seal | — |
| `@unconfirmed/sui-codegen` | Move codegen: typed BCS schemas and call builders from `sui move summary` output or an on-chain package (gRPC); a config file and a CLI. Generated code needs only `effect`, `@unconfirmed/bcs` and `@unconfirmed/sui` (runtime: `@unconfirmed/sui/Move`) | — (dev-time) |
| `@unconfirmed/walrus` | Walrus: read blobs from the storage nodes (verified, bad slivers blamed and replaced), write them (certified at `n − f` shards, resumable steps), the upload relay, aggregator and publisher gateways, quilts. Erasure coding and BLS through `@mysten/walrus-wasm`, loaded on first use | `@mysten/walrus-wasm`, `@noble/hashes` |
| `@unconfirmed/seal` | Seal: threshold identity-based encryption to key servers registered on Sui (independent and committee), session keys (key or wallet signer, one prompt), `seal_approve` approvals, key fetching over `Quorum` with every key verified, decryption. The crypto core (BLS12-381, Shamir, KDF, DEMs, the encrypted object) is pure and usable offline | `@noble/curves`, `@noble/hashes`, `@scure/base` |

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
  schedule: nodeRetry, while: (e) => e.retryable,  // per-member retry
  concurrency: 50, order: "weightedShuffle",
  linger: (elapsed) => Duration.sum(Duration.times(elapsed, 0.5), Duration.millis(500))  // wait for stragglers
})

const { winner } = yield* Quorum.agree(nodes, { weight, run: getStatus, key: canonical, threshold: f + 1, quorum: 2 * f + 1 })
```

- It returns on the success that crosses the threshold and fails fast (`QuorumFailed`, `reason: "unreachable"`) the moment failures leave too little weight; everything still in flight is interrupted and awaited before it returns.
- Results and errors carry every success, failure (with its typed error) and unsettled member, so callers can classify failures (`Quorum.failedWeight`).
- `giveUp: { when, weight, grace? }` (`run` only) stops early once final failures matching `when` weigh `weight` (`reason: "gaveUp"`), for failures that make success pointless rather than impossible: Walrus metadata stops at `2f + 1` not-found weight instead of waiting for every node; Seal stops once denials weigh `t`. An optional `grace` keeps going for a moment, and a threshold reached in it still succeeds.
- A defect in a member fails the whole call; it is not counted as a member failure. Timeouts go inside `run` (per attempt) or around the call (overall).
- `QuorumFailed` / `AgreementFailed` are `Data.TaggedError`s (generic in your member and error types, no `Schema`); convert them at your boundary. Design: [docs/design/quorum.md](docs/design/quorum.md).

### Walrus

```ts
import * as Read from "@unconfirmed/walrus/Read"
import * as Walrus from "@unconfirmed/walrus/Walrus"
import * as Write from "@unconfirmed/walrus/Write"
import * as SuiGrpc from "@unconfirmed/sui/grpc"

// System, committees, storage nodes and the encoder for one network; needs an HttpClient and a Sui client.
const layer = Walrus.layer({ network: "testnet" }).pipe(          // or { config: { systemObjectId, stakingObjectId } }
  Layer.provideMerge(SuiGrpc.layer({ baseUrl: "https://fullnode.testnet.sui.io:443" })),
  Layer.provideMerge(FetchHttpClient.layer)
)

const bytes = yield* Read.blob(blobId)                            // straight from the storage nodes, verified
const status = yield* Read.status(blobId)                         // { _tag: "Permanent", endEpoch, isCertified, ... }, f + 1 shards agreeing

// Write through the nodes: encode, register, upload, certify (two transactions, signed by `signer`).
const certified = yield* Write.run(bytes, { epochs: 5, deletable: true, executor: Write.viaTx(signer) })
// { _tag: "Certified", blobId, blobObjectId, certifiedEpoch, endEpoch, deletable, digest }
```

- **Reads** verify the metadata against the blob id before using it, check each sliver's shape, decode from `n − 2f` shards and re-derive the blob id (`consistency: "strict"`, the default). If the bytes don't match, the slivers are checked one by one: a node that served a bad one is blamed and replaced. Only a blob the writer encoded wrongly is `InconsistentBlob`. A blob unknown to `2f + 1` shards is `BlobNotFound` (`BlobBlocked` for blocked blobs), typically within seconds. During an epoch change the read committee is chosen per blob from its certified epoch.
- **Writes** count weight in shards, as the chain does. The certificate is built at `n − f` (`@mysten/walrus` counts nodes, so it can refuse a valid certificate or build one the chain rejects). Each confirmation's signature is checked. In-flight sliver bytes are capped (12.5 MB), retries are per request, and the write lingers `0.5 × elapsed + 500 ms` after the quorum for stragglers, as the Rust client does. [docs/design/walrus.md](docs/design/walrus.md) §1.8 and §2 list what differs from `@mysten/walrus` and why.
- **Steps are resumable.** `onStep` receives each step as plain JSON (`Schema.encode(Write.Step)`), and `resume` continues from it in another process. Each step checks the chain before acting, so a crash between register and persist reuses the registration rather than paying again. For the transactions themselves, any `Executor` works: `Write.viaTx(signer)` (a key or a wallet), or `sui-lifecycle`'s `Lifecycle.run` for a journal.
- **Through the upload relay** the blob goes to a relay that encodes and stores it for a tip in SUI. The relay's certificate is verified before the certify transaction is built. Only relay writes need the relay layer (`via: "relay"` adds `UploadRelay` to the requirements):

  ```ts
  const layer = Layer.mergeAll(
    Walrus.layer({ network: "testnet" }),
    UploadRelay.layer({ host: UploadRelay.TESTNET_HOST, maxTip: 1_000n })   // tips above maxTip (MIST) are TipTooHigh
  ).pipe(Layer.provideMerge(SuiGrpc.layer({ baseUrl })), Layer.provideMerge(FetchHttpClient.layer))
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
  const { quilt, patches } = yield* Quilt.encode(entries, nShards)   // entries: { identifier, contents, tags? }[]; byte-identical to @mysten/walrus
  const certified = yield* Write.run(quilt, { epochs: 5, deletable: true, attributes: Quilt.ATTRIBUTE, executor: Write.viaTx(signer) })
  const file = yield* QuiltRead.patch(Quilt.patchId(certified.blobId, patches[0]!))   // or QuiltRead.byIdentifier(blobId, "hello.txt")
  ```

  A patch read fetches only that file's columns, each from the node holding its shard, and verifies them together (one WASM call, two for `byIdentifier`) before returning anything; any missing or mismatching column falls back to `Read.blob`. `@mysten/walrus` trusts one node's unverified sliver here. `verify: false` skips the check.
- Every failure is a typed `Schema.TaggedError` (`BlobNotFound`, `NotEnoughSlivers`, `NotEnoughConfirmations`, `EncoderError`, ...). Nothing a node, gateway or the WASM throws escapes as a defect.

**The WASM.** Erasure coding and BLS run in `@mysten/walrus-wasm`. Each call takes about 2.5 s at testnet's 1000 shards, synchronously, whatever the blob size up to a few MB: a read costs two calls, a write one. The module is imported only when an `Encoder` layer is built, so importing the package costs nothing until then. How to load it depends on the runtime:

| Runtime | What to do |
|---|---|
| Bun, Node (unbundled) | Nothing. |
| Server bundle | Keep `@mysten/walrus-wasm` external (`--external @mysten/walrus-wasm`). A Bun bundle that inlines it works only on the machine that built it, and esbuild's ESM output fails (no `__dirname`). |
| Browser, Vite / webpack 5 | Nothing (they emit the `.wasm`), or pass `wasmUrl` from `import wasmUrl from "@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url"` (Vite). |
| Browser, esbuild / Rolldown / Bun | Serve `node_modules/@mysten/walrus-wasm/web/walrus_wasm_bg.wasm` (358 KB) and pass its URL: `Walrus.layer({ network, wasmUrl: "/walrus_wasm_bg.wasm" })` (or `Encoder.layer({ wasmUrl })`). |

**Live tests.** `SUI_LIVE=1 bun test packages/walrus` reads testnet without spending anything: committees, a recently certified blob through the nodes and through the public aggregator, and a random id. Add `WALRUS_LIVE=1` to also write. That uses the Sui CLI's active address (`~/.sui/sui_config`): direct, resumed and relay writes of 32-byte blobs, each burned afterwards, about 0.003–0.005 SUI and 0.0009 WAL per write.

### Seal

```ts
import * as Approval from "@unconfirmed/seal/Approval"
import * as Config from "@unconfirmed/seal/Config"
import * as Seal from "@unconfirmed/seal/Seal"
import * as SuiGrpc from "@unconfirmed/sui/grpc"

// Configuration, key servers read from chain, and the key server HTTP client; needs an HttpClient and a Sui client.
const layer = Seal.layer({ servers: [Config.testnet.mysten1, Config.testnet.mysten2, Config.testnet.committee] }).pipe(
  Layer.provideMerge(SuiGrpc.layer({ baseUrl: "https://fullnode.testnet.sui.io:443" })),
  Layer.provideMerge(FetchHttpClient.layer)
)

const id = Bcs.encodeSync(Bcs.Address)(signer.address)                       // account_based: the id is the user's address
const { encryptedObject } = yield* Seal.encrypt({ packageId, id, data, threshold: 2 })   // or dem: "Hmac256Ctr", aad

const session = yield* Seal.session({ packageId, signer })                   // a key Signer or a wallet's WalletSigner
const approval = yield* Approval.fromRecipe(Approval.call({ target: `${packageId}::account_based::seal_approve`, id }))
const plaintext = yield* Seal.decrypt({ data: encryptedObject, session, approval })      // one prompt, one round of requests
```

- **Weights come from the ciphertext.** `decrypt` asks the servers the object names that are also configured, each counting for its number of shares in the object. `@mysten/seal` requires the client's configured weights to equal the object's. Servers the object names but the configuration lacks are never contacted: their URLs come from objects anyone can create, and a request tells the server who is asking for what. Their public keys are still read from chain when `checkShareConsistency: true`.
- **Strict ids.** Package, server and user ids are `0x` + 64 hex digits. A short or unprefixed id is refused up front; `@mysten/seal` signs it as given and every server then rejects the session. `decrypt` checks that the object, the session and the approval belong together (`ApprovalMismatch`) before sending anything. `Seal.session` checks that the package is a first version, which `SessionKey.make` doesn't.
- **One wallet prompt per session.** Concurrent callers share the prompt; a rejected prompt isn't remembered. `@mysten/seal` prompts once per concurrent call.
- **The derived-key cache belongs to the session** and is checked after the session's expiry. `@mysten/seal` keeps one unbounded cache per client and returns from it before looking at the session, so an expired session, or another user's session on the same client, decrypts from it. `Seal.fetchKeys({ objects, session, approval })` fetches keys for many objects in one round; after that, `decrypt` sends nothing. Every key is verified against the server's on-chain public key before it is cached or used.
- **`ThresholdNotMet` lists every server's failure**, each a typed `KeyServerError` (`NoAccess` with the Move abort, `InvalidPtb`, `Timeout`, `RateLimited`, ...), plus `reason: "denied" | "unreachable" | "insufficientWeight"`. `@mysten/seal` throws one "majority" error, or `undefined` when servers answer with unusable keys. Transient failures are retried per server.
- **Early stop.** Once refusals of the request itself weigh the threshold, the call waits `denialGrace` (2 s) and gives up, rather than waiting for a dead server's 10 s timeout. Under a low threshold (1 of 3), a user who isn't allowed finds out in about 2 s. An approval that arrives inside the window still wins.
- `Seal.derivedKeys` gives verified keys for on-chain decryption. Committee (MPC) servers go through their aggregator (`aggregatorUrl`, `apiKeyName` / `apiKey` on mainnet). With pinned public keys, `Envelope.seal` / `Envelope.open` encrypt and decrypt with no service at all. Design and every difference from `@mysten/seal`: [docs/design/seal.md](docs/design/seal.md) §1.7 and §2.

**Live tests.** `SUI_LIVE=1 bun test packages/seal` runs against testnet without spending anything: key server objects and proofs, and decryption with fresh in-memory keys under Mysten's canary policies (`account_based`, `tle`). That covers interop with `@mysten/seal`, a denial, `fetchKeys`, a wallet signer, an unreachable server and open-mode errors. Add `SEAL_LIVE=1` to also run the owned-object policy (`private_data`) with the Sui CLI's active address (`~/.sui/sui_config`). That creates one small object per run, about 0.003 SUI, not refundable.

## How it composes

**1. Capabilities are separate services.** Instead of one client with 30 methods there are `Chain`, `Objects`, `Coins`, `Packages`, `Transactions` and `Checkpoints`. A function's type says what it touches:

```ts
Resolve.inputs   // Effect<Plan, ObjectNotFound | RpcError, Objects | Packages>
Resolve.budget   // Effect<Plan, ..., Transactions | Chain>
Resolve.coins    // Effect<Plan, ..., Coins>
```

A test provides only those services. A transport can implement a subset, and the compiler tells you what's missing. Transports can also be mixed, e.g. gRPC for execution and GraphQL for history, with `Layer.merge`.

```ts
import * as SuiGrpc from "@unconfirmed/sui/grpc"
SuiGrpc.layerCore({ baseUrl })                              // Chain, Objects, Coins, Packages, Transactions: all Tx.run needs
DynamicFieldsGrpc.layer.pipe(Layer.provideMerge(SuiGrpc.layerCore({ baseUrl })))  // core + one more (layerCore also provides GrpcWeb)
ObjectsGrpc.layer.pipe(Layer.provide(GrpcWeb.layer({ baseUrl })))  // just Objects
SuiGrpc.layer({ baseUrl })                                  // all nine, adding Checkpoints, CheckpointData, Events, DynamicFields
```

Prefer `layerCore` or an explicit composition: a program ships the RPCs of the layers it provides, and `SuiGrpc.layer` adds about 27 KB of checkpoint, event and dynamic-field code that a transaction never calls.

**2. Signature schemes are plugins.** The core dispatches on the flag byte but knows only the schemes you install:

```ts
SignatureSchemes.layer(Ed25519.scheme, Secp256k1.scheme, MultiSig.scheme)
```

- A signature from an uninstalled scheme is a typed `UnsupportedScheme`, and that scheme's code isn't in your bundle.
- A scheme that needs services (zkLogin needs chain state) passes those requirements on to the layer. The program doesn't compile until they're provided (see `schemes.test.ts`).
- Multisig verifies each member through the registry, so it supports exactly the member schemes you installed.

**3. Signers are values.** `Signer = { address, publicKey, sign(intentMessage) }`. An in-memory key, a hardware wallet, a KMS and `MultiSig.signer(pk, [a, b])` are all the same type, and anything that takes a `Signer` (`Tx.run`, `Signer.signPersonalMessage`) works with all of them.

A browser wallet never signs raw intent messages: it signs a whole transaction and may change it first (re-resolving gas). That is a `TransactionSigner = { address, signTransaction(data) => { bytes, signature } }`. `Tx.execute` and `Tx.run` take either kind, and submit exactly the bytes the wallet signed. With several signers, wallets sign first; key signers then sign the final bytes. A wallet may re-pick only gas terms it pays for: a changed sender, command, input or gas owner, or changed gas terms a key signer (a sponsor) pays for, is a `SigningError` before any key signs.

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

**Address balances are the default way to pay and send.**

```ts
// Gas: Resolve.auto (the default) pays from the address balance when it covers the
// budget and the gas coin isn't used, otherwise with coins. If the gas coin is used,
// a coin reservation lets the address balance fund it.
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

const tx = yield* TransactionJson.decode(await mystenTx.toJSON({ supportedIntents: ["CoinWithBalance", "AllowanceBalance"] }))
const data = yield* TransactionJson.resolve(tx)                  // the default pipeline, keeping the JSON's gas fields
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
                                                                // (a bad answer after submitting is ExecutionUnconfirmed, with the digest: check before retrying)
yield* signer.signPersonalMessage(new TextEncoder().encode("hi"))
```

A missing feature is `UnsupportedFeature`; a user rejection is `SigningError` with reason `"rejected"`.

**5. The transport ships only the RPCs you call, and only the fields it reads.** The generated code has one descriptor constant per protobuf message and one handle per RPC that references only what it reaches. The capability services use pruned handles (`generated/lean.ts`, generated from `packages/sui/scripts/grpc-lean.ts`) whose descriptors carry just the fields in their read masks; the rest of a response is skipped as unknown fields. `grpc.unary(Rpc.NameService_LookupName, …)` is the escape hatch for anything the capability services don't cover, with full descriptors.

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
import * as Mnemonic from "@unconfirmed/sui-mnemonic"

const m = yield* Mnemonic.generate()                                        // 12 words; 24 with generate(24)
const signer = yield* Mnemonic.ed25519Signer(m)                             // m/44'/784'/0'/0'/0'
const k1 = yield* Secp256k1.fromSecretKey(yield* Mnemonic.secp256k1SecretKey(m, { account: 1 }))  // m/54'/784'/1'/0/0
const seed = yield* Mnemonic.toSeed(m)                                      // derive many keys without re-running PBKDF2
const pq = yield* MlDsa65.fromSecretKey(yield* Mnemonic.mldsa65SecretKey(seed, "m/94'/784'/0'/0'/3'"))
```

Errors are typed: `InvalidMnemonic` (word count, unknown word, checksum, seed length) and `InvalidPath` (each scheme accepts only its own purpose and hardening). Every scheme derives the same keys as `@mysten/sui`.

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
    { path: "./move/counter" },                                    // local: runs `sui move summary`
    { id: "0x…", network: "testnet", name: "deepbook" },           // on-chain, over gRPC GetPackage
    { path: "./move/counter", package: "sui", modules: ["coin"] }  // framework modules, same summaries
  ]
})
```

```sh
bun packages/sui-codegen/src/bin.ts generate     # or Generate.run(config) from code
```

This writes `src/generated/<package>/<module>.ts` (schemas, type strings and call builders), `<package>/$package.ts`, and `deps/<address>/<module>.ts` (dependency types, pruned to what layouts reach). A generated call is an ordinary recipe step:

```ts
import * as counter from "./generated/counter/counter.ts"

const recipe = Effect.gen(function*() {
  const [c] = yield* counter.create()                                  // results: a tuple, one per Move return
  yield* counter.increment({ arguments: { counter: c, by: 5n } })      // or positional: [c, 5n]
  const [a, b] = yield* pool.swap({ arguments: [poolId, coin], typeArguments: [SUI, USDC] })  // arity-checked
  yield* Ptb.transferObjects([c, a, b], yield* Ptb.address(me))
})
yield* Tx.run(recipe, { signer }).pipe(Effect.provide(Layer.succeed(counter.Package, testnetId)))  // R needs no Package by default
const value = yield* counter.Counter.get(id)   // Objects.getAs with the generated schema
counter.Counter.type()                         // "0x<defining id>::counter::Counter"
```

- **Package ids.** Each package has one `Package` (`Context.Reference<string>`) defaulting to the id it was generated from, so calls need nothing in `R`; point them elsewhere with `Layer.succeed` / `Effect.provideService`. Type strings use each type's defining (type-origin) id, which survives upgrades.
- **Schemas.** Structs and enums are BCS Schemas (`_tag` enums, positional structs as tuples). Generic types are functions of their non-phantom parameters' schemas (`Pair(Bcs.u8, Bcs.u64)`); `.type(...)` takes every type argument. Framework types use built-ins (`Move.UID`, `Coin`, `Balance`, `Table`, `VecMap`, `TypeName`, ...).
- **Arguments.** Objects take an id or an argument; pure values take plain TS values (`bigint` for u64+, `string` for addresses, `Uint8Array` for `vector<u8>`, `Option` / bare value / `undefined` for `Option<T>`) or an argument; a generic `T` is encoded by its type argument. `&mut TxContext` is dropped; `Clock`, `Random`, `DenyList`, `SuiSystemState` and `AccumulatorRoot` are filled in as `@mysten/sui` does, and can be overridden by name.
- **Tree-shaking.** Every top-level definition is a `/* @__PURE__ */` call over a thunk, so an unused one disappears under every bundler: one generated call adds ~2.6 KB min / 0.8 KB gzip over a hand-written `Ptb.moveCall` (Mysten's generated module adds ~5.5 / 1.8).
- Tests check byte parity with `@mysten/codegen`'s generated types and call builders (`packages/sui-codegen/test/parity.test.ts`) and publish the fixture to devnet (`live.test.ts`).

## Importing

Following [Effect's guidance](https://effect.website/docs/v4/getting-started/importing-effect), every package imports Effect and each other as namespaces from subpaths:

```ts
import * as Effect from "effect/Effect"
import * as Address from "@unconfirmed/sui/Address"
import * as ObjectsGrpc from "@unconfirmed/sui/grpc/ObjectsGrpc"
```

The barrels (`import { Address } from "@unconfirmed/sui"`) exist for convenience. Only bundlers with deep scope analysis (Rolldown, Rollup, Webpack 5+; Bun in practice) shake them well. esbuild doesn't.

## What ships (`bun scripts/bundle-report.ts`)

KB minified / minified+gzip, browser target, the app using namespace imports, comments stripped under every bundler (Rolldown otherwise keeps each `@__PURE__` annotation). Add `--named` to compare barrel imports, or `--detail` for a per-package breakdown.

| Program | Bun | esbuild | Rolldown | `@mysten/*` (Rolldown) |
|---|---|---|---|---|
| Effect baseline (HttpClient + Schema) | 128 / 43 | 125 / 43 | 122 / 40 | — |
| `Quorum.run`, three members (no Schema) | 60 / 20 | 59 / 21 | 56 / 19 | — |
| Verify, Ed25519 only | 146 / 52 | 144 / 51 | 144 / 50 | 129 / 44 (ships every scheme) |
| Verify, Ed25519 + k1 + r1 + multisig | 178 / 63 | 176 / 63 | 173 / 60 | — |
| Read one object | 199 / 66 | 197 / 67 | 195 / 64 | 289 / 76 (ships all 30 RPCs) |
| Build + resolve + sign + execute (`SuiGrpc.layerCore`) | 311 / 101 | 306 / 101 | 302 / 97 | 373 / 105 |
| The same with `SuiGrpc.layer` (all nine services) | 338 / 106 | 333 / 106 | 329 / 101 | — |
| Walrus: read via the aggregator | 144 / 49 | 144 / 49 | 145 / 47 | — |
| Walrus: `Bft` + `Encoding` sizes only | 0.5 / 0.3 | 0.5 / 0.3 | 0.5 / 0.3 | — |
| Walrus: read a blob from the nodes | 384 / 110 | 378 / 110 | 388 / 107 | 409 / 111 (`readBlob`) |
| Walrus: write a blob through the nodes | 453 / 136 | 447 / 135 | 455 / 130 | 455 / 128 (`writeBlob`) |
| Walrus: write a blob through the relay | 458 / 137 | 452 / 137 | 460 / 132 | — |
| Seal: parse an encrypted object | 91 / 31 | 90 / 31 | 97 / 31 | — |
| Seal: encrypt with pinned keys (`Envelope.seal`) | 177 / 63 | 175 / 63 | 183 / 62 | — |
| Seal: encrypt + decrypt (the layer, gRPC, `FetchHttpClient`) | 487 / 150 | 481 / 150 | 490 / 145 | 470 / 136 (`SealClient` + `SuiGrpcClient`) |

- **Walrus.** JS only. Programs that read or write from the nodes also fetch the 358 KB WASM, which no bundler counts. The report checks each Walrus bundle for the WASM glue and the quorum code: the aggregator-only and pure-core programs contain neither, under all three bundlers and also with barrel imports. `@mysten/*` is `@mysten/sui` 3.0.1 / `@mysten/walrus` 2.0.1.
- **Seal.** The report checks each Seal bundle for BLS12-381, the quorum code and `HttpClient`. Parsing an encrypted object ships none of them (BCS and `Schema` only). Encrypting with pinned keys ships BLS12-381 (noble, ~80 KB) but neither `HttpClient` nor the quorum, under all three bundlers. The full program is 20 KB larger than `@mysten/seal` 2.0.1 with `@mysten/sui` 3.0.1 (9 KB gzip, Rolldown).
- **With barrel imports in the app,** esbuild grows by ~40 KB per program; before the library itself switched to namespace imports, it grew ~3×.
- **The Effect runtime dominates** (73–95% of our bundles). Measured with Rolldown:
  - `Effect` + `Layer`: 34 KB min / 12 KB gzip.
  - `HttpClient` (which brings `Stream`): +52 / +16.
  - `Schema` (from `Schema.TaggedError` errors and BCS-as-Schema): +40 / +13.
  - The protobuf codec: ~20 KB.
  - `Quorum.run` is 59 KB against 26 KB for a bare `Effect.runPromise(Effect.succeed(1))`: the quorum code itself is ~6.8 / 2.7 KB (both entry points); the rest is the Effect modules it uses (`Schedule` via retry, spans, `Queue`, `Scope`, `Duration`), which an app with `HttpClient` already ships.
- **For an app already on Effect,** that cost is shared, and the Sui-specific code is a small part of these numbers.

## Develop

```sh
bun install
bun run typecheck
bun run test          # offline: parity with @mysten/sui (BCS, built tx bytes, signatures, multisig)
bun run test:live     # + testnet reads, devnet Ed25519 / coin-selection / multisig / wallet-standard executions
bun run codegen       # protoc -> descriptor chunks + types from packages/sui/proto/src (sui-apis)
```

`@mysten/sui` and `@mysten/codegen` are dev dependencies, used only as reference implementations in parity tests. After changing the codegen fixture, `bun packages/sui-codegen/scripts/fixtures.ts` regenerates its summaries and the golden output.

## Writing a scheme extension

```ts
export const scheme: SignatureScheme.SignatureScheme</* services it needs */> = {
  name: "MyScheme",
  flag: 0x08,
  verify: (body, intentMessage, registry) => /* Effect<PublicKey, VerifyError, R> */,
  verifyMember: (publicKey, signature, intentMessage, registry) => /* optional: as a multisig member */,
  address: (publicKey) => /* optional: if not blake2b256(flag || publicKey) */
}
export const fromSecretKey = (sk: Uint8Array): Effect.Effect<Signer.Signer, Signer.InvalidKey> => ...
```

`packages/sui-secp256k1/src/index.ts` is a complete example (~80 lines).

## License

[Apache-2.0](LICENSE)
