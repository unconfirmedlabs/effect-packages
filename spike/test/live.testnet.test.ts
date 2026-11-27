/**
 * Against a real testnet full node over gRPC-web. Opt in with SUI_LIVE=1.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as Bcs from "../src/bcs/Bcs.ts"
import { GrpcWeb } from "../src/grpc/GrpcWeb.ts"
import { SuiClient } from "../src/sui/SuiClient.ts"
import * as T from "../src/sui/Types.ts"
import * as Ptb from "../src/tx/Ptb.ts"
import * as Tx from "../src/tx/Tx.ts"

const live = process.env.SUI_LIVE === "1" ? describe : describe.skip
const BASE_URL = process.env.SUI_GRPC_URL ?? "https://fullnode.testnet.sui.io:443"

/** Counts HTTP requests, to prove batching. */
const makeLayer = () => {
  const requests: Array<string> = []
  const http = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(Effect.service(HttpClient.HttpClient), HttpClient.tapRequest((req) => Effect.sync(() => requests.push(req.url))))
  ).pipe(Layer.provide(FetchHttpClient.layer))
  const layer = SuiClient.layer.pipe(Layer.provide(GrpcWeb.layer({ baseUrl: BASE_URL })), Layer.provide(http))
  return { layer, requests }
}

const Clock = Bcs.struct({ id: Bcs.Address, timestampMs: Bcs.u64 })

live("testnet", () => {
  test("concurrent getObject calls coalesce into one BatchGetObjects", async () => {
    const { layer, requests } = makeLayer()
    const objects = await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* SuiClient
        return yield* Effect.forEach(["0x5", "0x6", "0x8", "0x6"].map(T.address), client.getObject, {
          concurrency: "unbounded"
        })
      }).pipe(Effect.provide(layer))
    )
    expect(objects.map((o) => o.type.split("::").slice(1).join("::"))).toEqual([
      "sui_system::SuiSystemState",
      "clock::Clock",
      "random::Random",
      "clock::Clock"
    ])
    expect(requests.filter((u) => u.endsWith("BatchGetObjects")).length).toBe(1)
    expect(requests.length).toBe(1)

    // The object contents decode with a BCS Schema.
    const clock = Bcs.decodeSync(Clock)(objects[1]!.contents)
    expect(clock.timestampMs > 1_700_000_000_000n).toBe(true)
  })

  test("a missing object is a typed ObjectNotFound", async () => {
    const { layer } = makeLayer()
    const error = await Effect.runPromise(
      Effect.flatMap(Effect.service(SuiClient), (c) => c.getObject(T.address("0xabcdef"))).pipe(Effect.flip, Effect.provide(layer))
    )
    expect(error._tag).toBe("ObjectNotFound")
  })

  test("build -> resolve -> simulate a read-only Move call, decode the return value", async () => {
    const { layer, requests } = makeLayer()
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* SuiClient
        const { draft } = yield* Ptb.build(
          Effect.gen(function*() {
            const clock = yield* Ptb.object("0x6")
            return yield* Ptb.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [clock] })
          })
        )
        const data = yield* Tx.resolve(draft, { sender: T.address("0x1"), gas: { budget: 50_000_000n } })
        const sim = yield* client.simulate(Tx.serialize(data), { checks: false })
        return { data, sim }
      }).pipe(Effect.provide(layer))
    )

    // `&Clock` in the function signature => the shared input was resolved as Immutable.
    const input = result.data.kind.inputs[0]!
    expect(input._tag === "Object" && input.value._tag === "SharedObject" && input.value.mutability._tag).toBe("Immutable")

    expect(result.sim.success).toBe(true)
    const ts = Bcs.decodeSync(Bcs.u64)(result.sim.returnValues[0]![0]!)
    expect(Number(ts)).toBeGreaterThan(Date.now() - 10 * 60_000)
    console.log("requests:", requests.map((u) => u.split("/").pop()))
  })

  test("checkpoints are a Stream", async () => {
    const { layer } = makeLayer()
    const cps = await Effect.runPromise(
      Effect.flatMap(Effect.service(SuiClient), (c) => c.checkpoints({ pageSize: 5 }).pipe(Stream.take(3), Stream.runCollect)).pipe(
        Effect.provide(layer)
      )
    )
    expect(cps.length).toBe(3)
    expect(cps[1]!.sequenceNumber).toBe(cps[0]!.sequenceNumber + 1n)
  })
})
