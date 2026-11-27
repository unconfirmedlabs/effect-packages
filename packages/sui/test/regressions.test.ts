/**
 * Offline regressions for the review round: each test failed before its fix.
 * gRPC layers run against a scripted `GrpcWeb` that records requests.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schedule, Stream } from "effect"
import * as ChainGrpc from "../src/grpc/ChainGrpc.ts"
import * as CheckpointsGrpc from "../src/grpc/CheckpointsGrpc.ts"
import * as CheckpointDataGrpc from "../src/grpc/CheckpointDataGrpc.ts"
import { effects as toEffects, object as toObject } from "../src/grpc/convert.ts"
import * as DynamicFieldsGrpc from "../src/grpc/DynamicFieldsGrpc.ts"
import * as EventsGrpc from "../src/grpc/EventsGrpc.ts"
import { GrpcWeb } from "../src/grpc/GrpcWeb.ts"
import * as PackagesGrpc from "../src/grpc/PackagesGrpc.ts"
import {
  Address,
  Chain,
  CheckpointData,
  Checkpoints,
  DynamicFields,
  Events,
  Objects,
  Packages,
  SignatureScheme,
  Transactions,
  Verify
} from "../src/index.ts"
import { RpcError } from "../src/RpcError.ts"

const A = Address.normalize
const short = (path: string) => path.split("/").pop()!

type Script = {
  unary?: (method: string, req: any, n: number) => Effect.Effect<any, RpcError>
  stream?: (method: string, req: any, n: number) => Stream.Stream<any, RpcError>
}

/** A scripted node: records every request; `n` counts calls per method. */
const fakeGrpc = (script: Script) => {
  const requests: Array<{ method: string; req: any }> = []
  const counts = new Map<string, number>()
  const tick = (m: string) => {
    const n = counts.get(m) ?? 0
    counts.set(m, n + 1)
    return n
  }
  const layer = Layer.succeed(GrpcWeb, GrpcWeb.of({
    unary: (method, req) =>
      Effect.suspend(() => {
        const m = short(method.path)
        requests.push({ method: m, req })
        return script.unary ? script.unary(m, req, tick(m)) : Effect.die(`unexpected ${m}`)
      }),
    serverStream: (method, req) =>
      Stream.suspend(() => {
        const m = short(method.path)
        requests.push({ method: m, req })
        return script.stream ? script.stream(m, req, tick(m)) : Stream.die(`unexpected ${m}`)
      })
  }))
  return { layer, requests }
}

const SERVICE_INFO = { checkpoint_height: 1000n, lowest_available_checkpoint: 400n, epoch: 7n, chain_id: "x" }
const unavailable = (m: string) => new RpcError({ method: m, code: "UNAVAILABLE", message: "blip" })
const ev = (cp: bigint, tx: bigint, i: number) => ({
  event: { event_type: "0x2::m::E", sender: "0x1", package_id: "0x2", module: "m", checkpoint: cp, transaction_digest: "d", transaction_index: tx, event_index: i, contents: { value: new Uint8Array([1]) } },
  watermark: { cursor: new Uint8Array([Number(cp % 256n), Number(tx), i]), cursor_position: { checkpoint: cp, transaction_index: tx, event_index: i + 1 } }
})
const ITEM_LIMIT = { reason: 1 }
const SCAN_LIMIT = { reason: 2 }
const TIP = { reason: 5 }

const runEvents = <A, E>(f: (e: Events.Events["Service"]) => Effect.Effect<A, E>, script: Script) => {
  const g = fakeGrpc(script)
  return Effect.runPromise(Effect.flatMap(Effect.service(Events.Events), f).pipe(
    Effect.provide(EventsGrpc.layer.pipe(Layer.provide(g.layer)))
  )).then((r) => ({ r, requests: g.requests }))
}

describe("Events.list (review A1-A5)", () => {
  test("A1: descending without start pins start at the pruning floor and ends cleanly once the floor passes the watermark", async () => {
    const { r, requests } = await runEvents((e) => e.list({ descending: true }).pipe(Stream.runCollect), {
      // The floor moves from 400 to 998 while the scan runs.
      unary: (_m, _req, n) => Effect.succeed(n === 0 ? SERVICE_INFO : { ...SERVICE_INFO, lowest_available_checkpoint: 998n }),
      stream: (_m, _req, n) =>
        n === 0
          ? Stream.make(ev(999n, 0n, 0), { ...ev(998n, 0n, 0), end: ITEM_LIMIT })
          : Stream.concat(Stream.make(ev(997n, 0n, 0)), Stream.fail(new RpcError({ method: "ListEvents", code: "OUT_OF_RANGE", message: "requested data below earliest available" })))
    })
    expect(r.map((e) => e.checkpoint)).toEqual([999n, 998n, 997n])
    const lists = requests.filter((x) => x.method === "ListEvents")
    expect(lists.every((x) => x.req.start_checkpoint === 400n)).toBe(true)
    expect(lists[1]!.req.options.before).toBeDefined()
  })

  test("A2/A3: every request asks for 1000 items; an open ascending scan pins end at the tip of the call", async () => {
    const { requests } = await runEvents((e) => e.list({ start: 500n }).pipe(Stream.runCollect), {
      unary: () => Effect.succeed(SERVICE_INFO),
      stream: (_m, _req, n) =>
        n === 0 ? Stream.make({ ...ev(500n, 0n, 0), end: ITEM_LIMIT }) : Stream.make({ watermark: ev(501n, 0n, 0).watermark, end: TIP })
    })
    const lists = requests.filter((x) => x.method === "ListEvents")
    expect(lists).toHaveLength(2)
    expect(lists.map((x) => x.req.options.limit)).toEqual([1000, 1000])
    expect(lists.map((x) => x.req.end_checkpoint)).toEqual([1001n, 1001n])
  })

  test("A4: an empty any() yields nothing without a request", async () => {
    const { r, requests } = await runEvents((e) => e.list({ filter: Events.any() }).pipe(Stream.runCollect), {})
    expect(r).toEqual([])
    expect(requests).toEqual([])
  })

  test("A5: a budget end without a cursor is DATA_LOSS, not a silent truncation", async () => {
    const { r } = await runEvents((e) => e.list({ start: 1n, end: 2n }).pipe(Stream.runCollect, Effect.flip), {
      stream: () => Stream.make({ event: ev(1n, 0n, 0).event, end: ITEM_LIMIT })
    })
    expect(r.code).toBe("DATA_LOSS")
  })

  test("A5: the same cursor twice without progress fails instead of looping", async () => {
    const stuck = { watermark: { cursor: new Uint8Array([9]) }, end: SCAN_LIMIT }
    const { r, requests } = await runEvents((e) => e.list({ start: 1n, end: 2n }).pipe(Stream.runCollect, Effect.flip), {
      stream: () => Stream.make(stuck)
    })
    expect(r.code).toBe("DATA_LOSS")
    expect(requests.length).toBe(2)
  })
})

describe("checkpoint scans (review A2/A3)", () => {
  test("Checkpoints.list and CheckpointData.list ask for 50 per call and pin the tip", async () => {
    const g = fakeGrpc({
      unary: () => Effect.succeed(SERVICE_INFO),
      stream: () => Stream.make({ checkpoint: { sequence_number: 999n, digest: "c" }, watermark: { cursor: new Uint8Array([1]), cursor_position: { checkpoint: 1000n } }, end: TIP })
    })
    await Effect.runPromise(Effect.gen(function*() {
      yield* Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.list({ start: 999n }).pipe(Stream.runCollect))
      yield* Effect.flatMap(Effect.service(CheckpointData.CheckpointData), (c) => c.list({ start: 999n }).pipe(Stream.runCollect))
    }).pipe(Effect.provide(Layer.mergeAll(CheckpointsGrpc.layer, CheckpointDataGrpc.layer).pipe(Layer.provide(g.layer)))))
    const lists = g.requests.filter((x) => x.method === "ListCheckpoints")
    expect(lists.map((x) => [x.req.options.limit, x.req.end_checkpoint])).toEqual([[50, 1001n], [50, 1001n]])
  })
})

describe("CheckpointData.follow (review A6)", () => {
  const cp = (n: number): CheckpointData.Checkpoint => ({ sequenceNumber: BigInt(n), digest: `c${n}`, epoch: 0n, timestampMs: 0n, transactions: [] })
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => cp(a + i))

  test("reconnects when the subscription closes cleanly", async () => {
    let subscriptions = 0
    const svc = CheckpointData.CheckpointData.of({
      get: () => Effect.die("no"),
      list: (o) => Stream.fromIterable(range(Number(o?.start ?? 0n), o?.end === undefined ? 3 : Number(o.end))),
      subscribe: Stream.suspend(() => {
        subscriptions++
        return subscriptions === 1 ? Stream.make(cp(3)) : Stream.make(cp(5), cp(6))
      })
    })
    const got = await Effect.runPromise(
      CheckpointData.follow(0n, { reconnectDelay: "1 millis" }).pipe(Stream.take(7), Stream.runCollect, Effect.provideService(CheckpointData.CheckpointData, svc))
    )
    expect(got.map((c) => Number(c.sequenceNumber))).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(subscriptions).toBe(2)
  })

  test("an unfillable gap is a typed CheckpointGap after the bounded retries", async () => {
    const svc = CheckpointData.CheckpointData.of({
      get: () => Effect.die("no"),
      list: (o) => Stream.fromIterable(o?.end === undefined ? range(0, 2) : []),
      subscribe: Stream.make(cp(10))
    })
    const e = await Effect.runPromise(
      CheckpointData.follow(0n, { gapRetry: "1 millis", gapAttempts: 3 }).pipe(Stream.runCollect, Effect.flip, Effect.provideService(CheckpointData.CheckpointData, svc))
    )
    expect(e._tag).toBe("CheckpointGap")
    expect(e._tag === "CheckpointGap" && [e.from, e.to]).toEqual([2n, 10n])
  })
})

describe("Transactions.waitFor (review A7)", () => {
  test("an exhausted schedule reports TransactionNotFound, not a timeout that never elapsed", async () => {
    const svc = Transactions.Transactions.of({
      simulate: () => Effect.die("no"),
      execute: () => Effect.die("no"),
      get: (digest) => Effect.fail(new Transactions.TransactionNotFound({ digest }))
    })
    const e = await Effect.runPromise(
      Transactions.waitFor("D", { schedule: Schedule.recurs(2), timeout: "10 seconds" }).pipe(Effect.flip, Effect.provideService(Transactions.Transactions, svc))
    )
    expect(e._tag).toBe("TransactionNotFound")
  })
})

describe("DynamicFieldsGrpc (review A8/A9)", () => {
  const objects = Layer.succeed(Objects.Objects, Objects.Objects.of({ get: () => Effect.die("no object reads expected"), listOwned: () => Stream.empty }))
  const run = <A, E>(f: (d: DynamicFields.DynamicFields["Service"]) => Effect.Effect<A, E>, script: Script) =>
    Effect.runPromise(Effect.flatMap(Effect.service(DynamicFields.DynamicFields), f).pipe(
      Effect.provide(DynamicFieldsGrpc.layer.pipe(Layer.provide(Layer.merge(fakeGrpc(script).layer, objects))))
    ))

  test("A8: a malformed name type is InvalidDynamicFieldName through the gRPC layer", async () => {
    for (const type of ["not a type", "0x2::m", "vector<u8", "0xzz::m::T"]) {
      const e = await run((d) => d.get(A("0x5"), { type, bcs: new Uint8Array([1]) }).pipe(Effect.flip), {})
      expect(e._tag).toBe("InvalidDynamicFieldName")
      const o = await run((d) => d.getObject(A("0x5"), { type, bcs: new Uint8Array([1]) }).pipe(Effect.flip), {})
      expect(o._tag).toBe("InvalidDynamicFieldName")
    }
  })

  test("A9: a listing entry without field_id is RpcError DATA_LOSS, not a defect", async () => {
    const e = await run((d) => d.list(A("0x5")).pipe(Stream.runCollect, Effect.flip), {
      unary: () => Effect.succeed({ dynamic_fields: [{ kind: 1, parent: "0x5", name: { name: "u64", value: new Uint8Array(8) } }] })
    })
    expect(e._tag === "RpcError" && e.code).toBe("DATA_LOSS")
  })
})

describe("evidence fields (review B10, 17)", () => {
  test("objects carry previousTransaction", () => {
    const o = toObject({ object_id: "0x1", version: 3n, digest: "D", owner: { kind: 4 }, object_type: "0x2::m::T", previous_transaction: "TX" })
    expect(o.previousTransaction).toBe("TX")
  })

  test("changed objects carry their input state; package writes are Immutable", () => {
    const fx = toEffects({
      digest: "T",
      effects: {
        status: { success: true },
        changed_objects: [
          { object_id: "0x9", input_state: 2, input_version: 4n, input_digest: "I", input_owner: { kind: 1, address: "0x1" }, output_state: 2, output_version: 5n, output_owner: { kind: 1, address: "0x2" }, id_operation: 1 },
          { object_id: "0xa", input_state: 1, output_state: 3, output_version: 1n, id_operation: 2 }
        ]
      }
    })
    const [mutated, pkg] = fx.changedObjects
    expect([mutated!.inputVersion, mutated!.inputDigest, mutated!.inputOwner]).toEqual([4n, "I" as any, { _tag: "AddressOwner", address: A("0x1") }])
    expect([pkg!.inputVersion, pkg!.inputOwner]).toEqual([undefined, undefined])
    expect(pkg!.owner).toEqual({ _tag: "Immutable" })
  })

  test("ChainInfo: an unreported floor is undefined (not 0n); the epoch's first checkpoint is reported", async () => {
    const g = fakeGrpc({
      unary: (m) =>
        Effect.succeed(m === "GetServiceInfo" ? { chain_id: "x", epoch: 7n, checkpoint_height: 10n } : { epoch: { epoch: 7n, first_checkpoint: 3n, reference_gas_price: 1000n } })
    })
    const info = await Effect.runPromise(Effect.flatMap(Effect.service(Chain.Chain), (c) => c.info).pipe(
      Effect.provide(ChainGrpc.layer.pipe(Layer.provide(g.layer)))
    ))
    expect(info.lowestAvailableCheckpoint).toBeUndefined()
    expect(info.epochFirstCheckpoint).toBe(3n)
  })
})

describe("success-only caches (review 16)", () => {
  test("Packages.getFunction: a transient failure is not cached; successes are", async () => {
    const g = fakeGrpc({
      unary: (_m, _req, n) => n === 0 ? Effect.fail(unavailable("GetFunction")) : Effect.succeed({ function: { is_entry: true, parameters: [] } })
    })
    const r = await Effect.runPromise(Effect.gen(function*() {
      const p = yield* Packages.Packages
      const target = { package: A("0x2"), module: "m", function: "f" }
      const first = yield* Effect.flip(p.getFunction(target))
      const second = yield* p.getFunction(target)
      const third = yield* p.getFunction(target)
      return { first, second, third }
    }).pipe(Effect.provide(PackagesGrpc.layer.pipe(Layer.provide(g.layer)))))
    expect(r.first.code).toBe("UNAVAILABLE")
    expect(r.second.isEntry).toBe(true)
    expect(r.third).toEqual(r.second)
    expect(g.requests).toHaveLength(2)
  })

  test("Chain.info and referenceGasPrice: a transient failure is not cached", async () => {
    let gasCalls = 0
    const g = fakeGrpc({
      unary: (m, _req, n) => {
        if (m === "GetServiceInfo") return n === 0 ? Effect.fail(unavailable(m)) : Effect.succeed(SERVICE_INFO)
        return gasCalls++ === 0
          ? Effect.fail(unavailable(m))
          : Effect.succeed({ epoch: { epoch: 7n, first_checkpoint: 1n, reference_gas_price: 750n } })
      }
    })
    const r = await Effect.runPromise(Effect.gen(function*() {
      const c = yield* Chain.Chain
      const g1 = yield* Effect.flip(c.referenceGasPrice)
      const g2 = yield* c.referenceGasPrice
      const e1 = yield* Effect.flip(c.info)
      const i2 = yield* c.info
      return { e1, i2, g1, g2 }
    }).pipe(Effect.provide(ChainGrpc.layer.pipe(Layer.provide(g.layer)))))
    expect(r.e1.code).toBe("UNAVAILABLE")
    expect(r.i2.lowestAvailableCheckpoint).toBe(400n)
    expect(r.g1.code).toBe("UNAVAILABLE")
    expect(r.g2).toBe(750n)
  })
})

describe("SignatureScheme (review 12, 15)", () => {
  const primary = A("0xaa")
  const legacy = A("0xbb")
  const scheme = (fail?: boolean): SignatureScheme.SignatureScheme => ({
    name: "Test",
    flag: 0x09,
    verify: () =>
      fail
        ? Effect.fail(new SignatureScheme.VerificationUnavailable({ scheme: "Test", reason: "node down", retryable: true }))
        : Effect.succeed({ flag: 0x09, bytes: new Uint8Array([1]) }),
    address: () => primary,
    addresses: () => [primary, legacy]
  })
  const sig = new Uint8Array([0x09, 0])
  const msg = new Uint8Array([1, 2, 3])
  const run = <A, E>(e: Effect.Effect<A, E, SignatureScheme.SignatureSchemes>, fail?: boolean) =>
    Effect.runPromise(e.pipe(Effect.provide(SignatureScheme.SignatureSchemes.layer(scheme(fail)))))

  test("12: an outage is VerificationUnavailable, typed and retryable", async () => {
    const e = await run(Effect.flip(Verify.personalMessage(msg, sig)), true)
    expect(e._tag).toBe("VerificationUnavailable")
    expect(e._tag === "VerificationUnavailable" && e.retryable).toBe(true)
  })

  test("15: an expected address from the scheme's `addresses` verifies; others still fail", async () => {
    const v = await run(Verify.personalMessage(msg, sig, { address: legacy }))
    expect(v.address).toBe(legacy)
    expect((await run(Verify.personalMessage(msg, sig))).address).toBe(primary)
    const e = await run(Effect.flip(Verify.personalMessage(msg, sig, { address: A("0xcc") })))
    expect(e._tag).toBe("InvalidSignature")
  })
})

describe("Packages.getFunction type arguments", () => {
  test("a closed generic datatype carries its type arguments; an open one does not", async () => {
    const WAL = `${A("0xa1")}::wal::WAL`
    const coin = (args: ReadonlyArray<object>) => ({ type: 10, type_name: `${A("0x2")}::coin::Coin`, type_parameter_instantiation: args })
    const g = fakeGrpc({
      unary: () =>
        Effect.succeed({
          function: {
            parameters: [
              { reference: 2, body: coin([{ type: 10, type_name: WAL }]) },
              { reference: 0, body: coin([{ type: 11, type_parameter: 0 }]) },
              {
                body: {
                  type: 10,
                  type_name: `${A("0x2")}::vec_map::VecMap`,
                  type_parameter_instantiation: [{ type: 1 }, { type: 9, type_parameter_instantiation: [{ type: 4 }] }]
                }
              },
              { body: { type: 6 } }
            ]
          }
        })
    })
    const f = await Effect.runPromise(
      Effect.flatMap(Effect.service(Packages.Packages), (p) => p.getFunction({ package: A("0x2"), module: "m", function: "f" })).pipe(
        Effect.provide(PackagesGrpc.layer.pipe(Layer.provide(g.layer)))
      )
    )
    expect(f.parameters).toEqual([
      { reference: "Mutable", typeName: `${A("0x2")}::coin::Coin`, typeArguments: [WAL] },
      { reference: "Value", typeName: `${A("0x2")}::coin::Coin` },
      { reference: "Value", typeName: `${A("0x2")}::vec_map::VecMap`, typeArguments: ["address", "vector<u16>"] },
      { reference: "Value", typeName: undefined }
    ])
  })
})
