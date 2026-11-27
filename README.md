# effect-sdks

Ground-up Effect implementations of the Mysten SDKs. Sui first. See [EXPLORATION.md](EXPLORATION.md) for the reasoning; `spike/` is the original proof of concept.

## Packages

| Package | What | Extra deps |
|---|---|---|
| `@unconfirmed/bcs` | BCS declared as Effect Schemas | `@scure/base` |
| `@unconfirmed/sui` | Core: addresses, type tags, transaction data, PTB builder (incl. address-balance withdrawals, deposits and coin/balance intents), resolver (address-balance gas by default), `Signer`, the signature-scheme registry, Ed25519. Capability services: Chain, Objects, Coins, Packages, Transactions (+ `waitFor`), Checkpoints, DynamicFields, Events, CheckpointData (+ `follow`) | `@noble/hashes`, `@noble/curves` (ed25519 only) |
| `@unconfirmed/sui/grpc` | Every capability over gRPC-web (`HttpClient` + `effect/protobuf`) | — |
| `@unconfirmed/sui-graphql` | Every capability over Sui GraphQL (`effect/graphql`), including SSE subscriptions; mixable with gRPC per service | — |
| `@unconfirmed/sui-lifecycle` | Crash-safe submission: outcomes (applied / not_applied / unknown), identical-bytes resubmission, reconcile from on-chain evidence, journal (memory / KeyValueStore), sender lock | — |
| `@unconfirmed/sui-secp256k1` | Secp256k1 scheme and signers | `@noble/curves` |
| `@unconfirmed/sui-secp256r1` | Secp256r1 scheme and signers | `@noble/curves` |
| `@unconfirmed/sui-multisig` | Multisig scheme, `signer`, `combine` | — |
| `@unconfirmed/sui-zklogin` | zkLogin scheme (verification needs a `ZkLoginVerifier`; gRPC layer provided), signer, addresses, nonce, JWT | `poseidon-lite` |
| `@unconfirmed/sui-enoki` | Enoki client, sponsored transactions (verifies sponsor bytes before signing), zkLogin flow | — |
| `@unconfirmed/sui-codegen` | Move codegen: typed BCS schemas and call builders from `sui move summary` output or an on-chain package (gRPC); a config file and a CLI. Generated code needs only `effect`, `@unconfirmed/bcs` and `@unconfirmed/sui` (runtime: `@unconfirmed/sui/Move`) | — (dev-time) |

Next: passkey, mnemonics/keystore, ML-DSA-65, then `quorum`, Seal and Walrus.

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

**3. Signers are values.** `Signer = { address, publicKey, sign(intentMessage) }`. An in-memory key, a hardware wallet, a KMS, a browser wallet and `MultiSig.signer(pk, [a, b])` are all the same type, and anything that takes a `Signer` (`Tx.run`, `Signer.signPersonalMessage`) works with all of them.

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

// Or by hand: withdrawals and deposits
const w = yield* Ptb.withdrawal({ amount, type, from: "sender" })           // or "sponsor" / an allowance
yield* Ptb.sendFunds(yield* Ptb.redeemCoin(w, type), yield* Ptb.address(to), type)
```

- `Resolve.balances` resolves intents the way `@mysten/sui`'s `tx.coin` / `tx.balance` do, with byte-identical output.
- The transaction's own withdrawals are counted against the address balance before choosing how to pay gas.
- Coin reservation refs match `@mysten/sui`'s encoding and are proven on devnet.
- `Resolve.unchecked` (empty payment, no balance check) is for simulation and for bytes whose payer is funded later.

**5. The transport ships only the RPCs you call.** The generated code has one descriptor constant per protobuf message and one handle per RPC that references only what it reaches. `grpc.unary(Rpc.NameService_LookupName, …)` is the escape hatch for anything the capability services don't cover.

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
bun run test:live     # + testnet reads, devnet Ed25519 / coin-selection / multisig executions
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
