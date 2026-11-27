/**
 * Chain state from recorded testnet and mainnet objects
 * (`scripts/record-fixtures.ts`): the generated schemas decode them, `System`
 * and `Committees` build the right values, C5 holds, and the pure checks.
 */
import { describe, expect, test } from "bun:test"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import { TestClock } from "effect/testing"
import * as Address from "@unconfirmed/sui/Address"
import * as Committee from "../src/Committee.ts"
import * as Config from "../src/Config.ts"
import * as System from "../src/System.ts"
import { type Fixture, loadFixture, objectsLayer, packagesLayer, restoreObject } from "./fixtures.ts"

const testnet = loadFixture("testnet")
const mainnet = loadFixture("mainnet")

const layers = (fixture: Fixture, overrides: Parameters<typeof objectsLayer>[1] = []) => {
  const objects = objectsLayer(fixture, overrides)
  const deps = Layer.mergeAll(objects.layer, packagesLayer(fixture), Config.layer(fixture.config))
  return {
    gets: objects.gets,
    layer: Layer.mergeAll(System.layer, Committee.layer()).pipe(Layer.provideMerge(deps))
  }
}

const run = <A, E>(fixture: Fixture, effect: Effect.Effect<A, E, System.System | Committee.Committees>) =>
  Effect.runPromise(Effect.provide(effect, layers(fixture).layer))

const both = Effect.gen(function*() {
  const state = yield* (yield* Effect.service(System.System)).state
  const walType = yield* (yield* Effect.service(System.System)).walType
  const committees = yield* (yield* Effect.service(Committee.Committees)).get
  return { state, walType, committees }
})

describe("System", () => {
  test("testnet: decodes the system object and its inner state", async () => {
    const { state, walType } = await run(testnet, both)
    expect(state.systemObjectId).toBe(Config.testnet.systemObjectId)
    expect(state.epoch).toBe(594)
    expect(state.nShards).toBe(1000)
    expect(state.packageId).toBe(Address.normalize("0x7d3b2086808a62bbc44d18c6b1d407973d77dd26946735873092c2f5650b4611"))
    expect(state.typeOrigin).toBe(Address.normalize("0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66"))
    expect(state.storagePrice).toBe(4724n)
    expect(state.writePrice).toBe(9421n)
    expect(state.initialSharedVersion).toBeGreaterThan(0n)
    expect(state.members.length).toBe(99)
    expect(state.members.reduce((n, m) => n + m.weight, 0)).toBe(1000)
    expect(state.members.every((m) => m.publicKey.length === 96)).toBe(true)
    expect(walType).toBe(`${Address.normalize("0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a")}::wal::WAL`)
  })

  test("mainnet objects decode too; C5 holds on both networks, keys included", async () => {
    for (const fixture of [testnet, mainnet]) {
      const { state, committees } = await run(fixture, both)
      expect(state.nShards).toBe(1000)
      expect(Result.isSuccess(Committee.checkAgainstSystem(committees.current, state))).toBe(true)
      expect(committees.current.nodes.map((n) => Buffer.from(n.publicKey).toString("hex")))
        .toEqual(state.members.map((m) => Buffer.from(m.publicKey).toString("hex")))
    }
    const { walType } = await run(mainnet, both)
    expect(walType).toBe(`${Address.normalize("0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59")}::wal::WAL`)
  })

  test("state is reused for STATE_TTL, then read again (prices and the package id move); refresh reads at once", async () => {
    const { gets, layer } = layers(testnet)
    const reads = () => gets.get(Config.testnet.systemObjectId)
    await Effect.runPromise(
      Effect.gen(function*() {
        const system = yield* Effect.service(System.System)
        yield* system.state
        yield* system.walType
        yield* TestClock.adjust(Duration.subtract(System.STATE_TTL, Duration.seconds(1)))
        yield* system.state
        expect(reads()).toBe(1)
        yield* TestClock.adjust("2 seconds")
        yield* system.state
        expect(reads()).toBe(2)
        yield* system.refresh
        expect(reads()).toBe(3)
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))
    )
  })

  test("an inner state of another type is UnsupportedSystemVersion; an object that is not a System is ObjectDecodeError", async () => {
    const stateError = (overrides: Parameters<typeof objectsLayer>[1]) =>
      Effect.runPromise(Effect.flatMap(Effect.service(System.System), (s) => s.state).pipe(Effect.flip, Effect.provide(layers(testnet, overrides).layer)))
    const field = restoreObject(testnet.objects.find((o) => o.type.includes("SystemStateInnerV1"))!)
    const v2 = { ...field, type: field.type.replace("SystemStateInnerV1", "SystemStateInnerV2") }
    expect((await stateError([v2]))._tag).toBe("UnsupportedSystemVersion")
    const staking = restoreObject(testnet.objects.find((o) => o.objectId === Config.testnet.stakingObjectId)!)
    expect((await stateError([{ ...staking, objectId: Config.testnet.systemObjectId }]))._tag).toBe("ObjectDecodeError")
  })
})

describe("Committees", () => {
  test("testnet: 99 nodes sorted by id, shards partitioned, urls and keys from the pools", async () => {
    const { committees } = await run(testnet, both)
    const { current, previous, transitioning } = committees
    expect(transitioning).toBe(false)
    expect(current.epoch).toBe(594)
    expect(previous?.epoch).toBe(593)
    expect(current.nShards).toBe(1000)
    expect(current.nodes.length).toBe(99)
    const ids = current.nodes.map((n) => n.nodeId)
    expect([...ids].sort()).toEqual(ids)
    expect(current.nodes.map((n) => n.index)).toEqual(ids.map((_, i) => i))
    const shards = current.nodes.flatMap((n) => n.shards).sort((a, b) => a - b)
    expect(shards).toEqual(Array.from({ length: 1000 }, (_, i) => i))
    expect(current.nodes.every((node) => /^https:\/\/[^/]+$/.test(node.url) && node.shards.every((s) => current.nodeOfShard(s) === node)))
      .toBe(true)
    expect(() => current.nodeOfShard(1000)).toThrow(RangeError)
  })

  test("cached for the ttl, then read again; refresh reads at once", async () => {
    const { gets, layer } = layers(testnet)
    await Effect.runPromise(
      Effect.gen(function*() {
        const committees = yield* Effect.service(Committee.Committees)
        yield* committees.get
        yield* committees.get
        expect(gets.get(Config.testnet.stakingObjectId)).toBe(1)
        yield* TestClock.adjust("59 seconds")
        yield* committees.get
        expect(gets.get(Config.testnet.stakingObjectId)).toBe(1)
        yield* TestClock.adjust("2 seconds")
        yield* committees.get
        expect(gets.get(Config.testnet.stakingObjectId)).toBe(2)
        yield* committees.refresh
        expect(gets.get(Config.testnet.stakingObjectId)).toBe(3)
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))
    )
  })
})

// -----------------------------------------------------------------------------
// Pure
// -----------------------------------------------------------------------------

const POOL = (name: string) => ({ node_info: { name, network_address: `${name}:9185`, public_key: { bytes: new Uint8Array(96) } } }) as any
const id = (n: number) => Address.normalize(`0x${n.toString(16)}`)
const map = (entries: ReadonlyArray<readonly [number, ReadonlyArray<number>]>) =>
  [{ contents: entries.map(([n, shards]) => ({ key: id(n), value: [...shards] })) }] as const
const pools = new Map([1, 2, 3].map((n) => [id(n), POOL(`n${n}`)]))

const committee = (epoch: number) => Result.getOrThrow(Committee.make(epoch, 4, map([[1, [0, 3]], [2, [1]], [3, [2]]]), pools))

describe("make", () => {
  test("indexes nodes in map order and maps shards to nodes", () => {
    const c = committee(5)
    expect(c.nodes.map((n) => [n.index, n.name, n.url, n.shards])).toEqual([
      [0, "n1", "https://n1:9185", [0, 3]],
      [1, "n2", "https://n2:9185", [1]],
      [2, "n3", "https://n3:9185", [2]]
    ])
    expect([0, 1, 2, 3].map((s) => c.nodeOfShard(s).name)).toEqual(["n1", "n2", "n3", "n1"])
  })

  test("rejects maps that do not partition the shards", () => {
    expect(Committee.make(1, 4, map([[1, [0, 1]], [2, [1, 2, 3]]]), pools)).toEqual(Result.fail("shard 1 is assigned twice"))
    expect(Committee.make(1, 4, map([[1, [0, 1]], [2, [2]]]), pools)).toEqual(Result.fail("shard 3 is not assigned"))
    expect(Committee.make(1, 4, map([[1, [0, 4]]]), pools)).toEqual(Result.fail(`node ${id(1)} holds shard 4 of 4`))
    expect(Committee.make(1, 4, map([[9, [0, 1, 2, 3]]]), pools)).toEqual(Result.fail(`no staking pool for node ${id(9)}`))
  })
})

describe("readCommittee (C6)", () => {
  const current = committee(10)
  const previous = committee(9)
  const stable: Committee.ActiveCommittees = { current, previous, transitioning: false }
  const changing: Committee.ActiveCommittees = { current, previous, transitioning: true }
  const read = (c: Committee.ActiveCommittees, e: number | undefined) => Result.getOrThrow(Committee.readCommittee(c, e))

  test("current unless transitioning and certified before this epoch; later is BehindCurrentEpoch", () => {
    expect([read(stable, 3), read(stable, 10)]).toEqual([current, current])
    expect([read(changing, 9), read(changing, 1)]).toEqual([previous, previous])
    expect(read(changing, 10)).toBe(current)
    // unknown certified epoch, or no previous committee: the current committee
    expect(read(changing, undefined)).toBe(current)
    expect(read({ current, previous: undefined, transitioning: true }, 3)).toBe(current)
    const r = Committee.readCommittee(stable, 11)
    expect(Result.isFailure(r) && r.failure._tag === "BehindCurrentEpoch" && [r.failure.clientEpoch, r.failure.certifiedEpoch]).toEqual([10, 11])
  })
})

describe("checkAgainstSystem (C5)", () => {
  const c = committee(7)
  const state: System.SystemState = {
    systemObjectId: id(0x99),
    initialSharedVersion: 1n,
    epoch: 7,
    nShards: 4,
    packageId: id(0x77),
    typeOrigin: id(0x78),
    storagePrice: 1n,
    writePrice: 1n,
    members: [
      { nodeId: id(1), weight: 2, publicKey: new Uint8Array(96) },
      { nodeId: id(2), weight: 1, publicKey: new Uint8Array(96) },
      { nodeId: id(3), weight: 1, publicKey: new Uint8Array(96) }
    ]
  }
  const reason = (s: System.SystemState) => {
    const r = Committee.checkAgainstSystem(c, s)
    return Result.isFailure(r) ? r.failure.reason : "ok"
  }
  test("every disagreement is named", () => {
    const [a, b, d] = state.members
    expect(reason(state)).toBe("ok")
    expect(reason({ ...state, epoch: 8 })).toBe("different epochs")
    expect(reason({ ...state, nShards: 5 })).toContain("shards")
    expect(reason({ ...state, members: state.members.slice(1) })).toContain("2 members")
    expect(reason({ ...state, members: [b!, a!, d!] })).toContain("member 0")
    expect(reason({ ...state, members: state.members.map((m, i) => (i === 2 ? { ...m, weight: 2 } : m)) })).toContain("weighs 2")
  })
})
