/**
 * Every recipe builds offline from a fixed `System` (the recorded testnet
 * state): calls go to the system's package id (never the generated default),
 * the system object is a shared input with the right mutability, WAL is one
 * exact coin intent destroyed afterwards, and pure inputs encode as Move
 * expects them.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as Ptb from "@unconfirmed/sui/Ptb"
import type * as T from "@unconfirmed/sui/TransactionData"
import * as TypeTag from "@unconfirmed/sui/TypeTag"
import * as BlobId from "../src/BlobId.ts"
import * as Certificate from "../src/Certificate.ts"
import * as Config from "../src/Config.ts"
import * as Cost from "../src/Cost.ts"
import * as Encoding from "../src/Encoding.ts"
import { Package } from "../src/generated/walrus/$package.ts"
import * as Messages from "../src/Messages.ts"
import * as Recipes from "../src/Recipes.ts"
import * as System from "../src/System.ts"
import { loadFixture, objectsLayer, packagesLayer } from "./fixtures.ts"

const fixture = loadFixture("testnet")
/** Not the generated default: proves calls take the id from the system object. */
const PKG = Address.normalize("0xfeed")
let state: System.SystemState
let walType: string

beforeAll(async () => {
  const live = await Effect.runPromise(
    Effect.flatMap(Effect.service(System.System), (s) => Effect.zip(s.state, s.walType)).pipe(
      Effect.provide(System.layer.pipe(
        Layer.provide(Layer.mergeAll(objectsLayer(fixture).layer, packagesLayer(fixture), Config.layer(fixture.config)))
      ))
    )
  )
  state = { ...live[0], packageId: PKG }
  walType = live[1]
})

const build = <A, E>(recipe: Effect.Effect<A, E, Recipes.RecipeServices>) =>
  Effect.runPromise(Ptb.build(recipe).pipe(Effect.provide(System.layerFromState(state, walType))))

const buildFail = <A, E>(recipe: Effect.Effect<A, E, Recipes.RecipeServices>) =>
  Effect.runPromise(Ptb.build(recipe).pipe(Effect.flip, Effect.provide(System.layerFromState(state, walType))))

type MoveCall = Extract<T.Command, { _tag: "MoveCall" }>
const calls = (draft: Ptb.Draft) =>
  draft.commands.map((c) =>
    c._tag === "MoveCall" ? `${c.package === PKG ? "PKG" : c.package}::${c.module}::${c.function}` : c._tag
  )
const call = (draft: Ptb.Draft, fn: string) => draft.commands.find((c) => c._tag === "MoveCall" && c.function === fn) as MoveCall
const pureAt = (draft: Ptb.Draft, a: T.Argument) => {
  if (a._tag !== "Input") throw new Error("not an input")
  const input = draft.inputs[a.value]!
  if (input._tag !== "Pure") throw new Error("not pure")
  return input.bytes
}
const systemInput = (draft: Ptb.Draft) => {
  const i = draft.inputs.findIndex((x) => x._tag === "Object" && x.value._tag === "SharedObject" && x.value.objectId === state.systemObjectId)
  const input = draft.inputs[i]!
  if (input._tag !== "Object" || input.value._tag !== "SharedObject") throw new Error("no system input")
  return { index: i, mutable: input.value.mutability._tag === "Mutable", isv: input.value.initialSharedVersion }
}
const intents = (draft: Ptb.Draft) => draft.commands.filter((c): c is Extract<Ptb.Command, { _tag: "BalanceIntent" }> => c._tag === "BalanceIntent")

const BLOB_ID = BlobId.fromU256(0x1234_5678_9abc_def0n)
const ROOT = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const LENGTH = 100_000

describe("registerBlob", () => {
  test("one coin pays space and write; reserve, register, destroy_zero", async () => {
    const { draft, value } = await build(
      Recipes.registerBlob({ blobId: BLOB_ID, rootHash: ROOT, unencodedLength: LENGTH, epochs: 3, deletable: true })
    )
    expect(calls(draft)).toEqual(["BalanceIntent", "PKG::system::reserve_space", "PKG::system::register_blob", `${Address.SUI_FRAMEWORK}::coin::destroy_zero`])
    expect(value).toEqual({ _tag: "NestedResult", value: [2, 0] })

    const cost = Cost.cost(LENGTH, 3, { storage: state.storagePrice, write: state.writePrice }, state.nShards)
    const [coin] = intents(draft)
    expect(coin!.amount).toBe(cost.total)
    expect(coin!.coinType).toBe(walType)
    expect(coin!.output).toBe("coin")

    const sys = systemInput(draft)
    expect(sys).toEqual({ index: 0, mutable: true, isv: state.initialSharedVersion })

    const reserve = call(draft, "reserve_space")
    expect(reserve.arguments[0]).toEqual({ _tag: "Input", value: 0 })
    expect(Bcs.decodeSync(Bcs.u64)(pureAt(draft, reserve.arguments[1]!))).toBe(BigInt(cost.encodedLength))
    expect(Bcs.decodeSync(Bcs.u32)(pureAt(draft, reserve.arguments[2]!))).toBe(3)
    expect(reserve.arguments[3]).toEqual({ _tag: "Result", value: 0 })

    const register = call(draft, "register_blob")
    const [self, storage, blobId, root, size, enc, deletable, payment] = register.arguments
    expect(self).toEqual({ _tag: "Input", value: 0 })
    expect(storage).toEqual({ _tag: "NestedResult", value: [1, 0] })
    expect(Bcs.decodeSync(Bcs.u256)(pureAt(draft, blobId!))).toBe(BlobId.toU256(BLOB_ID))
    // The root hash goes in as a little-endian u256: its BCS bytes are the hash itself.
    expect(pureAt(draft, root!)).toEqual(ROOT)
    expect(Bcs.decodeSync(Bcs.u64)(pureAt(draft, size!))).toBe(BigInt(LENGTH))
    expect(Bcs.decodeSync(Bcs.u8)(pureAt(draft, enc!))).toBe(Encoding.RS2)
    expect(Bcs.decodeSync(Bcs.bool)(pureAt(draft, deletable!))).toBe(true)
    expect(payment).toEqual({ _tag: "Result", value: 0 })

    const destroy = call(draft, "destroy_zero")
    expect(destroy.arguments).toEqual([{ _tag: "Result", value: 0 }])
    expect(destroy.typeArguments).toEqual([TypeTag.parse(walType)])
  })

  test("with a Storage given: the coin pays the write only, no reserve_space", async () => {
    const { draft } = await build(
      Effect.gen(function*() {
        const storage = yield* Recipes.reserveSpace({ unencodedLength: LENGTH, epochs: 2 })
        return yield* Recipes.registerBlob({ blobId: BLOB_ID, rootHash: ROOT, unencodedLength: LENGTH, epochs: 2, deletable: false, storage })
      })
    )
    const cost = Cost.cost(LENGTH, 2, { storage: state.storagePrice, write: state.writePrice }, state.nShards)
    expect(calls(draft).filter((c) => c !== "BalanceIntent")).toEqual([
      "PKG::system::reserve_space",
      `${Address.SUI_FRAMEWORK}::coin::destroy_zero`,
      "PKG::system::register_blob",
      `${Address.SUI_FRAMEWORK}::coin::destroy_zero`
    ])
    expect(intents(draft).map((i) => i.amount)).toEqual([cost.storage, cost.write])
    expect(call(draft, "register_blob").arguments[1]).toEqual({ _tag: "NestedResult", value: [1, 0] })
    // one system input, shared by both calls
    expect(draft.inputs.filter((i) => i._tag === "Object")).toHaveLength(1)
  })

  test("attributes: metadata::new, add_metadata, one insert per entry in record order", async () => {
    const { draft } = await build(
      Recipes.registerBlob({
        blobId: BLOB_ID,
        rootHash: ROOT,
        unencodedLength: 10,
        epochs: 1,
        deletable: true,
        attributes: { _walrusBlobType: "quilt", a: "1" }
      })
    )
    expect(calls(draft).slice(2)).toEqual([
      "PKG::system::register_blob",
      "PKG::metadata::new",
      "PKG::blob::add_metadata",
      "PKG::blob::insert_or_update_metadata_pair",
      "PKG::blob::insert_or_update_metadata_pair",
      `${Address.SUI_FRAMEWORK}::coin::destroy_zero`
    ])
    const inserts = draft.commands.filter((c): c is MoveCall => c._tag === "MoveCall" && c.function === "insert_or_update_metadata_pair")
    expect(inserts.map((c) => [c.arguments[0], Bcs.decodeSync(Bcs.string)(pureAt(draft, c.arguments[1]!)), Bcs.decodeSync(Bcs.string)(pureAt(draft, c.arguments[2]!))]))
      .toEqual([
        [{ _tag: "NestedResult", value: [2, 0] }, "_walrusBlobType", "quilt"],
        [{ _tag: "NestedResult", value: [2, 0] }, "a", "1"]
      ])
    expect(call(draft, "add_metadata").arguments).toEqual([{ _tag: "NestedResult", value: [2, 0] }, { _tag: "NestedResult", value: [3, 0] }])
  })

  test("a blob over the maximum size is BlobTooLarge, before anything is added", async () => {
    const e = await buildFail(
      Recipes.registerBlob({ blobId: BLOB_ID, rootHash: ROOT, unencodedLength: Encoding.maxBlobSize(1000) + 1, epochs: 1, deletable: true })
    )
    expect(e._tag).toBe("BlobTooLarge")
  })
})

describe("reserveSpace", () => {
  test("an exact storage-cost coin, or the caller's payment", async () => {
    const own = await build(Recipes.reserveSpace({ unencodedLength: 1, epochs: 5 }))
    expect(calls(own.draft)).toEqual(["BalanceIntent", "PKG::system::reserve_space", `${Address.SUI_FRAMEWORK}::coin::destroy_zero`])
    expect(intents(own.draft)[0]!.amount).toBe(63n * state.storagePrice * 5n) // E4: a 1-byte blob is 63 units
    expect(own.value).toEqual({ _tag: "NestedResult", value: [1, 0] })

    const paid = await build(Effect.flatMap(Ptb.object("0xc0"), (payment) => Recipes.reserveSpace({ unencodedLength: 1, epochs: 5, payment })))
    expect(calls(paid.draft)).toEqual(["PKG::system::reserve_space"])
    expect(call(paid.draft, "reserve_space").arguments[3]).toEqual({ _tag: "Input", value: 0 })
  })
})

describe("certifyBlob", () => {
  const message = Messages.confirmationMessage(594, BLOB_ID, { _tag: "Permanent" })
  test("immutable shared system, the blob, signature, bitmap over the system committee, message", async () => {
    const certificate: Certificate.Certificate = { epoch: 594, signers: [0, 3, 8, 98], serializedMessage: message, signature: new Uint8Array(96).fill(7) }
    const blobObjectId = Address.normalize("0xb10b")
    const { draft } = await build(Recipes.certifyBlob({ blobObjectId, certificate }))
    expect(calls(draft)).toEqual(["PKG::system::certify_blob"])
    expect(systemInput(draft)).toEqual({ index: 0, mutable: false, isv: state.initialSharedVersion })
    expect(draft.inputs[1]).toEqual({ _tag: "UnresolvedObject", objectId: blobObjectId })
    const [, , sig, bitmap, msg] = call(draft, "certify_blob").arguments
    expect(Bcs.decodeSync(Bcs.byteVector)(pureAt(draft, sig!))).toEqual(certificate.signature)
    const bits = Bcs.decodeSync(Bcs.byteVector)(pureAt(draft, bitmap!))
    expect(bits).toEqual(Certificate.signersBitmap(certificate.signers, 99))
    expect(bits.length).toBe(13)
    expect(Bcs.decodeSync(Bcs.byteVector)(pureAt(draft, msg!))).toEqual(message)
  })

  test("a signer outside the committee is a typed error", async () => {
    const certificate: Certificate.Certificate = { epoch: 594, signers: [99], serializedMessage: message, signature: new Uint8Array(96) }
    const e = await buildFail(Recipes.certifyBlob({ blobObjectId: Address.normalize("0xb10b"), certificate }))
    expect(e._tag).toBe("InvalidPureValue")
  })
})

describe("delete, extend, burn, destroy", () => {
  const blobObjectId = Address.normalize("0xb10b")

  test("deleteBlob returns the Storage; destroyStorage drops it", async () => {
    const { draft, value } = await build(Effect.flatMap(Recipes.deleteBlob(blobObjectId), Recipes.destroyStorage))
    expect(calls(draft)).toEqual(["PKG::system::delete_blob", "PKG::storage_resource::destroy"])
    expect(systemInput(draft).mutable).toBe(false)
    expect(call(draft, "destroy").arguments).toEqual([{ _tag: "NestedResult", value: [0, 0] }])
    expect(value).toBeUndefined()
  })

  test("extendBlob: an exact coin for units × storage price × epochs", async () => {
    const storageSize = Encoding.encodedLength(LENGTH, 1000)
    const { draft } = await build(Recipes.extendBlob({ blobObjectId, storageSize, epochs: 4 }))
    expect(calls(draft)).toEqual(["BalanceIntent", "PKG::system::extend_blob", `${Address.SUI_FRAMEWORK}::coin::destroy_zero`])
    expect(intents(draft)[0]!.amount).toBe(BigInt(Encoding.storageUnits(storageSize)) * state.storagePrice * 4n)
    expect(systemInput(draft).mutable).toBe(true)
    const [, blob, epochs, coin] = call(draft, "extend_blob").arguments
    expect(draft.inputs[(blob as { value: number }).value]).toEqual({ _tag: "UnresolvedObject", objectId: blobObjectId })
    expect(Bcs.decodeSync(Bcs.u32)(pureAt(draft, epochs!))).toBe(4)
    expect(coin).toEqual({ _tag: "Result", value: 0 })
  })

  test("burnBlob", async () => {
    const { draft } = await build(Recipes.burnBlob(blobObjectId))
    expect(calls(draft)).toEqual(["PKG::blob::burn"])
    expect(draft.inputs).toEqual([{ _tag: "UnresolvedObject", objectId: blobObjectId }])
  })

  test("blobType uses the type-origin package", async () => {
    const t = await Effect.runPromise(Recipes.blobType.pipe(Effect.provide(System.layerFromState(state, walType))))
    expect(t).toBe(`${state.typeOrigin}::blob::Blob`)
  })
})

test("the generated Package default is untouched by recipes (it stays the testnet id)", async () => {
  const id = await Effect.runPromise(Effect.gen(function*() { return yield* Package }))
  expect(id).toBe(Address.normalize("0x7d3b2086808a62bbc44d18c6b1d407973d77dd26946735873092c2f5650b4611"))
})
