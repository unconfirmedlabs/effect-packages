/**
 * Offline: dynamic field and derived object ids (parity with @mysten/sui),
 * address alias reads, event filters and decoding, `Transactions.waitFor`,
 * `CheckpointData.follow`.
 */
import { bcs as mysten } from "@mysten/sui/bcs"
import { deriveDynamicFieldID, deriveObjectID } from "@mysten/sui/utils"
import { base58 } from "@scure/base"
import { Bcs } from "@unconfirmed/bcs"
import { describe, expect, test } from "bun:test"
import { Effect, Schedule, Stream } from "effect"
import { Address, AddressAlias, CheckpointData, DynamicFields, Ed25519, Events, Objects, Transactions, TypeTag } from "../src/index.ts"

const A = Address.normalize

describe("DynamicFields.deriveId", () => {
  const parent = A("0x5a1e")
  test("matches deriveDynamicFieldID for primitive, vector, generic and object-field name types", () => {
    const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
      ["u64", mysten.u64().serialize(42n).toBytes()],
      ["vector<u8>", mysten.vector(mysten.u8()).serialize([1, 2, 3]).toBytes()],
      ["0x2::coin::Coin<0x2::sui::SUI>", new Uint8Array(40).fill(3)],
      ["0xdee9::custodian::Account<0x2::sui::SUI, 0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN>", new Uint8Array(32).fill(9)]
    ]
    for (const [type, key] of cases) {
      expect(DynamicFields.deriveId(parent, type, key)).toBe(deriveDynamicFieldID(parent, type, key) as Address.Address)
    }
    const key = mysten.u64().serialize(1n).toBytes()
    expect(DynamicFields.deriveId(parent, DynamicFields.objectFieldNameType("u64"), key)).toBe(
      deriveDynamicFieldID(parent, "0x2::dynamic_object_field::Wrapper<u64>", key) as Address.Address
    )
  })

  test("a malformed name type is InvalidDynamicFieldName, not a defect", async () => {
    const fake = DynamicFields.DynamicFields.of({
      get: () => Effect.die("unreachable"),
      getObject: () => Effect.die("unreachable"),
      list: () => Stream.empty
    })
    const e = await Effect.runPromise(
      DynamicFields.getWith(A("0x1"), "u64", Bcs.u8, 1000 as any).pipe(
        Effect.flip,
        Effect.provideService(DynamicFields.DynamicFields, fake)
      )
    )
    expect(e._tag).toBe("InvalidDynamicFieldName")
  })
})

describe("derived objects and address aliases", () => {
  // On testnet: 0x5004…'s AddressAliases is 0x0012…, holding 0x5004… and 0xb0e5….
  const owner = A("0x50044dc5ec176a977766842b2fbb939826c829dd9b322da8668037deb9aabc6e")
  const alias = A("0xb0e57cfc3f9f5f65f957f40eeb4e320541505ef488706e43fcfbaba7d0173248")
  const aliasesId = A("0x0012939da3025aa4e81584426e99c70a844a832c3097deabef093092cf177cd4")

  test("deriveObjectId matches deriveObjectID; an alias set's id matches the chain", () => {
    const key = mysten.u64().serialize(7n).toBytes()
    expect(DynamicFields.deriveObjectId(A("0x5a1e"), "u64", key)).toBe(deriveObjectID(A("0x5a1e"), "u64", key) as Address.Address)
    expect(AddressAlias.aliasesId(owner)).toBe(aliasesId)
  })

  test("AddressAlias.get decodes the set, an address without one is its own alias, checkedSigner refuses a key outside it", async () => {
    const contents = Bcs.encodeSync(AddressAlias.AddressAliases)({ id: aliasesId, aliases: { contents: [owner, alias] } })
    const objects = Objects.Objects.of({
      get: (id) =>
        id === aliasesId
          ? Effect.succeed({ objectId: id, version: 2n, digest: base58.encode(new Uint8Array(32)) as any, owner: { _tag: "ConsensusAddressOwner", startVersion: 1n, address: owner }, type: "0x2::address_alias::AddressAliases", contents, previousTransaction: undefined })
          : Effect.fail(new Objects.ObjectNotFound({ objectId: id })),
      listOwned: () => Stream.empty
    })
    const stranger = await Effect.runPromise(Ed25519.fromSecretKey(new Uint8Array(32).fill(5)))
    const [set, none, allowed, refused] = await Effect.runPromise(Effect.all([
      AddressAlias.get(owner),
      AddressAlias.get(alias),
      AddressAlias.allows(owner, alias),
      Effect.flip(AddressAlias.checkedSigner(owner, stranger))
    ]).pipe(Effect.provideService(Objects.Objects, objects)))
    expect(set).toEqual({ address: owner, enabled: true, aliases: [owner, alias], objectId: aliasesId })
    expect(none).toMatchObject({ enabled: false, aliases: [alias] })
    expect(allowed).toBe(true)
    expect(refused).toMatchObject({ _tag: "AliasNotAllowed", address: owner, signer: stranger.address })
  })
})

describe("Events", () => {
  test("filters lower to DNF", () => {
    const s = Events.sender(A("0x1"))
    const t = Events.eventType("0x2::coin::CoinCreated")
    const m = Events.emitModule("0x2::coin")
    const dnf = Events.toDnf(Events.all(Events.any(s, t), Events.not(m)))
    expect(dnf.map((term) => term.map((l) => `${l.negated ? "!" : ""}${l.predicate._tag}`))).toEqual([
      ["Sender", "!EmitModule"],
      ["EventType", "!EmitModule"]
    ])
  })

  test("type filters are padded (nodes reject 0x2)", () => {
    const p = (l: Events.Literal) => (l.predicate as { type?: string; module?: string })
    expect(p(Events.eventType("0x2::coin::CoinCreated<0x2::sui::SUI>")).type).toBe(
      `${A("0x2")}::coin::CoinCreated<${A("0x2")}::sui::SUI>`
    )
    expect(p(Events.eventType("0x2::kiosk")).type).toBe(`${A("0x2")}::kiosk`)
    expect(p(Events.emitModule("0x2")).module).toBe(A("0x2"))
    expect(p(Events.eventType("not a type")).type).toBe("not a type")
  })

  test("TypeTag.matchesPath matches whole path segments only", () => {
    const { matchesPath } = TypeTag
    const coin = "0x2::coin::Coin<0x2::sui::SUI>"
    expect([matchesPath("0x2", coin), matchesPath("0x2::coin::Coin", coin), matchesPath(coin, coin)]).toEqual([true, true, true])
    expect([matchesPath("0x2::co", coin), matchesPath("0x2::coin::Co", coin), matchesPath("0x2::coin::Coin<u8>", coin)]).toEqual([false, false, false])
  })

  test("decode with a BCS schema; bad bytes are EventDecodeError", async () => {
    const Ev = Bcs.struct({ id: Bcs.Address, value: Bcs.u64 })
    const contents = mysten.struct("E", { id: mysten.Address, value: mysten.u64() }).serialize({ id: A("0x7"), value: 5n }).toBytes()
    const base: Events.Event = {
      type: "0x2::x::E",
      sender: A("0x1"),
      packageId: A("0x2"),
      module: "x",
      contents,
      transactionDigest: "d",
      checkpoint: 1n,
      transactionIndex: 0n,
      eventIndex: 0
    }
    expect(await Effect.runPromise(Events.decode(Ev)(base))).toEqual({ id: A("0x7"), value: 5n })
    const e = await Effect.runPromise(Events.decode(Ev)({ ...base, contents: contents.subarray(1) }).pipe(Effect.flip))
    expect(e._tag).toBe("EventDecodeError")
  })
})

describe("Transactions.waitFor", () => {
  const effects = { digest: "D", status: { _tag: "Success" as const }, gasUsed: { computationCost: 0n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n }, changedObjects: [] }
  const txs = (get: Transactions.Transactions["Service"]["get"]) =>
    Transactions.Transactions.of({ simulate: () => Effect.die("no"), execute: () => Effect.die("no"), get })

  test("retries TransactionNotFound until visible", async () => {
    let calls = 0
    const svc = txs((digest) =>
      Effect.suspend(() => ++calls < 3 ? Effect.fail(new Transactions.TransactionNotFound({ digest })) : Effect.succeed(effects))
    )
    const r = await Effect.runPromise(
      Transactions.waitFor("D", { retry: Schedule.spaced("10 millis"), timeout: "5 seconds" }).pipe(Effect.provideService(Transactions.Transactions, svc))
    )
    expect(r.digest).toBe("D")
    expect(calls).toBe(3)
  })

  test("times out with a typed error", async () => {
    const svc = txs((digest) => Effect.fail(new Transactions.TransactionNotFound({ digest })))
    const e = await Effect.runPromise(
      Transactions.waitFor("D", { timeout: "300 millis" }).pipe(Effect.flip, Effect.provideService(Transactions.Transactions, svc))
    )
    expect(e._tag).toBe("TransactionWaitTimeout")
  })

  test("does not retry transport failures", async () => {
    let calls = 0
    const { RpcError } = await import("../src/RpcError.ts")
    const svc = txs(() => Effect.suspend(() => (calls++, Effect.fail(new RpcError({ method: "m", code: "UNAVAILABLE", message: "down" })))))
    const e = await Effect.runPromise(Transactions.waitFor("D").pipe(Effect.flip, Effect.provideService(Transactions.Transactions, svc)))
    expect(e._tag).toBe("RpcError")
    expect(calls).toBe(1)
  })
})

describe("CheckpointData.follow", () => {
  const cp = (n: number): CheckpointData.Checkpoint => ({ sequenceNumber: BigInt(n), digest: `c${n}`, epoch: 0n, timestampMs: 0n, transactions: [] })
  const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => cp(a + i))

  test("history, then live; fills the gap and drops overlap", async () => {
    let tip = 13 // the list index trails: first gap fill only reaches 13
    const listCalls: Array<string> = []
    const svc = CheckpointData.CheckpointData.of({
      get: () => Effect.die("no"),
      list: (o) =>
        Stream.suspend(() => {
          const start = Number(o?.start ?? 0n)
          const end = Math.min(o?.end === undefined ? tip : Number(o.end), tip)
          listCalls.push(`${start}-${end}`)
          tip += 2
          return Stream.fromIterable(range(start, end))
        }),
      // The subscription starts at 16 with an overlap re-delivery of 16.
      subscribe: Stream.fromIterable([cp(16), cp(16), cp(17), cp(18)])
    })
    const got = await Effect.runPromise(
      CheckpointData.follow(10n).pipe(Stream.take(9), Stream.runCollect, Effect.provideService(CheckpointData.CheckpointData, svc))
    )
    expect(got.map((c) => Number(c.sequenceNumber))).toEqual(range(10, 19).map((c) => Number(c.sequenceNumber)))
    expect(listCalls[0]).toBe("10-13")
  })
})
