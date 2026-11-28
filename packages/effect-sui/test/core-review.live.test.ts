/**
 * Live regressions for the core review. Opt in with SUI_LIVE=1.
 *
 * - CORE-1 (devnet, faucet): spending 8 SUI from the gas coin when the wallet
 *   holds 6 + ~4 SUI in two coins succeeds (it failed on chain with
 *   `InsufficientCoinBalance` when payment stopped at the budget).
 * - X-1 (testnet): a descending `Events.list` without `start` never comes back
 *   empty, even when the pruning floor moves under it.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { Coins, Ed25519, Events, Ptb, Tx } from "../src/index.ts"
import { DEVNET, faucet, grpcLayer, live, TESTNET } from "./support.ts"

const suite = live ? describe : describe.skip
const SUI = 1_000_000_000n

suite("core review, live", () => {
  test("CORE-1: 8 SUI from the gas coin across two coins (devnet)", async () => {
    const { layer } = grpcLayer(DEVNET)
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        yield* faucet(signer.address)
        const coins = yield* Coins.Coins
        const start = yield* coins.getBalance(signer.address)
        // Split the faucet coin: 6 SUI + the rest, no address balance.
        yield* Tx.run(Effect.gen(function*() {
          const [c] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(6n * SUI)])
          yield* Ptb.transferObjects([c!], yield* Ptb.address(signer.address))
        }), { signer })
        const split = yield* coins.list(signer.address).pipe(
          Stream.runCollect,
          Effect.repeat({ until: (cs) => cs.length === 2, schedule: Schedule.spaced("500 millis"), times: 40 })
        )
        const amount = 8n * SUI
        const data = yield* Tx.build(Effect.gen(function*() {
          const c = yield* Ptb.coin({ amount })
          yield* Ptb.transferObjects([c], yield* Ptb.address(signer.address))
        }), { sender: signer.address })
        const effects = yield* Tx.execute(data, signer)
        return { start: start.total, coins: split.length, payment: data.gasData.payment.length, status: effects.status._tag }
      }).pipe(Effect.provide(layer))
    )
    expect(result.start).toBeGreaterThan(9n * SUI)
    expect(result.coins).toBe(2)
    expect(result.payment).toBe(2)
    expect(result.status).toBe("Success")
  }, 90_000)

  test("X-1: descending Events.list without start never returns nothing (testnet, 20 tries)", async () => {
    const { layer } = grpcLayer(TESTNET)
    const counts = await Effect.runPromise(
      Effect.flatMap(Effect.service(Events.Events), (e) =>
        Effect.forEach(
          Array.from({ length: 20 }),
          () => e.list({ descending: true }).pipe(Stream.take(1), Stream.runCollect, Effect.map((xs) => xs.length)),
          { concurrency: 4 }
        )).pipe(Effect.provide(layer))
    )
    expect(counts.every((n) => n === 1)).toBe(true)
  }, 120_000)
})
