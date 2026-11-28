/**
 * The in-memory node (`@unconfirmed/sui/Testing`): batched reads and the
 * request log, seeded balances and fields, and a scripted transaction through
 * `Tx.run`, `waitFor` and `Events`.
 */
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as Address from "../src/Address.ts"
import * as Coins from "../src/Coins.ts"
import * as DynamicFields from "../src/DynamicFields.ts"
import * as Ed25519 from "../src/Ed25519.ts"
import * as Events from "../src/Events.ts"
import * as Objects from "../src/Objects.ts"
import * as Ptb from "../src/Ptb.ts"
import * as Testing from "../src/Testing.ts"
import * as TransactionData from "../src/TransactionData.ts"
import * as Transactions from "../src/Transactions.ts"
import * as Tx from "../src/Tx.ts"
import * as TypeTag from "../src/TypeTag.ts"

const A = Address.normalize
const PKG = A("0xabc")
const Counter = Bcs.struct({ id: Bcs.Address, value: Bcs.u64 })
const Bumped = Bcs.struct({ value: Bcs.u64 })

const run = <A, E>(effect: Effect.Effect<A, E, Testing.Services | Testing.Node>, seed?: Testing.Seed) =>
  Effect.runPromise(Effect.provide(effect, Testing.layer(seed)))

test("concurrent object and dynamic field reads are one logged batch", async () => {
  const parent = A("0x1")
  const name = { type: "u64", bcs: Bcs.encodeSync(Bcs.u64)(7n) }
  const { results, requests } = await run(
    Effect.gen(function*() {
      const objects = yield* Objects.Objects
      const fields = yield* DynamicFields.DynamicFields
      const results = yield* Effect.all([
        Effect.exit(objects.get(A("0x1"))),
        Effect.exit(objects.get(A("0x404"))),
        Effect.exit(Effect.map(fields.get(parent, name), (f) => Bcs.decodeSync(Bcs.u64)(f.value))),
        Effect.exit(objects.get(A("0x1")))
      ], { concurrency: "unbounded" })
      return { results, requests: yield* Testing.Node.use((n) => n.requests) }
    }),
    {
      objects: [{ objectId: "0x1", type: `${PKG}::counter::Counter`, contents: Bcs.encodeSync(Counter)({ id: A("0x1"), value: 1n }) }],
      dynamicFields: [{ parent, name, valueType: "u64", value: Bcs.encodeSync(Bcs.u64)(99n) }]
    }
  )
  expect(Exit.isSuccess(results[0])).toBe(true)
  expect(results[1]).toEqual(Exit.fail(new Objects.ObjectNotFound({ objectId: A("0x404") })))
  expect(results[2]).toEqual(Exit.succeed(99n))
  expect(requests).toEqual([
    { method: "DynamicFields.get", args: [parent, name] },
    { method: "Objects.get", args: [A("0x1"), A("0x404"), DynamicFields.deriveId(parent, "u64", name.bcs), A("0x1")] }
  ])
})

test("balances count coins and the address balance, per coin type", async () => {
  const owner = A("0xa11ce")
  const USDC = `${PKG}::usdc::USDC`
  const { sui, all, coins } = await run(
    Effect.gen(function*() {
      const c = yield* Coins.Coins
      return {
        sui: yield* c.getBalance(owner),
        all: yield* Stream.runCollect(c.listBalances(owner)),
        coins: yield* Stream.runCollect(c.list(owner))
      }
    }),
    {
      coins: [{ owner, balance: 5n }, { owner, balance: 7n }, { owner, balance: 1n, coinType: USDC }],
      addressBalances: [{ owner, amount: 100n }, { owner, amount: 3n, coinType: `${PKG}::wal::WAL` }]
    }
  )
  expect(sui).toEqual({ coinType: TypeTag.SUI, total: 112n, addressBalance: 100n, coinBalance: 12n })
  expect(all.map((b) => [b.coinType, b.total])).toEqual([
    [TypeTag.SUI, 112n],
    [TypeTag.normalizeString(USDC), 1n],
    [TypeTag.normalizeString(`${PKG}::wal::WAL`), 3n]
  ])
  expect(coins.map((c) => c.balance).sort()).toEqual([1n, 5n, 7n])
})

test("Tx.run resolves against seeded state and the responder's events and balance changes come back on request", async () => {
  const counter = A("0xc0")
  await run(Effect.gen(function*() {
    const node = yield* Testing.Node
    const signer = yield* Ed25519.generate
    yield* node.setAddressBalance({ owner: signer.address, amount: 10_000_000n })
    yield* node.setClock(1_700_000_000_000n)
    yield* node.respond(({ mode, data }) =>
      mode === "simulate"
        ? { gasUsed: { computationCost: 1000n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n } }
        : {
          events: [{ type: `${PKG}::counter::Bumped`, contents: Bcs.encodeSync(Bumped)({ value: 2n }) }],
          balanceChanges: [{ address: data.sender, coinType: TypeTag.SUI, amount: -1000n }]
        }
    )

    const effects = yield* Tx.run(
      Effect.gen(function*() {
        yield* Ptb.moveCall({ target: `${PKG}::counter::bump`, arguments: [yield* Ptb.object(counter)] })
      }),
      { signer, include: ["events", "balanceChanges"] }
    )
    expect(effects.events?.map((e) => [e.type, e.sender, e.module])).toEqual([[TypeTag.normalizeString(`${PKG}::counter::Bumped`), signer.address, "counter"]])
    expect(yield* Events.decode(Bumped)(effects.events![0]!)).toEqual({ value: 2n })
    expect(effects.balanceChanges).toEqual([{ address: signer.address, coinType: TypeTag.SUI, amount: -1000n }])
    expect(effects.checkpoint).toBeUndefined()

    const landed = yield* Transactions.waitFor(effects.digest)
    expect([landed.checkpoint, landed.timestampMs, landed.events]).toEqual([1n, 1_700_000_000_000n, undefined])
    const listed = yield* Stream.runCollect((yield* Events.Events).list({ filter: Events.eventType(`${PKG}::counter`) }))
    expect(listed.map((e) => [e.transactionDigest, e.checkpoint])).toEqual([[effects.digest, 1n]])

    const executed = (yield* node.requests).find((r) => r.method === "Transactions.execute")
    expect(Result.getOrThrow(TransactionData.decode(executed!.args[0] as Uint8Array))).toMatchObject({ sender: signer.address, gasData: { payment: [], budget: 1_000_000n + 1000n } })
  }), {
    objects: [{ objectId: counter, type: `${PKG}::counter::Counter`, contents: Bcs.encodeSync(Counter)({ id: counter, value: 1n }) }],
    packages: [{
      packageId: PKG,
      functions: { "counter::bump": { isEntry: true, parameters: [{ reference: "Mutable", typeName: `${PKG}::counter::Counter` }] } }
    }]
  })
})

test("an unseeded Move function and a scripted abort fail typed", async () => {
  const exits = await run(Effect.gen(function*() {
    const signer = yield* Ed25519.generate
    const node = yield* Testing.Node
    yield* node.setAddressBalance({ owner: signer.address, amount: 10_000_000n })
    const recipe = (target: `${string}::${string}::${string}`) =>
      Effect.gen(function*() {
        yield* Ptb.moveCall({ target, arguments: [yield* Ptb.object(A("0x6"))] })
      })
    const unseeded = yield* Effect.exit(Tx.run(recipe(`${PKG}::m::f`), { signer }))
    yield* node.putPackage({ packageId: PKG, functions: { "m::f": { isEntry: true, parameters: [{ reference: "Immutable", typeName: "0x2::clock::Clock" }] } } })
    yield* node.respond(({ mode }) =>
      mode === "simulate" ? {} : { status: { _tag: "Failure", description: "MoveAbort in command 0", command: 0, abortCode: 7n } }
    )
    return [unseeded, yield* Effect.exit(Tx.run(recipe(`${PKG}::m::f`), { signer }))] as const
  }))
  expect(exits[0]).toMatchObject({ cause: { reasons: [{ error: { _tag: "RpcError", code: "NOT_FOUND" } }] } })
  expect(exits[1]).toMatchObject({ cause: { reasons: [{ error: { _tag: "ExecutionFailed", command: 0 } }] } })
})
