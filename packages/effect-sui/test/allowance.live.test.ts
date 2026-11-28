/**
 * Allowances on devnet, end to end. Opt in with SUI_LIVE=1.
 *
 * A funder deposits SUI into its address balance and creates an
 * `0x2::allowance::Allowance<Balance<SUI>>` for a spender (lifetime cap,
 * expiration). The spender then draws a coin and a balance from it through
 * `Ptb.coin({ allowance })` / `Ptb.balance({ allowance })`, and the resolver
 * refuses, before signing, a spend over the cap and a sender that isn't the spender.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import { Bcs } from "@unconfirmed/effect-bcs"
import { Address, Coins, Ed25519, Ptb, Tx, TypeTag } from "../src/index.ts"
import { DEVNET, faucet, grpcLayer, live } from "./support.ts"

const suite = live ? describe : describe.skip
const SUI = 1_000_000_000n
const CAP = 10_000n

const balanceWhen = (owner: Address.Address, ok: (b: Coins.Balance) => boolean) =>
  Effect.flatMap(Effect.service(Coins.Coins), (c) =>
    c.getBalance(owner).pipe(Effect.repeat({ until: ok, schedule: Schedule.spaced("500 millis"), times: 40 })))

suite("allowances on devnet", () => {
  test("create an allowance, spend a coin and a balance from it, typed refusals", async () => {
    const { layer } = grpcLayer(DEVNET)
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const funder = yield* Ed25519.generate
        const spender = yield* Ed25519.generate
        const recipient = yield* Ed25519.generate
        yield* faucet(funder.address)
        yield* faucet(spender.address)

        // 1. The funder deposits 1 SUI into its address balance and creates the allowance.
        const created = yield* Tx.run(
          Effect.gen(function*() {
            const [one] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(SUI)])
            yield* Ptb.sendFunds(one!, yield* Ptb.address(funder.address))
            const noRateLimit = yield* Ptb.moveCall({ target: "0x1::option::none", typeArguments: ["0x2::allowance::RateLimit"] })
            yield* Ptb.moveCall({
              target: "0x2::allowance::new",
              typeArguments: [`0x2::balance::Balance<${TypeTag.SUI}>`],
              arguments: [
                yield* Ptb.string("effect-sdks live test"),
                yield* Ptb.address(spender.address),
                yield* Ptb.pure(Bcs.option(Bcs.u256), Option.some(CAP)),
                yield* Ptb.pure(Bcs.option(Bcs.u64), Option.none()),
                yield* Ptb.pure(Bcs.option(Bcs.u64), Option.some(BigInt(Date.now()) + 86_400_000n)),
                noRateLimit
              ]
            })
          }),
          { signer: funder }
        )
        const allowance = created.changedObjects.find((o) => o.operation === "Created" && o.type?.includes("::allowance::Allowance<"))
        if (!allowance) return yield* Effect.die(new Error(`no Allowance created in ${created.digest}`))
        yield* balanceWhen(funder.address, (b) => b.addressBalance >= SUI)

        // 2. The spender draws a coin (by id) and a balance (funder given) from the allowance.
        const spendRecipe = Effect.gen(function*() {
          const coin = yield* Ptb.coin({ amount: 1_000n, allowance: allowance.objectId })
          const bal = yield* Ptb.balance({ amount: 500n, allowance: { objectId: allowance.objectId, funder: funder.address } })
          const to = yield* Ptb.address(recipient.address)
          yield* Ptb.transferObjects([coin], to)
          yield* Ptb.sendBalance(bal, to)
        })
        const spent = yield* Tx.build(spendRecipe, { sender: spender.address }).pipe(
          // The new shared object may trail execution on the read path.
          Effect.retry({ while: (e) => e._tag === "AllowanceNotFound", schedule: Schedule.spaced("500 millis"), times: 20 })
        )
        const spentEffects = yield* Tx.execute(spent, spender)
        const received = yield* balanceWhen(recipient.address, (b) => b.addressBalance === 500n && b.coinBalance === 1_000n)

        // 3. Refused before signing: over the remaining cap, and a sender that isn't the spender.
        const overCap = yield* Tx.build(
          Effect.flatMap(Ptb.balance({ amount: CAP, allowance: allowance.objectId }), (b) =>
            Effect.flatMap(Ptb.address(recipient.address), (to) => Ptb.sendBalance(b, to))),
          { sender: spender.address }
        ).pipe(Effect.flip)
        const stranger = yield* Tx.build(spendRecipe, { sender: recipient.address, gasBudget: 2_000_000n }).pipe(Effect.flip)

        return { created, spent, spentEffects, received, overCap, stranger }
      }).pipe(Effect.provide(layer))
    )

    expect(result.created.status._tag).toBe("Success")
    const withdrawals = result.spent.kind._tag === "ProgrammableTransaction"
      ? result.spent.kind.inputs.filter((i) => i._tag === "FundsWithdrawal")
      : []
    expect(withdrawals.map((w) => w.withdrawFrom._tag)).toEqual(["SenderAllowance", "SenderAllowance"])
    expect(result.spentEffects.status._tag).toBe("Success")
    expect(result.received.addressBalance).toBe(500n)
    expect(result.received.coinBalance).toBe(1_000n)
    expect(result.overCap).toMatchObject({ _tag: "InsufficientAllowance", limit: "lifetime", required: CAP, available: CAP - 1_500n })
    expect(result.stranger._tag).toBe("AllowanceSpenderMismatch")
    console.log("allowance created", result.created.digest, "spent", result.spentEffects.digest)
  }, 180_000)
})
