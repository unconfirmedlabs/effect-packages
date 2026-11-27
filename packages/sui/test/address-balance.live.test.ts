/**
 * Address balances on devnet, end to end. Opt in with SUI_LIVE=1.
 *
 * faucet coins → deposit into the address balance (paid with coins) → a
 * transfer paid from the address balance whose coin and balance come from it →
 * a gas-coin transaction funded by a coin reservation → a typed refusal when
 * the address balance can't pay.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { Address, CoinReservation, Coins, Ed25519, Ptb, Resolve, Tx } from "../src/index.ts"
import { DEVNET, faucet, grpcLayer, live } from "./support.ts"

const suite = live ? describe : describe.skip
const SUI = 1_000_000_000n

/** Poll a balance until `ok` holds: full-node indexes trail execution slightly. */
const balanceWhen = (owner: Address.Address, ok: (b: Coins.Balance) => boolean) =>
  Effect.flatMap(Effect.service(Coins.Coins), (c) =>
    c.getBalance(owner).pipe(
      Effect.repeat({ until: ok, schedule: Schedule.spaced("500 millis"), times: 40 })
    ))

suite("address balances on devnet", () => {
  test("deposit, pay gas from it, send coins and balances from it, fund the gas coin by reservation", async () => {
    const { layer } = grpcLayer(DEVNET)
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const a = yield* Ed25519.generate
        const b = yield* Ed25519.generate
        yield* faucet(a.address)

        // 1. Deposit 2 SUI into A's address balance. A has no address balance yet,
        //    so `auto` pays gas with A's faucet coin.
        const deposit = yield* Tx.build(
          Effect.gen(function*() {
            const [two] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(2n * SUI)])
            yield* Ptb.sendFunds(two!, yield* Ptb.address(a.address))
          }),
          { sender: a.address }
        )
        const depositPaidWithCoins = deposit.gasData.payment.length > 0 && !deposit.gasData.payment.some(CoinReservation.isReservation)
        yield* Tx.execute(deposit, a)
        const afterDeposit = yield* balanceWhen(a.address, (x) => x.addressBalance >= 2n * SUI)

        // 2. Pay B a coin and an address-balance deposit, both drawn from A's address
        //    balance, with gas also paid from it: no coin objects involved.
        const transfer = yield* Tx.build(
          Effect.gen(function*() {
            const coin = yield* Ptb.coin({ amount: 1_000n, useGasCoin: false })
            const bal = yield* Ptb.balance({ amount: 500n, useGasCoin: false })
            const to = yield* Ptb.address(b.address)
            yield* Ptb.transferObjects([coin], to)
            yield* Ptb.sendBalance(bal, to)
          }),
          { sender: a.address }
        )
        const transferEffects = yield* Tx.execute(transfer, a)
        const bBalance = yield* balanceWhen(b.address, (x) => x.addressBalance === 500n && x.coinBalance === 1_000n)

        // 3. A transaction that uses the gas coin, paid strictly from the address
        //    balance: the gas coin is funded by a coin reservation.
        const reserved = yield* Tx.build(
          Effect.gen(function*() {
            const [c] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(7n)])
            yield* Ptb.transferObjects([c!], yield* Ptb.address(b.address))
          }),
          { sender: a.address, payment: Resolve.addressBalance }
        )
        const reservedEffects = yield* Tx.execute(reserved, a)

        // 4. An empty account can't pay from its address balance: refused before signing.
        const broke = yield* Ed25519.generate
        const refused = yield* Tx.build(
          Effect.flatMap(Ptb.address(b.address), (to) => Ptb.transferObjects([], to)),
          { sender: broke.address, payment: Resolve.addressBalance, gasBudget: 2_000_000n }
        ).pipe(Effect.flip)

        return {
          depositPaidWithCoins,
          afterDeposit,
          transfer,
          transferEffects,
          bBalance,
          reserved,
          reservedEffects,
          refused
        }
      }).pipe(Effect.provide(layer))
    )

    expect(result.depositPaidWithCoins).toBe(true)
    expect(result.afterDeposit.addressBalance).toBeGreaterThanOrEqual(2n * SUI)

    // Address-balance gas: empty payment, ValidDuring replay protection.
    expect(result.transfer.gasData.payment).toEqual([])
    expect(result.transfer.expiration._tag).toBe("ValidDuring")
    expect(result.transfer.kind.inputs.some((i) => i._tag === "FundsWithdrawal")).toBe(true)
    expect(result.transfer.kind.inputs.some((i) => i._tag === "Object")).toBe(false)
    expect(result.transferEffects.status._tag).toBe("Success")
    expect(result.bBalance.addressBalance).toBe(500n)
    expect(result.bBalance.coinBalance).toBe(1_000n)

    // Gas coin funded by a reservation.
    expect(result.reserved.gasData.payment.length).toBe(1)
    expect(CoinReservation.isReservation(result.reserved.gasData.payment[0]!)).toBe(true)
    expect(result.reservedEffects.status._tag).toBe("Success")

    expect(result.refused._tag).toBe("InsufficientGas")
    console.log("address-balance transfer", result.transferEffects.digest, "reservation", result.reservedEffects.digest)
  }, 120_000)
})
