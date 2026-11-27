/**
 * Against a real full node over gRPC-web. Opt in with SUI_LIVE=1. Devnet execution
 * is covered by core-review.live, server-resolve.live and the address-balance and
 * allowance live tests.
 */
import { Bcs } from "@unconfirmed/bcs"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Address, Objects, Ptb, Transactions, Tx } from "../src/index.ts"
import { grpcLayer, live, TESTNET } from "./support.ts"

const suite = live ? describe : describe.skip
const Clock = Bcs.struct({ id: Bcs.Address, timestampMs: Bcs.u64 })

suite("testnet", () => {
  test("concurrent reads coalesce into one BatchGetObjects", async () => {
    const { layer, requests } = grpcLayer(TESTNET)
    const objs = await Effect.runPromise(
      Effect.gen(function*() {
        const objects = yield* Objects.Objects
        return yield* Effect.forEach(["0x5", "0x6", "0x8", "0x6"].map(Address.normalize), objects.get, { concurrency: "unbounded" })
      }).pipe(Effect.provide(layer))
    )
    expect(objs.map((o) => o.type.split("::").pop())).toEqual(["SuiSystemState", "Clock", "Random", "Clock"])
    expect(requests).toEqual(["BatchGetObjects"])
    const clock = await Effect.runPromise(Objects.decode(Clock)(objs[1]!))
    expect(clock.timestampMs > 1_700_000_000_000n).toBe(true)
  })

  test("missing objects are ObjectNotFound", async () => {
    const { layer } = grpcLayer(TESTNET)
    const e = await Effect.runPromise(Objects.getAs(Address.normalize("0xabcdef"), Clock).pipe(Effect.flip, Effect.provide(layer)))
    expect(e._tag).toBe("ObjectNotFound")
  })

  test("resolve infers &Clock as an immutable shared input; simulate returns the value", async () => {
    const { layer } = grpcLayer(TESTNET)
    const { data, sim } = await Effect.runPromise(
      Effect.gen(function*() {
        const data = yield* Tx.build(
          Effect.gen(function*() {
            return yield* Ptb.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [yield* Ptb.object("0x6")] })
          }),
          { sender: Address.normalize("0x1"), gasBudget: 50_000_000n }
        )
        const sim = yield* Effect.flatMap(Effect.service(Transactions.Transactions), (t) =>
          t.simulate(Tx.serialize(data), { checks: false }))
        return { data, sim }
      }).pipe(Effect.provide(layer))
    )
    const input = data.kind.inputs[0]!
    expect(input._tag === "Object" && input.value._tag === "SharedObject" && input.value.mutability._tag).toBe("Immutable")
    expect(sim.effects.status._tag).toBe("Success")
    expect(Number(Bcs.decodeSync(Bcs.u64)(sim.returnValues[0]![0]!))).toBeGreaterThan(Date.now() - 600_000)
  })
})
