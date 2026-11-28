/**
 * Server-side resolution (`Resolve.server`, the default for online builds):
 * build-only on testnet, executed on devnet with faucet funds. Opt in with
 * SUI_LIVE=1.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { Address, CoinReservation, Ed25519, Ptb, Resolve, Tx } from "../src/index.ts"
import type * as T from "../src/TransactionData.ts"
import { fundedAddress } from "@unconfirmed/test-support/funded"
import { DEVNET, faucet, grpcLayer, live, TESTNET } from "./support.ts"

const suite = live ? describe : describe.skip
/** A testnet address that holds SUI (`SUI_FUNDED_ADDRESS`); the build-only suite skips without one. */
const funded = fundedAddress()
const buildSuite = live && funded !== undefined ? describe : describe.skip
const FUNDED = Address.normalize(funded ?? "0x0")

const split = (to: Address.Address) =>
  Effect.gen(function*() {
    const [c] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1000n)])
    yield* Ptb.transferObjects([c!], yield* Ptb.address(to))
  })
const clock = Effect.gen(function*() {
  yield* Ptb.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [yield* Ptb.object("0x6")] })
})

const runOn = <A, E>(url: string, f: (requests: Array<string>) => Effect.Effect<A, E, any>) => {
  const { layer, requests } = grpcLayer(url)
  return Effect.runPromise(Effect.provide(f(requests), layer) as Effect.Effect<A, E>)
}

buildSuite("server-side resolution on testnet (build only)", () => {
  test("split from gas + transfer: one SimulateTransaction, nothing else", async () => {
    const { data, requests } = await runOn(TESTNET, (requests) =>
      Effect.map(Tx.build(split(FUNDED), { sender: FUNDED }), (data) => ({ data, requests: [...requests] })))
    expect(requests).toEqual(["SimulateTransaction"])
    expect(data.gasData.owner).toBe(FUNDED)
    expect(data.gasData.payment.length).toBeGreaterThan(0)
    expect(data.gasData.budget).toBeGreaterThan(0n)
  })

  test("a clock call: the simulation and the signature read run at once; &Clock stays immutable; the client path agrees but for gas", async () => {
    const { data, requests, client } = await runOn(TESTNET, (requests) =>
      Effect.gen(function*() {
        const data = yield* Tx.build(clock, { sender: FUNDED })
        const seen = [...requests]
        const client = yield* Tx.build(clock, { sender: FUNDED, resolve: "client" })
        return { data, requests: seen, client }
      }))
    expect([...requests].sort()).toEqual(["GetFunction", "SimulateTransaction"])
    const input = data.kind.inputs[0]!
    expect(input._tag === "Object" && input.value._tag === "SharedObject" && input.value.mutability._tag).toBe("Immutable")
    expect(data.kind).toEqual(client.kind)
    expect(data.gasData.price).toBe(client.gasData.price)
  })

  test("a Ptb.coin intent is sourced client-side, then resolved on the node", async () => {
    const data = await runOn(TESTNET, () =>
      Tx.build(Effect.gen(function*() {
        const c = yield* Ptb.coin({ amount: 1000n })
        yield* Ptb.transferObjects([c], yield* Ptb.address(FUNDED))
      }), { sender: FUNDED }))
    expect(data.kind.commands.length).toBeGreaterThan(1)
  })

  test("sponsored: the node pays from the sponsor; one using the gas coin resolves client-side", async () => {
    const sender = (await Effect.runPromise(Ed25519.generate)).address
    const { call, gasCoin, requests } = await runOn(TESTNET, (requests) =>
      Effect.gen(function*() {
        const call = yield* Tx.build(clock, { sender, gasOwner: FUNDED, resolve: "server" })
        requests.length = 0
        const gasCoin = yield* Tx.build(split(sender), { sender, gasOwner: FUNDED })
        return { call, gasCoin, requests: [...requests] }
      }))
    expect(call.sender).toBe(sender)
    expect(call.gasData.owner).toBe(FUNDED)
    expect(gasCoin.gasData.owner).toBe(FUNDED)
    expect(gasCoin.gasData.payment.length).toBeGreaterThan(0)
    expect(requests.filter((r) => r === "SimulateTransaction").length).toBe(1) // the client-side budget dry run
    expect(requests).toContain("GetBalance")
  })

  test("a fixed payment, price, budget and expiration come back exactly as given", async () => {
    const result = await runOn(TESTNET, () =>
      Effect.gen(function*() {
        // A payment that covers a split from the gas coin (this address holds its SUI in
        // its address balance: a reservation plus a coin), then handed back as fixed.
        const first = yield* Tx.build(split(FUNDED), { sender: FUNDED })
        const payment = first.gasData.payment
        // An address-balance payment needs a ValidDuring window; reuse the node's.
        const expiration: T.TransactionExpiration = first.expiration
        const fixedPayment = yield* Tx.build(split(FUNDED), {
          sender: FUNDED,
          payment: Resolve.fixed(payment),
          expiration,
          resolve: "server"
        })
        const all = yield* Tx.build(clock, {
          sender: FUNDED,
          gasPrice: 1500n,
          gasBudget: 9_000_000n,
          expiration,
          resolve: "server"
        })
        return { payment, fixedPayment, all, expiration }
      }))
    expect(result.fixedPayment.gasData.payment).toEqual(result.payment)
    expect(result.all.gasData.price).toBe(1500n)
    expect(result.all.gasData.budget).toBe(9_000_000n)
    expect(result.all.expiration).toEqual(result.expiration)
  })

  test("Tx.simulate: sending the gas coin to the sender's address balance (folding every SUI coin) succeeds", async () => {
    const { data, effects } = await runOn(TESTNET, () =>
      Tx.simulate(Effect.gen(function*() {
        yield* Ptb.sendFunds(Ptb.gas, yield* Ptb.address(FUNDED))
      }), { sender: FUNDED }))
    expect(effects.status._tag).toBe("Success")
    expect(data.gasData.owner).toBe(FUNDED)
  })

  test("an abort in the simulation is GasEstimationFailed; a missing object falls back to ObjectNotFound", async () => {
    const [aborted, missing] = await runOn(TESTNET, () =>
      Effect.all([
        Effect.flip(Tx.build(Effect.gen(function*() {
          const zero = yield* Ptb.moveCall({ target: "0x2::balance::zero", typeArguments: ["0x2::sui::SUI"], arguments: [] })
          yield* Ptb.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: ["0x2::sui::SUI"], arguments: [zero] })
          yield* Ptb.moveCall({ target: "0x2::balance::destroy_zero", typeArguments: ["0x2::sui::SUI"], arguments: [zero] })
        }), { sender: FUNDED, resolve: "server" })),
        Effect.flip(Tx.build(Effect.gen(function*() {
          yield* Ptb.transferObjects([yield* Ptb.object("0x1234567")], yield* Ptb.address(FUNDED))
        }), { sender: FUNDED }))
      ]))
    expect(aborted._tag).toBe("GasEstimationFailed")
    expect(missing._tag).toBe("ObjectNotFound")
  })
})

suite("server-side resolution on devnet (executed)", () => {
  test("Tx.run on the default path, a Ptb.coin transfer, and sponsored transactions", async () => {
    const result = await runOn(DEVNET, (requests) =>
      Effect.gen(function*() {
        const a = yield* Ed25519.generate
        const b = yield* Ed25519.generate
        yield* faucet(a.address)
        requests.length = 0
        const first = yield* Tx.run(split(b.address), { signer: a })
        const firstRequests = [...requests]
        // The node's owned-object index can trail the execution just done, so a coin
        // picked from it may be a version behind, which execution refuses ("rebuilt").
        const fresh = <A, E extends { readonly _tag: string }, R>(f: Effect.Effect<A, E, R>) =>
          f.pipe(Effect.retry({
            while: (e) => e._tag === "RpcError" && (e as unknown as Error).message.includes("rebuilt"),
            schedule: Schedule.spaced("1 second"),
            times: 10
          }))
        const coin = yield* fresh(Tx.run(Effect.gen(function*() {
          const c = yield* Ptb.coin({ amount: 2000n })
          yield* Ptb.transferObjects([c], yield* Ptb.address(b.address))
        }), { signer: a }))
        // B has no SUI; A sponsors it.
        const sponsoredData = yield* fresh(Tx.build(clock, { sender: b.address, gasOwner: a.address }))
        const sponsored = yield* fresh(Tx.execute(sponsoredData, [b, a]))
        const sponsoredSplit = yield* fresh(
          Effect.flatMap(Tx.build(split(b.address), { sender: b.address, gasOwner: a.address }), (d) => Tx.execute(d, [b, a]))
        )
        return { first, firstRequests, coin, sponsoredData, sponsored, sponsoredSplit }
      }))
    expect(result.first.status._tag).toBe("Success")
    expect(result.firstRequests).toEqual(["SimulateTransaction", "ExecuteTransaction"])
    expect(result.coin.status._tag).toBe("Success")
    expect(result.sponsoredData.gasData.owner).not.toBe(result.sponsoredData.sender)
    expect(result.sponsored.status._tag).toBe("Success")
    expect(result.sponsoredSplit.status._tag).toBe("Success")
    // A has only coins (no address balance): the node pays with A's coins.
    expect(result.sponsoredData.gasData.payment.some((r) => !CoinReservation.isReservation(r))).toBe(true)
  }, 120_000)
})
