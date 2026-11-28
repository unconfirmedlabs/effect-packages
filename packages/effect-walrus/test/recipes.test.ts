/**
 * Recipes built offline from a fixed `System` (the recorded testnet state),
 * for what command-level parity with `@mysten/walrus`
 * (`parity.recipes.test.ts`) cannot show: calls go to the system's package id
 * (never the generated default), WAL is one exact coin intent destroyed
 * afterwards, and the branches Mysten has no builder for.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import type * as T from "@unconfirmed/effect-sui/TransactionData"
import * as TypeTag from "@unconfirmed/effect-sui/TypeTag"
import * as BlobId from "../src/BlobId.ts"
import * as Certificate from "../src/Certificate.ts"
import * as Config from "../src/Config.ts"
import * as Cost from "../src/Cost.ts"
import * as Encoding from "../src/Encoding.ts"
import * as Messages from "../src/Messages.ts"
import * as Recipes from "../src/Recipes.ts"
import * as System from "../src/System.ts"
import { loadFixture, objectsLayer } from "./fixtures.ts"

const fixture = loadFixture("testnet")
/** Not the generated default: proves calls take the id from the system object. */
const PKG = Address.normalize("0xfeed")
let state: System.SystemState
let walType: string

beforeAll(async () => {
  const live = await Effect.runPromise(
    Effect.flatMap(Effect.service(System.System), (s) => Effect.zip(s.state, s.walType)).pipe(
      Effect.provide(System.layer.pipe(
        Layer.provide(Layer.mergeAll(objectsLayer(fixture).layer, Config.layer(fixture.config)))
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
    expect(value).toEqual({ _tag: "Result", value: 2 })

    const cost = Cost.cost(LENGTH, 3, { storage: state.storagePrice, write: state.writePrice }, state.nShards)
    expect(intents(draft).map((c) => [c.amount, c.coinType, c.output])).toEqual([[cost.total, walType, "coin"]])
    expect(systemInput(draft)).toEqual({ index: 0, mutable: true, isv: state.initialSharedVersion })

    expect(call(draft, "destroy_zero").typeArguments).toEqual([TypeTag.parse(walType)])
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
    expect(call(draft, "register_blob").arguments[1]).toEqual({ _tag: "Result", value: 1 })
    // one system input, shared by both calls
    expect(draft.inputs.filter((i) => i._tag === "Object")).toHaveLength(1)
  })

  test("a blob over the maximum size is BlobTooLarge, before anything is added", async () => {
    const e = await buildFail(
      Recipes.registerBlob({ blobId: BLOB_ID, rootHash: ROOT, unencodedLength: Encoding.maxBlobSize(1000) + 1, epochs: 1, deletable: true })
    )
    expect(e._tag).toBe("BlobTooLarge")
  })
})

describe("reserveSpace", () => {
  test("the caller's payment instead of a coin", async () => {
    const paid = await build(Effect.flatMap(Ptb.object("0xc0"), (payment) => Recipes.reserveSpace({ unencodedLength: 1, epochs: 5, payment })))
    expect(calls(paid.draft)).toEqual(["PKG::system::reserve_space"])
    expect(call(paid.draft, "reserve_space").arguments[3]).toEqual({ _tag: "Input", value: 0 })
  })
})

describe("certifyBlob", () => {
  const message = Messages.confirmationMessage(594, BLOB_ID, { _tag: "Permanent" })
  test("a signer outside the committee is a typed error", async () => {
    const certificate: Certificate.Certificate = { epoch: 594, signers: [99], serializedMessage: message, signature: new Uint8Array(96) }
    const e = await buildFail(Recipes.certifyBlob({ blobObjectId: Address.normalize("0xb10b"), certificate }))
    expect(e._tag).toBe("InvalidPureValue")
  })
})
