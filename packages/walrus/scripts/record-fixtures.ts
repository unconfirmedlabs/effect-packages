/**
 * Record the chain objects `System` and `Committees` read (the system and
 * staking objects, their inner fields, every staking pool of the current and
 * previous committees) and the `reserve_space` signature, for testnet and
 * mainnet, into `test/fixtures/<network>.json`. Read-only.
 *
 *   bun packages/walrus/scripts/record-fixtures.ts
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Packages from "@unconfirmed/sui/Packages"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Committee from "../src/Committee.ts"
import * as Config from "../src/Config.ts"
import * as System from "../src/System.ts"
import { type Fixture, fixturesDir, type RecordedObject, recordObject } from "../test/fixtures.ts"

const networks = {
  testnet: { config: Config.testnet, url: "https://fullnode.testnet.sui.io:443" },
  mainnet: { config: Config.mainnet, url: "https://fullnode.mainnet.sui.io:443" }
} as const

for (const [network, { config, url }] of Object.entries(networks) as Array<[keyof typeof networks, (typeof networks)[keyof typeof networks]]>) {
  const objects = new Map<string, RecordedObject>()
  const functions: Record<string, Packages.MoveFunction> = {}

  // Wrap the real services so that every read is recorded.
  const recording = Layer.effect(
    Objects.Objects,
    Effect.map(Effect.service(Objects.Objects), (o) =>
      Objects.Objects.of({
        get: (id) => Effect.tap(o.get(id), (obj) => Effect.sync(() => objects.set(obj.objectId, recordObject(obj)))),
        listOwned: o.listOwned
      }))
  )
  const recordingPackages = Layer.effect(
    Packages.Packages,
    Effect.map(Effect.service(Packages.Packages), (p) =>
      Packages.Packages.of({
        getFunction: (t) =>
          Effect.tap(p.getFunction(t), (f) => Effect.sync(() => (functions[`${t.package}::${t.module}::${t.function}`] = f)))
      }))
  )
  const chain = SuiGrpc.layer({ url }).pipe(Layer.provide(FetchHttpClient.layer))
  const program = Effect.gen(function*() {
    const state = yield* System.load
    yield* System.loadWalType(state.packageId)
    const committees = yield* Committee.load()
    return { state, committees }
  }).pipe(
    Effect.provide(Layer.mergeAll(recording, recordingPackages).pipe(Layer.provide(chain), Layer.provideMerge(Config.layer(config))))
  )
  const { committees, state } = await Effect.runPromise(program)
  const fixture: Fixture = {
    network,
    recordedAt: new Date().toISOString(),
    config,
    objects: [...objects.values()].sort((a, b) => a.objectId.localeCompare(b.objectId)),
    functions
  }
  writeFileSync(join(fixturesDir, `${network}.json`), JSON.stringify(fixture, null, 1) + "\n")
  console.log(
    `${network}: epoch ${state.epoch}, ${committees.current.nodes.length} nodes, ${objects.size} objects, transitioning ${committees.transitioning}`
  )
}
