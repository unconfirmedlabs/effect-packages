/**
 * Golden output, the generated API's behaviour, and the CLI.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Ptb from "@unconfirmed/sui/Ptb"
import type * as T from "@unconfirmed/sui/TransactionData"
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as M from "../src/Model.ts"
import * as Render from "../src/Render.ts"
import * as Summary from "../src/Summary.ts"
import * as fixture from "./golden/fixture/fixture/fixture.ts"
import { fixtureDir, goldenDir, goldenRuns, renderGolden } from "./support.ts"

const files = (dir: string, prefix = ""): Array<string> =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir, join(prefix, e.name)) : [join(prefix, e.name)]
  ).sort()

describe("golden output", () => {
  for (const run of Object.keys(goldenRuns) as Array<keyof typeof goldenRuns>) {
    test(`${run} is up to date (bun packages/sui-codegen/scripts/fixtures.ts)`, async () => {
      const rendered = await Effect.runPromise(renderGolden(run))
      expect(rendered.map((f) => f.path).sort()).toEqual(files(join(goldenDir, run)))
      for (const f of rendered) expect(f.contents).toBe(readFileSync(join(goldenDir, run, f.path), "utf-8"))
    })
  }

  test("dependencies are pruned to what layouts reach; built-ins aren't regenerated", () => {
    expect(files(join(goldenDir, "fixture"))).toEqual(["deps/0x2/versioned.ts", "fixture/$package.ts", "fixture/fixture.ts"])
    expect(files(join(goldenDir, "framework"))).toEqual([
      "std/$package.ts",
      "std/option.ts",
      "sui/$package.ts",
      "sui/balance.ts",
      "sui/coin.ts"
    ])
  })

  test("generated modules import only effect, @unconfirmed/bcs, @unconfirmed/sui and each other, as namespaces", () => {
    for (const run of Object.keys(goldenRuns)) {
      for (const f of files(join(goldenDir, run))) {
        const imports = readFileSync(join(goldenDir, run, f), "utf-8").split("\n").filter((l) => l.startsWith("import "))
        for (const line of imports) {
          expect(line).toMatch(
            /^import (type )?(\* as \w+|\{ Package \}) from "(effect\/\w+|@unconfirmed\/bcs\/Bcs|@unconfirmed\/sui\/Move|\.{1,2}\/[\w/$.]+\.ts)"$/
          )
        }
      }
    }
  })

  test("public and entry functions are generated; public(package) and private ones aren't", () => {
    expect(typeof fixture.create).toBe("function") // private entry
    expect(typeof fixture.newThing).toBe("function")
    expect("internal" in fixture).toBe(false)
    expect("helper" in fixture).toBe(false)
  })

  test("top-level calls are marked pure", () => {
    const source = readFileSync(join(goldenDir, "fixture/fixture/fixture.ts"), "utf-8")
    for (const line of source.split("\n").filter((l) => /^export const \w+ = \w+\.\w+\(/.test(l))) {
      expect(line).toContain("/* @__PURE__ */")
    }
    expect(source.match(/^export const [A-Z]\w* = (?!\/\* @__PURE__ \*\/)/m)).toBeNull()
  })
})

describe("generated API", () => {
  const draft = <A, E>(recipe: Effect.Effect<A, E, Ptb.PtbBuilder>) =>
    Effect.runPromise(Ptb.build(recipe)).then(({ draft, value }) => ({ draft, value }))
  const call = (c: Ptb.Command) => {
    if (c._tag !== "MoveCall") throw new Error("not a move call")
    return c
  }

  test("calls go to the Package reference: default, or provided", async () => {
    const { draft: d1 } = await draft(fixture.newVault())
    expect(call(d1.commands[0]!).package).toBe(Address.normalize("0x0"))
    const id = Address.normalize("0xabc")
    const { draft: d2 } = await draft(fixture.newVault().pipe(Effect.provideService(fixture.Package, id)))
    expect(call(d2.commands[0]!).package).toBe(id)
    const { draft: d3 } = await Effect.runPromise(
      Ptb.build(fixture.newVault()).pipe(Effect.provide(Layer.succeed(fixture.Package, id)))
    )
    expect(call(d3.commands[0]!).package).toBe(id)
  })

  test("results are a tuple as long as the Move return list", async () => {
    const { value } = await draft(Effect.gen(function*() {
      const none = yield* fixture.check({ arguments: [1n] })
      const one = yield* fixture.name({ arguments: ["0x1"] })
      const three = yield* fixture.stats({ arguments: ["0x1"] })
      return [none, one, three] as const
    }))
    expect(value.map((r) => r.length)).toEqual([0, 1, 3])
    const nested: T.Argument = { _tag: "NestedResult", value: [2, 2] }
    expect(value[2][2]).toEqual(nested)
  })

  test("Option parameters take an Option, a bare value or undefined", async () => {
    const { draft: d } = await draft(Effect.gen(function*() {
      yield* fixture.wrap({ arguments: ["0x1", Option.some(3)] })
      yield* fixture.wrap({ arguments: ["0x1", 3] })
      yield* fixture.wrap({ arguments: ["0x1", undefined] })
      yield* fixture.wrap({ arguments: { thing: "0x1" } })
    }))
    const pures = d.inputs.flatMap((i) => (i._tag === "Pure" ? [Array.from(i.bytes)] : []))
    expect(pures).toEqual([[1, 3], [1, 3], [0], [0]])
  })

  test("generic parameters are encoded by their type argument", async () => {
    const { draft: d } = await draft(fixture.makePair({ arguments: [7, "0x2"], typeArguments: ["0x2::sui::SUI", "u8", "address"] }))
    expect(d.inputs[0]).toEqual({ _tag: "Pure", bytes: new Uint8Array([7]) })
    expect(d.inputs[1]).toEqual({ _tag: "Pure", bytes: Bcs.encodeSync(Bcs.Address)(Address.normalize("0x2")) })
    const { draft: d2 } = await draft(fixture.boxed({ arguments: ["0x99"], typeArguments: [fixture.Thing.type()] }))
    expect(d2.inputs[0]).toEqual({ _tag: "UnresolvedObject", objectId: Address.normalize("0x99") })
  })

  test("Thing.get reads and decodes an object", async () => {
    const value: fixture.Thing = {
      id: Address.normalize("0x1"),
      owner_ref: Address.normalize("0x2"),
      name: "n",
      label: "l",
      tags: [],
      nums: [7n],
      maybe: Option.none(),
      pair: { first: 1, second: 2n },
      point: [0, 1],
      status: { _tag: "Scored", value: [1, false] },
      created_ms: 0n
    }
    const objects = Layer.succeed(Objects.Objects, {
      get: (objectId) =>
        Effect.succeed({
          objectId,
          version: 1n,
          digest: "" as T.ObjectDigest,
          owner: { _tag: "Immutable" },
          type: fixture.Thing.type(),
          contents: Bcs.encodeSync(fixture.Thing)(value),
          previousTransaction: undefined
        }),
      listOwned: () => Stream.empty
    })
    expect(await Effect.runPromise(fixture.Thing.get("0x1").pipe(Effect.provide(objects)))).toEqual(value)
    const boxed = fixture.Box(Bcs.u64)
    expect(typeof boxed.get).toBe("function")
  })

  test("types: arity and argument kinds are checked", () => {
    const typeOnly = () => {
      // @ts-expect-error make_pair has three type parameters
      fixture.makePair({ arguments: [1, 2], typeArguments: ["u8", "u8"] })
      // @ts-expect-error u64 is a bigint
      fixture.check({ arguments: [1] })
      // @ts-expect-error the named form needs every value parameter
      fixture.pause({ arguments: { thing: "0x1", reason: "r" } })
      // @ts-expect-error a non-key struct value can't be an object id
      fixture.setPair({ arguments: ["0x1", "0x2"] })
      const pair: fixture.Pair<number, bigint> = { first: 1, second: 2n }
      // Error and requirement channels are exact: no `Package` in R, failures only from parsing ids, types and pure values.
      const noArgs: Effect.Effect<readonly [], Ptb.InvalidPureValue, Ptb.PtbBuilder> = fixture.newVault()
      const objects: Effect.Effect<readonly [T.Argument], Ptb.InvalidPureValue, Ptb.PtbBuilder> = fixture.name({ arguments: ["0x1"] })
      const mixed: Effect.Effect<readonly [], Ptb.InvalidPureValue, Ptb.PtbBuilder> = fixture.rename({ arguments: ["0x1", "n"] })
      return [pair, noArgs, objects, mixed]
    }
    expect(typeof typeOnly).toBe("function")
  })
})

describe("inputs", () => {
  test("summaries keep parameter names, docs and declaration order of fields", async () => {
    const model = await Effect.runPromise(Summary.load(fixtureDir))
    const m = model.packages.find((p) => p.address === model.root)!.modules[0]!
    const thing = m.datatypes.find((d) => d.name === "Thing")!
    expect(thing.kind._tag === "Struct" && thing.kind.fields.map((f) => f.name).slice(0, 3)).toEqual(["id", "owner_ref", "name"])
    expect(m.functions.find((f) => f.name === "pause")!.parameters.map((p) => p.name)).toEqual(["thing", "reason", "until_ms"])
    expect(thing.doc).toBe("The main object.")
  })

  test("after an upgrade: calls go to the storage id, type strings keep each type's origin", () => {
    const original = Address.normalize("0xa1")
    const v2 = Address.normalize("0xa2")
    const v3 = Address.normalize("0xa3")
    const u64: M.Type = { _tag: "Primitive", name: "u64" }
    const pkg: M.Package = {
      address: original,
      storageId: v3,
      name: "upgraded",
      modules: [{
        name: "m",
        doc: undefined,
        datatypes: [
          { name: "Old", abilities: ["drop"], typeParameters: [], origin: original, doc: undefined, kind: { _tag: "Struct", positional: false, fields: [{ name: "a", type: u64, doc: undefined }] } },
          { name: "New", abilities: ["drop"], typeParameters: [], origin: v2, doc: undefined, kind: { _tag: "Struct", positional: false, fields: [{ name: "old", type: { _tag: "Datatype", address: original, module: "m", name: "Old", typeArguments: [] }, doc: undefined }] } }
        ],
        functions: [{ name: "f", visibility: "public", entry: false, typeParameters: [], parameters: [], returns: [], doc: undefined }]
      }]
    }
    const out = Object.fromEntries(Render.render([pkg], [{ address: original }]).map((f) => [f.path, f.contents]))
    expect(out["upgraded/$package.ts"]).toContain(`defaultValue: () => "${v3}"`)
    expect(out["upgraded/m.ts"]).toContain(`() => "${original}::m::Old"`)
    expect(out["upgraded/m.ts"]).toContain(`() => "${v2}::m::New"`)
  })

  test("render rejects unknown roots and modules", async () => {
    const model = await Effect.runPromise(Summary.load(fixtureDir))
    expect(() => Render.render(model.packages, [{ address: model.root, modules: ["nope"] }])).toThrow(M.CodegenError)
    expect(() => Render.render(model.packages, [{ address: Address.normalize("0x77") }])).toThrow(M.CodegenError)
  })
})

describe("CLI", () => {
  test("generate --config writes the configured packages", () => {
    const bin = join(import.meta.dir, "../src/bin.ts")
    const r = spawnSync("bun", [bin, "generate", "--config", join(import.meta.dir, "fixtures/sui-codegen.config.ts")], {
      encoding: "utf-8"
    })
    expect(r.stderr).toBe("")
    expect(r.status).toBe(0)
    const out = join(import.meta.dir, "../.mysten/cli")
    expect(existsSync(join(out, "fixture/fixture.ts"))).toBe(true)
    expect(existsSync(join(out, "std/option.ts"))).toBe(true)
    expect(readFileSync(join(out, "fixture/fixture.ts"), "utf-8")).toBe(
      readFileSync(join(goldenDir, "fixture/fixture/fixture.ts"), "utf-8")
    )
  })

  test("a bad command prints usage", () => {
    const r = spawnSync("bun", [join(import.meta.dir, "../src/bin.ts"), "nope"], { encoding: "utf-8" })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("usage")
  })
})
