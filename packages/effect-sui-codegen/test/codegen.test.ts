/**
 * Golden output, the generated API's behaviour, and the CLI.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Objects from "@unconfirmed/effect-sui/Objects"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import type * as T from "@unconfirmed/effect-sui/TransactionData"
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
    test(`${run} is up to date (bun packages/effect-sui-codegen/scripts/fixtures.ts)`, async () => {
      const rendered = await Effect.runPromise(renderGolden(run))
      expect(rendered.map((f) => f.path).sort()).toEqual(files(join(goldenDir, run)))
      for (const f of rendered) expect(f.contents).toBe(readFileSync(join(goldenDir, run, f.path), "utf-8"))
    })
  }

  test("generated modules import only effect, @unconfirmed/effect-bcs, @unconfirmed/effect-sui and each other, as namespaces", () => {
    for (const run of Object.keys(goldenRuns)) {
      for (const f of files(join(goldenDir, run))) {
        const imports = readFileSync(join(goldenDir, run, f), "utf-8").split("\n").filter((l) => l.startsWith("import "))
        for (const line of imports) {
          expect(line).toMatch(
            /^import (type )?(\* as \w+|\{ (Origins, )?Package \}|\{ Origins \}) from "(effect\/\w+|@unconfirmed\/effect-bcs\/Bcs|@unconfirmed\/effect-sui\/Move|\.{1,2}\/[\w/$.]+\.ts)"$/
          )
        }
      }
    }
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
  /** A node holding one object: `contents` under the type `type`. */
  const objects = (type: string, contents: Uint8Array) =>
    Layer.succeed(Objects.Objects, {
      get: (objectId) =>
        Effect.succeed({
          objectId,
          version: 1n,
          digest: "" as T.ObjectDigest,
          owner: { _tag: "Immutable" },
          type,
          contents,
          previousTransaction: undefined
        }),
      listOwned: () => Stream.empty
    })
  const thingBytes = Bcs.encodeSync(fixture.Thing)(value)

  test("calls follow the Package reference; type strings and Thing.get follow Origins", async () => {
    const { draft: d1 } = await draft(fixture.newVault())
    expect(call(d1.commands[0]!).package).toBe(Address.normalize("0x0"))
    const id = Address.normalize("0xabc")
    const { draft: d2 } = await Effect.runPromise(
      Ptb.build(fixture.newVault()).pipe(Effect.provide(Layer.succeed(fixture.Package, id)))
    )
    expect(call(d2.commands[0]!).package).toBe(id)

    // Another deployment: its original id, and the defining id of a type an upgrade added.
    const other = Layer.succeed(fixture.Origins, { originalId: "0xb1", typeOrigins: { "fixture::Marker": "0xb2" } })
    const types = await Effect.runPromise(Effect.all([fixture.Thing.type(), fixture.Pair.type("u8", "u8", "u64"), fixture.Marker.type()]).pipe(Effect.provide(other)))
    expect(types).toEqual([`${Address.normalize("0xb1")}::fixture::Thing`, `${Address.normalize("0xb1")}::fixture::Pair<u8, u8, u64>`, `${Address.normalize("0xb2")}::fixture::Marker`])
    // The node reports the short form; addresses are compared normalized.
    const read = fixture.Thing.get("0x1").pipe(Effect.provide(objects("0xb1::fixture::Thing", thingBytes)))
    expect(await Effect.runPromise(read.pipe(Effect.provide(other)))).toEqual(value)
    expect((await Effect.runPromise(Effect.flip(read)))._tag).toBe("ObjectTypeMismatch")
  })

  test("Thing.get checks the type before decoding: an object of another type is refused, though its bytes parse", async () => {
    const e = await Effect.runPromise(
      fixture.Marker.type().pipe(
        Effect.flatMap((marker) => Effect.flip(fixture.Thing.get("0x1").pipe(Effect.provide(objects(marker, thingBytes)))))
      )
    )
    expect(e).toMatchObject({
      _tag: "ObjectTypeMismatch",
      objectId: Address.normalize("0x1"),
      expected: `${Address.normalize("0x0")}::fixture::Thing`,
      actual: `${Address.normalize("0x0")}::fixture::Marker`
    })
  })

  test("a generic object read without type arguments matches any instantiation; with them, only that one", async () => {
    const Box = fixture.Box(Bcs.u64)
    const node = objects("0x0::fixture::Box<u64>", Bcs.encodeSync(Box)({ id: Address.normalize("0x1"), value: 5n }))
    expect(await Effect.runPromise(Box.get("0x1").pipe(Effect.provide(node)))).toEqual({ id: Address.normalize("0x1"), value: 5n })
    expect((await Effect.runPromise(Box.get("0x1", "u64").pipe(Effect.provide(node)))).value).toBe(5n)
    expect((await Effect.runPromise(Effect.flip(Box.get("0x1", "u8").pipe(Effect.provide(node)))))._tag).toBe("ObjectTypeMismatch")
  })
})

describe("inputs", () => {
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
    expect(out["upgraded/$package.ts"]).toContain(`originalId: "${original}"`)
    expect(out["upgraded/$package.ts"]).toContain(`"m::New": "${v2}"`)
    expect(out["upgraded/$package.ts"]).not.toContain(`"m::Old"`)
  })

  test("a generic parameter is pure when its type argument is, else an object id", async () => {
    const input = async (typeArgument: string, value: unknown) =>
      (await Effect.runPromise(Ptb.build(fixture.boxed({ arguments: [value as never], typeArguments: [typeArgument] })))).draft.inputs[0]
    const pure = (bytes: Uint8Array) => ({ _tag: "Pure" as const, bytes })
    expect(await input("0x1::string::String", "hi")).toEqual(pure(Bcs.encodeSync(Bcs.string)("hi")))
    expect(await input("0x1::option::Option<u64>", 5n)).toEqual(pure(Bcs.encodeSync(Bcs.option(Bcs.u64))(Option.some(5n))))
    expect(await input("vector<u256>", [1n])).toEqual(pure(Bcs.encodeSync(Bcs.vector(Bcs.u256))([1n])))
    expect(await input(Effect.runSync(fixture.Thing.type()), "0x99")).toEqual({ _tag: "UnresolvedObject", objectId: Address.normalize("0x99") })
    const notAnId = await Effect.runPromiseExit(Ptb.build(fixture.boxed({ arguments: [7 as never], typeArguments: [Effect.runSync(fixture.Thing.type())] })))
    expect(notAnId._tag === "Failure" && String(notAnId.cause)).toContain("expected an object id")
  })

  test("render rejects unknown roots and modules", async () => {
    const model = await Effect.runPromise(Summary.load(fixtureDir))
    expect(() => Render.render(model.packages, [{ address: model.root, modules: ["nope"] }])).toThrow(M.CodegenError)
    expect(() => Render.render(model.packages, [{ address: Address.normalize("0x77") }])).toThrow(M.CodegenError)
  })
})

// Type tests: compile-time only. Arity and argument kinds are checked, and the
// error and requirement channels are exact.
export const typeTests = () => {
  // @ts-expect-error make_pair has three type parameters
  fixture.makePair({ arguments: [1, 2], typeArguments: ["u8", "u8"] })
  // @ts-expect-error u64 is a bigint
  fixture.check({ arguments: [1] })
  // @ts-expect-error the named form needs every value parameter
  fixture.pause({ arguments: { thing: "0x1", reason: "r" } })
  // @ts-expect-error a non-key struct value can't be an object id
  fixture.setPair({ arguments: ["0x1", "0x2"] })
  const pair: fixture.Pair<number, bigint> = { first: 1, second: 2n }
  // No `Package` in R, failures only from parsing ids, types and pure values.
  const noArgs: Effect.Effect<readonly [], Ptb.InvalidPureValue, Ptb.PtbBuilder> = fixture.newVault()
  const objects: Effect.Effect<readonly [T.Argument], Ptb.InvalidPureValue, Ptb.PtbBuilder> = fixture.name({ arguments: ["0x1"] })
  const mixed: Effect.Effect<readonly [], Ptb.InvalidPureValue, Ptb.PtbBuilder> = fixture.rename({ arguments: ["0x1", "n"] })
  return [pair, noArgs, objects, mixed]
}

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
})
