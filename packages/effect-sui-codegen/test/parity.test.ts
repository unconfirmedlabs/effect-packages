/**
 * Parity with `@mysten/codegen`: the same values through our generated schemas
 * and Mysten's generated `BcsType`s give the same bytes, and a transaction
 * built with our generated call builders gives the same bytes as Mysten's.
 */
import { bcs } from "@mysten/sui/bcs"
import { Transaction } from "@mysten/sui/transactions"
import { beforeAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Objects from "@unconfirmed/effect-sui/Objects"
import * as Packages from "@unconfirmed/effect-sui/Packages"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import * as Resolve from "@unconfirmed/effect-sui/Resolve"
import * as T from "@unconfirmed/effect-sui/TransactionData"
import { join } from "node:path"
import * as M from "../src/Model.ts"
import * as Summary from "../src/Summary.ts"
import * as fixture from "./golden/fixture/fixture/fixture.ts"
import * as coin from "./golden/framework/sui/coin.ts"
import { generateMysten, MYSTEN_PACKAGE, mystenDir } from "./mysten.ts"
import { fixtureDir } from "./support.ts"

const A = Address.normalize
const D = (seed: number) => Bcs.decodeSync(Bcs.Digest)(new Uint8Array([32, ...new Uint8Array(32).fill(seed)])) as T.ObjectDigest
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

let theirs: any
let theirCoin: any
let model: M.Model

beforeAll(async () => {
  await generateMysten()
  theirs = await import(join(mystenDir, "fixture/fixture.ts"))
  theirCoin = await import(join(mystenDir, "sui/coin.ts"))
  model = await Effect.runPromise(Summary.load(fixtureDir))
}, 120_000)

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const ID1 = A("0xab")
const ID2 = A("0xcd")

const thing = (status: fixture.Status): fixture.Thing => ({
  id: ID1,
  owner_ref: ID2,
  name: "hello ✓",
  label: "ascii",
  tags: ["a", "bc"],
  nums: [1n, 2n ** 63n],
  maybe: Option.some(5n),
  pair: { first: 7, second: 10n ** 12n },
  point: [3, 4],
  status,
  created_ms: 1_700_000_000_000n
})

const theirThing = (status: unknown) => ({
  id: ID1,
  owner_ref: ID2,
  name: "hello ✓",
  label: "ascii",
  tags: ["a", "bc"],
  nums: ["1", (2n ** 63n).toString()],
  maybe: "5",
  pair: { first: 7, second: (10n ** 12n).toString() },
  point: [3, 4],
  status,
  created_ms: "1700000000000"
})

const statuses: ReadonlyArray<readonly [fixture.Status, unknown]> = [
  [{ _tag: "Active" }, { Active: true }],
  [{ _tag: "Paused", reason: "maintenance", until_ms: 99n }, { Paused: { reason: "maintenance", until_ms: "99" } }],
  [{ _tag: "Scored", value: [12, true] }, { Scored: [12, true] }],
  [{ _tag: "Wrapped", value: Option.some(3) }, { Wrapped: 3 }],
  [{ _tag: "Wrapped", value: Option.none() }, { Wrapped: null }]
]

describe("struct schemas encode like @mysten/codegen's", () => {
  test("Thing with every enum variant shape: unit, struct, tuple, Option some and none", () => {
    for (const [ours, them] of statuses) {
      const bytes = Bcs.encodeSync(fixture.Thing)(thing(ours))
      expect(hex(bytes)).toBe(hex(theirs.Thing.serialize(theirThing(them)).toBytes()))
      expect(Bcs.decodeSync(fixture.Thing)(bytes)).toEqual(thing(ours))
    }
  })

  test("generic Pair and Box: only non-phantom parameters shape the layout", () => {
    expect(hex(Bcs.encodeSync(fixture.Pair(Bcs.u8, Bcs.u64))({ first: 1, second: 2n })))
      .toBe(hex(theirs.Pair(bcs.u8(), bcs.u64()).serialize({ first: 1, second: "2" }).toBytes()))
    const box = fixture.Box(fixture.Pair(Bcs.string, Bcs.vector(Bcs.u16)))
    const value = { id: ID1, value: { first: "x", second: [1, 65535] } }
    expect(hex(Bcs.encodeSync(box)(value)))
      .toBe(hex(theirs.Box(theirs.Pair(bcs.string(), bcs.vector(bcs.u16()))).serialize(value).toBytes()))
  })

  test("framework types: built-in (Balance, Table, VecMap, TypeName) and generated (Versioned)", () => {
    const vault: fixture.Vault = {
      id: ID1,
      balance: { value: 10n },
      ledger: { id: ID2, size: 2n },
      meta: { contents: [{ key: "k", value: 1n }, { key: "l", value: 2n }] },
      kind: { name: "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI" },
      versioned: { id: A("0xee"), version: 1n }
    }
    const them = {
      ...vault,
      balance: { value: "10" },
      ledger: { id: ID2, size: "2" },
      meta: { contents: [{ key: "k", value: "1" }, { key: "l", value: "2" }] },
      versioned: { id: A("0xee"), version: "1" }
    }
    const bytes = Bcs.encodeSync(fixture.Vault)(vault)
    expect(hex(bytes)).toBe(hex(theirs.Vault.serialize(them).toBytes()))
    expect(Bcs.decodeSync(fixture.Vault)(bytes)).toEqual(vault)
  })

  test("framework module types: Coin, TreasuryCap", () => {
    const sui = "0x2::sui::SUI"
    expect(hex(Bcs.encodeSync(coin.Coin)({ id: ID1, balance: { value: 5n } })))
      .toBe(hex(theirCoin.Coin.serialize({ id: ID1, balance: { value: "5" } }).toBytes()))
    expect(hex(Bcs.encodeSync(coin.TreasuryCap)({ id: ID1, total_supply: { value: 5n } })))
      .toBe(hex(theirCoin.TreasuryCap.serialize({ id: ID1, total_supply: { value: "5" } }).toBytes()))
    expect(Effect.runSync(coin.Coin.type(sui))).toBe(`${A("0x2")}::coin::Coin<${sui}>`)
  })

  test("type strings use the defining package and every type argument", () => {
    expect(Effect.runSync(fixture.Thing.type())).toBe(`${A("0x0")}::fixture::Thing`)
    expect(Effect.runSync(fixture.Pair.type("0x2::sui::SUI", "u8", "u64"))).toBe(`${A("0x0")}::fixture::Pair<0x2::sui::SUI, u8, u64>`)
  })
})

// -----------------------------------------------------------------------------
// Transactions
// -----------------------------------------------------------------------------

const sender = A("0x5e4d")
const gasRef = { objectId: A("0xfeed"), version: 9n, digest: D(7) }
const THING = A("0x7a")
const VAULT = A("0x7b")
const COIN = A("0x7c")
const PKG = A(MYSTEN_PACKAGE)

interface Obj {
  readonly version: bigint
  readonly shared?: bigint
}
const chain: Record<string, Obj> = {
  [THING]: { version: 5n },
  [VAULT]: { version: 12n, shared: 11n },
  [COIN]: { version: 6n },
  [A("0x8")]: { version: 100n, shared: 42n },
  [A("0x403")]: { version: 101n, shared: 7n }
}

const objectsLayer = Layer.succeed(Objects.Objects, {
  get: (objectId) => {
    const o = chain[objectId]
    if (o === undefined) return Effect.fail(new Objects.ObjectNotFound({ objectId }))
    return Effect.succeed({
      objectId,
      version: o.version,
      digest: D(Number(o.version)),
      owner: o.shared !== undefined ? { _tag: "Shared", initialSharedVersion: o.shared } : { _tag: "AddressOwner", address: sender },
      type: "",
      contents: new Uint8Array(),
      previousTransaction: undefined
    } as Objects.SuiObject)
  },
  listOwned: () => Stream.empty
})

const findFunction = (pkg: string, module: string, name: string) => {
  const p = model.packages.find((p) => p.address === (pkg === PKG ? model.root : pkg))!
  return p.modules.find((m) => m.name === module)!.functions.find((f) => f.name === name)!
}
const typeName = (t: M.Type): string | undefined => {
  const d = M.deref(t)
  return d._tag === "Datatype" ? `${d.address}::${d.module}::${d.name}` : undefined
}

const packagesLayer = Layer.succeed(Packages.Packages, {
  getFunction: (target) =>
    Effect.succeed({
      isEntry: findFunction(target.package, target.module, target.function).entry,
      parameters: findFunction(target.package, target.module, target.function).parameters.map((p) => ({
        reference: p.type._tag === "Reference" ? (p.type.mutable ? "Mutable" : "Immutable") : "Value",
        typeName: typeName(p.type)
      }))
    } satisfies Packages.MoveFunction),
  getModules: () => Effect.die("unused")
})

const mystenClient = {
  core: {
    resolveTransactionPlugin: () => undefined,
    getObjects: async ({ objectIds }: { objectIds: Array<string> }) => ({
      objects: objectIds.map((id) => {
        const o = chain[A(id)]!
        return {
          objectId: A(id),
          version: String(o.version),
          digest: D(Number(o.version)),
          owner: o.shared !== undefined
            ? { $kind: "Shared", Shared: { initialSharedVersion: String(o.shared) } }
            : { $kind: "AddressOwner", AddressOwner: sender }
        }
      })
    }),
    getMoveFunction: async ({ packageId, moduleName, name }: { packageId: string; moduleName: string; name: string }) => ({
      function: {
        parameters: findFunction(A(packageId), moduleName, name).parameters.map((p) => ({
          reference: p.type._tag === "Reference" ? (p.type.mutable ? "mutable" : "immutable") : null,
          body: typeName(p.type) !== undefined
            ? { $kind: "datatype", datatype: { typeName: typeName(p.type), typeParameters: [] } }
            : { $kind: "unknown" }
        }))
      }
    })
  }
}

const ours = (recipe: Effect.Effect<unknown, unknown, Ptb.PtbBuilder>) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const { draft } = yield* Ptb.build(recipe)
      const plan = yield* Resolve.inputs({ sender, draft })
      const data = yield* Resolve.finish({ ...plan, gasPrice: 1000n, gasBudget: 10_000_000n, gasPayment: [gasRef] })
      return T.encode(data)
    }).pipe(
      Effect.provide(Layer.merge(objectsLayer, packagesLayer)),
      Effect.provideService(fixture.Package, PKG)
    ) as Effect.Effect<Uint8Array>
  )

const build = async (f: (tx: Transaction) => void) => {
  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasPrice(1000)
  tx.setGasBudget(10_000_000)
  tx.setGasPayment([{ ...gasRef, version: "9" }])
  tx.setExpiration({ None: true })
  f(tx)
  return tx.build({ client: mystenClient as never })
}

describe("call builders build the same transaction as @mysten/codegen's", () => {
  test("pure values, options, vectors, generics, results, auto-filled Clock/Random/DenyList/SuiSystemState", async () => {
    const marker = Effect.runSync(fixture.Marker.type())
    const mine = await ours(Effect.gen(function*() {
      const [created] = yield* fixture.newThing({
        arguments: { name: "n", label: "l", tags: ["t", "u"], nums: [1n, 2n], maybe: 3n }
      })
      yield* fixture.rename({ arguments: [created, "renamed"] })
      yield* fixture.wrap({ arguments: { thing: created } })
      yield* fixture.allPure({
        arguments: {
          flag: true,
          small: 1,
          mid: 2,
          big: 3,
          large: 4n,
          huge: 5n,
          giant: 6n,
          who: "0x2",
          id: THING,
          bytes: new Uint8Array([1, 2]),
          nested: [[1n], [2n, 3n]],
          names: ["a"],
          maybeName: Option.some("x")
        }
      })
      const [pair] = yield* fixture.makePair({ arguments: [7, 9n], typeArguments: [marker, "u8", "u64"] })
      yield* fixture.setPair({ arguments: { thing: created, pair } })
      const [count, , hasMaybe] = yield* fixture.stats({ arguments: [created] })
      yield* fixture.create({ arguments: { name: "e" } })
      yield* fixture.roll({ arguments: { thing: THING } })
      yield* fixture.touchSystem({ arguments: [1] })
      yield* fixture.deposit({ arguments: { vault: VAULT, coin: COIN } })
      const [boxed] = yield* fixture.boxed({ arguments: [5n], typeArguments: ["u64"] })
      yield* coin.denyListV2ContainsCurrentEpoch({ arguments: ["0x2"], typeArguments: ["0x2::sui::SUI"] })
      yield* Ptb.transferObjects([created, boxed], yield* Ptb.address(sender))
      // One return value is the command's `Result` (as Mysten's result used directly), several are `NestedResult`s.
      expect([created, count, hasMaybe].map((r) => r._tag)).toEqual(["Result", "NestedResult", "NestedResult"])
    }))
    const reference = await build((tx) => {
      const created = tx.add(theirs.newThing({
        arguments: { name: "n", label: "l", tags: ["t", "u"], nums: [1n, 2n], maybe: 3n }
      }))
      tx.add(theirs.rename({ arguments: [created, "renamed"] }))
      tx.add(theirs.wrap({ arguments: { thing: created, value: null } }))
      tx.add(theirs.allPure({
        arguments: {
          flag: true,
          small: 1,
          mid: 2,
          big: 3,
          large: 4n,
          huge: 5n,
          giant: 6n,
          who: "0x2",
          id: THING,
          bytes: [1, 2],
          nested: [[1n], [2n, 3n]],
          names: ["a"],
          maybeName: "x"
        }
      }))
      const pair = tx.add(theirs.makePair({ arguments: [7, 9n], typeArguments: [marker, "u8", "u64"] }))
      tx.add(theirs.setPair({ arguments: { thing: created, pair } }))
      tx.add(theirs.stats({ arguments: [created] }))
      tx.add(theirs.create({ arguments: { name: "e" } }))
      tx.add(theirs.roll({ arguments: { thing: THING } }))
      tx.add(theirs.touchSystem({ arguments: [1] }))
      tx.add(theirs.deposit({ arguments: { vault: VAULT, coin: COIN } }))
      const boxed = tx.add(theirs.boxed({ arguments: [5n], typeArguments: ["u64"] }))
      tx.add(theirCoin.denyListV2ContainsCurrentEpoch({ arguments: ["0x2"], typeArguments: ["0x2::sui::SUI"] }))
      tx.transferObjects([created, boxed], tx.pure.address(sender))
    })
    expect(hex(mine)).toBe(hex(reference))
  })

  test("auto-filled objects can be overridden, and the positional form matches the named one", async () => {
    const a = await ours(fixture.create({ arguments: { name: "x", clock: THING } }))
    const b = await build((tx) => {
      tx.moveCall({ target: `${PKG}::fixture::create`, arguments: [tx.pure.string("x"), tx.object(THING)] })
    })
    expect(hex(a)).toBe(hex(b))
    const named = await ours(fixture.pause({ arguments: { thing: THING, reason: "r", untilMs: 1n } }))
    const positional = await ours(fixture.pause({ arguments: [THING, "r", 1n] }))
    expect(hex(named)).toBe(hex(positional))
  })

  test("bad pure values are typed failures", async () => {
    const exit = await Effect.runPromiseExit(Ptb.build(fixture.check({ arguments: [-1n] })))
    expect(JSON.stringify(exit)).toContain("InvalidPureValue")
    const bad = await Effect.runPromiseExit(Ptb.build(fixture.allPure({
      arguments: [true, 1, 2, 3, 4n, 5n, 6n, "not hex", THING, new Uint8Array(), [], [], undefined]
    })))
    expect(JSON.stringify(bad)).toContain("InvalidPureValue")
  })
})
