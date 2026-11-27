/**
 * ML-DSA-65 on devnet: a transaction signed by an ML-DSA key alone, and by a
 * multisig whose signing member is ML-DSA. Opt in with SUI_LIVE=1.
 */
import { Ed25519, Ptb, Resolve, Signer, Tx } from "@unconfirmed/sui"
import * as MultiSig from "@unconfirmed/sui-multisig"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { DEVNET, faucet, grpcLayer, live } from "@unconfirmed/test-support/live"
import * as MlDsa65 from "../src/index.ts"

const suite = live ? describe : describe.skip

const send = (signer: Signer.Signer, to: Signer.Signer["address"]) =>
  Effect.gen(function*() {
    yield* faucet(signer.address)
    return yield* Tx.run(
      Effect.gen(function*() {
        const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
        yield* Ptb.transferObjects([coin!], yield* Ptb.address(to))
      }),
      { signer, payment: Resolve.coins }
    )
  })

suite("devnet ML-DSA-65", () => {
  test("an ML-DSA-65 signer executes a transaction", async () => {
    const { layer } = grpcLayer(DEVNET)
    const effects = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* MlDsa65.generate
        const other = yield* Ed25519.generate
        return yield* send(signer, other.address)
      }).pipe(Effect.provide(layer))
    )
    console.log("ML-DSA-65 executed", effects.digest)
    expect(effects.status._tag).toBe("Success")
  }, 60_000)

  test("a multisig with an ML-DSA-65 member executes a transaction", async () => {
    const { layer } = grpcLayer(DEVNET)
    const effects = await Effect.runPromise(
      Effect.gen(function*() {
        const a = yield* Ed25519.generate
        const b = yield* MlDsa65.generate
        const pk = yield* MultiSig.publicKey({
          members: [{ publicKey: a.publicKey, weight: 1 }, { publicKey: b.publicKey, weight: 2 }],
          threshold: 2
        })
        return yield* send(yield* MultiSig.signer(pk, [b]), a.address)
      }).pipe(Effect.provide(layer))
    )
    console.log("ML-DSA-65 multisig executed", effects.digest)
    expect(effects.status._tag).toBe("Success")
  }, 60_000)
})
