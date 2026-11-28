/**
 * Allowance-funded coin/balance intents: byte parity with @mysten/sui's
 * `tx.coin({ allowance })` / `tx.balance({ allowance })` (its `AllowanceBalance`
 * intent), and the typed refusals for what the chain would abort.
 *
 * Allowance objects are encoded with @mysten/bcs, independently of our layout.
 */
import { bcs } from "@mysten/sui/bcs"
import { Transaction } from "@mysten/sui/transactions"
import { base58 } from "@scure/base"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { Address, Objects, Ptb, Resolve, TransactionData as T, TransactionJson, TypeTag } from "../src/index.ts"
import * as Testing from "../src/Testing.ts"
import { toB64 } from "./support.ts"
// Not exported publicly by @mysten/sui; loaded from its shipped build (untyped).
const coreResolverModule = "../../../node_modules/@mysten/sui/dist/client/core-resolver.mjs"
const { coreClientResolveTransactionPlugin } = (await import(coreResolverModule)) as { coreClientResolveTransactionPlugin: unknown }

const A = Address.normalize
const sender = A("0x5e4d")
const funder = A("0xf00d")
const recipient = A("0xcafe")
const D = (seed: number) => base58.encode(new Uint8Array(32).fill(seed)) as T.ObjectDigest
const gasRef = { objectId: A("0xfeed"), version: 9n, digest: D(7) }
const TOKEN = TypeTag.normalizeString("0x123::token::TOKEN")
const APP_PKG = A("0xa99")
const APP = TypeTag.normalizeString(`${APP_PKG}::app::APP`)
const ALW = A("0xa11")
const ALW2 = A("0xa12")

// -----------------------------------------------------------------------------
// @mysten/bcs encoding of 0x2::allowance::Allowance<T> and 0x2::clock::Clock
// -----------------------------------------------------------------------------

const MWindow = bcs.enum("Window", { PeriodicMs: bcs.u64(), CalendarMonths: bcs.u8() })
const MRateLimit = bcs.enum("RateLimit", {
  Windowed: bcs.struct("Windowed", { limit: bcs.u256(), spent: bcs.u256(), anchor_ms: bcs.option(bcs.u64()), index: bcs.u64(), window: MWindow })
})
const MAllowance = bcs.struct("Allowance", {
  id: bcs.Address,
  settings: bcs.struct("Settings", {
    funder: bcs.Address,
    spender: bcs.option(bcs.Address),
    app: bcs.option(bcs.struct("TypeName", { name: bcs.string() })),
    lifetime_cap: bcs.option(bcs.u256()),
    start_timestamp_ms: bcs.option(bcs.u64()),
    expiration_timestamp_ms: bcs.option(bcs.u64()),
    rate_limit: bcs.option(MRateLimit),
    name: bcs.string()
  }),
  current_spend: bcs.u256()
})
const MClock = bcs.struct("Clock", { id: bcs.Address, timestamp_ms: bcs.u64() })

interface AllowanceSpec {
  readonly id: string
  readonly coinType?: string
  readonly funder?: string
  readonly spender?: string | null
  /** TypeName form: no `0x`. */
  readonly app?: string
  readonly lifetimeCap?: bigint
  readonly currentSpend?: bigint
  readonly start?: bigint
  readonly expiration?: bigint
  readonly rate?: { limit: bigint; spent: bigint; anchor: bigint | null; index: bigint; window: { PeriodicMs: bigint } | { CalendarMonths: number } }
  readonly shared?: boolean
  readonly type?: string
}

interface World {
  readonly allowances: ReadonlyArray<AllowanceSpec>
  /** Address balance by `owner|coinType`. */
  readonly balances: Record<string, bigint>
  readonly clockMs?: bigint
}

interface FakeObject {
  readonly objectId: Address.Address
  readonly version: bigint
  readonly digest: T.ObjectDigest
  readonly type: string
  readonly contents: Uint8Array
  readonly owner: Objects.Owner
}

const objectsOf = (w: World): Map<string, FakeObject> => {
  const out = new Map<string, FakeObject>()
  w.allowances.forEach((a, n) => {
    const coinType = a.coinType ?? TypeTag.SUI
    out.set(A(a.id), {
      objectId: A(a.id),
      version: 20n + BigInt(n),
      digest: D(40 + n),
      type: a.type ?? TypeTag.normalizeString(`0x2::allowance::Allowance<0x2::balance::Balance<${coinType}>>`),
      owner: a.shared === false ? { _tag: "AddressOwner", address: funder } : { _tag: "Shared", initialSharedVersion: 10n + BigInt(n) },
      contents: MAllowance.serialize({
        id: A(a.id),
        settings: {
          funder: a.funder ?? funder,
          spender: a.spender === undefined ? sender : a.spender,
          app: a.app === undefined ? null : { name: a.app },
          lifetime_cap: a.lifetimeCap ?? 1_000_000n,
          start_timestamp_ms: a.start ?? null,
          expiration_timestamp_ms: a.expiration ?? null,
          rate_limit: a.rate
            ? { Windowed: { limit: a.rate.limit, spent: a.rate.spent, anchor_ms: a.rate.anchor, index: a.rate.index, window: a.rate.window } }
            : null,
          name: "test allowance"
        },
        current_spend: a.currentSpend ?? 0n
      }).toBytes()
    })
  })
  if (w.clockMs !== undefined) {
    out.set(A("0x6"), {
      objectId: A("0x6"),
      version: 99n,
      digest: D(6),
      type: TypeTag.normalizeString("0x2::clock::Clock"),
      owner: { _tag: "Shared", initialSharedVersion: 1n },
      contents: MClock.serialize({ id: A("0x6"), timestamp_ms: w.clockMs }).toBytes()
    })
  }
  return out
}

/** Our services: the world on an in-memory node. */
const world = (w: World) =>
  Testing.layer({
    objects: [...objectsOf(w).values()],
    addressBalances: Object.entries(w.balances).map(([key, amount]) => {
      const [owner, coinType] = key.split("|") as [string, string]
      return { owner, coinType, amount }
    })
  })

/** The same world as a @mysten/sui client. */
const mystenClient = (w: World) => {
  const objects = objectsOf(w)
  return {
    core: {
      // The default object resolution, over the stubs below.
      resolveTransactionPlugin: () => coreClientResolveTransactionPlugin,
      getObjects: async ({ objectIds }: { objectIds: Array<string> }) => ({
        objects: objectIds.map((id) => {
          const o = objects.get(A(id))
          if (!o) return new Error(`not found: ${id}`)
          return {
            objectId: o.objectId,
            version: String(o.version),
            digest: o.digest,
            type: o.type,
            content: o.contents,
            owner: o.owner._tag === "Shared"
              ? { $kind: "Shared", Shared: { initialSharedVersion: String(o.owner.initialSharedVersion) } }
              : { $kind: "AddressOwner", AddressOwner: funder }
          }
        })
      }),
      getBalance: async ({ owner, coinType }: { owner: string; coinType: string }) => {
        const t = TypeTag.normalizeString(coinType)
        const ab = w.balances[`${A(owner)}|${t}`] ?? 0n
        return { balance: { coinType: t, balance: String(ab), addressBalance: String(ab), coinBalance: "0" } }
      },
      listCoins: async () => ({ objects: [], hasNextPage: false, cursor: null })
    }
  }
}

const resolveOurs = (w: World, recipe: Effect.Effect<unknown, unknown, Ptb.PtbBuilder>) =>
  Effect.gen(function*() {
    const { draft } = yield* Ptb.build(recipe)
    const plan = yield* Resolve.inputs({ sender, draft }).pipe(Effect.flatMap(Resolve.balances))
    return yield* Resolve.finish({ ...plan, gasPrice: 1000n, gasBudget: 10_000_000n, gasPayment: [gasRef] })
  }).pipe(Effect.provide(world(w)))

const ours = (w: World, recipe: Effect.Effect<unknown, unknown, Ptb.PtbBuilder>) =>
  Effect.runPromise(Effect.map(resolveOurs(w, recipe), T.encode) as Effect.Effect<Uint8Array>)

const theirs = async (w: World, build: (tx: Transaction) => void) => {
  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasPrice(1000)
  tx.setGasBudget(10_000_000)
  tx.setGasPayment([{ ...gasRef, version: "9" }])
  tx.setExpiration({ None: true })
  build(tx)
  return tx.build({ client: mystenClient(w) as never })
}

const same = async (w: World, recipe: Effect.Effect<unknown, unknown, Ptb.PtbBuilder>, build: (tx: Transaction) => void) =>
  expect(toB64(await ours(w, recipe))).toBe(toB64(await theirs(w, build)))

/** The typed failure, by tag. */
const refusal = async (w: World, recipe: Effect.Effect<unknown, unknown, Ptb.PtbBuilder>) => {
  const e = await Effect.runPromise(Effect.flip(resolveOurs(w, recipe)) as Effect.Effect<any>)
  return e as { readonly _tag: string } & Record<string, unknown>
}

const funded = { [`${funder}|${TypeTag.SUI}`]: 1_000_000n, [`${funder}|${TOKEN}`]: 1_000_000n }

describe("allowance intents match tx.coin / tx.balance with allowance", () => {
  test("a SUI coin by allowance id: withdrawal, balance_spend, from_balance", () =>
    same(
      { allowances: [{ id: ALW }], balances: funded },
      Effect.gen(function*() {
        const c = yield* Ptb.coin({ amount: 500n, allowance: ALW })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
      }),
      (tx) => tx.transferObjects([tx.coin({ balance: 500, allowance: ALW })], tx.pure.address(recipient))
    ))

  test("a token balance with the funder given, sent to an address balance", () =>
    same(
      { allowances: [{ id: ALW, coinType: TOKEN }], balances: funded },
      Effect.gen(function*() {
        const b = yield* Ptb.balance({ amount: 70n, type: TOKEN, allowance: { objectId: ALW, funder } })
        yield* Ptb.sendBalance(b, yield* Ptb.address(recipient), TOKEN)
      }),
      (tx) => {
        const b = tx.balance({ balance: 70, type: TOKEN, allowance: { objectId: ALW, funder } })
        tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: [TOKEN], arguments: [b, tx.pure.address(recipient)] })
      }
    ))

  test("app-bound: app_balance_spend with the app's SpendPermit", () =>
    same(
      { allowances: [{ id: ALW, app: APP.slice(2) }], balances: funded },
      Effect.gen(function*() {
        const permit = yield* Ptb.moveCall({ target: `${APP_PKG}::app::spend_permit` })
        const c = yield* Ptb.coin({ amount: 9n, allowance: { objectId: ALW, app: { type: APP, permit } } })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
      }),
      (tx) => {
        const permit = tx.moveCall({ target: `${APP_PKG}::app::spend_permit` })
        tx.transferObjects([tx.coin({ balance: 9, allowance: { objectId: ALW, app: { type: APP, permit } } })], tx.pure.address(recipient))
      }
    ))

  test("two spends from one allowance share its input; later results are remapped", () =>
    same(
      { allowances: [{ id: ALW }, { id: ALW2, coinType: TOKEN }], balances: funded },
      Effect.gen(function*() {
        const a = yield* Ptb.coin({ amount: 1n, allowance: ALW })
        const b = yield* Ptb.balance({ amount: 2n, allowance: ALW })
        const t = yield* Ptb.coin({ amount: 3n, type: TOKEN, allowance: ALW2 })
        const to = yield* Ptb.address(recipient)
        yield* Ptb.transferObjects([a, t], to)
        yield* Ptb.sendBalance(b, to)
      }),
      (tx) => {
        const a = tx.coin({ balance: 1, allowance: ALW })
        const b = tx.balance({ balance: 2, allowance: ALW })
        const t = tx.coin({ balance: 3, type: TOKEN, allowance: ALW2 })
        const to = tx.pure.address(recipient)
        tx.transferObjects([a, t], to)
        tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: ["0x2::sui::SUI"], arguments: [b, to] })
      }
    ))

  test("with sender-funded intents and a shared clock: allowances resolve first, like @mysten/sui", () =>
    same(
      {
        allowances: [{ id: ALW, coinType: TOKEN }],
        balances: { ...funded, [`${sender}|${TOKEN}`]: 1000n, [`${sender}|${TypeTag.SUI}`]: 1000n }
      },
      Effect.gen(function*() {
        const mine = yield* Ptb.coin({ amount: 100n, type: TOKEN })
        const clock = yield* Ptb.clock
        const theirs = yield* Ptb.coin({ amount: 50n, type: TOKEN, allowance: ALW })
        const sui = yield* Ptb.balance({ amount: 5n })
        yield* Ptb.moveCall({ target: `${APP_PKG}::app::use_clock`, arguments: [clock] })
        const to = yield* Ptb.address(recipient)
        yield* Ptb.transferObjects([mine, theirs], to)
        yield* Ptb.sendBalance(sui, to)
      }),
      (tx) => {
        const mine = tx.coin({ balance: 100, type: TOKEN })
        const clock = tx.object.clock()
        const theirs = tx.coin({ balance: 50, type: TOKEN, allowance: ALW })
        const sui = tx.balance({ balance: 5 })
        tx.moveCall({ target: `${APP_PKG}::app::use_clock`, arguments: [clock] })
        const to = tx.pure.address(recipient)
        tx.transferObjects([mine, theirs], to)
        tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: ["0x2::sui::SUI"], arguments: [sui, to] })
      }
    ))

  test("the allowance object also used by a Move call keeps one mutable shared input", () =>
    same(
      { allowances: [{ id: ALW }], balances: funded },
      Effect.gen(function*() {
        yield* Ptb.moveCall({ target: `${APP_PKG}::app::inspect`, arguments: [yield* Ptb.object(ALW)] })
        const c = yield* Ptb.coin({ amount: 4n, allowance: ALW })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
      }),
      (tx) => {
        tx.moveCall({ target: `${APP_PKG}::app::inspect`, arguments: [tx.object(ALW)] })
        tx.transferObjects([tx.coin({ balance: 4, allowance: ALW })], tx.pure.address(recipient))
      }
    ))
})

describe("typed refusals before signing", () => {
  const spend = (amount: bigint, allowance: Ptb.AllowanceReference = ALW, type?: string) =>
    Effect.flatMap(Ptb.coin({ amount, allowance, ...(type && { type }) }), (c) =>
      Effect.flatMap(Ptb.address(recipient), (to) => Ptb.transferObjects([c], to)))

  test("no such object: AllowanceNotFound", async () => {
    expect((await refusal({ allowances: [], balances: funded }, spend(1n)))._tag).toBe("AllowanceNotFound")
  })

  test("wrong coin type, owned object, unrelated type, wrong funder: InvalidAllowance", async () => {
    expect((await refusal({ allowances: [{ id: ALW }], balances: funded }, spend(1n, ALW, TOKEN)))._tag).toBe("InvalidAllowance")
    expect((await refusal({ allowances: [{ id: ALW, shared: false }], balances: funded }, spend(1n)))._tag).toBe("InvalidAllowance")
    expect((await refusal({ allowances: [{ id: ALW, type: "0x2::coin::Coin<0x2::sui::SUI>" }], balances: funded }, spend(1n)))._tag)
      .toBe("InvalidAllowance")
    expect((await refusal({ allowances: [{ id: ALW }], balances: funded }, spend(1n, { objectId: ALW, funder: recipient })))._tag)
      .toBe("InvalidAllowance")
  })

  test("app-bound without a permit, a permit for another app, a permit where none is bound: AllowanceAppMismatch", async () => {
    const bound = { allowances: [{ id: ALW, app: APP.slice(2) }], balances: funded }
    const e = await refusal(bound, spend(1n))
    expect(e._tag).toBe("AllowanceAppMismatch")
    expect(e.allowanceApp).toBe(APP)
    expect(e.permitApp).toBe(null)
    const withPermit = (type: string) =>
      Effect.flatMap(Ptb.moveCall({ target: `${APP_PKG}::app::spend_permit` }), (permit) => spend(1n, { objectId: ALW, app: { type, permit } }))
    expect((await refusal(bound, withPermit(`${APP_PKG}::other::OTHER`)))._tag).toBe("AllowanceAppMismatch")
    expect((await refusal({ allowances: [{ id: ALW }], balances: funded }, withPermit(APP)))._tag).toBe("AllowanceAppMismatch")
  })

  test("a sender that isn't the spender: AllowanceSpenderMismatch", async () => {
    const e = await refusal({ allowances: [{ id: ALW, spender: recipient }], balances: funded }, spend(1n))
    expect(e._tag).toBe("AllowanceSpenderMismatch")
    expect(e.spender).toBe(recipient)
    expect((await refusal({ allowances: [{ id: ALW, spender: null }], balances: funded }, spend(1n)))._tag).toBe("AllowanceSpenderMismatch")
  })

  test("outside the start/expiration window on the chain clock", async () => {
    expect((await refusal({ allowances: [{ id: ALW, start: 2000n }], balances: funded, clockMs: 1999n }, spend(1n)))._tag).toBe("AllowanceNotStarted")
    expect((await refusal({ allowances: [{ id: ALW, expiration: 2000n }], balances: funded, clockMs: 2000n }, spend(1n)))._tag).toBe("AllowanceExpired")
    // Start is inclusive, expiration exclusive.
    await expect(ours({ allowances: [{ id: ALW, start: 2000n, expiration: 3000n }], balances: funded, clockMs: 2000n }, spend(1n))).resolves.toBeDefined()
  })

  test("beyond the lifetime cap, counting every spend in the transaction", async () => {
    const w = { allowances: [{ id: ALW, lifetimeCap: 100n, currentSpend: 60n }], balances: funded }
    await expect(ours(w, spend(40n))).resolves.toBeDefined()
    const e = await refusal(w, Effect.flatMap(spend(30n), () => spend(11n)))
    expect(e).toMatchObject({ _tag: "InsufficientAllowance", limit: "lifetime", required: 41n, available: 40n })
  })

  test("beyond the rate limit: the current periodic window counts its spend, a rolled one doesn't", async () => {
    const rate = (index: bigint) => ({ limit: 100n, spent: 80n, anchor: 1000n, index, window: { PeriodicMs: 500n } })
    // now = 2200: (2200 - 1000) / 500 = 2.
    const current = await refusal({ allowances: [{ id: ALW, rate: rate(2n) }], balances: funded, clockMs: 2200n }, spend(21n))
    expect(current).toMatchObject({ _tag: "InsufficientAllowance", limit: "rate", required: 21n, available: 20n })
    await expect(ours({ allowances: [{ id: ALW, rate: rate(1n) }], balances: funded, clockMs: 2200n }, spend(21n))).resolves.toBeDefined()
    // A calendar window may have rolled: only the limit itself is certain.
    const calendar = { limit: 100n, spent: 80n, anchor: 1000n, index: 0n, window: { CalendarMonths: 1 } }
    await expect(ours({ allowances: [{ id: ALW, rate: calendar }], balances: funded, clockMs: 2200n }, spend(21n))).resolves.toBeDefined()
    expect((await refusal({ allowances: [{ id: ALW, rate: calendar }], balances: funded, clockMs: 2200n }, spend(101n)))._tag)
      .toBe("InsufficientAllowance")
  })

  test("more than the funder's address balance: InsufficientBalance for the funder", async () => {
    const e = await refusal({ allowances: [{ id: ALW }], balances: { [`${funder}|${TypeTag.SUI}`]: 10n } }, spend(11n))
    expect(e).toMatchObject({ _tag: "InsufficientBalance", owner: funder, required: 11n, available: 10n })
  })
})

// -----------------------------------------------------------------------------
// Transaction JSON: the AllowanceBalance $Intent both ways
// -----------------------------------------------------------------------------

/** Mysten's unresolved JSON for a recipe, gas fixed like `theirs`. */
const mystenJson = (build: (tx: Transaction) => void) => {
  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasPrice(1000)
  tx.setGasBudget(10_000_000)
  tx.setGasPayment([{ ...gasRef, version: "9" }])
  tx.setExpiration({ None: true })
  build(tx)
  return tx.toJSON({ supportedIntents: ["AllowanceBalance", "CoinWithBalance"] })
}

/** Decode Mysten JSON and finish it with our resolver. */
const fromMystenJson = (w: World, json: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const tx = yield* TransactionJson.decode(json)
      const plan = yield* TransactionJson.toPlan(tx).pipe(Effect.flatMap(Resolve.inputs), Effect.flatMap(Resolve.balances))
      return T.encode(yield* Resolve.finish(plan))
    }).pipe(Effect.provide(world(w))) as Effect.Effect<Uint8Array>
  )

/** Encode our Draft as JSON and let Mysten finish it. */
const toMystenJson = (w: World, recipe: Effect.Effect<unknown, unknown, Ptb.PtbBuilder>) =>
  Effect.runPromise(
    Effect.flatMap(Ptb.build(recipe), ({ draft }) =>
      TransactionJson.encode({
        sender,
        draft,
        gasPrice: 1000n,
        gasBudget: 10_000_000n,
        gasPayment: [gasRef],
        expiration: { _tag: "None" }
      })) as Effect.Effect<string>
  ).then((json) => Transaction.from(json).build({ client: mystenClient(w) as never }))

describe("AllowanceBalance intents in transaction JSON", () => {
  const cases: Array<[string, World, Effect.Effect<unknown, unknown, Ptb.PtbBuilder>, (tx: Transaction) => void]> = [
    [
      "a token balance with the funder given",
      { allowances: [{ id: ALW, coinType: TOKEN }], balances: funded },
      Effect.gen(function*() {
        const b = yield* Ptb.balance({ amount: 70n, type: TOKEN, allowance: { objectId: ALW, funder } })
        yield* Ptb.sendBalance(b, yield* Ptb.address(recipient), TOKEN)
      }),
      (tx) => {
        const b = tx.balance({ balance: 70, type: TOKEN, allowance: { objectId: ALW, funder } })
        tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: [TOKEN], arguments: [b, tx.pure.address(recipient)] })
      }
    ],
    [
      "app-bound with a SpendPermit",
      { allowances: [{ id: ALW, app: APP.slice(2) }], balances: funded },
      Effect.gen(function*() {
        const permit = yield* Ptb.moveCall({ target: `${APP_PKG}::app::spend_permit` })
        const c = yield* Ptb.coin({ amount: 9n, allowance: { objectId: ALW, app: { type: APP, permit } } })
        yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
      }),
      (tx) => {
        const permit = tx.moveCall({ target: `${APP_PKG}::app::spend_permit` })
        tx.transferObjects([tx.coin({ balance: 9, allowance: { objectId: ALW, app: { type: APP, permit } } })], tx.pure.address(recipient))
      }
    ]
  ]

  for (const [name, w, recipe, build] of cases) {
    test(`${name}: Mysten JSON -> our resolve, and our JSON -> Mysten's build, give the same bytes`, async () => {
      expect(toB64(await fromMystenJson(w, await mystenJson(build)))).toBe(toB64(await theirs(w, build)))
      expect(toB64(await toMystenJson(w, recipe))).toBe(toB64(await ours(w, recipe)))
    })
  }

  test("an app type without a permit input is invalid", async () => {
    const json = JSON.parse(await mystenJson(cases[1]![3]))
    const intent = json.commands.find((c: any) => c.$Intent)
    delete intent.$Intent.inputs.permit
    const e = await Effect.runPromise(Effect.flip(TransactionJson.decode(json)))
    expect(e._tag).toBe("InvalidTransactionJson")
  })
})
