import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import { TestClock } from "effect/testing"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import type { Address } from "@unconfirmed/sui/Address"
import * as Move from "@unconfirmed/sui/Move"
import type * as Objects from "@unconfirmed/sui/Objects"
import * as Config from "../src/Config.ts"
import * as Ibe from "../src/Ibe.ts"
import * as KeyServer from "../src/KeyServer.ts"
import { loadFixture, objectsLayer, type RecordedService, serviceStub } from "./fixtures.ts"

const testnet = loadFixture("testnet")
const mainnet = loadFixture("mainnet")

const ID = {
  mysten1: Config.testnet.mysten1.objectId as Address, // V1, shared
  mysten2: Config.testnet.mysten2.objectId as Address,
  mirai: "0x164ac3d2b3b8694b8181c13f671950004765c23f270321a45fdd04d40cccf0f2" as Address, // V1, address-owned
  suiftly: "0x6a0726a1ea3d62ba2f2ae51104f2c3633c003fb75621d06fde47f04dc930ba06" as Address, // 503 on /v1/service
  overclock: "0x9c949e53c36ab7a9c484ed9e8b43267a77d4b8d70e79aa6b39042e3d4c434105" as Address, // timed out
  committee: Config.testnet.committee.objectId as Address, // V2 committee, object-owned
  mainnetCommittee: Config.mainnet.committee.objectId as Address
}

// -----------------------------------------------------------------------------
// Synthesized objects
// -----------------------------------------------------------------------------

const PKG = "0x" + "11".repeat(32)
const synth = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Address
const MASTER = 0x5ea1n
const PK = Ibe.publicKey(MASTER)

const object = (objectId: string, type: string, contents: Uint8Array): Objects.SuiObject => ({
  objectId: objectId as Address,
  version: 1n,
  digest: "11111111111111111111111111111111" as any,
  owner: { _tag: "Shared", initialSharedVersion: 1n },
  type,
  contents,
  previousTransaction: undefined
})

const outer = (id: Address, first: bigint, last: bigint, o: { type?: string; contents?: Uint8Array } = {}) =>
  object(
    id,
    o.type ?? `${PKG}::key_server::KeyServer`,
    o.contents ?? Bcs.encodeSync(KeyServer.KeyServerBcs)({ id, firstVersion: first, lastVersion: last })
  )

type V1 = typeof KeyServer.KeyServerV1Bcs.Type
type V2 = typeof KeyServer.KeyServerV2Bcs.Type
const v1 = (o: Partial<V1> = {}): V1 => ({ name: "synth-v1", url: "https://v1.example", keyType: 0, pk: PK, ...o })
const v2 = (o: Partial<V2> = {}): V2 => ({
  name: "synth-v2",
  keyType: 0,
  pk: PK,
  serverType: { _tag: "Independent", url: "https://v2.example" },
  ...o
})

const field1 = (parent: Address, value: V1, o: { name?: bigint; type?: string; id?: Address; trailing?: boolean } = {}) => {
  const id = o.id ?? KeyServer.fieldId(parent, 1)
  const bytes = Bcs.encodeSync(Move.Field(Bcs.u64, KeyServer.KeyServerV1Bcs))({ id, name: o.name ?? 1n, value })
  return object(
    id,
    o.type ?? `0x2::dynamic_field::Field<u64, ${PKG}::key_server::KeyServerV1>`,
    o.trailing ? new Uint8Array([...bytes, 0]) : bytes
  )
}
const field2 = (parent: Address, value: V2, o: { type?: string } = {}) => {
  const id = KeyServer.fieldId(parent, 2)
  const bytes = Bcs.encodeSync(Move.Field(Bcs.u64, KeyServer.KeyServerV2Bcs))({ id, name: 2n, value })
  return object(id, o.type ?? `0x2::dynamic_field::Field<u64, 0x99::key_server::KeyServerV2>`, bytes)
}

// -----------------------------------------------------------------------------
// Running
// -----------------------------------------------------------------------------

const readWith = (id: Address, extra: ReadonlyArray<Objects.SuiObject> = []) =>
  Effect.runPromiseExit(KeyServer.read(id).pipe(Effect.provide(objectsLayer([testnet, mainnet], extra).layer)))

const readOk = async (id: Address, extra: ReadonlyArray<Objects.SuiObject> = []) => {
  const exit = await readWith(id, extra)
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return exit.value
}

const failure = (exit: Exit.Exit<unknown, unknown>): any => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const f = exit.cause.reasons.find((r) => r._tag === "Fail") as any
  if (f === undefined) throw new Error(`expected a typed failure: ${String(exit.cause)}`)
  return f.error
}

const invalidReason = async (id: Address, extra: ReadonlyArray<Objects.SuiObject>) => {
  const e = failure(await readWith(id, extra))
  expect(e._tag).toBe("InvalidKeyServer")
  expect(e.objectId).toBe(id)
  return e.reason as string
}

const servicesLayer = (
  servers: ReadonlyArray<Config.ServerInput>,
  o: { extra?: ReadonlyArray<Objects.SuiObject>; verified?: boolean; services?: Record<string, RecordedService>; ttl?: string } = {}
) => {
  const objects = objectsLayer([testnet, mainnet], o.extra ?? [])
  const stub = serviceStub(o.services ?? testnet.services)
  const opts = o.ttl === undefined ? undefined : { ttl: o.ttl as any }
  const base = o.verified ? KeyServer.layerVerified(opts) : KeyServer.layer(opts)
  const layer = base.pipe(
    Layer.provide(Layer.mergeAll(Config.layerFrom(Result.getOrThrow(Config.make(servers))), objects.layer, stub.layer))
  )
  return { layer, gets: objects.gets, calls: stub.calls }
}

const get = (id: Address) => Effect.flatMap(Effect.service(KeyServer.KeyServers), (s) => s.get(id))

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

// -----------------------------------------------------------------------------

describe("KeyServer.read: recorded objects", () => {
  test("every recorded server decodes, with the layout and type the recorder saw", async () => {
    for (const f of [testnet, mainnet]) {
      for (const k of f.keyServers) {
        const s = await readOk(k.objectId as Address)
        expect([s.name, s.layout, s.type._tag]).toEqual([k.name, k.layout, k.type as any])
        expect(s.publicKey.length).toBe(96)
      }
    }
  })

  test("V2 committees: testnet 3 of 5, mainnet 5 of 8", async () => {
    for (const [id, threshold, n] of [[ID.committee, 3, 5], [ID.mainnetCommittee, 5, 8]] as const) {
      const s = await readOk(id)
      expect(s.layout).toBe(2)
      if (s.type._tag !== "Committee") throw new Error("expected a committee")
      expect([s.type.version, s.type.threshold, s.type.members.length]).toEqual([0, threshold, n])
      expect(new Set(s.type.members.map((m) => m.partyId)).size).toBe(n)
    }
  })

  test("reads the object and both candidate fields in one round, nothing else", async () => {
    const objects = objectsLayer([testnet])
    await Effect.runPromise(KeyServer.read(ID.mysten1).pipe(Effect.provide(objects.layer)))
    expect(new Set(objects.gets.keys())).toEqual(
      new Set([ID.mysten1, KeyServer.fieldId(ID.mysten1, 2), KeyServer.fieldId(ID.mysten1, 1)])
    )
    for (const n of objects.gets.values()) expect(n).toBe(1)
  })
})

describe("KeyServer.read: synthesized layouts and version choice", () => {
  test("V2 independent decodes", async () => {
    const id = synth(2)
    const s = await readOk(id, [outer(id, 2n, 2n), field2(id, v2())])
    expect(s).toEqual({ objectId: id, name: "synth-v2", publicKey: PK, layout: 2, type: { _tag: "Independent", url: "https://v2.example" } })
  })

  test("the highest supported version in [first, last] is read (K2); none or a broken range is refused", async () => {
    const read = async (first: bigint, last: bigint) => {
      const id = synth(Number(first * 10n + last) + 100)
      return (await readOk(id, [outer(id, first, last), field1(id, v1()), field2(id, v2())])).layout
    }
    expect([await read(1n, 2n), await read(1n, 1n), await read(1n, 3n)]).toEqual([2, 1, 2])
    const id = synth(5)
    expect(await invalidReason(id, [outer(id, 3n, 4n)])).toContain("no supported version")
    expect(await invalidReason(id, [outer(id, 2n, 1n)])).toContain("invalid version range")
    expect(await invalidReason(id, [outer(id, 0n, 1n)])).toContain("invalid version range")
  })
})

describe("KeyServer.read: every InvalidKeyServer reason", () => {
  test("untrusted chain data that does not decode to a usable key server is refused", async () => {
    const id = synth(10)
    const good = Bcs.encodeSync(KeyServer.KeyServerBcs)({ id, firstVersion: 1n, lastVersion: 1n })
    const infinity = new Uint8Array(96)
    infinity[0] = 0xc0
    const fieldType = (t: string) => field1(id, v1(), { type: t })
    const cases: ReadonlyArray<readonly [ReadonlyArray<Objects.SuiObject>, string]> = [
      [[outer(id, 1n, 1n, { type: `${PKG}::other::KeyServer` }), field1(id, v1())], "not a key_server::KeyServer"],
      [[outer(id, 1n, 1n, { type: `${PKG}::key_server::KeyServer<u8>` })], "not a key_server::KeyServer"],
      [[outer(id, 1n, 1n, { contents: new Uint8Array([...good, 1]) }), field1(id, v1())], "trailing"],
      [[outer(id, 1n, 1n), field1(id, v1(), { trailing: true })], "trailing"],
      [[outer(id, 1n, 1n, { contents: Bcs.encodeSync(KeyServer.KeyServerBcs)({ id: synth(11), firstVersion: 1n, lastVersion: 1n }) }), field1(id, v1())], "holds id"],
      [[outer(id, 1n, 1n)], "versioned field 1 not found"],
      [[outer(id, 1n, 1n), fieldType(`0x2::dynamic_field::Field<u64, ${PKG}::key_server::KeyServerV2>`)], "not a KeyServerV1 field"],
      [[outer(id, 1n, 1n), fieldType(`0x3::dynamic_field::Field<u64, ${PKG}::key_server::KeyServerV1>`)], "not a KeyServerV1 field"],
      [[outer(id, 1n, 1n), field1(id, v1(), { name: 2n })], "names another field"],
      [[outer(id, 1n, 1n), field1(id, v1({ keyType: 1 }))], "unsupported key type 1"],
      [[outer(id, 1n, 1n), field1(id, v1({ pk: PK.subarray(0, 48) }))], "not a valid G2 point"],
      [[outer(id, 1n, 1n), field1(id, v1({ pk: infinity }))], "not a valid G2 point"]
    ]
    for (const [objects, reason] of cases) expect(await invalidReason(id, objects)).toContain(reason)
    const id2 = synth(12)
    expect(await invalidReason(id2, [outer(id2, 2n, 2n), field2(id2, v2({ keyType: 7 }))])).toContain("unsupported key type")
    expect(await invalidReason(id2, [outer(id2, 2n, 2n), field2(id2, v2({ pk: new Uint8Array(96) }))])).toContain("G2")
    expect(await invalidReason("0x2" as Address, [])).toContain("not an object id")
    // Any package address is accepted (K4).
    expect((await readOk(id, [outer(id, 1n, 1n, { type: "0x42::key_server::KeyServer" }), field1(id, v1())])).layout).toBe(1)
  })
})

describe("KeyServer.resolve: configuration", () => {
  const onChain = (type: KeyServer.OnChain["type"]): KeyServer.OnChain => ({ objectId: synth(20), name: "n", publicKey: PK, layout: 2, type })
  const committee = onChain({ _tag: "Committee", version: 0, threshold: 1, members: [] })
  const independent = onChain({ _tag: "Independent", url: "https://ks.example" })
  const apiKey = { name: "x-api-key", value: Redacted.make("k") }

  test("committee: aggregator and API key from configuration; independent: on-chain URL; refusals", () => {
    expect(Result.getOrThrow(KeyServer.resolve(committee, { objectId: synth(20), weight: 1, aggregatorUrl: "https://agg.example", apiKey })))
      .toMatchObject({ type: "Committee", url: "https://agg.example", apiKey })
    expect(Result.getOrThrow(KeyServer.resolve(independent, { objectId: synth(20), weight: 1, apiKey })))
      .toMatchObject({ type: "Independent", url: "https://ks.example", apiKey })
    expect(Result.getOrThrow(KeyServer.resolve(independent, undefined)).url).toBeUndefined()
    const reason = (r: Result.Result<unknown, KeyServer.InvalidKeyServer>) => Result.isFailure(r) ? r.failure.reason : "ok"
    expect(reason(KeyServer.resolve(committee, { objectId: synth(20), weight: 1 }))).toContain("needs aggregatorUrl")
    expect(reason(KeyServer.resolve(independent, { objectId: synth(20), weight: 1, aggregatorUrl: "https://a.example" }))).toContain(
      "must not have aggregatorUrl"
    )
    const bad = onChain({ _tag: "Independent", url: "javascript:alert(1)" })
    expect(reason(KeyServer.resolve(bad, { objectId: synth(20), weight: 1 }))).toContain("not http(s)")
    expect(reason(KeyServer.resolve(bad, undefined))).toBe("ok") // never asked
  })
})

describe("KeyServers.layer", () => {
  test("configured servers: URL from chain or configuration; any id is readable", async () => {
    const { layer } = servicesLayer([Config.testnet.mysten1, { ...Config.testnet.committee, apiKeyName: "k", apiKey: "v" }])
    const [m, c, other] = await Effect.runPromise(
      Effect.all([get(ID.mysten1), get(ID.committee), get(ID.mirai)]).pipe(Effect.provide(layer))
    )
    expect(m).toMatchObject({ type: "Independent", url: "https://seal-key-server-testnet-1.mystenlabs.com", apiKey: undefined })
    expect(c.type).toBe("Committee")
    expect(c.url).toBe("https://seal-aggregator-testnet.mystenlabs.com")
    expect(c.apiKey?.name).toBe("k")
    expect(other).toMatchObject({ name: "studio-mirai-open", url: undefined })
  })

  test("ids are normalised: one entry for every spelling", async () => {
    const { gets, layer } = servicesLayer([Config.testnet.mysten1])
    await Effect.runPromise(
      Effect.all([get(ID.mysten1), get(ID.mysten1.toUpperCase().replace("0X", "0x") as Address)]).pipe(Effect.provide(layer))
    )
    expect(gets.get(ID.mysten1)).toBe(1)
  })

  test("concurrent gets make one read", async () => {
    const { gets, layer } = servicesLayer([Config.testnet.mysten1])
    await Effect.runPromise(Effect.all(Array.from({ length: 10 }, () => get(ID.mysten1)), { concurrency: "unbounded" }).pipe(Effect.provide(layer)))
    expect(gets.get(ID.mysten1)).toBe(1)
    expect(gets.get(KeyServer.fieldId(ID.mysten1, 1))).toBe(1)
  })

  test("TTL and refresh under TestClock", async () => {
    const { gets, layer } = servicesLayer([Config.testnet.mysten1], { ttl: "1 minute" })
    await Effect.runPromise(
      Effect.gen(function*() {
        const ks = yield* Effect.service(KeyServer.KeyServers)
        yield* ks.get(ID.mysten1)
        yield* TestClock.adjust("59 seconds")
        yield* ks.get(ID.mysten1)
        expect(gets.get(ID.mysten1)).toBe(1)
        yield* TestClock.adjust("2 seconds")
        yield* ks.get(ID.mysten1)
        expect(gets.get(ID.mysten1)).toBe(2)
        yield* ks.refresh(ID.mysten1)
        expect(gets.get(ID.mysten1)).toBe(3)
        yield* ks.get(ID.mysten1)
        expect(gets.get(ID.mysten1)).toBe(3)
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))
    )
  })

  test("failures are not cached", async () => {
    const id = synth(30)
    const { gets, layer } = servicesLayer([{ objectId: id }])
    await Effect.runPromise(
      Effect.gen(function*() {
        const ks = yield* Effect.service(KeyServer.KeyServers)
        expect(Exit.isFailure(yield* Effect.exit(ks.get(id)))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(ks.get(id)))).toBe(true)
      }).pipe(Effect.provide(layer))
    )
    expect(gets.get(id)).toBe(2)
  })
})

describe("KeyServers.layerVerified", () => {
  const reachable = testnet.keyServers.filter((k) => testnet.services[k.objectId]?.status === 200 && k.type === "Independent")

  test("accepts the recorded live proofs of possession (C17)", async () => {
    expect(reachable.length).toBe(8)
    const { calls, layer } = servicesLayer(reachable.map((k) => ({ objectId: k.objectId })), { verified: true })
    const servers = await Effect.runPromise(Effect.forEach(reachable, (k) => get(k.objectId as Address)).pipe(Effect.provide(layer)))
    expect(servers.map((s) => s.name)).toEqual(reachable.map((k) => k.name))
    for (const k of reachable) expect(calls.get(k.objectId)).toBe(1)
  })

  test("rejects a proof for another id, and an answer naming another id", async () => {
    const services = {
      ...testnet.services,
      // mysten2's genuine answer, served for mysten1 with mysten1's id: the proof is for another id.
      [ID.mysten1]: {
        ...testnet.services[ID.mysten2]!,
        body: JSON.stringify({ ...JSON.parse(testnet.services[ID.mysten2]!.body!), service_id: ID.mysten1 })
      },
      // mysten2's genuine answer naming mysten1.
      [ID.mysten2]: testnet.services[ID.mysten1]!
    }
    const { layer } = servicesLayer([Config.testnet.mysten1, Config.testnet.mysten2], { verified: true, services })
    const [a, b] = await Effect.runPromise(
      Effect.all([Effect.exit(get(ID.mysten1)), Effect.exit(get(ID.mysten2))]).pipe(Effect.provide(layer))
    )
    expect(failure(a).reason).toBe("proof of possession does not verify")
    expect(failure(b).reason).toContain("names another id")
  })

  test("SEAL-6: an unreachable server fails with its kind, transient ones retryable, and is asked again next time", async () => {
    const { calls, layer } = servicesLayer([{ objectId: ID.suiftly }, { objectId: ID.overclock }], { verified: true })
    await Effect.runPromise(
      Effect.gen(function*() {
        const e1 = failure(yield* Effect.exit(get(ID.suiftly)))
        expect([e1._tag, e1.kind, e1.retryable]).toEqual(["InvalidKeyServer", "Unavailable", true])
        expect(e1.reason).toContain("proof of possession unavailable (Unavailable)")
        expect(failure(yield* Effect.exit(get(ID.overclock))).reason).toContain("TimeoutError")
        yield* Effect.exit(get(ID.suiftly))
      }).pipe(Effect.provide(layer))
    )
    expect(calls.get(ID.suiftly)).toBe(2)
    const bad = servicesLayer([Config.testnet.mysten1], {
      verified: true,
      services: { [ID.mysten1]: { url: "https://x.test", status: 404, body: "no such route" } }
    })
    const r = failure(await Effect.runPromiseExit(get(ID.mysten1).pipe(Effect.provide(bad.layer))))
    expect([r.kind, r.retryable]).toEqual(["Rejected", false])
  })

  test("SEAL-6: a verified (object, public key) is not asked again after the TTL or a refresh", async () => {
    const { calls, gets, layer } = servicesLayer([Config.testnet.mysten1], { verified: true, ttl: "1 minute" })
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* get(ID.mysten1)
        yield* TestClock.adjust("2 minutes")
        yield* get(ID.mysten1)
        yield* Effect.flatMap(Effect.service(KeyServer.KeyServers), (s) => s.refresh(ID.mysten1))
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))
    )
    expect(gets.get(ID.mysten1)).toBe(3) // reloaded twice (URLs may change)
    expect(calls.get(ID.mysten1)).toBe(1) // proved once
  })

  test("committee and unconfigured servers are not asked", async () => {
    const { calls, layer } = servicesLayer([Config.testnet.committee], { verified: true })
    await Effect.runPromise(Effect.all([get(ID.committee), get(ID.mysten1)]).pipe(Effect.provide(layer)))
    expect(calls.size).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// BCS parity with @mysten/seal (§6.2)
// -----------------------------------------------------------------------------

const mysten = (await import("../../../node_modules/@mysten/seal/dist/bcs.mjs" as string)) as {
  KeyServerMove: { serialize(v: unknown): { toBytes(): Uint8Array }; parse(b: Uint8Array): any }
  KeyServerMoveV1: { serialize(v: unknown): { toBytes(): Uint8Array }; parse(b: Uint8Array): any }
  KeyServerMoveV2: { serialize(v: unknown): { toBytes(): Uint8Array }; parse(b: Uint8Array): any }
}

describe("BCS parity with @mysten/seal", () => {
  const fieldValue = (r: { contents: string }) => {
    // Field<u64, V>: 32-byte id, 8-byte name, then the value.
    return Buffer.from(r.contents, "base64").subarray(40)
  }
  const recordedFields = [...testnet.objects, ...mainnet.objects].filter((o) => o.type.includes("dynamic_field::Field"))

  test("KeyServer: same bytes, each parses the other's", () => {
    const id = synth(60)
    const ours = Bcs.encodeSync(KeyServer.KeyServerBcs)({ id, firstVersion: 1n, lastVersion: 2n })
    const theirs = mysten.KeyServerMove.serialize({ id, firstVersion: 1, lastVersion: 2 }).toBytes()
    expect(hex(ours)).toBe(hex(theirs))
    for (const r of [...testnet.objects, ...mainnet.objects].filter((o) => o.type.endsWith("::key_server::KeyServer"))) {
      const bytes = Buffer.from(r.contents, "base64")
      const t = mysten.KeyServerMove.parse(bytes)
      const o = Bcs.decodeSync(KeyServer.KeyServerBcs)(bytes)
      expect([o.id, String(o.firstVersion), String(o.lastVersion)]).toEqual([t.id, String(t.firstVersion), String(t.lastVersion)])
    }
  })

  test("KeyServerV1: recorded fields and a synthesized value", () => {
    const v1Fields = recordedFields.filter((o) => o.type.endsWith("KeyServerV1>"))
    expect(v1Fields.length).toBe(10)
    for (const r of v1Fields) {
      const bytes = fieldValue(r)
      const t = mysten.KeyServerMoveV1.parse(bytes)
      const o = Bcs.decodeSync(KeyServer.KeyServerV1Bcs)(bytes)
      expect([o.name, o.url, o.keyType, hex(o.pk)]).toEqual([t.name, t.url, t.keyType, hex(new Uint8Array(t.pk))])
      expect(hex(Bcs.encodeSync(KeyServer.KeyServerV1Bcs)(o))).toBe(hex(mysten.KeyServerMoveV1.serialize(t).toBytes()))
    }
  })

  test("KeyServerV2: recorded committees and a synthesized independent", () => {
    const v2Fields = recordedFields.filter((o) => o.type.endsWith("KeyServerV2>"))
    expect(v2Fields.length).toBe(2)
    for (const r of v2Fields) {
      const bytes = fieldValue(r)
      const t = mysten.KeyServerMoveV2.parse(bytes)
      const o = Bcs.decodeSync(KeyServer.KeyServerV2Bcs)(bytes)
      if (o.serverType._tag !== "Committee") throw new Error("expected a committee")
      expect([o.name, o.keyType, hex(o.pk)]).toEqual([t.name, t.keyType, hex(new Uint8Array(t.pk))])
      const c = t.serverType.Committee
      expect([o.serverType.version, o.serverType.threshold]).toEqual([c.version, c.threshold])
      expect(o.serverType.partialKeyServers.map((m) => [m.name, m.url, m.partyId, hex(m.partialPk)])).toEqual(
        c.partialKeyServers.map((m: any) => [m.name, m.url, m.partyId, hex(new Uint8Array(m.partialPk))])
      )
      expect(hex(mysten.KeyServerMoveV2.serialize(t).toBytes())).toBe(hex(bytes))
    }
    const value = v2()
    const ours = Bcs.encodeSync(KeyServer.KeyServerV2Bcs)(value)
    const theirs = mysten.KeyServerMoveV2.serialize({
      name: value.name,
      keyType: 0,
      pk: Array.from(PK),
      serverType: { Independent: { url: "https://v2.example" } }
    }).toBytes()
    expect(hex(ours)).toBe(hex(theirs))
    expect(mysten.KeyServerMoveV2.parse(ours).serverType.Independent.url).toBe("https://v2.example")
  })
})
