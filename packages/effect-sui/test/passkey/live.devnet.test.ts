/**
 * A devnet transaction signed by a (software) passkey, through the same
 * `Tx.run` any other signer uses. Opt in with SUI_LIVE=1.
 */
import { Ed25519, Ptb, Resolve, Tx } from "@unconfirmed/sui"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { DEVNET, faucet, grpcLayer, live } from "@unconfirmed/test-support/live"
import * as Passkey from "../src/index.ts"

const suite = live ? describe : describe.skip

suite("devnet passkey", () => {
  test("a passkey Signer executes a transaction", async () => {
    const { layer } = grpcLayer(DEVNET)
    const effects = await Effect.runPromise(
      Effect.gen(function*() {
        const provider = yield* Passkey.softwareProvider()
        const signer = yield* Passkey.create(provider)
        const recipient = yield* Ed25519.generate
        yield* faucet(signer.address)
        return yield* Tx.run(
          Effect.gen(function*() {
            const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
            yield* Ptb.transferObjects([coin!], yield* Ptb.address(recipient.address))
          }),
          { signer, payment: Resolve.coins }
        )
      }).pipe(Effect.provide(layer))
    )
    console.log("passkey executed", effects.digest)
    expect(effects.status._tag).toBe("Success")
  }, 60_000)
})
