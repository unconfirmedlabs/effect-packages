/**
 * Devnet, opt in with SUI_LIVE=1: publish the fixture with our SDK, point the
 * generated `Package` at it, call generated functions, read the objects back
 * with the generated schemas, and check that generating from the published
 * package over gRPC matches generating from the summaries.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Ed25519 from "@unconfirmed/effect-sui/Ed25519"
import { GrpcWeb } from "@unconfirmed/effect-sui/grpc/GrpcWeb"
import * as Rpc from "@unconfirmed/effect-sui/grpc/generated/rpc"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import * as Tx from "@unconfirmed/effect-sui/Tx"
import { spawnSync } from "node:child_process"
import { DEVNET, faucet, grpcLayer, live } from "@unconfirmed/test-support/live"
import * as FromGrpc from "../src/FromGrpc.ts"
import * as Generate from "../src/Generate.ts"
import * as M from "../src/Model.ts"
import * as Render from "../src/Render.ts"
import * as Summary from "../src/Summary.ts"
import * as fixture from "./golden/fixture/fixture/fixture.ts"
import { fixtureDir } from "./support.ts"

const suite = live ? describe : describe.skip

/** Drop what bytecode doesn't carry: parameter and type parameter names, doc comments. */
const bytecodeView = (packages: ReadonlyArray<M.Package>): ReadonlyArray<M.Package> =>
  packages.map((p) => ({
    ...p,
    modules: p.modules.map((m) => ({
      ...m,
      doc: undefined,
      datatypes: m.datatypes.map((d) => ({
        ...d,
        doc: undefined,
        typeParameters: d.typeParameters.map((t) => ({ ...t, name: undefined })),
        kind: d.kind._tag === "Struct"
          ? { ...d.kind, fields: d.kind.fields.map((f) => ({ ...f, doc: undefined })) }
          : { ...d.kind, variants: d.kind.variants.map((v) => ({ ...v, fields: v.fields.map((f) => ({ ...f, doc: undefined })) })) }
      })),
      functions: m.functions.map((f) => ({
        ...f,
        doc: undefined,
        typeParameters: f.typeParameters.map((t) => ({ ...t, name: undefined })),
        parameters: f.parameters.map((x) => ({ ...x, name: undefined }))
      }))
    }))
  }))

suite("devnet", () => {
  test("publish the fixture, call the generated builders, decode with the generated schemas", async () => {
    const build = spawnSync("sui", ["move", "build", "--dump-bytecode-as-base64"], { cwd: fixtureDir, encoding: "utf-8" })
    expect(build.status).toBe(0)
    const { modules, dependencies } = JSON.parse(build.stdout) as { modules: Array<string>; dependencies: Array<string> }
    const { layer } = grpcLayer(DEVNET)

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        yield* faucet(signer.address)

        // 1. Publish with our SDK, keep the UpgradeCap.
        const published = yield* Tx.run(
          Effect.gen(function*() {
            const cap = yield* Ptb.publish(modules.map((m) => new Uint8Array(Buffer.from(m, "base64"))), dependencies)
            yield* Ptb.transferObjects([cap], yield* Ptb.address(signer.address))
          }),
          { signer }
        )
        const pkg = published.changedObjects.find((o) => o.type === "package")!.objectId
        expect(published.changedObjects.some((o) => o.type?.endsWith("::package::UpgradeCap"))).toBe(true)

        // Wait until the node serves the new package.
        const grpc = yield* GrpcWeb
        yield* grpc.unary(Rpc.MovePackageService_GetFunction, { package_id: pkg, module_name: "fixture", name: "new_thing" }).pipe(
          Effect.retry({ while: (e) => e.code === "NOT_FOUND", schedule: Schedule.spaced("500 millis"), times: 40 })
        )

        // 2. Point the generated bindings at it.
        const deployment = Layer.mergeAll(Layer.succeed(fixture.Package, pkg), Layer.succeed(fixture.Origins, { originalId: pkg }))

        // 3. Call generated functions.
        const created = yield* Tx.run(
          Effect.gen(function*() {
            const [thing] = yield* fixture.newThing({
              arguments: { name: "first", label: "abc", tags: ["x", "y"], nums: [1n, 2n, 3n], maybe: 42n }
            })
            yield* fixture.rename({ arguments: [thing, "renamed"] })
            yield* fixture.score({ arguments: { thing, points: 7, ok: true } })
            const [count, createdMs, hasMaybe] = yield* fixture.stats({ arguments: [thing] })
            yield* fixture.allPure({
              arguments: [true, 1, 2, 3, 4n, 5n, 6n, "0x2", pkg, new Uint8Array([1]), [[1n]], ["a"], Option.some("b")]
            })
            yield* fixture.check({ arguments: [count] })
            void createdMs
            void hasMaybe
            yield* Ptb.transferObjects([thing], yield* Ptb.address(signer.address))
            yield* fixture.newVault()
            yield* fixture.touchSystem({ arguments: [9] })
          }),
          { signer }
        ).pipe(Effect.provide(deployment))
        const thingId = created.changedObjects.find((o) => o.operation === "Created" && o.type === `${pkg}::fixture::Thing`)!.objectId
        const vaultId = created.changedObjects.find((o) => o.operation === "Created" && o.type === `${pkg}::fixture::Vault`)!.objectId

        const before = yield* fixture.Thing.get(thingId).pipe(
          Effect.provide(deployment),
          Effect.retry({ while: (e) => e._tag === "ObjectNotFound", schedule: Schedule.spaced("500 millis"), times: 20 })
        )
        const vault = yield* fixture.Vault.get(vaultId).pipe(
          Effect.provide(deployment),
          Effect.retry({ while: (e) => e._tag === "ObjectNotFound", schedule: Schedule.spaced("500 millis"), times: 20 })
        )

        const marker = yield* fixture.Marker.type().pipe(Effect.provide(deployment))
        expect(marker).toBe(`${pkg}::fixture::Marker`)
        const updated = yield* Tx.run(
          Effect.gen(function*() {
            yield* fixture.pause({ arguments: [thingId, "maintenance", 99n] })
            const [pair] = yield* fixture.makePair({ arguments: [9, 10n], typeArguments: [marker, "u8", "u64"] })
            yield* fixture.setPair({ arguments: { thing: thingId, pair } })
            yield* fixture.roll({ arguments: { thing: thingId } }) // &Random: must come last
          }),
          { signer }
        ).pipe(Effect.provide(deployment))
        // Reads can trail execution by a moment: wait for the new version.
        const after = yield* fixture.Thing.get(thingId).pipe(
          Effect.provide(deployment),
          Effect.repeat({ until: (t) => t.status._tag === "Paused", schedule: Schedule.spaced("500 millis"), times: 20 })
        )

        // 4. Generate from the published package over gRPC.
        const onChain = yield* FromGrpc.load(pkg, { name: "fixture" })
        return { pkg, published, created, updated, before, after, vault, onChain, thingId }
      }).pipe(Effect.provide(GrpcWeb.layer({ url: DEVNET }).pipe(Layer.provideMerge(layer))))
    )

    const { pkg, before, after, vault, thingId } = result
    console.log("publish", result.published.digest, "package", pkg)
    console.log("calls", result.created.digest, result.updated.digest)

    expect(before.id).toBe(thingId)
    expect(before.owner_ref).toBe(thingId)
    expect(before.name).toBe("renamed")
    expect(before.label).toBe("abc")
    expect(before.tags).toEqual(["x", "y"])
    expect(before.nums).toEqual([1n, 2n, 3n])
    expect(before.maybe).toEqual(Option.some(42n))
    expect(before.pair).toEqual({ first: 7, second: 1_000_000_000_000n })
    expect(before.point).toEqual([3, 4])
    expect(before.status).toEqual({ _tag: "Scored", value: [7, true] })
    expect(before.created_ms > 1_700_000_000_000n).toBe(true)

    expect(after.status).toEqual({ _tag: "Paused", reason: "maintenance", until_ms: 99n })
    expect(after.pair).toEqual({ first: 9, second: 10n })
    expect(after.created_ms).not.toBe(before.created_ms) // rolled

    expect(vault.balance).toEqual({ value: 0n })
    expect(vault.ledger.size).toBe(0n)
    expect(vault.meta).toEqual({ contents: [] })
    expect(vault.kind.name).toBe(`${"0".repeat(63)}2::sui::SUI`)
    expect(vault.versioned.version).toBe(1n)

    // Same output from gRPC as from the (unpublished) summaries given the published id, apart from
    // what bytecode lacks: `packageId` reaches type strings, so the types match the chain's.
    const local = await Effect.runPromise(Summary.load(fixtureDir, { packageId: pkg }))
    const localPackage = Render.render(local.packages, [{ address: local.root }]).find((f) => f.path === "fixture/$package.ts")!
    expect(localPackage.contents).toContain(`originalId: "${pkg}"`)
    expect(result.created.changedObjects.some((o) => o.type === `${pkg}::fixture::Thing`)).toBe(true)
    const fromSummaries = Render.render(bytecodeView(local.packages), [{ address: local.root }], { docs: false })
    const fromGrpc = Render.render(result.onChain.packages, [{ address: result.onChain.root }], { docs: false })
    expect(fromGrpc.map((f) => f.path)).toEqual(fromSummaries.map((f) => f.path))
    for (let i = 0; i < fromGrpc.length; i++) expect(fromGrpc[i]!.contents).toBe(fromSummaries[i]!.contents)
  }, 180_000)

  test("an on-chain package from config: framework modules over gRPC", async () => {
    const files = await Effect.runPromise(
      Generate.files({ output: "unused", packages: [{ id: "0x2", url: DEVNET, modules: ["balance"] }] }).pipe(
        Effect.provide(FetchHttpClient.layer)
      )
    )
    expect(files.map((f) => f.path)).toEqual(["0x2/$package.ts", "0x2/balance.ts"])
    expect(files[1]!.contents).toContain("export const Supply = /* @__PURE__ */ Move.datatype(")
  }, 60_000)
})
