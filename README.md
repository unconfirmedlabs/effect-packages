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

Next: Move codegen, then `quorum`, Seal and Walrus.

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
SuiGrpc.layer({ baseUrl })                                  // everything
ObjectsGrpc.layer.pipe(Layer.provide(GrpcWeb.layer({ baseUrl })))  // just Objects
```

**2. Signature schemes are plugins.** The core dispatches on the flag byte but knows only the schemes you install:

```ts
SignatureSchemes.layer(Ed25519.scheme, Secp256k1.scheme, MultiSig.scheme)
```

- A signature from an uninstalled scheme is a typed `UnsupportedScheme`, and that scheme's code isn't in your bundle.
- A scheme that needs services (zkLogin needs chain state) passes those requirements on to the layer. The program doesn't compile until they're provided (see `schemes.test.ts`).
- Multisig verifies each member through the registry, so it supports exactly the member schemes you installed.

**3. Signers are values.** `Signer = { address, publicKey, sign(intentMessage) }`. An in-memory key, a hardware wallet, a KMS and `MultiSig.signer(pk, [a, b])` are all the same type, and anything that takes a `Signer` (`Tx.run`, `Signer.signPersonalMessage`) works with all of them.

A browser wallet never signs raw intent messages: it signs a whole transaction and may change it first (re-resolving gas). That is a `TransactionSigner = { address, signTransaction(data) => { bytes, signature } }`. `Tx.execute` and `Tx.run` take either kind, and submit exactly the bytes the wallet signed. With several signers, wallets sign first; key signers then sign the final bytes.

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
const json = yield* TransactionJson.encode({ sender, draft })   // Ptb.coin / Ptb.balance become CoinWithBalance intents
const json2 = yield* TransactionJson.encode(data)                // resolved TransactionData (with its digest)
// Transaction.from(json) in @mysten/sui builds the same bytes our resolver does.

const tx = yield* TransactionJson.decode(await mystenTx.toJSON({ supportedIntents: ["CoinWithBalance"] }))
const data = yield* TransactionJson.resolve(tx)                  // the default pipeline, keeping the JSON's gas fields
const offline = yield* TransactionJson.toTransactionData(tx)     // already fully resolved: no network
```

An intent other than `CoinWithBalance`, an `UnresolvedPure` that needs a Move signature, or an unknown command or input kind is a typed `UnsupportedTransactionJson`, never dropped.

**Wallets.** `@unconfirmed/sui-wallet` makes wallet-standard Sui wallets signers:

```ts
import * as Wallet from "@unconfirmed/sui-wallet/Wallet"

const wallet = yield* Wallet.find("Slush")                       // or Wallet.wallets / Wallet.changes (a Stream)
const accounts = yield* Wallet.connect(wallet)                   // ConnectionError("rejected") if the user refuses
const signer = yield* Wallet.signer(wallet, { chain: "sui:testnet" })
yield* Tx.run(recipe, { signer })                                // we resolve, the wallet signs, we execute its bytes
yield* signer.signAndExecuteTransaction({ draft })               // or: the wallet resolves and submits
yield* signer.signPersonalMessage(new TextEncoder().encode("hi"))
```

A missing feature is `UnsupportedFeature`; a user rejection is `SigningError` with reason `"rejected"`.

**5. The transport ships only the RPCs you call.** The generated code has one descriptor constant per protobuf message and one handle per RPC that references only what it reaches. `grpc.unary(Rpc.NameService_LookupName, …)` is the escape hatch for anything the capability services don't cover.

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

## Importing

Following [Effect's guidance](https://effect.website/docs/v4/getting-started/importing-effect), every package imports Effect and each other as namespaces from subpaths:

```ts
import * as Effect from "effect/Effect"
import * as Address from "@unconfirmed/sui/Address"
import * as ObjectsGrpc from "@unconfirmed/sui/grpc/ObjectsGrpc"
```

The barrels (`import { Address } from "@unconfirmed/sui"`) exist for convenience. Only bundlers with deep scope analysis (Rolldown, Rollup, Webpack 5+; Bun in practice) shake them well. esbuild doesn't.

## What ships (`bun scripts/bundle-report.ts`)

KB minified / minified+gzip, browser target, the app using namespace imports. Add `--named` to compare barrel imports, or `--detail` for a per-package breakdown.

| Program | Bun | esbuild | Rolldown | `@mysten/sui` 3.0.1 (Rolldown) |
|---|---|---|---|---|
| Effect baseline (HttpClient + Schema) | 128 / 43 | 125 / 43 | 127 / 41 | — |
| Verify, Ed25519 only | 146 / 52 | 144 / 52 | 149 / 50 | 131 / 44 (ships every scheme) |
| Verify, Ed25519 + k1 + r1 + multisig | 177 / 63 | 175 / 63 | 177 / 61 | — |
| Read one object | 205 / 67 | 204 / 68 | 210 / 66 | 294 / 77 (ships all 30 RPCs) |
| Build + resolve + sign + execute | 355 / 103 | 351 / 103 | 360 / 101 | 383 / 106 |

- **With barrel imports in the app,** esbuild grows by ~40 KB per program; before the library itself switched to namespace imports, it grew ~3×.
- **The Effect runtime dominates** (73–95% of our bundles). Measured with Rolldown:
  - `Effect` + `Layer`: 34 KB min / 12 KB gzip.
  - `HttpClient` (which brings `Stream`): +52 / +16.
  - `Schema` (from `Schema.TaggedError` errors and BCS-as-Schema): +40 / +13.
  - The protobuf codec: ~20 KB.
- **For an app already on Effect,** that cost is shared, and the Sui-specific code is a small part of these numbers.

## Develop

```sh
bun install
bun run typecheck
bun run test          # offline: parity with @mysten/sui (BCS, built tx bytes, signatures, multisig)
bun run test:live     # + testnet reads, devnet Ed25519 / coin-selection / multisig / wallet-standard executions
bun run codegen       # protoc -> descriptor chunks + types from packages/sui/proto/src (sui-apis)
```

`@mysten/sui` is a dev dependency, used only as the reference implementation in parity tests.

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
