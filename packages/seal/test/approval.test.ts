import { Transaction } from "@mysten/sui/transactions"
import { base58 } from "@scure/base"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as Move from "@unconfirmed/sui/Move"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Packages from "@unconfirmed/sui/Packages"
import * as Ptb from "@unconfirmed/sui/Ptb"
import * as T from "@unconfirmed/sui/TransactionData"
import { describe, expect, test } from "bun:test"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { Approval } from "../src/index.ts"
import { hex, utf8 } from "./support.ts"

const PKG = Address.normalize("0x" + "ab".repeat(32))
const OTHER = Address.normalize("0x" + "cd".repeat(32))
const target = `${PKG}::account_based::seal_approve` as const

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}
const reason = <A>(r: Result.Result<A, { reason: string }>): string => {
  if (Result.isSuccess(r)) throw new Error("expected failure")
  return r.failure.reason
}

const pure = (bytes: Uint8Array): T.CallArg => ({ _tag: "Pure", bytes })
const idArg = (id: Uint8Array) => pure(Bcs.encodeSync(Bcs.byteVector)(id))
const moveCall = (o: { pkg?: Address.Address; fn?: string; args?: ReadonlyArray<T.Argument> } = {}): T.Command => ({
  _tag: "MoveCall",
  package: o.pkg ?? PKG,
  module: "m",
  function: o.fn ?? "seal_approve",
  typeArguments: [],
  arguments: o.args ?? [{ _tag: "Input", value: 0 }]
})
const input = (value: number): T.Argument => ({ _tag: "Input", value })

describe("Approval.call + fromRecipeOffline", () => {
  test("several calls, one written with Move.call as generated builders are: ids in order, duplicates kept (H6)", async () => {
    const pkg = Context.Reference<string>("test/pkg", { defaultValue: () => PKG })
    const recipe = Effect.gen(function*() {
      yield* Approval.call({ target, id: utf8("a") })
      yield* Approval.call({ target: `${PKG}::tle::seal_approve`, id: utf8("b"), arguments: [yield* Ptb.clock] })
      yield* Move.call(pkg, "m::seal_approve_extra", [], [Move.pure(Bcs.byteVector, utf8("a")), Ptb.u64(5n)], 0)
    })
    const a = await Effect.runPromise(Approval.fromRecipeOffline(recipe))
    expect(a.ids.map((i) => new TextDecoder().decode(i))).toEqual(["a", "b", "a"])
    expect(a.ptb.commands.length).toBe(3)
  })

  test("unresolved object inputs are refused offline", async () => {
    const recipe = Effect.gen(function*() {
      yield* Approval.call({ target, id: utf8("a"), arguments: [yield* Ptb.object("0x123")] })
    })
    const exit = await Effect.runPromise(Effect.flip(Approval.fromRecipeOffline(recipe)))
    expect(exit._tag).toBe("InvalidApproval")
    expect((exit as { reason: string }).reason).toContain("fromRecipe")
  })
})

describe("P1, with the key server's wording", () => {
  const base: T.ProgrammableTransaction = { inputs: [idArg(utf8("i"))], commands: [moveCall()] }

  test("each rule", () => {
    const cases: Array<[T.ProgrammableTransaction, string]> = [
      [{ ...base, commands: Array.from({ length: 101 }, () => moveCall()) }, "Too many commands in PTB (more than 100)"],
      [{ inputs: [], commands: [moveCall()] }, "Empty PTB input or command"],
      [{ ...base, commands: [] }, "Empty PTB input or command"],
      [{ ...base, commands: [{ _tag: "MergeCoins", destination: input(0), sources: [] }] }, "Invalid first command"],
      [{ ...base, commands: [moveCall(), { _tag: "TransferObjects", objects: [], address: input(0) }] }, "Non MoveCall command"],
      [{ ...base, commands: [moveCall({ args: [input(0), { _tag: "GasCoin" }] })] }, "Only pure inputs are allowed"],
      [{ ...base, commands: [moveCall({ args: [input(0), { _tag: "Result", value: 0 }] })] }, "Only pure inputs are allowed"],
      [{ ...base, commands: [moveCall({ args: [] })] }, "Empty args"],
      [{ ...base, commands: [moveCall({ args: [input(5)] })] }, "Invalid first parameter for seal_approve"],
      [{
        inputs: [{ _tag: "Object", value: { _tag: "SharedObject", objectId: Address.CLOCK, initialSharedVersion: 1n, mutability: { _tag: "Immutable" } } }],
        commands: [moveCall()]
      }, "Invalid first parameter for seal_approve"],
      [{ inputs: [pure(new Uint8Array([5, 1]))], commands: [moveCall()] }, "Invalid BCS for first parameter for seal_approve"],
      [{ inputs: [pure(new Uint8Array([1, 1, 1]))], commands: [moveCall()] }, "Invalid BCS for first parameter for seal_approve"],
      [{ ...base, commands: [moveCall({ fn: "approve" })] }, "Invalid function or package id"],
      [{ ...base, commands: [moveCall(), moveCall({ pkg: OTHER })] }, "Invalid function or package id"]
    ]
    for (const [ptb, expected] of cases) expect(reason(Approval.fromProgrammable(ptb))).toStartWith(expected)
  })

  test("100 commands and an empty id are fine (the server only decodes it); fromBytes refuses trailing bytes", () => {
    expect(ok(Approval.fromProgrammable({ ...base, commands: Array.from({ length: 100 }, () => moveCall()) })).ids.length).toBe(100)
    expect(ok(Approval.fromProgrammable({ inputs: [idArg(new Uint8Array())], commands: [moveCall()] })).ids).toEqual([new Uint8Array()])
    const bytes = Bcs.encodeSync(T.ProgrammableTransaction)(base)
    expect(reason(Approval.fromBytes(new Uint8Array([...bytes, 0])))).toBe("Invalid BCS")
  })
})

describe("fromTransactionKindBytes (item 15)", () => {
  const build = async (onlyTransactionKind: boolean) => {
    const tx = new Transaction()
    tx.moveCall({ target, arguments: [tx.pure.vector("u8", [1, 2, 3])] })
    tx.moveCall({ target, arguments: [tx.pure.vector("u8", [4]), tx.object.clock()] })
    if (onlyTransactionKind) return tx.build({ onlyTransactionKind: true })
    tx.setSender(Address.normalize("0x1"))
    tx.setGasPrice(1000)
    tx.setGasBudget(1000)
    tx.setGasPayment([{ objectId: Address.normalize("0x77"), version: "1", digest: base58.encode(new Uint8Array(32)) }])
    tx.setExpiration({ None: true })
    return tx.build()
  }

  test("@mysten/sui's onlyTransactionKind bytes: same PTB as ours", async () => {
    const kind = await build(true)
    const a = ok(Approval.fromTransactionKindBytes(kind))
    expect(a.ids).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4])])
    expect(hex(a.bytes)).toBe(hex(kind.slice(1)))
    const ours = await Effect.runPromise(Approval.fromRecipeOffline(Effect.gen(function*() {
      yield* Approval.call({ target, id: new Uint8Array([1, 2, 3]) })
      yield* Approval.call({ target, id: new Uint8Array([4]), arguments: [Ptb.clock] })
    })))
    expect(hex(ours.bytes)).toBe(hex(a.bytes))
  })

  test("full transaction bytes, a wrong tag, trailing bytes and empty input are refused", async () => {
    const full = await build(false)
    expect(reason(Approval.fromTransactionKindBytes(full))).toContain("full TransactionData bytes")
    const kind = await build(true)
    expect(reason(Approval.fromTransactionKindBytes(new Uint8Array([1, ...kind.slice(1)])))).toContain("tag 1")
    expect(reason(Approval.fromTransactionKindBytes(new Uint8Array([...kind, 0])))).toBe("Invalid BCS for TransactionKind")
    expect(reason(Approval.fromTransactionKindBytes(new Uint8Array()))).toContain("empty")
  })
})

describe("fromRecipe (object inputs resolved)", () => {
  const D = (n: number) => base58.encode(new Uint8Array(32).fill(n)) as T.ObjectDigest
  const OWNED = Address.normalize("0x0a")
  const SHARED = Address.normalize("0x0b")
  const objects: Record<string, Objects.SuiObject> = {
    [OWNED]: { objectId: OWNED, version: 7n, digest: D(7), owner: { _tag: "AddressOwner", address: Address.normalize("0x1") }, type: `${PKG}::private_data::PrivateData`, contents: new Uint8Array(), previousTransaction: undefined },
    [SHARED]: { objectId: SHARED, version: 9n, digest: D(9), owner: { _tag: "Shared", initialSharedVersion: 3n }, type: `${PKG}::whitelist::Whitelist`, contents: new Uint8Array(), previousTransaction: undefined },
    [Address.CLOCK]: { objectId: Address.CLOCK, version: 100n, digest: D(1), owner: { _tag: "Shared", initialSharedVersion: 1n }, type: "0x2::clock::Clock", contents: new Uint8Array(), previousTransaction: undefined }
  }
  const layer = Layer.mergeAll(
    Layer.succeed(Objects.Objects, {
      get: (id) => {
        const o = objects[id]
        return o ? Effect.succeed(o) : Effect.fail(new Objects.ObjectNotFound({ objectId: id }))
      },
      listOwned: () => Stream.empty
    }),
    Layer.succeed(Packages.Packages, {
      getFunction: () =>
        Effect.succeed({
          isEntry: true,
          parameters: [
            { reference: "Value", typeName: undefined },
            { reference: "Immutable", typeName: "x" },
            { reference: "Immutable", typeName: "y" },
            { reference: "Immutable", typeName: "z" }
          ]
        }),
      getModules: () => Effect.die("unused")
    })
  )

  test("an owned, a shared and the Clock input", async () => {
    const recipe = Effect.gen(function*() {
      yield* Approval.call({
        target,
        id: utf8("i"),
        arguments: [Ptb.object(OWNED), Ptb.object(SHARED), Ptb.object(Address.CLOCK)]
      })
    })
    const a = await Effect.runPromise(Approval.fromRecipe(recipe).pipe(Effect.provide(layer)))
    expect(a.ptb.inputs.slice(1)).toEqual([
      { _tag: "Object", value: { _tag: "ImmOrOwnedObject", objectId: OWNED, version: 7n, digest: D(7) } },
      { _tag: "Object", value: { _tag: "SharedObject", objectId: SHARED, initialSharedVersion: 3n, mutability: { _tag: "Immutable" } } },
      { _tag: "Object", value: { _tag: "SharedObject", objectId: Address.CLOCK, initialSharedVersion: 1n, mutability: { _tag: "Immutable" } } }
    ])
    expect(a.ids).toEqual([utf8("i")])
  })
})
