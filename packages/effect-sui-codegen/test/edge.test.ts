/**
 * Local packages, config merging, name collisions and safe writes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type * as Config from "../src/Config.ts"
import * as Generate from "../src/Generate.ts"
import * as M from "../src/Model.ts"
import * as Render from "../src/Render.ts"
import * as Summary from "../src/Summary.ts"
import { fixtureDir } from "./support.ts"

const summaries = join(fixtureDir, "package_summaries")
const scratch = join(import.meta.dir, "../.mysten/edge")
const ZERO = Address.normalize("0x0")

const files = (packages: ReadonlyArray<Config.LocalPackage>) =>
  Effect.runPromise(Generate.files({ output: "unused", packages }))
const filesExit = (packages: ReadonlyArray<Config.LocalPackage>) =>
  Effect.runPromiseExit(Generate.files({ output: "unused", packages }))
const byPath = (fs: ReadonlyArray<Render.File>) => Object.fromEntries(fs.map((f) => [f.path, f.contents]))
const packageDefault = (contents: string) => contents.match(/defaultValue: \(\) => "(.*)"/)?.[1]
const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const json = JSON.stringify(exit.cause)
  return { typed: json.includes("CodegenError"), defect: json.includes("\"Die\""), json }
}

/** A copy of the fixture summaries whose root package is labelled `label`. */
const relabelled = (dir: string, label: string) => {
  rmSync(dir, { recursive: true, force: true })
  cpSync(summaries, dir, { recursive: true })
  if (label === "fixture") return dir
  cpSync(join(dir, "fixture"), join(dir, label), { recursive: true })
  rmSync(join(dir, "fixture"), { recursive: true })
  const mapping = JSON.parse(readFileSync(join(dir, "address_mapping.json"), "utf-8"))
  mapping[label] = mapping.fixture
  delete mapping.fixture
  writeFileSync(join(dir, "address_mapping.json"), JSON.stringify(mapping))
  const f = join(dir, label, "fixture.json")
  writeFileSync(f, readFileSync(f, "utf-8").replaceAll("\"address\": \"fixture\"", `"address": "${label}"`))
  return dir
}

beforeAll(() => mkdirSync(scratch, { recursive: true }))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("local packages", () => {
  test("packageId reaches type strings of an unpublished package (CT-6)", async () => {
    const id = Address.normalize("0x999")
    const out = byPath(await files([{ path: summaries, package: "fixture", packageId: "0x999" }]))
    expect(packageDefault(out["fixture/$package.ts"]!)).toBe(id)
    expect(out["fixture/$package.ts"]).toContain(`originalId: "${id}"`)
    expect(out["fixture/$package.ts"]).not.toContain(ZERO)
  })

  test("originalId and typeOrigins for an upgraded local package (CT-6)", async () => {
    const original = Address.normalize("0xa1")
    const latest = Address.normalize("0xa3")
    const v2 = Address.normalize("0xa2")
    const out = byPath(
      await files([{
        path: summaries,
        package: "fixture",
        packageId: latest,
        originalId: original,
        typeOrigins: { "fixture::Marker": v2 }
      }])
    )
    expect(packageDefault(out["fixture/$package.ts"]!)).toBe(latest)
    expect(out["fixture/$package.ts"]).toContain(`originalId: "${original}"`)
    expect(out["fixture/$package.ts"]).toContain(`"fixture::Marker": "${v2}"`)
  })

  test("two unpublished local packages in one config (CT-7)", async () => {
    const a = relabelled(join(scratch, "two-a"), "fixture")
    const b = relabelled(join(scratch, "two-b"), "other")
    const out = byPath(await files([{ path: a, package: "fixture" }, { path: b, package: "other", packageId: "0xbb" }]))
    expect(Object.keys(out)).toContain("fixture/fixture.ts")
    expect(Object.keys(out)).toContain("other/fixture.ts")
    expect(packageDefault(out["fixture/$package.ts"]!)).toBe(ZERO)
    expect(packageDefault(out["other/$package.ts"]!)).toBe(Address.normalize("0xbb"))
    expect(out["other/$package.ts"]).toContain(`originalId: "${Address.normalize("0xbb")}"`)
  })

  test("a Published.toml with several environments needs `environment`; its record gives the ids", async () => {
    const dir = join(scratch, "published")
    rmSync(dir, { recursive: true, force: true })
    cpSync(summaries, join(dir, "package_summaries"), { recursive: true })
    cpSync(join(fixtureDir, "Move.toml"), join(dir, "Move.toml"))
    const record = (env: string, chain: string, publishedAt: string, originalId: string) =>
      `[published.${env}]\nchain-id = "${chain}"\npublished-at = "${publishedAt}"\noriginal-id = "${originalId}"\nversion = 2\n` +
      `build-config = { flavor = "sui", edition = "2024" }\nupgrade-capability = "0xc1"\n`
    writeFileSync(join(dir, "Published.toml"), `# Generated by Move\n\n${record("testnet", "4c78adac", "0xa2", "0xa1")}\n${record("mainnet", "35834a8a", "0xb2", "0xb1")}`)
    const ambiguous = await filesExit([{ path: dir, summarize: false }])
    expect(failure(ambiguous).json).toContain("AmbiguousEnvironment")
    const out = byPath(await files([{ path: dir, summarize: false, environment: "mainnet" }]))
    expect(packageDefault(out["fixture/$package.ts"]!)).toBe(Address.normalize("0xb2"))
    expect(out["fixture/$package.ts"]).toContain(`originalId: "${Address.normalize("0xb1")}"`)
  })

  test("two unpublished packages in one summary directory (CT-7)", async () => {
    const dir = relabelled(join(scratch, "both"), "fixture")
    cpSync(join(dir, "fixture"), join(dir, "other"), { recursive: true })
    const mapping = JSON.parse(readFileSync(join(dir, "address_mapping.json"), "utf-8"))
    writeFileSync(join(dir, "address_mapping.json"), JSON.stringify({ ...mapping, other: "0x0" }))
    const model = await Effect.runPromise(Summary.load(dir, { package: "fixture" }))
    expect(model.root).toBe(M.unpublished("fixture"))
    expect(model.packages.map((p) => p.address)).toContain(M.unpublished("other"))
  })

  test("a dependency the summaries label by address is named by its Move.toml, found through the build's source maps (#14)", async () => {
    // `sui move summary` labels a package reached only through another dependency by its address.
    const dir = join(scratch, "by-address")
    const address = Address.normalize("0xc4")
    rmSync(dir, { recursive: true, force: true })
    cpSync(summaries, join(dir, "pkg/package_summaries"), { recursive: true })
    cpSync(join(fixtureDir, "Move.toml"), join(dir, "pkg/Move.toml"))
    mkdirSync(join(dir, "pkg/package_summaries", address))
    writeFileSync(
      join(dir, "pkg/package_summaries", address, "bps.json"),
      JSON.stringify({ id: { address, name: "bps" }, functions: {}, structs: {}, enums: {} })
    )
    mkdirSync(join(dir, "bps/sources"), { recursive: true })
    writeFileSync(join(dir, "bps/Move.toml"), `[package]\nname = "bps"\nedition = "2024"\n`)
    const maps = join(dir, "pkg/build/fixture/debug_info/dependencies/bps")
    mkdirSync(maps, { recursive: true })
    writeFileSync(join(maps, "bps.json"), JSON.stringify({ from_file_path: join(dir, "bps/sources/bps.move"), module_name: [address.slice(2), "bps"] }))

    const model = await Effect.runPromise(Summary.load(join(dir, "pkg")))
    expect(model.packages.find((p) => p.address === address)?.name).toBe("bps")

    rmSync(join(dir, "pkg/build"), { recursive: true })
    const f = failure(await Effect.runPromiseExit(Summary.load(join(dir, "pkg"))))
    expect(f.typed).toBe(true)
    expect(f.json).toContain(`cannot name dependency ${address}`)
  })

  test("summary directories not in the address mapping are ignored; bad input is a CodegenError (CT-21)", async () => {
    const dir = relabelled(join(scratch, "stray"), "fixture")
    mkdirSync(join(dir, ".cache"))
    const model = await Effect.runPromise(Summary.load(dir, { package: "fixture" }))
    expect(model.packages.some((p) => p.name === ".cache")).toBe(false)

    writeFileSync(join(dir, "address_mapping.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "address_mapping.json"), "utf-8")), sui: "nope" }))
    const f = failure(await Effect.runPromiseExit(Summary.load(dir, { package: "fixture" })))
    expect(f.typed).toBe(true)
    expect(f.defect).toBe(false)
  })
})

describe("merging", () => {
  const framework = { path: summaries, package: "sui", name: "framework", packageId: "0x999", modules: ["clock"] }
  test("a configured root keeps its name and packageId whatever the entry order (CT-8)", async () => {
    for (const packages of [[{ path: summaries, package: "fixture" }, framework], [framework, { path: summaries, package: "fixture" }]]) {
      const out = byPath(await files(packages))
      expect(packageDefault(out["framework/$package.ts"]!)).toBe(Address.normalize("0x999"))
      expect(out["sui/$package.ts"]).toBeUndefined()
    }
  })
})

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

const A = M.normalizeAddress("0xabc")
const A2 = M.normalizeAddress("0x2")
const u64: M.Type = { _tag: "Primitive", name: "u64" }
const dt = (address: string, module: string, name: string): M.Type => ({ _tag: "Datatype", address, module, name, typeArguments: [] })
const ref = (t: M.Type): M.Type => ({ _tag: "Reference", mutable: false, type: t })
const struct = (name: string, fields: Array<M.Field> = [{ name: "x", type: u64, doc: undefined }]): M.Datatype => ({
  name,
  abilities: ["store", "drop"],
  typeParameters: [],
  origin: A,
  doc: undefined,
  kind: { _tag: "Struct", positional: false, fields }
})
const fn = (name: string, parameters: Array<M.Parameter>): M.MoveFunction => ({
  name,
  visibility: "public",
  entry: false,
  typeParameters: [],
  parameters,
  returns: [],
  doc: undefined
})
const sui: M.Package = {
  address: A2,
  storageId: A2,
  name: "sui",
  modules: [
    { name: "clock", doc: undefined, functions: [], datatypes: [{ ...struct("Clock"), abilities: ["key"], origin: A2 }] },
    { name: "random", doc: undefined, functions: [], datatypes: [{ ...struct("Random"), abilities: ["key"], origin: A2 }] }
  ]
}
const game: M.Module = {
  name: "game",
  doc: undefined,
  datatypes: [
    struct("Move"),
    struct("Bcs"),
    struct("Package"),
    struct("Holder", [{ name: "m", type: dt(A, "game", "Move"), doc: undefined }, { name: "__proto__", type: u64, doc: undefined }])
  ],
  functions: [
    fn("draw", [{ name: "random", type: u64 }, { name: "rnd", type: ref(dt(A2, "random", "Random")) }]),
    fn("f", [{ name: "foo_bar", type: u64 }, { name: "fooBar", type: u64 }]),
    fn("foo_bar", []),
    fn("fooBar", []),
    fn("needs_signer", [{ name: "s", type: ref({ _tag: "Primitive", name: "signer" }) }])
  ]
}

describe("names", () => {
  let mod: any
  let source: string
  beforeAll(async () => {
    const out = Render.render([{ address: A, storageId: A, name: "pkg", modules: [game] }, sui], [{ address: A }])
    await Effect.runPromise(Generate.write(join(scratch, "names"), out))
    source = out.find((f) => f.path === "pkg/game.ts")!.contents
    mod = await import(join(scratch, "names/pkg/game.ts"))
  })

  test("types named Move, Bcs and Package are exported under their names (CT-20)", () => {
    expect(Effect.runSync(mod.Move.type())).toBe(`${A}::game::Move`)
    expect(Effect.runSync(mod.Bcs.type())).toBe(`${A}::game::Bcs`)
    expect(Effect.runSync(mod.Package.type())).toBe(`${A}::game::Package`)
    expect(source).toContain(`export { Move_ as Move }`)
    expect(source).not.toContain("export { Package }")
  })

  test("functions whose camelCase names collide: the camelCase one keeps it, the other its Move name (CT-20)", () => {
    expect(typeof mod.fooBar).toBe("function")
    expect(typeof mod.foo_bar).toBe("function")
  })

  test("a function with a signer parameter is skipped with a comment (CT-20)", () => {
    expect("needsSigner" in mod).toBe(false)
    expect(source).toContain("`game::needs_signer` is not generated")
  })

  test("a value named like an auto-filled object gets a distinct key; camelCase twins too (CT-9)", async () => {
    expect(source).toContain("readonly random2: Move.Input<bigint>")
    expect(source).toContain("Move.random(Move.isTuple(a) ? undefined : a.random)")
    expect(source).toContain("readonly fooBar: Move.Input<bigint>")
    expect(source).toContain("readonly fooBar2: Move.Input<bigint>")
    const { draft } = await Effect.runPromise(Ptb.build(Effect.gen(function*() {
      yield* mod.draw({ arguments: { random2: 7n } })
      yield* mod.f({ arguments: { fooBar: 1n, fooBar2: 2n } })
    }) as Effect.Effect<void, unknown, Ptb.PtbBuilder>))
    const pures = draft.inputs.flatMap((i) => (i._tag === "Pure" ? [i.bytes[0]] : []))
    expect(pures).toEqual([7, 1, 2])
    const draw = draft.commands[0]!
    if (draw._tag !== "MoveCall") throw new Error("not a move call")
    expect(draw.arguments.length).toBe(2)
  })

  test("a field named __proto__ is an own key, not the prototype (CT-25)", () => {
    expect(source).toContain(`["__proto__"]: Bcs.u64`)
  })
})

describe("writing", () => {
  test("refuses to replace a directory holding files it did not generate (CT-22)", async () => {
    const out = join(scratch, "write")
    mkdirSync(join(out, "pkg"), { recursive: true })
    writeFileSync(join(out, "pkg/mine.ts"), "export const mine = 1\n")
    const rendered = [{ path: "pkg/m.ts", contents: `${Render.HEADER}export {}\n` }]
    const f = failure(await Effect.runPromiseExit(Generate.write(out, rendered)))
    expect(f.typed).toBe(true)
    expect(existsSync(join(out, "pkg/mine.ts"))).toBe(true)
    expect(existsSync(join(out, "pkg/m.ts"))).toBe(false)
    // Generated files alone are replaced.
    rmSync(join(out, "pkg/mine.ts"))
    writeFileSync(join(out, "pkg/old.ts"), `${Render.HEADER}export {}\n`)
    await Effect.runPromise(Generate.write(out, rendered))
    expect(existsSync(join(out, "pkg/old.ts"))).toBe(false)
    expect(existsSync(join(out, "pkg/m.ts"))).toBe(true)
  })

  test("two roots with the same name fail instead of overwriting each other (CT-22)", async () => {
    const B = M.normalizeAddress("0xdef")
    const one = (address: string, f: string): M.Package => ({
      address,
      storageId: address,
      name: "pkg",
      modules: [{ name: "m", doc: undefined, datatypes: [], functions: [fn(f, [])] }]
    })
    expect(() => Render.render([one(A, "f"), one(B, "g")], [{ address: A }, { address: B }])).toThrow(M.CodegenError)
    const f = failure(await filesExit([{ path: summaries, package: "fixture", name: "x" }, { path: summaries, package: "std", name: "x" }]))
    expect(f.typed).toBe(true)
  })
})
