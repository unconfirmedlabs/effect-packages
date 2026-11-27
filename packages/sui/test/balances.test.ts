/**
 * Address balances: byte parity with @mysten/sui for withdrawals, coin/balance
 * intents and coin reservation refs, and the gas payment strategies.
 */
import { Transaction } from "@mysten/sui/transactions"
// Not exported publicly by @mysten/sui; loaded from its shipped build (untyped).
const reservationModule = "../../../node_modules/@mysten/sui/dist/utils/coin-reservation.mjs"
const { createCoinReservationRef } = (await import(reservationModule)) as {
  createCoinReservationRef: (reserved: bigint, owner: string, chainId: string, epoch: string) => { objectId: string; version: string; digest: string }
}
import { base58 } from "@scure/base"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { Address, Chain, CoinReservation, Coins, Objects, Ptb, Resolve, TransactionData as T, TypeTag } from "../src/index.ts"
import { toB64 } from "./support.ts"

const A = Address.normalize
const sender = A("0x5e4d")
const recipient = A("0xcafe")
const D = (seed: number) => base58.encode(new Uint8Array(32).fill(seed)) as T.ObjectDigest
const CHAIN = D(9)
const gasRef = { objectId: A("0xfeed"), version: 9n, digest: D(7) }
const TOKEN = TypeTag.normalizeString("0x123::token::TOKEN")

interface Fixture {
  readonly balances: Record<string, bigint> // address balance per coin type
  readonly coins: Record<string, ReadonlyArray<{ id: string; version: bigint; balance: bigint }>>
}

const coinRef = (c: { id: string; version: bigint }) => ({ objectId: A(c.id), version: c.version, digest: D(Number(c.version)) })

/** A scripted `Coins` (ours) and the equivalent @mysten client. */
const coinsLayer = (f: Fixture) =>
  Layer.succeed(Coins.Coins, {
    getBalance: (_owner, coinType = TypeTag.SUI) => {
      const t = TypeTag.normalizeString(coinType)
      const ab = f.balances[t] ?? 0n
      const cb = (f.coins[t] ?? []).reduce((s, c) => s + c.balance, 0n)
      return Effect.succeed({ coinType: t, total: ab + cb, addressBalance: ab, coinBalance: cb })
    },
    list: (_owner, coinType = TypeTag.SUI) =>
      Stream.fromIterable((f.coins[TypeTag.normalizeString(coinType)] ?? []).map((c) => ({
        ref: coinRef(c),
        coinType: TypeTag.normalizeString(coinType),
        balance: c.balance
      })))
  })

const mystenClient = (f: Fixture) => ({
  core: {
    getBalance: async ({ coinType }: { coinType: string }) => {
      const t = TypeTag.normalizeString(coinType)
      const ab = f.balances[t] ?? 0n
      const cb = (f.coins[t] ?? []).reduce((s, c) => s + c.balance, 0n)
      return { balance: { coinType: t, balance: String(ab + cb), addressBalance: String(ab), coinBalance: String(cb) } }
    },
    listCoins: async ({ coinType }: { coinType: string }) => ({
      objects: (f.coins[TypeTag.normalizeString(coinType)] ?? []).map((c) => ({
        objectId: A(c.id),
        version: String(c.version),
        digest: D(Number(c.version)),
        balance: String(c.balance),
        type: `0x2::coin::Coin<${coinType}>`
      })),
      hasNextPage: false,
      cursor: null
    })
  }
})

/** Build with our builder + `Resolve.balances`, fixed gas. */
const ours = (f: Fixture, recipe: Effect.Effect<unknown, unknown, Ptb.PtbBuilder>) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const { draft } = yield* Ptb.build(recipe)
      const plan = yield* Resolve.balances({ sender, draft })
      const data = yield* Resolve.finish({ ...plan, gasPrice: 1000n, gasBudget: 10_000_000n, gasPayment: [gasRef] })
      return T.encode(data)
    }).pipe(Effect.provide(coinsLayer(f))) as Effect.Effect<Uint8Array>
  )

/** Build the same thing with @mysten/sui. */
const theirs = async (f: Fixture, build: (tx: Transaction) => void) => {
  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasPrice(1000)
  tx.setGasBudget(10_000_000)
  tx.setGasPayment([{ ...gasRef, version: "9" }])
  tx.setExpiration({ None: true })
  build(tx)
  return tx.build({ client: mystenClient(f) as never })
}

const same = async (f: Fixture, recipe: Effect.Effect<unknown, unknown, Ptb.PtbBuilder>, build: (tx: Transaction) => void) =>
  expect(toB64(await ours(f, recipe))).toBe(toB64(await theirs(f, build)))

describe("withdrawals", () => {
  test("withdrawal + redeem + send_funds match tx.withdrawal", async () => {
    await same(
      { balances: {}, coins: {} },
      Effect.gen(function*() {
        const w = yield* Ptb.withdrawal({ amount: 500n })
        const coin = yield* Ptb.redeemCoin(w)
        yield* Ptb.sendFunds(coin, yield* Ptb.address(recipient))
        const w2 = yield* Ptb.withdrawal({ amount: 7n, type: TOKEN, from: "sponsor" })
        const bal = yield* Ptb.redeemBalance(w2, TOKEN)
        yield* Ptb.sendBalance(bal, yield* Ptb.address(recipient), TOKEN)
      }),
      (tx) => {
        const coin = tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: ["0x2::sui::SUI"], arguments: [tx.withdrawal({ amount: 500 })] })
        tx.moveCall({ target: "0x2::coin::send_funds", typeArguments: ["0x2::sui::SUI"], arguments: [coin, tx.pure.address(recipient)] })
        const bal = tx.moveCall({ target: "0x2::balance::redeem_funds", typeArguments: [TOKEN], arguments: [tx.withdrawal({ amount: 7, type: TOKEN, from: "sponsor" })] })
        tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: [TOKEN], arguments: [bal, tx.pure.address(recipient)] })
      }
    )
  })
})

describe("coin / balance intents match tx.coin / tx.balance", () => {
  test("all balance intents, address balance sufficient: one redeem per intent", () =>
    same(
      { balances: { [TOKEN]: 1000n }, coins: {} },
      Effect.gen(function*() {
        const a = yield* Ptb.balance({ amount: 100n, type: TOKEN })
        const b = yield* Ptb.balance({ amount: 200n, type: TOKEN })
        yield* Ptb.sendBalance(a, yield* Ptb.address(recipient), TOKEN)
        yield* Ptb.sendBalance(b, yield* Ptb.address(recipient), TOKEN)
      }),
      (tx) => {
        const a = tx.balance({ balance: 100, type: TOKEN })
        const b = tx.balance({ balance: 200, type: TOKEN })
        tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: [TOKEN], arguments: [a, tx.pure.address(recipient)] })
        tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: [TOKEN], arguments: [b, tx.pure.address(recipient)] })
      }
    ))

  test("mixed coin + balance from the address balance: redeem, split, into_balance, remainder home", () =>
    same(
      { balances: { [TOKEN]: 1000n }, coins: {} },
      Effect.gen(function*() {
        const c = yield* Ptb.coin({ amount: 300n, type: TOKEN })
        const b = yield* Ptb.balance({ amount: 200n, type: TOKEN })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
        yield* Ptb.sendBalance(b, yield* Ptb.address(recipient), TOKEN)
      }),
      (tx) => {
        const c = tx.coin({ balance: 300, type: TOKEN })
        const b = tx.balance({ balance: 200, type: TOKEN })
        tx.transferObjects([c], tx.pure.address(recipient))
        tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: [TOKEN], arguments: [b, tx.pure.address(recipient)] })
      }
    ))

  test("owned coins topped up from the address balance", () =>
    same(
      { balances: { [TOKEN]: 50n }, coins: { [TOKEN]: [{ id: "0xc1", version: 3n, balance: 100n }, { id: "0xc2", version: 4n, balance: 120n }] } },
      Effect.gen(function*() {
        const c = yield* Ptb.coin({ amount: 250n, type: TOKEN })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
      }),
      (tx) => tx.transferObjects([tx.coin({ balance: 250, type: TOKEN })], tx.pure.address(recipient))
    ))

  test("coins only, exact amount: the empty coin is destroyed", () =>
    same(
      { balances: {}, coins: { [TOKEN]: [{ id: "0xc1", version: 3n, balance: 100n }, { id: "0xc2", version: 4n, balance: 150n }] } },
      Effect.gen(function*() {
        const c = yield* Ptb.coin({ amount: 250n, type: TOKEN })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
      }),
      (tx) => tx.transferObjects([tx.coin({ balance: 250, type: TOKEN })], tx.pure.address(recipient))
    ))

  test("SUI with no address balance splits from the gas coin", () =>
    same(
      { balances: {}, coins: {} },
      Effect.gen(function*() {
        const c = yield* Ptb.coin({ amount: 1000n })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
      }),
      (tx) => tx.transferObjects([tx.coin({ balance: 1000 })], tx.pure.address(recipient))
    ))

  test("SUI with an address balance draws from it, not the gas coin", () =>
    same(
      { balances: { [TypeTag.SUI]: 5000n }, coins: {} },
      Effect.gen(function*() {
        const c = yield* Ptb.coin({ amount: 1000n })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
      }),
      (tx) => tx.transferObjects([tx.coin({ balance: 1000 })], tx.pure.address(recipient))
    ))

  test("zero amounts become coin::zero / balance::zero", () =>
    same(
      { balances: {}, coins: {} },
      Effect.gen(function*() {
        const c = yield* Ptb.coin({ amount: 0n, type: TOKEN })
        const b = yield* Ptb.balance({ amount: 0n, type: TOKEN })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
        yield* Ptb.sendBalance(b, yield* Ptb.address(recipient), TOKEN)
      }),
      (tx) => {
        const c = tx.coin({ balance: 0, type: TOKEN })
        const b = tx.balance({ balance: 0, type: TOKEN })
        tx.transferObjects([c], tx.pure.address(recipient))
        tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: [TOKEN], arguments: [b, tx.pure.address(recipient)] })
      }
    ))

  test("results of commands after an intent are remapped", () =>
    same(
      { balances: { [TOKEN]: 1000n }, coins: {} },
      Effect.gen(function*() {
        const [g] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(5n)])
        const c = yield* Ptb.coin({ amount: 300n, type: TOKEN })
        const [g2] = yield* Ptb.splitCoins(g!, [yield* Ptb.u64(2n)])
        const c2 = yield* Ptb.coin({ amount: 100n, type: TOKEN })
        yield* Ptb.transferObjects([c, g2!, c2, g!], yield* Ptb.address(recipient))
      }),
      (tx) => {
        const [g] = tx.splitCoins(tx.gas, [tx.pure.u64(5)])
        const c = tx.coin({ balance: 300, type: TOKEN })
        const [g2] = tx.splitCoins(g!, [tx.pure.u64(2)])
        const c2 = tx.coin({ balance: 100, type: TOKEN })
        tx.transferObjects([c, g2!, c2, g!], tx.pure.address(recipient))
      }
    ))

  test("not enough anywhere is a typed InsufficientBalance", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const { draft } = yield* Ptb.build(Ptb.coin({ amount: 10_000n, type: TOKEN }))
        return yield* Resolve.balances({ sender, draft })
      }).pipe(
        Effect.flip,
        Effect.provide(coinsLayer({ balances: { [TOKEN]: 10n }, coins: { [TOKEN]: [{ id: "0xc1", version: 3n, balance: 20n }] } })),
        // Only allowance intents read objects.
        Effect.provideService(Objects.Objects, { get: (objectId) => Effect.fail(new Objects.ObjectNotFound({ objectId })), listOwned: () => Stream.empty })
      )
    )
    expect(exit._tag === "Success" && exit.value._tag).toBe("InsufficientBalance")
    expect(exit._tag === "Success" && exit.value._tag === "InsufficientBalance" && exit.value.available).toBe(30n)
  })

  test("an unresolved intent is Incomplete, not silently dropped", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Ptb.build(Ptb.coin({ amount: 1n })), ({ draft }) =>
        Resolve.finish({ sender, draft, gasPrice: 1n, gasBudget: 1n, gasPayment: [] }))
    )
    expect(JSON.stringify(exit)).toContain("Resolve.balances")
  })
})

describe("coin reservation refs", () => {
  test("match createCoinReservationRef", () => {
    const ref = CoinReservation.make({ reserved: 123_456_789n, owner: sender, chainId: CHAIN, epoch: 812n })
    const theirsRef = createCoinReservationRef(123_456_789n, sender, CHAIN, "812")
    expect(ref.objectId).toBe(theirsRef.objectId as Address.Address)
    expect(String(ref.version)).toBe(String(theirsRef.version))
    expect(ref.digest).toBe(theirsRef.digest as T.ObjectDigest)
    expect(CoinReservation.isReservation(ref)).toBe(true)
    expect(CoinReservation.reservedOf(ref)).toBe(123_456_789n)
    expect(CoinReservation.isReservation(gasRef)).toBe(false)
  })
})

describe("gas payment strategies", () => {
  const chain = Layer.succeed(Chain.Chain, {
    info: Effect.succeed({ chainId: CHAIN, chain: "test", epoch: 812n, checkpointHeight: 1n, lowestAvailableCheckpoint: 0n, epochFirstCheckpoint: 0n }),
    referenceGasPrice: Effect.succeed(1000n)
  })
  const run = <E, R>(
    f: Fixture,
    recipe: Effect.Effect<unknown, never, Ptb.PtbBuilder>,
    strategy: Resolve.PaymentStrategy<E, R>,
    budget = 1_000_000n
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function*() {
        const { draft } = yield* Effect.orDie(Ptb.build(recipe))
        return yield* strategy({ sender, draft, gasBudget: budget })
      }).pipe(Effect.provide(Layer.mergeAll(coinsLayer(f), chain))) as Effect.Effect<Resolve.Plan, E>
    )
  const noGasCoin = Effect.orDie(Effect.flatMap(Ptb.address(recipient), (to) => Ptb.transferObjects([], to)))
  const usesGas = Effect.orDie(Effect.gen(function*() {
    const [c] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1n)])
    yield* Ptb.transferObjects([c!], yield* Ptb.address(recipient))
  }))
  const suiCoins = [{ id: "0xa1", version: 2n, balance: 600_000n }, { id: "0xa2", version: 3n, balance: 600_000n }]

  test("auto: address balance covers it and the gas coin is unused → empty payment, ValidDuring", async () => {
    const exit = await run({ balances: { [TypeTag.SUI]: 2_000_000n }, coins: { [TypeTag.SUI]: suiCoins } }, noGasCoin, Resolve.auto)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.gasPayment).toEqual([])
    expect(exit.value.expiration?._tag).toBe("ValidDuring")
  })

  test("auto: address balance short → coins until the budget is covered", async () => {
    const exit = await run({ balances: { [TypeTag.SUI]: 10n }, coins: { [TypeTag.SUI]: suiCoins } }, noGasCoin, Resolve.auto)
    expect(exit._tag === "Success" && exit.value.gasPayment!.map((r) => r.objectId)).toEqual([A("0xa1"), A("0xa2")])
  })

  test("auto: the gas coin is used and there is an address balance → reservation first, coins only for the rest", async () => {
    const exit = await run({ balances: { [TypeTag.SUI]: 700_000n }, coins: { [TypeTag.SUI]: suiCoins } }, usesGas, Resolve.auto)
    if (exit._tag !== "Success") throw new Error(JSON.stringify(exit))
    const [first, ...rest] = exit.value.gasPayment!
    expect(first).toEqual(CoinReservation.make({ reserved: 700_000n, owner: sender, chainId: CHAIN, epoch: 812n }))
    expect(rest.map((r) => r.objectId)).toEqual([A("0xa1")])
  })

  test("auto: the transaction's own SUI withdrawals count against the address balance", async () => {
    const withdraws = Effect.orDie(Effect.gen(function*() {
      const w = yield* Ptb.withdrawal({ amount: 1_500_000n })
      yield* Ptb.sendFunds(yield* Ptb.redeemCoin(w), yield* Ptb.address(recipient))
    }))
    const exit = await run({ balances: { [TypeTag.SUI]: 2_000_000n }, coins: { [TypeTag.SUI]: suiCoins } }, withdraws, Resolve.auto)
    // 2.0M - 1.5M withdrawn < 1.0M budget → coins
    expect(exit._tag === "Success" && exit.value.gasPayment!.length).toBe(2)
  })

  test("addressBalance: short is a typed InsufficientGas before anything is signed", async () => {
    const exit = await run({ balances: { [TypeTag.SUI]: 10n }, coins: { [TypeTag.SUI]: suiCoins } }, noGasCoin, Resolve.addressBalance)
    expect(exit._tag === "Failure" && String(exit.cause)).toContain("InsufficientGas")
  })

  test("addressBalance: with the gas coin in use, a single reservation", async () => {
    const exit = await run({ balances: { [TypeTag.SUI]: 2_000_000n }, coins: { [TypeTag.SUI]: suiCoins } }, usesGas, Resolve.addressBalance)
    expect(exit._tag === "Success" && exit.value.gasPayment).toEqual([
      CoinReservation.make({ reserved: 2_000_000n, owner: sender, chainId: CHAIN, epoch: 812n })
    ])
  })
})
