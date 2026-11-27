/**
 * README examples (How it composes), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { KeyValueStore } from "effect/persistence/KeyValueStore"
import type { Transaction } from "@mysten/sui/transactions"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import * as TransactionJson from "@unconfirmed/sui/TransactionJson"
import * as Wallet from "@unconfirmed/sui-wallet/Wallet"
import * as EvidenceGrpc from "@unconfirmed/sui-lifecycle/EvidenceGrpc"
import { JournalKeyValueStore, Lifecycle } from "@unconfirmed/sui-lifecycle"
import type { Address } from "@unconfirmed/sui/Address"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as Ptb from "@unconfirmed/sui/Ptb"
import * as Resolve from "@unconfirmed/sui/Resolve"
import type * as TransactionData from "@unconfirmed/sui/TransactionData"
import * as Tx from "@unconfirmed/sui/Tx"
import { GrpcWeb } from "@unconfirmed/sui/grpc/GrpcWeb"
import * as DynamicFieldsGrpc from "@unconfirmed/sui/grpc/DynamicFieldsGrpc"
import * as ObjectsGrpc from "@unconfirmed/sui/grpc/ObjectsGrpc"
import * as MultiSig from "@unconfirmed/sui-multisig"
import * as Secp256k1 from "@unconfirmed/sui-secp256k1"
import { baseUrl, recipe as aRecipe, SignatureSchemes, signer, to } from "./shared.ts"

declare const type: string
declare const amount: bigint
declare const allowanceId: string
declare const appAllowanceId: string
declare const pkg: string
declare const sender: Address
declare const data: TransactionData.TransactionData
declare const mystenTx: Transaction
declare const myKeyValueStore: Layer.Layer<KeyValueStore>

export const layers = () => {
  // #region readme
  SuiGrpc.layerCore({ baseUrl })                              // Chain, Objects, Coins, Packages, Transactions: all Tx.run needs
  DynamicFieldsGrpc.layer.pipe(Layer.provideMerge(SuiGrpc.layerCore({ baseUrl })))  // core + one more (layerCore also provides GrpcWeb)
  ObjectsGrpc.layer.pipe(Layer.provide(GrpcWeb.layer({ baseUrl })))  // just Objects
  SuiGrpc.layer({ baseUrl })                                  // all nine, adding Checkpoints, CheckpointData, Events, DynamicFields
  // #endregion
}

export const schemes = () => {
  // #region readme
  SignatureSchemes.layer(Ed25519.scheme, Secp256k1.scheme, MultiSig.scheme)
  // #endregion
}

export const transactions = Effect.gen(function*() {
  // #region readme
  const recipe = Effect.gen(function*() {                     // R = PtbBuilder: buildable offline
    const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
    yield* Ptb.transferObjects([coin], yield* Ptb.address(to))
  })
  yield* Tx.run(recipe, { signer })                           // address-balance gas
  yield* Tx.run(recipe, { signer, payment: Resolve.coins })   // coin selection
  // or by hand: Ptb.build -> Resolve.inputs -> gasPrice -> budget -> <your step> -> finish
  // #endregion
})

export const balances = (recipe: typeof aRecipe) =>
  Effect.gen(function*() {
    // #region readme
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
    // #endregion
  })

export const json = (recipe: typeof aRecipe) =>
  Effect.gen(function*() {
    // #region readme
    const { draft } = yield* Ptb.build(recipe)
    const json = yield* TransactionJson.encode({ sender, draft })   // Ptb.coin / Ptb.balance become CoinWithBalance (or, with `allowance`, AllowanceBalance) intents
    const json2 = yield* TransactionJson.encode(data)                // resolved TransactionData (with its digest)
    // Transaction.from(json) in @mysten/sui builds the same bytes our resolver does.

    const tx = yield* TransactionJson.decode(yield* Effect.promise(() => mystenTx.toJSON({ supportedIntents: ["CoinWithBalance", "AllowanceBalance"] })))
    const resolved = yield* TransactionJson.resolve(tx)              // the default pipeline, keeping the JSON's gas fields
    const offline = yield* TransactionJson.toTransactionData(tx)     // already fully resolved: no network
    // #endregion
  })

export const wallets = (draft: Ptb.Draft, recipe: typeof aRecipe) =>
  Effect.gen(function*() {
    // #region readme
    const wallet = yield* Wallet.find("Slush")                       // or Wallet.wallets / Wallet.changes (a Stream)
    const accounts = yield* Wallet.connect(wallet)                   // ConnectionError("rejected") if the user refuses
    const signer = yield* Wallet.signer(wallet, { chain: "sui:testnet" })
    yield* Tx.run(recipe, { signer })                                // we resolve, the wallet signs, we execute its bytes
    yield* signer.signAndExecuteTransaction({ draft })               // or: the wallet resolves and submits
                                                                    // (a failure after the wallet may have submitted is ExecutionUnconfirmed: check before retrying)
    yield* signer.signPersonalMessage(new TextEncoder().encode("hi"))
    // #endregion
  })

export const lifecycle = (recipe: typeof aRecipe) =>
  Effect.gen(function*() {
    // #region readme
    const layer = Layer.mergeAll(
      EvidenceGrpc.layer.pipe(Layer.provideMerge(SuiGrpc.layer({ baseUrl }))),   // same backend (and GrpcWeb) as Transactions
      JournalKeyValueStore.layer().pipe(Layer.provide(myKeyValueStore))
    )
    yield* Lifecycle.reconcileAll()               // at startup: settle what a crash left, 8 at a time
    const effects = yield* Lifecycle.run(recipe, { signer })
    // #endregion
  })
