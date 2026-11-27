/**
 * Devnet, opt in with SUI_LIVE=1: the in-process wallet signs, we execute;
 * and the wallet resolves + executes itself while we read the effects back.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Ptb, Transactions, Tx } from "@unconfirmed/sui"
import { DEVNET, faucet, grpcLayer, live } from "../../sui/test/support.ts"
import { Wallet } from "../src/index.ts"
import { fakeWallet } from "./FakeWallet.ts"

const suite = live ? describe : describe.skip

suite("devnet through a wallet-standard wallet", () => {
  test("Tx.run with the wallet as signer: we resolve, the wallet signs (Transaction.from), we execute", async () => {
    const { layer } = grpcLayer(DEVNET)
    const keypair = Ed25519Keypair.generate()
    const fake = fakeWallet({ keypair, name: "Live Wallet", chains: ["sui:devnet"] })
    const effects = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        yield* Wallet.register(fake.wallet)
        const wallet = yield* Wallet.find("Live Wallet")
        yield* Wallet.connect(wallet)
        const signer = yield* Wallet.signer(wallet, { chain: "sui:devnet" })
        yield* faucet(signer.address)
        return yield* Tx.run(
          Effect.gen(function*() {
            const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
            yield* Ptb.transferObjects([coin!], yield* Ptb.address(signer.address))
          }),
          { signer }
        )
      })).pipe(Effect.provide(layer))
    )
    console.log("wallet-signed, we executed:", effects.digest)
    expect(effects.status._tag).toBe("Success")
    expect(fake.received).toHaveLength(1)
  }, 90_000)

  test("signAndExecute: the wallet resolves a Draft (coin intent) with its own client and submits; we read the effects", async () => {
    const { layer } = grpcLayer(DEVNET)
    const keypair = Ed25519Keypair.generate()
    const client = new SuiGrpcClient({ network: "devnet", baseUrl: DEVNET })
    const fake = fakeWallet({ keypair, name: "Live Executor", chains: ["sui:devnet"], client })
    const { executed, effects } = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        yield* Wallet.register(fake.wallet)
        const wallet = yield* Wallet.find("Live Executor")
        yield* Wallet.connect(wallet)
        const signer = yield* Wallet.signer(wallet, { chain: "sui:devnet" })
        yield* faucet(signer.address)
        const { draft } = yield* Ptb.build(Effect.gen(function*() {
          const coin = yield* Ptb.coin({ amount: 2_000n })
          yield* Ptb.transferObjects([coin], yield* Ptb.address(signer.address))
        }))
        const executed = yield* signer.signAndExecuteTransaction({ draft })
        const effects = yield* Transactions.waitFor(executed.digest)
        return { executed, effects }
      })).pipe(Effect.provide(layer))
    )
    console.log("wallet resolved + executed:", executed.digest)
    expect(effects.digest).toBe(executed.digest)
    expect(effects.status._tag).toBe("Success")
    expect(executed.effects.length).toBeGreaterThan(0)
  }, 90_000)
})
