/**
 * A 2-of-3 multisig (Ed25519 + Ed25519 + Secp256k1, weights 1/1/2) executing
 * on devnet through the same `Tx.run` any single key uses. Opt in with SUI_LIVE=1.
 */
import { Ed25519, Ptb, Resolve, Tx } from "@unconfirmed/effect-sui"
import * as Secp256k1 from "@unconfirmed/effect-sui/Secp256k1"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { DEVNET, faucet, grpcLayer, live } from "@unconfirmed/test-support/live"
import * as MultiSig from "../../src/MultiSig.ts"

const suite = live ? describe : describe.skip

suite("devnet multisig", () => {
  test("a multisig Signer is just a Signer", async () => {
    const { layer } = grpcLayer(DEVNET)
    const effects = await Effect.runPromise(
      Effect.gen(function*() {
        const a = yield* Ed25519.generate
        const b = yield* Ed25519.generate
        const c = yield* Secp256k1.generate
        const pk = yield* MultiSig.publicKey({
          members: [{ publicKey: a.publicKey, weight: 1 }, { publicKey: b.publicKey, weight: 1 }, { publicKey: c.publicKey, weight: 2 }],
          threshold: 2
        })
        const signer = yield* MultiSig.signer(pk, [c]) // the weight-2 secp256k1 key alone meets the threshold
        yield* faucet(signer.address)
        return yield* Tx.run(
          Effect.gen(function*() {
            const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
            yield* Ptb.transferObjects([coin!], yield* Ptb.address(a.address))
          }),
          { signer, payment: Resolve.coins }
        )
      }).pipe(Effect.provide(layer))
    )
    console.log("multisig executed", effects.digest)
    expect(effects.status._tag).toBe("Success")
  }, 60_000)
})
