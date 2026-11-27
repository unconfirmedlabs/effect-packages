/**
 * Journal round-trips (memory and KeyValueStore), pruning, and a simulated
 * crash between signing and the submit result, recovered by reconcileAll.
 */
import { describe, expect, test } from "bun:test"
import { DateTime, Duration, Effect, Fiber, Layer, Option, Schema } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Ptb from "@unconfirmed/sui/Ptb"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as Journal from "../src/Journal.ts"
import { JournalEntry } from "../src/JournalEntry.ts"
import * as JournalKeyValueStore from "../src/JournalKeyValueStore.ts"
import * as Lifecycle from "../src/Lifecycle.ts"
import * as SubmitConfig from "../src/SubmitConfig.ts"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Resolve from "@unconfirmed/sui/Resolve"
import * as SenderLock from "../src/SenderLock.ts"
import { COIN, layer, makeWorld, ownedObject, signedTx } from "./world.ts"

const fast = SubmitConfig.layer({ lookupTimeout: 0, reconcileRecheck: 0, awaitVisibility: false })

const roundTrip = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const signed = yield* signedTx()
  const stuck = yield* signedTx({ nonce: 9 })
  const old = DateTime.makeUnsafe(1_000)
  const now = yield* DateTime.now
  yield* journal.put(JournalEntry.cases.Signed.make({ digest: signed.digest, signed, at: now }))
  yield* journal.put(JournalEntry.cases.Executed.make({ digest: "Settled1", at: old }))
  yield* journal.put(JournalEntry.cases.NotApplied.make({ digest: "Settled2", evidence: "expired", at: now }))
  yield* journal.put(
    JournalEntry.cases.Unknown.make({ digest: stuck.digest, signed: stuck, lastError: "x", attempts: 2, at: old })
  )
  const got = yield* journal.get(signed.digest)
  const unresolved = yield* journal.listUnresolved
  const pruned = yield* journal.pruneSettled(DateTime.subtractDuration(now, Duration.seconds(1)))
  const afterPrune = yield* Effect.all([journal.get("Settled1"), journal.get("Settled2"), journal.get(stuck.digest)])
  return { signed, got, unresolved, pruned, afterPrune }
})

const checkRoundTrip = (r: Effect.Success<typeof roundTrip>) => {
  const got = Option.getOrThrow(r.got)
  expect(got._tag).toBe("Signed")
  if (got._tag !== "Signed") return
  expect(got.signed.bytes).toEqual(r.signed.bytes)
  expect(got.signed.signatures[0]).toEqual(r.signed.signatures[0]!)
  expect(got.signed.chain).toBe(r.signed.chain)
  // oldest first
  expect(r.unresolved.map((e) => e._tag)).toEqual(["Unknown", "Signed"])
  expect(r.pruned).toBe(1)
  expect(r.afterPrune.map(Option.isSome)).toEqual([false, true, true])
}

describe("Journal", () => {
  test("memory round trip", async () => {
    checkRoundTrip(await Effect.runPromise(roundTrip.pipe(Effect.provide(Journal.layerMemory))))
  })

  test("KeyValueStore round trip, with settled markers", async () => {
    const { result, keys } = await Effect.runPromise(
      Effect.gen(function*() {
        const result = yield* roundTrip
        const keys = yield* Effect.flatMap(Effect.service(KeyValueStore.KeyValueStore), (s) => s.keys)
        return { result, keys }
      }).pipe(
        Effect.provide(JournalKeyValueStore.layer({ prefix: "j/" }).pipe(Layer.provideMerge(KeyValueStore.layerMemory)))
      )
    )
    checkRoundTrip(result)
    expect(keys.filter((k) => k.startsWith("j/settled:"))).toEqual(["j/settled:Settled2"])
  })

  test("entries are JSON", () => {
    const encoded = Schema.encodeSync(Schema.fromJsonString(JournalEntry))(
      JournalEntry.cases.NotApplied.make({ digest: "D", evidence: "inputConsumed", at: DateTime.makeUnsafe(5) })
    )
    expect(JSON.parse(encoded)).toEqual({ _tag: "NotApplied", digest: "D", evidence: "inputConsumed", at: 5 })
  })

  test("onUnresolved: fail refuses to build over unresolved entries", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        const signed = yield* signedTx()
        yield* JournalKeyValueStore.make(store).put(
          JournalEntry.cases.Signed.make({ digest: signed.digest, signed, at: yield* DateTime.now })
        )
        return yield* Effect.flip(
          Layer.build(JournalKeyValueStore.layer({ onUnresolved: "fail" })).pipe(Effect.scoped)
        )
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    )
    expect(error._tag).toBe("JournalError")
  })
})

describe("Journal integrity", () => {
  test("a KeyValueStore entry whose bytes don't hash to its digest is a JournalError", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        const signed = yield* signedTx()
        const other = yield* signedTx({ nonce: 2 })
        const forged = JournalEntry.cases.Signed.make({ digest: other.digest, signed: { ...signed, digest: other.digest }, at: yield* DateTime.now })
        yield* store.set(`entry:${other.digest}`, Schema.encodeSync(Schema.fromJsonString(JournalEntry))(forged))
        return yield* Effect.flip(JournalKeyValueStore.make(store).get(other.digest))
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    )
    expect(error._tag).toBe("JournalError")
  })

  test("pruneSettled never deletes an entry re-signed after its read", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const base = yield* KeyValueStore.KeyValueStore
        const signed = yield* signedTx()
        const journal0 = JournalKeyValueStore.make(base)
        yield* journal0.put(JournalEntry.cases.Executed.make({ digest: signed.digest, at: DateTime.makeUnsafe(1) }))
        // Another writer re-signs the same digest right after prune's bulk read of it.
        let reads = 0
        const racing: KeyValueStore.KeyValueStore = {
          ...base,
          get: (key) =>
            Effect.tap(base.get(key), () =>
              key === `entry:${signed.digest}` && ++reads === 1
                ? journal0.put(JournalEntry.cases.Signed.make({ digest: signed.digest, signed, at: DateTime.makeUnsafe(2) })).pipe(Effect.orDie)
                : Effect.void)
        }
        const pruned = yield* JournalKeyValueStore.make(racing).pruneSettled(DateTime.makeUnsafe(1_000))
        const entry = yield* journal0.get(signed.digest)
        return { pruned, tag: Option.map(entry, (e) => e._tag) }
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    )
    expect(result.pruned).toBe(0)
    expect(result.tag).toEqual(Option.some("Signed"))
  })
})

describe("crash recovery", () => {
  test("signed + journalled, crash before the submit result; reconcileAll recovers", async () => {
    const world = makeWorld({ script: ["hangAfter"] })
    const store = KeyValueStore.layerMemory
    const { before, recovered, after, entry } = await Effect.runPromise(
      Effect.gen(function*() {
        const signed = yield* signedTx()
        // Process 1: submits, the execute lands but the answer never comes; the process dies.
        const fiber = yield* Effect.forkChild(
          Lifecycle.submit(signed).pipe(Effect.provide(JournalKeyValueStore.layer()))
        )
        yield* Effect.yieldNow
        yield* Effect.sleep(10)
        yield* Fiber.interrupt(fiber)
        // Process 2: a fresh journal over the same store.
        return yield* Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const before = yield* journal.listUnresolved
          const recovered = yield* Lifecycle.reconcileAll()
          const after = yield* journal.listUnresolved
          const entry = yield* journal.get(signed.digest)
          return { before, recovered, after, entry }
        }).pipe(Effect.provide(JournalKeyValueStore.layer()))
      }).pipe(Effect.provide(Layer.mergeAll(layer(world), fast)), Effect.provide(store))
    )
    expect(before.map((e) => e._tag)).toEqual(["Signed"])
    expect(recovered.map((r) => r._tag)).toEqual(["Executed"])
    expect(after).toEqual([])
    expect(Option.getOrThrow(entry)._tag).toBe("Executed")
    expect(world.landed.size).toBe(1)
  })

  test("reconcileAll({ resubmit: true }) re-sends what is still unknown", async () => {
    const world = makeWorld({ script: ["hangAfter"] })
    world.landed.clear()
    const recovered = await Effect.runPromise(
      Effect.gen(function*() {
        const signed = yield* signedTx({ pinned: false })
        const journal = yield* Journal.Journal
        yield* journal.put(JournalEntry.cases.Signed.make({ digest: signed.digest, signed, at: yield* DateTime.now }))
        world.script = ["land"]
        return yield* Lifecycle.reconcileAll({ resubmit: true })
      }).pipe(Effect.provide(Layer.mergeAll(layer(world), fast, Journal.layerMemory)))
    )
    expect(recovered.map((r) => r._tag)).toEqual(["Executed"])
    expect(world.executeCalls).toBe(1)
  })
})

describe("sender lock", () => {
  const twoRuns = (world: ReturnType<typeof makeWorld>, pinned: boolean) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        const coin = ownedObject(COIN, 3n)
        const one = (amount: bigint) =>
          Lifecycle.run(
            Effect.gen(function*() {
              // Pinned: split from the gas coin paid by a fixed coin. Unpinned: the coin comes
              // from the address balance and gas is paid from it, so nothing is pinned or reserved.
              const c = pinned
                ? (yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(amount)]))[0]!
                : yield* Ptb.coin({ amount, useGasCoin: false })
              yield* Ptb.transferObjects([c], yield* Ptb.address(signer.address))
            }),
            pinned ? { signer, payment: Resolve.fixed([Objects.refOf(coin)]) } : { signer }
          )
        return yield* Effect.all([one(1n), one(2n)], { concurrency: "unbounded" })
      }).pipe(Effect.provide(Layer.mergeAll(layer(world), fast, Journal.layerMemory, SenderLock.layerMemory)))
    )

  test("runs whose bytes pin a gas coin are serialised from build through submit", async () => {
    const world = makeWorld({ executeDelay: 30 })
    await twoRuns(world, true)
    expect(world.maxInFlight).toBe(1)
    expect(world.builtDuringExecute).toBe(false)
  })

  test("address-balance runs (nothing pinned) release the lock after the build", async () => {
    const world = makeWorld({ executeDelay: 30 })
    await twoRuns(world, false)
    expect(world.maxInFlight).toBe(2)
  })
})

describe("run", () => {
  test("build -> sign -> journal -> submit against the stubs", async () => {
    const world = makeWorld()
    const { effects, tag } = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        const effects = yield* Lifecycle.run(
          Effect.gen(function*() {
            const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1n)])
            yield* Ptb.transferObjects([coin!], yield* Ptb.address(signer.address))
          }),
          { signer }
        )
        const entry = yield* Effect.flatMap(Effect.service(Journal.Journal), (j) => j.get(effects.digest))
        return { effects, tag: Option.getOrThrow(entry)._tag }
      }).pipe(Effect.provide(Layer.mergeAll(layer(world), fast, Journal.layerMemory)))
    )
    expect(effects.status._tag).toBe("Success")
    expect(tag).toBe("Executed")
  })
})
