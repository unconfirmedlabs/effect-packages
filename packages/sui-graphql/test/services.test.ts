/**
 * Offline: DynamicFields, Events (filter lowering, merging, paging) and
 * CheckpointData against a scripted `GraphQLProtocol`.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Stream } from "effect"
import { GraphQLClientError, GraphQLProtocol } from "effect/graphql"
import { Address, CheckpointData, DynamicFields, Events, Objects } from "@unconfirmed/sui"
import * as SuiGraphQL from "../src/index.ts"
import { eventCursorPosition } from "../src/convert.ts"
import { plan } from "../src/EventsGraphQL.ts"

const A = Address.normalize
type Request = GraphQLProtocol.GraphQLRequest

const scripted = (
  handler: (request: Request) => unknown,
  subscribe: (request: Request) => Stream.Stream<{ body: unknown }, GraphQLClientError.TransportError> = () => Stream.empty
) => {
  const requests: Array<Request> = []
  const layer = Layer.succeed(GraphQLProtocol.GraphQLProtocol, {
    execute: (request) =>
      Effect.sync(() => {
        requests.push(request)
        return { body: { data: handler(request) } }
      }),
    subscribe: (request) =>
      Stream.suspend(() => {
        requests.push(request)
        return subscribe(request)
      })
  })
  return { layer, requests }
}

const services = Layer.mergeAll(
  SuiGraphQL.EventsGraphQL.layer,
  SuiGraphQL.CheckpointDataGraphQL.layer,
  SuiGraphQL.DynamicFieldsGraphQL.layer.pipe(Layer.provideMerge(SuiGraphQL.ObjectsGraphQL.layer))
)

const run = <A, E>(
  effect: Effect.Effect<A, E, Events.Events | CheckpointData.CheckpointData | DynamicFields.DynamicFields | Objects.Objects>,
  protocol: Layer.Layer<GraphQLProtocol.GraphQLProtocol>
) => Effect.runPromise(effect.pipe(Effect.provide(services.pipe(Layer.provide(protocol)))))

/** A Sui-style event cursor: an opaque prefix, then checkpoint u64, transaction index u64, event index u32 (LE). */
const cursor = (checkpoint: number, tx: number, ev: number, withPosition = true) => {
  const bytes = new Uint8Array(withPosition ? 24 : 4)
  bytes.set([0, 1, 1, 18])
  if (withPosition) {
    const v = new DataView(bytes.buffer, 4)
    v.setBigUint64(0, BigInt(checkpoint), true)
    v.setBigUint64(8, BigInt(tx), true)
    v.setUint32(16, ev, true)
  }
  return btoa(String.fromCharCode(...bytes))
}

const eventNode = (checkpoint: number, digest: string, ev: number, extra: { type?: string; sender?: string; module?: string } = {}) => ({
  sequenceNumber: ev,
  sender: { address: extra.sender ?? "0x1" },
  transactionModule: { package: { address: "0x2" }, name: extra.module ?? "coin" },
  contents: { type: { repr: extra.type ?? "0x2::coin::CoinCreated<0x2::sui::SUI>" }, bcs: "AQ==" },
  transaction: { digest, effects: { checkpoint: { sequenceNumber: checkpoint } } }
})

const page = (edges: Array<unknown>, next: { end?: string; start?: string } = {}) => ({
  events: {
    pageInfo: {
      hasNextPage: next.end !== undefined,
      endCursor: next.end ?? null,
      hasPreviousPage: next.start !== undefined,
      startCursor: next.start ?? null
    },
    edges
  }
})

describe("event filter lowering", () => {
  const S = Events.sender(A("0x1"))
  const T = Events.eventType("0x2::coin::CoinCreated")
  const M = Events.emitModule("0x2::coin")

  test("one GraphQL filter per DNF term; the rest checked client-side", () => {
    const one = Result.getOrThrow(plan(Events.all(S, T, M)))
    expect(one).toEqual([{ server: { sender: A("0x1"), type: `${A("0x2")}::coin::CoinCreated` }, residual: [M] }])
    const neg = Result.getOrThrow(plan(Events.all(Events.not(S), M)))
    expect(neg).toEqual([{ server: { module: `${A("0x2")}::coin` }, residual: [Events.not(S)] }])
    const two = Result.getOrThrow(plan(Events.any(T, Events.all(M, S))))
    expect(two.map((p) => p.server)).toEqual([{ type: `${A("0x2")}::coin::CoinCreated` }, { sender: A("0x1"), module: `${A("0x2")}::coin` }])
    const types = Result.getOrThrow(plan(Events.all(T, Events.eventType("0x2::coin::CoinCreated<0x2::sui::SUI>"))))
    expect(types[0]!.residual.length).toBe(1)
  })

  test("empty any() matches nothing, empty all() everything, StreamHead is unsupported", () => {
    expect(Result.getOrThrow(plan(Events.any()))).toEqual([])
    expect(Result.getOrThrow(plan(Events.all()))).toEqual([{ server: {}, residual: [] }])
    expect(Result.isFailure(plan(Events.streamHead(A("0x9"))))).toBe(true)
    expect(Result.isFailure(plan(Events.any(T, Events.not(Events.streamHead(A("0x9"))))))).toBe(true)
  })

  test("event cursors carry the position", () => {
    expect(eventCursorPosition(cursor(5543, 7, 98))).toEqual({ checkpoint: 5543n, transactionIndex: 7n, eventIndex: 98 })
    expect(eventCursorPosition(cursor(1, 1, 1, false))).toBeUndefined()
  })
})

describe("Events.list", () => {
  test("OR terms run as separate queries, merged in ledger order and deduplicated", async () => {
    const { layer, requests } = scripted((req) => {
      if (req.operationName === "Tip") return { checkpoint: { sequenceNumber: 99 } }
      const f = (req.variables as any).filter
      // Term 1 (type): events at (10,0,0) and (12,1,0); term 2 (sender 0x7): (11,0,0) and (12,1,0).
      return f.type
        ? page([
          { cursor: cursor(10, 0, 0), node: eventNode(10, "D10", 0) },
          { cursor: cursor(12, 1, 0), node: eventNode(12, "D12", 0, { sender: "0x7" }) }
        ])
        : page([
          { cursor: cursor(11, 0, 0), node: eventNode(11, "D11", 0, { sender: "0x7", type: "0x5::x::Y" }) },
          { cursor: cursor(12, 1, 0), node: eventNode(12, "D12", 0, { sender: "0x7" }) }
        ])
    })
    const events = await run(
      Effect.flatMap(Effect.service(Events.Events), (e) =>
        e.list({ start: 10n, filter: Events.any(Events.eventType("0x2::coin::CoinCreated"), Events.sender(A("0x7"))) }).pipe(Stream.runCollect)),
      layer
    )
    expect(events.map((e) => [e.checkpoint, e.transactionIndex, e.transactionDigest])).toEqual([
      [10n, 0n, "D10"],
      [11n, 0n, "D11"],
      [12n, 1n, "D12"]
    ])
    const lists = requests.filter((r) => r.operationName === "ListEvents").map((r) => (r.variables as any).filter)
    expect(lists).toEqual([
      { type: `${A("0x2")}::coin::CoinCreated`, afterCheckpoint: 9, beforeCheckpoint: 100 },
      { sender: A("0x7"), afterCheckpoint: 9, beforeCheckpoint: 100 }
    ])
  })

  test("negations are applied client-side", async () => {
    const { layer } = scripted(() =>
      page([
        { cursor: cursor(10, 0, 0), node: eventNode(10, "D1", 0, { sender: "0x1" }) },
        { cursor: cursor(10, 1, 0), node: eventNode(10, "D2", 0, { sender: "0x2" }) }
      ])
    )
    const events = await run(
      Effect.flatMap(Effect.service(Events.Events), (e) =>
        e.list({ start: 10n, end: 11n, filter: Events.all(Events.emitModule("0x2::coin"), Events.not(Events.sender(A("0x1")))) }).pipe(
          Stream.runCollect
        )),
      layer
    )
    expect(events.map((e) => e.transactionDigest)).toEqual(["D2"])
  })

  test("descending pages backwards with last/before and reverses each page", async () => {
    const { layer, requests } = scripted((req) => {
      const before = (req.variables as any).before
      return before === null
        ? page([
          { cursor: cursor(11, 0, 0), node: eventNode(11, "B", 0) },
          { cursor: cursor(12, 0, 0), node: eventNode(12, "C", 0) }
        ], { start: "s1" })
        : page([{ cursor: cursor(10, 0, 0), node: eventNode(10, "A", 0) }])
    })
    const events = await run(
      Effect.flatMap(Effect.service(Events.Events), (e) => e.list({ start: 10n, end: 13n, descending: true }).pipe(Stream.runCollect)),
      layer
    )
    expect(events.map((e) => e.transactionDigest)).toEqual(["C", "B", "A"])
    expect(requests.map((r) => [(r.variables as any).last, (r.variables as any).before])).toEqual([[50, null], [50, "s1"]])
  })

  test("a cursor without a position falls back to the checkpoint's transaction order", async () => {
    const { layer, requests } = scripted((req) =>
      req.operationName === "CheckpointTransactionDigests"
        ? { checkpoint: { transactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ digest: "X" }, { digest: "D" }] } } }
        : page([{ cursor: cursor(0, 0, 0, false), node: eventNode(10, "D", 3) }])
    )
    const [e] = await run(
      Effect.flatMap(Effect.service(Events.Events), (e) => e.list({ start: 10n, end: 11n }).pipe(Stream.runCollect)),
      layer
    )
    expect([e!.checkpoint, e!.transactionIndex, e!.eventIndex]).toEqual([10n, 1n, 3])
    expect(requests.map((r) => r.operationName)).toEqual(["ListEvents", "CheckpointTransactionDigests"])
  })

  test("unsupported filters fail with INVALID_ARGUMENT; any() and start >= end send nothing", async () => {
    const { layer, requests } = scripted(() => {
      throw new Error("unexpected request")
    })
    const e = await run(
      Effect.flip(Effect.flatMap(Effect.service(Events.Events), (e) => e.list({ filter: Events.streamHead(A("0x9")) }).pipe(Stream.runCollect))),
      layer
    )
    expect(e).toMatchObject({ _tag: "RpcError", code: "INVALID_ARGUMENT" })
    const empty = await run(
      Effect.flatMap(Effect.service(Events.Events), (e) =>
        Effect.all([
          e.list({ filter: Events.any() }).pipe(Stream.runCollect),
          e.list({ start: 5n, end: 5n }).pipe(Stream.runCollect)
        ])),
      layer
    )
    expect(empty).toEqual([[], []])
    expect(requests.length).toBe(0)
  })
})

describe("Events.subscribe", () => {
  test("resumes from the last cursor and applies the residual filter", async () => {
    let attempt = 0
    const edge = (n: number, sender: string) => ({
      body: { data: { events: { cursor: cursor(n, 0, 0), node: eventNode(n, `D${n}`, 0, { sender }) } } }
    })
    const { layer, requests } = scripted(
      () => ({}),
      () => {
        attempt++
        return attempt === 1
          ? Stream.make(edge(1, "0x2"), edge(2, "0x1")).pipe(Stream.concat(Stream.fail(new GraphQLClientError.TransportError({ description: "dropped" }))))
          : Stream.make(edge(3, "0x2"))
      }
    )
    const got = await run(
      Effect.flatMap(Effect.service(Events.Events), (e) =>
        e.subscribe(Events.all(Events.emitModule("0x2::coin"), Events.not(Events.sender(A("0x1"))))).pipe(Stream.take(2), Stream.runCollect)),
      layer
    )
    expect(got.map((e) => e.checkpoint)).toEqual([1n, 3n])
    expect(requests.map((r) => r.variables)).toEqual([
      { filter: { module: `${A("0x2")}::coin` }, after: null },
      { filter: { module: `${A("0x2")}::coin` }, after: cursor(2, 0, 0) }
    ])
  })
})

describe("CheckpointData.get", () => {
  const change = (n: number) => ({
    address: `0x${n}`,
    idCreated: n === 1,
    idDeleted: false,
    inputState: n === 1 ? null : {
      version: 1,
      digest: "4DJfuRY7y2Y9gmatQMyXiMpLVy2awKFMxdSqgBkvmmig",
      owner: { __typename: "AddressOwner", address: { address: "0x9" } },
      asMoveObject: { contents: { type: { repr: "0x2::foo::Bar" } } },
      asMovePackage: null
    },
    outputState: {
      version: 2,
      digest: "4DJfuRY7y2Y9gmatQMyXiMpLVy2awKFMxdSqgBkvmmig",
      owner: { __typename: "AddressOwner", address: { address: "0x9" } },
      asMoveObject: { contents: { type: { repr: "0x2::foo::Bar" } } },
      asMovePackage: null
    }
  })
  const tx = (digest: string, moreEvents: boolean) => ({
    digest,
    effects: {
      digest,
      status: "SUCCESS",
      executionError: null,
      gasEffects: { gasSummary: { computationCost: 1, storageCost: 2, storageRebate: 0, nonRefundableStorageFee: 0 } },
      objectChanges: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [change(1), change(2)] },
      events: {
        pageInfo: { hasNextPage: moreEvents, endCursor: moreEvents ? "e1" : null },
        nodes: [{ ...eventNode(7, digest, 0), transaction: undefined }]
      }
    }
  })

  test("reads every transaction page and every event page, with positions filled in", async () => {
    const { layer, requests } = scripted((req) => {
      switch (req.operationName) {
        case "GetCheckpoint":
          return {
            checkpoint: {
              sequenceNumber: 7,
              digest: "CP7",
              timestamp: "2026-11-27T00:00:01.234Z",
              epoch: { epochId: 3 },
              transactions: { pageInfo: { hasNextPage: true, endCursor: "t1" }, nodes: [tx("T0", false)] }
            }
          }
        case "GetCheckpointTransactions":
          return { checkpoint: { transactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [tx("T1", true)] } } }
        case "GetTransactionEvents":
          return {
            transactionEffects: {
              events: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...eventNode(7, "T1", 1), transaction: undefined }] }
            }
          }
      }
      throw new Error(`unexpected ${req.operationName}`)
    })
    const cp = await run(Effect.flatMap(Effect.service(CheckpointData.CheckpointData), (c) => c.get(7n)), layer)
    expect([cp.sequenceNumber, cp.digest, cp.epoch, cp.timestampMs]).toEqual([7n, "CP7", 3n, BigInt(Date.parse("2026-11-27T00:00:01.234Z"))])
    expect(cp.transactions.map((t) => [t.digest, t.index, t.events.length])).toEqual([["T0", 0n, 1], ["T1", 1n, 2]])
    expect(cp.transactions[1]!.events.map((e) => [e.checkpoint, e.transactionIndex, e.eventIndex, e.transactionDigest])).toEqual([
      [7n, 1n, 0, "T1"],
      [7n, 1n, 1, "T1"]
    ])
    expect(cp.transactions[0]!.changedObjects[1]).toMatchObject({ inputVersion: 1n, inputOwner: { _tag: "AddressOwner", address: A("0x9") } })
    expect(cp.transactions[0]!.changedObjects[0]).toMatchObject({ operation: "Created", inputVersion: undefined })
    expect(requests.map((r) => r.operationName)).toEqual(["GetCheckpoint", "GetCheckpointTransactions", "GetTransactionEvents"])
  })

  test("a missing checkpoint is CheckpointNotFound", async () => {
    const { layer } = scripted(() => ({ checkpoint: null }))
    const e = await run(Effect.flip(Effect.flatMap(Effect.service(CheckpointData.CheckpointData), (c) => c.get(5n))), layer)
    expect(e).toEqual(new CheckpointData.CheckpointNotFound({ sequenceNumber: 5n }))
  })
})

describe("DynamicFields", () => {
  test("list maps values and object fields, filters the name type client-side", async () => {
    const { layer } = scripted(() => ({
      address: {
        dynamicFields: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { address: "0xa", name: { type: { repr: "u64" }, bcs: "AgAAAAAAAAA=" }, value: { __typename: "MoveValue", type: { repr: "0x3::s::Inner" }, bcs: "AQI=" } },
            {
              address: "0xb",
              name: { type: { repr: "0x1::string::String" }, bcs: "AWE=" },
              value: { __typename: "MoveObject", address: "0xc", contents: { type: { repr: "0x2::foo::Bar" } } }
            }
          ]
        }
      }
    }))
    const [all, strings] = await run(
      Effect.flatMap(Effect.service(DynamicFields.DynamicFields), (d) =>
        Effect.all([d.list(A("0x5")).pipe(Stream.runCollect), d.list(A("0x5"), { nameType: "0x1::string" }).pipe(Stream.runCollect)])),
      layer
    )
    expect(all.map((f) => [f.kind, f.fieldId, f.valueType, f.childId])).toEqual([
      ["Field", A("0xa"), `${A("0x3")}::s::Inner`, undefined],
      ["Object", A("0xb"), `${A("0x2")}::foo::Bar`, A("0xc")]
    ])
    expect([...all[1]!.value]).toEqual(Array.from({ length: 32 }, (_, i) => (i === 31 ? 0xc : 0)))
    expect(strings.map((f) => f.fieldId)).toEqual([A("0xb")])
  })

  test("get reads the derived id through the batched Objects.get; a missing field is DynamicFieldNotFound", async () => {
    const { layer, requests } = scripted(() => ({ multiGetObjects: [null] }))
    const name = { type: "u64", bcs: new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0]) }
    const e = await run(Effect.flip(Effect.flatMap(Effect.service(DynamicFields.DynamicFields), (d) => d.get(A("0x5"), name))), layer)
    const fieldId = DynamicFields.deriveId(A("0x5"), "u64", name.bcs)
    expect(e).toEqual(new DynamicFields.DynamicFieldNotFound({ parent: A("0x5"), nameType: "u64", fieldId }))
    expect((requests[0]!.variables as any).keys).toEqual([{ address: fieldId }])
    const bad = await run(
      Effect.flip(Effect.flatMap(Effect.service(DynamicFields.DynamicFields), (d) => d.get(A("0x5"), { type: "not a type<", bcs: name.bcs }))),
      layer
    )
    expect(bad._tag).toBe("InvalidDynamicFieldName")
  })
})
