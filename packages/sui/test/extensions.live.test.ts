/**
 * DynamicFields, Events, CheckpointData and Transactions.waitFor against real
 * full nodes. Opt in with SUI_LIVE=1.
 */
import { base58 } from "@scure/base"
import { Bcs } from "@unconfirmed/bcs"
import { describe, expect, test } from "bun:test"
import { Effect, Schedule, Stream } from "effect"
import { Address, Chain, CheckpointData, Checkpoints, DynamicFields, Ed25519, Events, Objects, Ptb, Resolve, Transactions, Tx } from "../src/index.ts"
import { DEVNET, faucet, grpcLayer, live, TESTNET } from "./support.ts"

const suite = live ? describe : describe.skip
const tip = Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.subscribe.pipe(Stream.runHead)).pipe(
  Effect.map((o) => (o._tag === "Some" ? o.value.sequenceNumber : 0n))
)

suite("testnet: extensions", () => {
  test("DynamicFields: list 0x5, derive its id, get by name through Objects.get", async () => {
    const { layer, requests } = grpcLayer(TESTNET)
    const { fields, got, viaSchema } = await Effect.runPromise(
      Effect.gen(function*() {
        const df = yield* DynamicFields.DynamicFields
        const fields = yield* df.list(Address.normalize("0x5")).pipe(Stream.runCollect)
        const f = fields[0]!
        const [got, viaSchema] = yield* Effect.all([
          df.get(f.parent, f.name),
          DynamicFields.getWith(f.parent, "u64", Bcs.u64, Bcs.decodeSync(Bcs.u64)(f.name.bcs))
        ], { concurrency: "unbounded" })
        return { fields, got, viaSchema }
      }).pipe(Effect.provide(layer))
    )
    const f = fields[0]!
    expect(f.kind).toBe("Field")
    expect(f.name.type).toBe("u64")
    expect(DynamicFields.deriveId(f.parent, f.name.type, f.name.bcs)).toBe(f.fieldId)
    expect(got.fieldId).toBe(f.fieldId)
    expect(got.valueType).toBe(f.valueType)
    expect(got.valueType.endsWith("::sui_system_state_inner::SuiSystemStateInnerV2")).toBe(true)
    expect(Buffer.from(got.value).equals(Buffer.from(f.value))).toBe(true)
    expect(viaSchema.fieldId).toBe(f.fieldId)
    // Both concurrent gets coalesced into one BatchGetObjects.
    expect(requests.filter((r) => r === "BatchGetObjects")).toHaveLength(1)
  }, 30_000)

  test("DynamicFields: a missing name is DynamicFieldNotFound", async () => {
    const { layer } = grpcLayer(TESTNET)
    const e = await Effect.runPromise(
      DynamicFields.getWith(Address.normalize("0x5"), "u64", Bcs.u64, 999_999n).pipe(Effect.flip, Effect.provide(layer))
    )
    expect(e._tag).toBe("DynamicFieldNotFound")
  })

  test("Events: list descending and ascending across server budgets; subscribe", async () => {
    const { layer, requests } = grpcLayer(TESTNET)
    const { newest, history, live } = await Effect.runPromise(
      Effect.gen(function*() {
        const events = yield* Events.Events
        const t = yield* tip
        const newest = yield* events.list({ descending: true }).pipe(Stream.take(3), Stream.runCollect)
        // > 1000 (the per-call item limit) forces resumption.
        const history = yield* events.list({ start: t - 30000n }).pipe(Stream.take(1500), Stream.runCollect)
        const live = yield* events.subscribe().pipe(Stream.take(2), Stream.runCollect, Effect.timeout("60 seconds"))
        return { newest, history, live }
      }).pipe(Effect.provide(layer))
    )
    expect(newest).toHaveLength(3)
    expect(newest[0]!.checkpoint >= newest[2]!.checkpoint).toBe(true)
    expect(history).toHaveLength(1500)
    expect(requests.filter((r) => r === "ListEvents").length).toBeGreaterThanOrEqual(3)
    const key = (e: Events.Event) => [e.checkpoint, e.transactionIndex, BigInt(e.eventIndex)] as const
    for (let i = 1; i < history.length; i++) {
      const [a, b] = [key(history[i - 1]!), key(history[i]!)]
      const ordered = a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))
      expect(ordered).toBe(true)
    }
    expect(history.every((e) => e.type.includes("::") && e.transactionDigest.length > 30 && e.contents.length > 0)).toBe(true)
    expect(live).toHaveLength(2)

    // Filtered by type: every result matches.
    const type = newest[0]!.type.split("<")[0]!
    const filtered = await Effect.runPromise(
      Effect.flatMap(Effect.service(Events.Events), (ev) =>
        ev.list({ filter: Events.eventType(type), descending: true }).pipe(Stream.take(5), Stream.runCollect)).pipe(
          Effect.provide(layer)
        )
    )
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.every((e) => e.type.startsWith(type))).toBe(true)
  }, 90_000)

  test("Events: a descending scan without start ends at the pruning floor instead of failing (review A1)", async () => {
    const { layer } = grpcLayer(TESTNET)
    const all = await Effect.runPromise(
      Effect.flatMap(Effect.service(Events.Events), (e) =>
        e.list({ descending: true, filter: Events.eventType("0x2::kiosk::ItemListed") }).pipe(Stream.runCollect)).pipe(
          Effect.timeout("80 seconds"),
          Effect.provide(layer)
        )
    )
    expect(all.every((e) => e.type.includes("::kiosk::ItemListed"))).toBe(true)
    console.log("descending ItemListed to the floor:", all.length)
  }, 90_000)

  test("Chain.info reports the epoch and the checkpoint height", async () => {
    const { layer } = grpcLayer(TESTNET)
    const info = await Effect.runPromise(Effect.flatMap(Effect.service(Chain.Chain), (c) => c.info).pipe(Effect.provide(layer)))
    expect(info.epoch > 0n && info.checkpointHeight > 0n).toBe(true)
  })

  test("CheckpointData: get, list across budgets, follow into live; Checkpoints.list resumes", async () => {
    const { layer } = grpcLayer(TESTNET)
    const r = await Effect.runPromise(
      Effect.gen(function*() {
        const data = yield* CheckpointData.CheckpointData
        const t = yield* tip
        const one = yield* data.get(t - 5n)
        const listed = yield* data.list({ start: t - 30n, end: t - 5n }).pipe(Stream.runCollect)
        const followed = yield* CheckpointData.follow(t - 3n).pipe(Stream.take(8), Stream.runCollect, Effect.timeout("60 seconds"))
        const summaries = yield* Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) =>
          c.list({ start: t - 30n, end: t - 5n }).pipe(Stream.runCollect))
        const missing = yield* data.get(t + 10_000_000n).pipe(Effect.flip)
        return { t, one, listed, followed, summaries, missing }
      }).pipe(Effect.provide(layer))
    )
    expect(r.one.sequenceNumber).toBe(r.t - 5n)
    expect(r.one.transactions.length).toBeGreaterThan(0)
    expect(r.one.timestampMs > 1_700_000_000_000n).toBe(true)
    const tx = r.one.transactions[0]!
    expect(tx.digest.length).toBeGreaterThan(30)
    expect(tx.status._tag).toBe("Success")
    expect(tx.changedObjects.length).toBeGreaterThan(0)
    // 25 > 10, the node's per-call checkpoint budget.
    expect(r.listed.map((c) => c.sequenceNumber)).toEqual(Array.from({ length: 25 }, (_, i) => r.t - 30n + BigInt(i)))
    expect(r.summaries.map((c) => c.sequenceNumber)).toEqual(r.listed.map((c) => c.sequenceNumber))
    expect(r.followed.map((c) => c.sequenceNumber)).toEqual(Array.from({ length: 8 }, (_, i) => r.t - 3n + BigInt(i)))
    expect(r.missing._tag).toBe("CheckpointNotFound")
    const withEvents = r.listed.flatMap((c) => c.transactions).find((t) => t.events.length > 0)
    if (withEvents) expect(withEvents.events[0]!.transactionDigest).toBe(withEvents.digest)
  }, 90_000)

  test("Transactions.waitFor: a known digest returns; an unknown one times out", async () => {
    const { layer } = grpcLayer(TESTNET)
    const r = await Effect.runPromise(
      Effect.gen(function*() {
        const data = yield* CheckpointData.CheckpointData
        const cp = yield* data.get((yield* tip) - 5n)
        const digest = cp.transactions[0]!.digest
        const found = yield* Transactions.waitFor(digest)
        const missing = yield* Transactions.waitFor(base58.encode(new Uint8Array(32).fill(1)), { timeout: "2 seconds" }).pipe(Effect.flip)
        return { digest, found, missing }
      }).pipe(Effect.provide(layer))
    )
    expect(r.found.digest).toBe(r.digest)
    expect(r.missing._tag).toBe("TransactionWaitTimeout")
  }, 30_000)
})

const ItemListed = Bcs.struct({ kiosk: Bcs.Address, id: Bcs.Address, price: Bcs.u64 })
const CAP = "0x2::kiosk::KioskOwnerCap"

suite("devnet: extensions", () => {
  test("kiosk place_and_list: dynamic object field, emitted event, checkpoint contents", async () => {
    const { layer } = grpcLayer(DEVNET)
    const r = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        yield* faucet(signer.address)
        const effects = yield* Tx.run(
          Effect.gen(function*() {
            const k1 = yield* Ptb.moveCall({ target: "0x2::kiosk::new" })
            const k2 = yield* Ptb.moveCall({ target: "0x2::kiosk::new" })
            yield* Ptb.moveCall({
              target: "0x2::kiosk::place_and_list",
              typeArguments: [CAP],
              arguments: [Ptb.nested(k1, 0), Ptb.nested(k1, 1), Ptb.nested(k2, 1), yield* Ptb.u64(777n)]
            })
            for (const k of [k1, k2]) {
              yield* Ptb.moveCall({ target: "0x2::transfer::public_share_object", typeArguments: ["0x2::kiosk::Kiosk"], arguments: [Ptb.nested(k, 0)] })
            }
            yield* Ptb.transferObjects([Ptb.nested(k1, 1)], yield* Ptb.address(signer.address))
          }),
          { signer, payment: Resolve.coins }
        )
        const waited = yield* Transactions.waitFor(effects.digest)
        const created = effects.changedObjects.filter((c) => c.operation === "Created")
        const kioskIds = created.filter((c) => c.type?.endsWith("::kiosk::Kiosk")).map((c) => c.objectId)
        const placedCap = created.find((c) => c.type?.endsWith("::kiosk::KioskOwnerCap") && c.owner?._tag === "ObjectOwner")!

        // Which kiosk holds it: the one with a dynamic object field.
        const df = yield* DynamicFields.DynamicFields
        const listings = yield* Effect.forEach(kioskIds, (k) => df.list(k).pipe(Stream.runCollect))
        const kiosk = kioskIds[listings.findIndex((l) => l.some((f) => f.kind === "Object"))]!
        const fields = listings.find((l) => l.some((f) => f.kind === "Object"))!
        const filtered = yield* df.list(kiosk, { nameType: "0x2::kiosk::Item" }).pipe(Stream.runCollect)
        const child = yield* DynamicFields.getObjectWith(kiosk, "0x2::kiosk::Item", Bcs.Address, placedCap.objectId)

        // The event: by sender, retried until the node has indexed it.
        const events = yield* Events.Events
        const event = yield* events.list({ filter: Events.all(Events.sender(signer.address), Events.eventType("0x2::kiosk::ItemListed")) }).pipe(
          Stream.runHead,
          Effect.flatMap((o) => (o._tag === "Some" ? Effect.succeed(o.value) : Effect.fail("not indexed" as const))),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 })
        )
        const decoded = yield* Events.decode(ItemListed)(event)
        const cp = yield* Effect.flatMap(Effect.service(CheckpointData.CheckpointData), (d) => d.get(event.checkpoint))
        const objects = yield* Objects.Objects
        const kioskObj = yield* objects.get(kiosk)
        return { effects, waited, placedCap, kiosk, fields, filtered, child, event, decoded, cp, kioskObj, signer }
      }).pipe(Effect.provide(layer))
    )
    console.log("devnet tx", r.effects.digest, "checkpoint", r.event.checkpoint)
    expect(r.waited.digest).toBe(r.effects.digest)
    const objField = r.fields.find((f) => f.kind === "Object")!
    expect(objField.name.type.endsWith("::kiosk::Item")).toBe(true)
    expect(objField.childId).toBe(r.placedCap.objectId)
    expect(r.filtered.map((f) => f.fieldId)).toEqual([objField.fieldId])
    expect(r.child.objectId).toBe(r.placedCap.objectId)
    expect(r.child.type.endsWith("::kiosk::KioskOwnerCap")).toBe(true)
    expect(r.event.transactionDigest).toBe(r.effects.digest)
    expect(r.event.sender).toBe(r.signer.address)
    expect(r.event.module).toBe("kiosk")
    expect(r.decoded).toEqual({ kiosk: r.kiosk, id: r.placedCap.objectId, price: 777n })
    const tx = r.cp.transactions.find((t) => t.digest === r.effects.digest)!
    expect(tx.status._tag).toBe("Success")
    expect(tx.events.map((e) => e.type.split("<")[0]!.split("::").slice(1).join("::"))).toContain("kiosk::ItemListed")
    expect(tx.events[0]!.contents).toEqual(r.event.contents)
    expect(tx.changedObjects.some((c) => c.objectId === r.kiosk)).toBe(true)
  }, 120_000)
})
