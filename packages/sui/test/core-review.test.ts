/**
 * Offline regressions for the core review (docs/review/core.md CORE-1..25,
 * cross-cutting X-1, signers SIGN-12). Each test failed before its fix.
 */
import { base58 } from "@scure/base"
import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as ChainGrpc from "../src/grpc/ChainGrpc.ts"
import * as EventsGrpc from "../src/grpc/EventsGrpc.ts"
import * as Rpc from "../src/grpc/generated/rpc.ts"
import { GrpcWeb } from "../src/grpc/GrpcWeb.ts"
import * as ObjectsGrpc from "../src/grpc/ObjectsGrpc.ts"
import * as PackagesGrpc from "../src/grpc/PackagesGrpc.ts"
import * as TransactionsGrpc from "../src/grpc/TransactionsGrpc.ts"
import {
  Address,
  AddressAlias,
  Chain,
  Coins,
  Ed25519,
  Events,
  Move,
  Objects,
  Packages,
  Ptb,
  Signer,
  TransactionData as T,
  TransactionJson,
  Transactions,
  Tx,
  TypeTag
} from "../src/index.ts"
import { RpcError } from "../src/RpcError.ts"
import { type GrpcScript, fakeGrpc } from "./support.ts"

const A = Address.normalize
const D = (seed: number) => base58.encode(new Uint8Array(32).fill(seed)) as T.ObjectDigest
const sender = A("0x5e4d")
const recipient = A("0xcafe")
const CHAIN = D(9)

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (exit._tag !== "Failure") return undefined
  if (Cause.hasDies(exit.cause)) throw new Error(`defect: ${Cause.pretty(exit.cause)}`)
  return Cause.squash(exit.cause) as E
}

// -----------------------------------------------------------------------------
// gRPC-web framing (CORE-3, CORE-12, CORE-19, CORE-24, CORE-8)
// -----------------------------------------------------------------------------

const frame = (payload: Uint8Array, trailer = false) => {
  const out = new Uint8Array(5 + payload.length)
  out[0] = trailer ? 0x80 : 0
  new DataView(out.buffer).setUint32(1, payload.length, false)
  out.set(payload, 5)
  return out
}
const trailers = (status: number, message = "") =>
  frame(new TextEncoder().encode(`grpc-status: ${status}\r\ngrpc-message: ${message}\r\n`), true)
const concat = (...xs: Array<Uint8Array>) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0))
  let at = 0
  for (const x of xs) {
    out.set(x, at)
    at += x.length
  }
  return out
}
/** `SubscribeCheckpointsResponse { cursor: n }`. */
const subResp = (n: number) => new Uint8Array([0x08, n])
/** `GetServiceInfoResponse { chain_id }`. */
const infoResp = (s: string) => new Uint8Array([0x0a, s.length, ...new TextEncoder().encode(s)])

const httpLayer = (chunks: ReadonlyArray<Uint8Array>, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      let i = 0
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (i < chunks.length) c.enqueue(chunks[i++]!)
          else c.close()
        }
      })
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })))
    })
  )
const grpcOver = (chunks: ReadonlyArray<Uint8Array>, status?: number) =>
  GrpcWeb.layer({ url: "http://node" }).pipe(Layer.provide(httpLayer(chunks, status)))
const subscribe = Effect.flatMap(Effect.service(GrpcWeb), (g) =>
  g.serverStream(Rpc.SubscriptionService_SubscribeCheckpoints, {}).pipe(Stream.runCollect))
const serviceInfo = Effect.flatMap(Effect.service(GrpcWeb), (g) => g.unary(Rpc.LedgerService_GetServiceInfo, {}))

describe("gRPC-web framing", () => {
  test("CORE-3: a body without its trailers frame, or cut inside a frame, fails (retryable); it does not complete", async () => {
    for (const cut of [frame(subResp(2)), new Uint8Array([0, 0, 0, 0, 9, 1, 2])]) {
      const e = failureOf(await Effect.runPromiseExit(Effect.provide(subscribe, grpcOver([frame(subResp(1)), cut])))) as RpcError
      expect([e.code, e.retryable]).toEqual(["UNAVAILABLE", true])
    }
  })

  test("a complete stream, split at every byte, decodes in order", async () => {
    const body = concat(frame(subResp(1)), frame(subResp(2)), trailers(0))
    const chunks = Array.from(body, (b) => new Uint8Array([b]))
    const r = await Effect.runPromise(Effect.provide(subscribe, grpcOver(chunks)))
    expect(r.map((x) => x.cursor)).toEqual([1n, 2n])
  })

  test("CORE-24: a unary error status after the message is not dropped", async () => {
    const exit = await Effect.runPromiseExit(Effect.provide(serviceInfo, grpcOver([frame(infoResp("abc")), trailers(13, "boom")])))
    const e = failureOf(exit) as RpcError
    expect([e.code, e.message]).toEqual(["INTERNAL", "boom"])
    const ok = await Effect.runPromise(Effect.provide(serviceInfo, grpcOver([concat(frame(infoResp("abc")), trailers(0))])))
    expect(ok.chain_id).toBe("abc")
  })

  test("X-9: a unary call without an answer fails with a retryable DEADLINE_EXCEEDED; no trace headers by default", async () => {
    const seen: Array<Record<string, string>> = []
    const hanging = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        seen.push({ ...request.headers })
        return Effect.never
      })
    )
    const layer = GrpcWeb.layer({ url: "http://node", requestTimeout: "20 millis" }).pipe(Layer.provide(hanging))
    const e = failureOf(await Effect.runPromiseExit(Effect.provide(serviceInfo, layer))) as RpcError
    expect([e.code, e.retryable]).toEqual(["DEADLINE_EXCEEDED", true])
    expect(Object.keys(seen[0]!).some((k) => k === "traceparent" || k === "b3")).toBe(false)
  })

  test("CORE-19: HTTP failures map to gRPC codes", async () => {
    const codes: Array<string> = []
    for (const status of [400, 401, 403, 404, 429, 502, 418]) {
      codes.push((failureOf(await Effect.runPromiseExit(Effect.provide(serviceInfo, grpcOver([], status)))) as RpcError).code)
    }
    expect(codes).toEqual(["INTERNAL", "UNAUTHENTICATED", "PERMISSION_DENIED", "UNIMPLEMENTED", "UNAVAILABLE", "UNAVAILABLE", "UNKNOWN"])
  })

  test("CORE-8: a request that can't be encoded is INVALID_ARGUMENT, not a defect", async () => {
    const bad = Effect.flatMap(Effect.service(GrpcWeb), (g) =>
      g.unary(Rpc.LedgerService_GetCheckpoint, { checkpoint_id: { _tag: "sequence_number", value: -1n } }))
    expect((failureOf(await Effect.runPromiseExit(Effect.provide(bad, grpcOver([])))) as RpcError).code).toBe("INVALID_ARGUMENT")
  })

  test("CORE-12: an 8 MiB message in 16 KiB chunks reassembles in linear time", async () => {
    const size = 8 << 20
    const len: Array<number> = []
    for (let n = size; ; ) {
      const b = n & 0x7f
      n = Math.floor(n / 128)
      len.push(n > 0 ? b | 0x80 : b)
      if (n === 0) break
    }
    const msg = new Uint8Array(1 + len.length + size).fill(0x61)
    msg[0] = 0x42 // field 8 (`server`), length-delimited
    msg.set(len, 1)
    const body = concat(frame(msg), trailers(0))
    const chunks: Array<Uint8Array> = []
    for (let i = 0; i < body.length; i += 16384) chunks.push(body.subarray(i, i + 16384))
    const t = performance.now()
    const r = await Effect.runPromise(Effect.provide(serviceInfo, grpcOver(chunks)))
    expect(r.server?.length).toBe(size)
    expect(performance.now() - t).toBeLessThan(2000) // quadratic: ~10 s
  })
})

// -----------------------------------------------------------------------------
// Scripted GrpcWeb for the services
// -----------------------------------------------------------------------------

const SERVICE_INFO = { checkpoint_height: 1000n, lowest_available_checkpoint: 400n, epoch: 7n, chain_id: CHAIN }
const ev = (cp: bigint) => ({
  event: { event_type: "0x2::m::E", sender: "0x1", package_id: "0x2", module: "m", checkpoint: cp, transaction_digest: "d", transaction_index: 0n, event_index: 0, contents: { value: new Uint8Array([1]) } },
  watermark: { cursor: new Uint8Array([Number(cp % 256n)]), cursor_position: { checkpoint: cp, transaction_index: 0n, event_index: 0 } }
})
const outOfRange = new RpcError({ method: "ListEvents", code: "OUT_OF_RANGE", message: "requested data below earliest available" })
const listEvents = (options: Events.ListOptions, script: GrpcScript) => {
  const g = fakeGrpc(script)
  return Effect.runPromiseExit(
    Effect.flatMap(Effect.service(Events.Events), (e) => Stream.runCollect(e.list(options))).pipe(
      Effect.provide(EventsGrpc.layer.pipe(Layer.provide(g.layer)))
    )
  ).then((exit) => ({ exit, requests: g.requests }))
}

describe("ledger scans", () => {
  test("CORE-3: a list stream that ends without QueryEnd is DATA_LOSS, not a complete range", async () => {
    const { exit } = await listEvents({ start: 1n, end: 100n }, { stream: () => Stream.make(ev(1n), ev(2n)) })
    expect((failureOf(exit) as RpcError).code).toBe("DATA_LOSS")
  })

  test("X-1: OUT_OF_RANGE on the first request of a descending scan re-pins the floor and retries", async () => {
    const { exit, requests } = await listEvents({ descending: true }, {
      unary: (_m, _req, n) => Effect.succeed(n === 0 ? SERVICE_INFO : { ...SERVICE_INFO, lowest_available_checkpoint: 420n }),
      stream: (_m, _req, n) => n === 0 ? Stream.fail(outOfRange) : Stream.make(ev(999n), { ...ev(998n), end: { reason: 3 } })
    })
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.map((e) => e.checkpoint)).toEqual([999n, 998n])
    expect(requests.filter((r) => r.method === "ListEvents").map((r) => r.req.start_checkpoint)).toEqual([400n, 420n])
  })

  test("X-1: an OUT_OF_RANGE that persists without progress fails typed instead of returning nothing", async () => {
    const { exit } = await listEvents({ descending: true }, {
      unary: (_m, _req, n) => Effect.succeed({ ...SERVICE_INFO, lowest_available_checkpoint: 400n + BigInt(n) }),
      stream: () => Stream.fail(outOfRange)
    })
    expect((failureOf(exit) as RpcError).code).toBe("OUT_OF_RANGE")
  })

  test("X-1: an explicit start below the floor is a typed OUT_OF_RANGE", async () => {
    const { exit } = await listEvents({ descending: true, start: 1n }, { unary: () => Effect.succeed(SERVICE_INFO), stream: () => Stream.fail(outOfRange) })
    expect((failureOf(exit) as RpcError).code).toBe("OUT_OF_RANGE")
  })
})

// -----------------------------------------------------------------------------
// Objects and Transactions (CORE-5, CORE-6, CORE-8, CORE-11, CT-15)
// -----------------------------------------------------------------------------

const objectMsg = (id: string, kind = 4) => ({ object_id: id, version: 1n, digest: D(1), owner: { kind }, object_type: "0x2::m::T" })
const objectsWith = (result: (id: string) => any) => {
  const g = fakeGrpc({
    unary: (_m, req) => Effect.succeed({ objects: req.requests.map((r: any) => ({ result: result(r.object_id) })) })
  })
  return { layer: ObjectsGrpc.layer.pipe(Layer.provide(g.layer)), requests: g.requests }
}
const getObject = (id: string, layer: Layer.Layer<Objects.Objects>) =>
  Effect.runPromiseExit(Effect.flatMap(Effect.service(Objects.Objects), (o) => o.get(A(id))).pipe(Effect.provide(layer)))

describe("Objects over gRPC", () => {
  test("CORE-6: only NOT_FOUND is ObjectNotFound; another per-object status is that RpcError; a missing entry is DATA_LOSS", async () => {
    const { layer } = objectsWith((id) =>
      id === A("0x5") ? { _tag: "error", value: { code: 5, message: "gone" } } : { _tag: "error", value: { code: 13, message: "storage error" } })
    expect(failureOf(await getObject("0x5", layer))).toMatchObject({ _tag: "ObjectNotFound" })
    expect(failureOf(await getObject("0x6", layer))).toMatchObject({ _tag: "RpcError", code: "INTERNAL", message: "storage error" })
    const g = fakeGrpc({ unary: () => Effect.succeed({ objects: [] }) })
    const exit = await getObject("0x7", ObjectsGrpc.layer.pipe(Layer.provide(g.layer)))
    expect(failureOf(exit)).toMatchObject({ _tag: "RpcError", code: "DATA_LOSS" })
  })

  test("CORE-11: concurrent gets of one id share an entry in the batch", async () => {
    const { layer, requests } = objectsWith((id) => ({ _tag: "object", value: objectMsg(id) }))
    const ids = ["0x1", "0x2", "0x1", "0x2", "0x1"].map(A)
    const r = await Effect.runPromise(
      Effect.flatMap(Effect.service(Objects.Objects), (o) => Effect.forEach(ids, (id) => o.get(id), { concurrency: "unbounded" })).pipe(
        Effect.provide(layer)
      )
    )
    expect(r.map((o) => o.objectId)).toEqual(ids)
    expect(requests.map((x) => x.req.requests.length)).toEqual([2])
  })

  test("CORE-8: a malformed object in a listing is DATA_LOSS, not a defect", async () => {
    const g = fakeGrpc({ unary: () => Effect.succeed({ objects: [{ object_id: "0x1", owner: { kind: 4 } }] }) })
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Effect.service(Objects.Objects), (o) => Stream.runCollect(o.listOwned(sender))).pipe(
        Effect.provide(ObjectsGrpc.layer.pipe(Layer.provide(g.layer)))
      )
    )
    expect(failureOf(exit)).toMatchObject({ code: "DATA_LOSS" })
  })
})

describe("Transactions over gRPC", () => {
  const transactions = (response: any) =>
    TransactionsGrpc.layer.pipe(Layer.provide(fakeGrpc({ unary: () => Effect.succeed(response) }).layer))
  const execute = (response: any) =>
    Effect.runPromiseExit(
      Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.execute(new Uint8Array([1, 2, 3]), [])).pipe(
        Effect.provide(transactions(response))
      )
    )

  test("CORE-5/CT-15: an empty execute response is ExecutedEffectsIncomplete with the digest, not a Move failure", async () => {
    const e = failureOf(await execute({})) as Transactions.ExecutedEffectsIncomplete
    expect(e._tag).toBe("ExecutedEffectsIncomplete")
    expect(e.digest.length).toBeGreaterThan(30)
  })

  test("CORE-5: an unknown owner kind in effects converts to Unknown instead of dying", async () => {
    const exit = await execute({
      transaction: {
        digest: "dig",
        effects: { status: { success: true }, changed_objects: [{ object_id: "0x9", output_owner: { kind: 6 } }] }
      }
    })
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.changedObjects[0]!.owner).toEqual({ _tag: "Unknown", kind: 6 })
  })

  test("CORE-18: a Move abort carries its location", async () => {
    const exit = await execute({
      transaction: {
        digest: "dig",
        effects: {
          status: {
            success: false,
            error: {
              description: "MoveAbort",
              command: 1n,
              error_details: { _tag: "abort", value: { abort_code: 7n, location: { package: "0x2", module: "coin", function_name: "split" } } }
            }
          }
        }
      }
    })
    if (exit._tag !== "Success") throw new Error("expected success")
    expect(exit.value.status).toMatchObject({ _tag: "Failure", command: 1, abortCode: 7n, location: { package: A("0x2"), module: "coin", function: "split" } })
  })
})

// -----------------------------------------------------------------------------
// Caches (CORE-10, CORE-9)
// -----------------------------------------------------------------------------

describe("in-flight sharing", () => {
  test("CORE-10: five concurrent getFunction calls on a cold cache make one request", async () => {
    const g = fakeGrpc({ unary: () => Effect.as(Effect.sleep("10 millis"), { function: { is_entry: true, parameters: [] } }) })
    await Effect.runPromise(
      Effect.flatMap(Effect.service(Packages.Packages), (p) =>
        Effect.all(Array.from({ length: 5 }, () => p.getFunction({ package: A("0x2"), module: "m", function: "f" })), {
          concurrency: "unbounded"
        })).pipe(Effect.provide(PackagesGrpc.layer.pipe(Layer.provide(g.layer))))
    )
    expect(g.requests).toHaveLength(1)
  })

  test("CORE-9/10: concurrent Chain.info and referenceGasPrice readers share one request each", async () => {
    const g = fakeGrpc({
      unary: (m) =>
        Effect.as(
          Effect.sleep("10 millis"),
          m === "GetServiceInfo" ? SERVICE_INFO : { epoch: { reference_gas_price: 750n } }
        )
    })
    await Effect.runPromise(
      Effect.flatMap(Effect.service(Chain.Chain), (c) =>
        Effect.all([c.info, c.info, c.referenceGasPrice, c.referenceGasPrice], { concurrency: "unbounded" })).pipe(
          Effect.provide(ChainGrpc.layer.pipe(Layer.provide(g.layer)))
        )
    )
    expect(g.requests.map((r) => r.method).sort()).toEqual(["GetEpoch", "GetServiceInfo"])
  })

  test("CT-13: a missing reference_gas_price is UNAVAILABLE, not 1000", async () => {
    const g = fakeGrpc({ unary: () => Effect.succeed({ epoch: { epoch: 7n } }) })
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Effect.service(Chain.Chain), (c) => c.referenceGasPrice).pipe(Effect.provide(ChainGrpc.layer.pipe(Layer.provide(g.layer))))
    )
    expect(failureOf(exit)).toMatchObject({ code: "UNAVAILABLE" })
  })
})

// -----------------------------------------------------------------------------
// Resolve (CORE-1, CORE-2, CORE-8, CORE-9)
// -----------------------------------------------------------------------------

interface Wallet {
  readonly addressBalance: bigint
  readonly coins: ReadonlyArray<bigint>
}
const coinRef = (i: number) => ({ objectId: A(`0xc0${i}`), version: 1n, digest: D(i + 1) })
const coinsLayer = (w: Wallet, calls: Array<string> = []) =>
  Layer.succeed(Coins.Coins, {
    getBalance: (_owner, coinType = TypeTag.SUI) =>
      Effect.sync(() => {
        calls.push("getBalance")
        const cb = coinType === TypeTag.SUI ? w.coins.reduce((s, c) => s + c, 0n) : 0n
        const ab = coinType === TypeTag.SUI ? w.addressBalance : 0n
        return { coinType, total: ab + cb, addressBalance: ab, coinBalance: cb }
      }),
    list: () =>
      Stream.suspend(() => {
        calls.push("list")
        return Stream.fromIterable(w.coins.map((balance, i) => ({ ref: coinRef(i), coinType: TypeTag.SUI, balance })))
      })
  })
const chainLayer = (calls: Array<string> = []) =>
  Layer.succeed(Chain.Chain, {
    info: Effect.sync(() => {
      calls.push("info")
      return { chainId: CHAIN, chain: "test", epoch: 812n, checkpointHeight: 1n }
    }),
    referenceGasPrice: Effect.sync(() => {
      calls.push("price")
      return 1000n
    })
  })
const noObjects = Layer.mergeAll(
  Layer.succeed(Objects.Objects, { get: (id) => Effect.fail(new Objects.ObjectNotFound({ objectId: id })), listOwned: () => Stream.empty }),
  Layer.succeed(Packages.Packages, { getFunction: () => Effect.die("unused") })
)
const budgetOf = (budget: bigint, calls: Array<string> = []) =>
  Layer.succeed(Transactions.Transactions, {
    simulate: () =>
      Effect.sync(() => {
        calls.push("simulate")
        return {
          effects: {
            digest: "x",
            status: { _tag: "Success" as const },
            gasUsed: { computationCost: budget - 1_000_000n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n },
            changedObjects: []
          },
          returnValues: []
        }
      }),
    execute: () => Effect.die("unused"),
    get: () => Effect.die("unused")
  })

const SUI = 1_000_000_000n
const pay8Sui = Effect.gen(function*() {
  const c = yield* Ptb.coin({ amount: 8n * SUI })
  yield* Ptb.transferObjects([c], yield* Ptb.address(recipient))
})

describe("gas payment (CORE-1)", () => {
  const build = (w: Wallet, recipe: Effect.Effect<unknown, Ptb.InvalidPureValue, Ptb.PtbBuilder>, calls: Array<string> = []) =>
    Effect.runPromiseExit(
      Tx.build(recipe, { sender }).pipe(Effect.provide(Layer.mergeAll(coinsLayer(w, calls), chainLayer(calls), noObjects, budgetOf(2_000_000n, calls))))
    )

  test("the devnet case: 8 SUI from the gas coin with coins of 6 + 3.998 SUI pays with both coins", async () => {
    const exit = await build({ addressBalance: 0n, coins: [6n * SUI, 3_998_000_000n] }, pay8Sui)
    if (exit._tag !== "Success") throw new Error(String(failureOf(exit)))
    expect(exit.value.gasData.payment.map((r) => r.objectId)).toEqual([coinRef(0).objectId, coinRef(1).objectId])
  })

  test("more than the wallet holds is InsufficientBalance before signing", async () => {
    const exit = await build({ addressBalance: 0n, coins: [1n * SUI] }, pay8Sui)
    expect(failureOf(exit)).toMatchObject({ _tag: "InsufficientBalance", required: 8n * SUI, available: 1n * SUI })
  })

  test("splitCoins(gas) beyond coins + budget is InsufficientGas, counting the split", async () => {
    const split = Effect.gen(function*() {
      const [c] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(5n * SUI)])
      yield* Ptb.transferObjects([c!], yield* Ptb.address(recipient))
    })
    const exit = await build({ addressBalance: 0n, coins: [5n * SUI] }, split)
    expect(failureOf(exit)).toMatchObject({ _tag: "InsufficientGas", required: 5n * SUI + 2_000_000n, available: 5n * SUI })
  })

  test("CORE-9: the SUI balance is read once, and price/info/balance/coins in one phase before the dry run", async () => {
    const calls: Array<string> = []
    const exit = await build({ addressBalance: 0n, coins: [6n * SUI, 3_998_000_000n] }, pay8Sui, calls)
    expect(exit._tag).toBe("Success")
    expect(calls.filter((c) => c === "getBalance")).toHaveLength(1)
    expect(calls.filter((c) => c === "list")).toHaveLength(1)
    expect(calls.indexOf("simulate")).toBe(calls.length - 1)
  })
})

describe("typed failures in place of defects (CORE-7, CORE-8, CT-21)", () => {
  const recipe = <E>(r: Effect.Effect<unknown, E, Ptb.PtbBuilder>) => Effect.runPromiseExit(Ptb.build(r))

  test("builders given a bad address or type are InvalidPureValue, not a throw", async () => {
    const bad: ReadonlyArray<Effect.Effect<unknown, unknown, Ptb.PtbBuilder>> = [
      Ptb.address("nope"),
      Ptb.object("nope"),
      Ptb.moveCall({ target: "0x2::m::f", typeArguments: ["0x2::sui"] }),
      Ptb.coin({ type: "SUI", amount: 1n }),
      Move.obj("nope"),
      Move.param("0x2::sui", 1n),
      Ptb.receiving({ objectId: "0x1", version: 1n, digest: "0OIl" }),
      Move.obj({ objectId: "0x1", version: -1n, digest: D(1) })
    ]
    for (const r of bad) expect(failureOf(await recipe(r))).toMatchObject({ _tag: "InvalidPureValue" })
  })

  const layers = Layer.mergeAll(coinsLayer({ addressBalance: 10n * SUI, coins: [] }), chainLayer(), noObjects, budgetOf(2_000_000n))

  test("Ptb.nested(intent, 1) is InvalidBalanceIntent", async () => {
    const r = Effect.gen(function*() {
      const c = yield* Ptb.coin({ amount: 1n })
      yield* Ptb.transferObjects([Ptb.nested(c, 1)], yield* Ptb.address(recipient))
    })
    const exit = await Effect.runPromiseExit(Tx.build(r, { sender }).pipe(Effect.provide(layers)))
    expect(failureOf(exit)).toMatchObject({ _tag: "InvalidBalanceIntent" })
  })

  test("an invalid sender is InvalidTransaction", async () => {
    const r = Effect.flatMap(Ptb.address(recipient), (to) => Ptb.transferObjects([Ptb.gas], to))
    const exit = await Effect.runPromiseExit(Tx.build(r, { sender: "0x2" as Address.Address }).pipe(Effect.provide(layers)))
    expect(failureOf(exit)).toMatchObject({ _tag: "InvalidTransaction" })
  })

  test("CORE-2: InsufficientGas is in the default pipeline's error type", () => {
    const r = Effect.flatMap(Ptb.address(recipient), (to) => Ptb.transferObjects([Ptb.gas], to))
    const run = Tx.run(r, { signer: { address: sender } as Signer.Signer })
    // Compiles only if InsufficientGas is in the error type.
    Effect.catchTag(run, "InsufficientGas", (e) => Effect.succeed(e.required))
    const check: Extract<Effect.Error<typeof run>, { _tag: "InsufficientGas" }> extends never ? false : true = true
    const viaJson = TransactionJson.resolve({ sender, draft: { inputs: [], commands: [] } })
    const checkJson: Extract<Effect.Error<typeof viaJson>, { _tag: "InsufficientGas" }> extends never ? false : true = true
    expect([check, checkJson]).toEqual([true, true])
  })
})

// -----------------------------------------------------------------------------
// Builders (CORE-13, CORE-14, CORE-22)
// -----------------------------------------------------------------------------

describe("builders", () => {
  test("CORE-14: a repeat Ptb.object with mutable: true widens a forced-immutable input", async () => {
    const { draft } = await Effect.runPromise(Ptb.build(Effect.gen(function*() {
      yield* Ptb.object("0x77", { mutable: false })
      yield* Ptb.object("0x77", { mutable: true })
    })))
    expect(draft.inputs).toEqual([{ _tag: "UnresolvedObject", objectId: A("0x77"), mutable: true }])
  })

  test("CORE-14: Ptb.objectArg and Ptb.object of one id share an input", async () => {
    const ref = { objectId: A("0x78"), version: 3n, digest: D(3) }
    const { draft, value } = await Effect.runPromise(Ptb.build(Effect.all([Ptb.objectArg({ _tag: "ImmOrOwnedObject", ...ref }), Ptb.object("0x78")])))
    expect(draft.inputs).toHaveLength(1)
    expect(value[0]).toEqual(value[1])
  })

  test("Ptb.memo runs a step once per build, concurrent uses included, and again in the next build", async () => {
    const register = Ptb.memo("register", Ptb.moveCall({ target: "0x2::m::register" }))
    const recipe = Effect.all([register, register, register], { concurrency: "unbounded" })
    const [first, second] = await Effect.runPromise(Effect.all([Ptb.build(recipe), Ptb.build(recipe)]))
    expect([first.draft.commands.length, second.draft.commands.length]).toEqual([1, 1])
    expect(first.value).toEqual([first.value[0], first.value[0], first.value[0]])
  })

  test("CORE-22: Move.datatype and Move.withGet don't modify the schema they are given", () => {
    const shared = Move.Table
    const type = Move.type("0x2", "my::Thing")
    const typed = Move.datatype(type, () => shared)
    Move.withGet(type, shared)
    expect(Effect.runSync(typed.type())).toBe(`${A("0x2")}::my::Thing`)
    expect("type" in shared || "get" in shared).toBe(false)
  })

  test("CORE-13: an expiration with both Validity and ValidDuring is refused", async () => {
    const fields = { minEpoch: "1", maxEpoch: "2", minTimestamp: null, maxTimestamp: null, chain: CHAIN, nonce: 1 }
    const json = {
      version: 2,
      sender,
      expiration: { Validity: { ...fields, maxEpoch: "999", allowedProposers: null }, ValidDuring: fields },
      gasData: { budget: null, price: null, owner: null, payment: null },
      inputs: [],
      commands: []
    }
    const exit = await Effect.runPromiseExit(TransactionJson.decode(JSON.stringify(json)))
    expect(failureOf(exit)).toMatchObject({ _tag: "InvalidTransactionJson" })
  })
})

// -----------------------------------------------------------------------------
// SIGN-12 / CORE-17: a key sender never signs an expiration it didn't see
// -----------------------------------------------------------------------------

describe("transaction signers (SIGN-12)", () => {
  const sponsor = A("0x5905")
  const base = (key: Signer.Signer): T.TransactionData => ({
    _tag: "V1",
    kind: { _tag: "ProgrammableTransaction", inputs: [], commands: [] },
    sender: key.address,
    gasData: { payment: [coinRef(0)], owner: sponsor, price: 1000n, budget: 5_000_000n },
    expiration: { _tag: "Epoch", value: 10n }
  })
  const wallet = (change: (d: T.TransactionData) => T.TransactionData): Signer.TransactionSigner => ({
    address: sponsor,
    signTransaction: (data) => Effect.succeed({ bytes: T.encode(change(data)), signature: new Uint8Array(97) })
  })
  const submitted: Array<Uint8Array> = []
  const node = Layer.succeed(Transactions.Transactions, {
    simulate: () => Effect.die("unused"),
    execute: (bytes) =>
      Effect.sync(() => {
        submitted.push(bytes)
        return { digest: "d", status: { _tag: "Success" as const }, gasUsed: { computationCost: 0n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n }, changedObjects: [] }
      }),
    get: () => Effect.die("unused")
  })
  const execute = (change: (d: T.TransactionData) => T.TransactionData) =>
    Effect.runPromiseExit(Effect.gen(function*() {
      const key = yield* Ed25519.fromSecretKey(new Uint8Array(32).fill(3))
      return yield* Tx.execute(base(key), [key, wallet(change)])
    }).pipe(Effect.provide(node)))

  test("a wallet sponsor that drops the sender's expiration is refused", async () => {
    submitted.length = 0
    const exit = await execute((d) => ({ ...d, expiration: { _tag: "None" } }))
    expect(failureOf(exit)).toMatchObject({ _tag: "SigningError", reason: "failed" })
    expect(submitted).toHaveLength(0)
  })

  test("a key that is neither sender nor gas owner is SignerMismatch before signing; as an alias signer it signs", async () => {
    submitted.length = 0
    const run = (wrap: (key: Signer.Signer, sender: Address.Address) => Signer.Signer) =>
      Effect.runPromiseExit(Effect.gen(function*() {
        const key = yield* Ed25519.fromSecretKey(new Uint8Array(32).fill(4))
        const sender = A("0xa11a5")
        return yield* Tx.execute({ ...base(key), sender }, [wrap(key, sender), wallet((d) => d)])
      }).pipe(Effect.provide(node)))
    expect(failureOf(await run((key) => key))).toMatchObject({ _tag: "SignerMismatch", signer: expect.any(String), sender: A("0xa11a5") })
    expect(submitted).toHaveLength(0)
    expect((await run((key, sender) => AddressAlias.signer(sender, key)))._tag).toBe("Success")
    expect(submitted).toHaveLength(1)
  })

  test("the wallet sponsor may still re-pick the gas terms it pays for", async () => {
    submitted.length = 0
    const exit = await execute((d) => ({ ...d, gasData: { ...d.gasData, budget: 6_000_000n } }))
    expect(exit._tag).toBe("Success")
    expect(submitted).toHaveLength(1)
  })
})
