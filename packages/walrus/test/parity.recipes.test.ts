/**
 * Command-level parity with `@mysten/walrus` 2.0.1: for the same recorded
 * testnet state, our recipes and Mysten's `*Transaction` builders give the
 * same commands and inputs, compared through transaction JSON
 * (`TransactionJson` / `Transaction.toJSON`).
 *
 * Mysten's client runs against a fake `SuiClient` that serves the recorded
 * objects. Two differences are intended and asserted explicitly:
 * - one WAL coin per transaction instead of one per cost (storage, write):
 *   the canonical form folds every WAL coin into one symbol and drops the
 *   `destroy_zero` calls, then the amounts and counts are compared;
 * - the system object is a shared input with its initial version and the
 *   mutability of the call (Mysten leaves it for resolution to look up):
 *   object inputs are compared by id, and the mutability is asserted.
 */
import { ClientCache } from "@mysten/sui/client"
import { WalrusClient } from "@mysten/walrus"
import { beforeAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as Ptb from "@unconfirmed/sui/Ptb"
import * as TransactionJson from "@unconfirmed/sui/TransactionJson"
import * as BlobId from "../src/BlobId.ts"
import type * as Certificate from "../src/Certificate.ts"
import * as Config from "../src/Config.ts"
import * as Encoding from "../src/Encoding.ts"
import * as blob from "../src/generated/walrus/blob.ts"
import * as Messages from "../src/Messages.ts"
import * as Recipes from "../src/Recipes.ts"
import * as System from "../src/System.ts"
import { loadFixture, objectsLayer, packagesLayer, restoreObject } from "./fixtures.ts"

const fixture = loadFixture("testnet")
const OWNER = Address.normalize("0xa11ce")
const BLOB_OBJECT = Address.normalize("0xb10b")
const LENGTH = 12_345
const ROOT = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
const BLOB_ID = BlobId.fromU256(0xdead_beef_0123_4567_89abn << 64n)

let state: System.SystemState
let walType: string
let mysten: WalrusClient

/** A `Blob` for Mysten's `extendBlob`, which reads the object first. */
const blobObject = () => ({
  objectId: BLOB_OBJECT,
  type: `${state.typeOrigin}::blob::Blob`,
  content: Bcs.encodeSync(blob.Blob)({
    id: BLOB_OBJECT,
    registered_epoch: state.epoch,
    blob_id: BlobId.toU256(BLOB_ID),
    size: BigInt(LENGTH),
    encoding_type: 1,
    certified_epoch: Option.some(state.epoch),
    storage: {
      id: Address.normalize("0x5707"),
      start_epoch: state.epoch,
      end_epoch: state.epoch + 2,
      storage_size: BigInt(Encoding.encodedLength(LENGTH, state.nShards))
    },
    deletable: true
  })
})

beforeAll(async () => {
  ;[state, walType] = await Effect.runPromise(
    Effect.flatMap(Effect.service(System.System), (s) => Effect.zip(s.state, s.walType)).pipe(
      Effect.provide(System.layer.pipe(
        Layer.provide(Layer.mergeAll(objectsLayer(fixture).layer, packagesLayer(fixture), Config.layer(fixture.config)))
      ))
    )
  )
  const objects = new Map<string, { objectId: string; type: string; content: Uint8Array }>(
    fixture.objects.map((r) => {
      const o = restoreObject(r)
      return [o.objectId, { objectId: o.objectId, type: o.type, content: o.contents }]
    })
  )
  objects.set(BLOB_OBJECT, blobObject())
  const fakeSui = {
    network: "testnet",
    cache: new ClientCache(),
    core: {
      getObjects: async ({ objectIds }: { objectIds: ReadonlyArray<string> }) => ({
        objects: objectIds.map((id) => objects.get(Address.normalize(id)) ?? new Error(`not found: ${id}`))
      }),
      // `#walType`: `staking::stake_with_pool`'s second parameter is `Coin<WAL>`.
      getMoveFunction: async () => ({
        function: {
          parameters: [
            { body: { $kind: "unknown" } },
            {
              body: {
                $kind: "datatype",
                datatype: {
                  typeName: "0x2::coin::Coin",
                  typeParameters: [{ $kind: "datatype", datatype: { typeName: walType, typeParameters: [] } }]
                }
              }
            }
          ]
        }
      })
    }
  }
  mysten = new WalrusClient({ network: "testnet", suiClient: fakeSui as never })
})

// -----------------------------------------------------------------------------
// Canonical form
// -----------------------------------------------------------------------------

type Json = any

const isWalCoin = (c: Json) => c.$Intent?.name === "CoinWithBalance"
const isDestroyZero = (c: Json) => c.MoveCall?.function === "destroy_zero" && c.MoveCall?.module === "coin"

/**
 * Commands with every WAL coin intent folded into `"WAL"` and the
 * `destroy_zero` calls dropped (results renumbered); inputs by object id or
 * pure bytes. Also returns the coin amounts and the number of `destroy_zero`s.
 */
const canonical = (json: Json) => {
  const input = (i: number) => {
    const x = json.inputs[i]
    if (x.Pure) return { pure: x.Pure.bytes }
    if (x.UnresolvedObject) return { object: Address.normalize(x.UnresolvedObject.objectId) }
    if (x.Object?.SharedObject) return { object: Address.normalize(x.Object.SharedObject.objectId) }
    if (x.Object?.ImmOrOwnedObject) return { object: Address.normalize(x.Object.ImmOrOwnedObject.objectId) }
    throw new Error(`unexpected input ${JSON.stringify(x)}`)
  }
  const renumber = new Map<number, number | "WAL">()
  let next = 0
  json.commands.forEach((c: Json, i: number) => {
    if (isWalCoin(c)) renumber.set(i, "WAL")
    else if (!isDestroyZero(c)) renumber.set(i, next++)
  })
  const arg = (a: Json): Json => {
    if (a.Input !== undefined) return input(a.Input)
    if (a.GasCoin) return "gas"
    const [cmd, sub] = a.Result !== undefined ? [a.Result, undefined] : a.NestedResult
    const to = renumber.get(cmd)
    if (to === "WAL") return "WAL"
    return sub === undefined ? { result: to } : { result: to, index: sub }
  }
  const commands = json.commands.flatMap((c: Json) => {
    if (isWalCoin(c) || isDestroyZero(c)) return []
    if (c.MoveCall) {
      const m = c.MoveCall
      return [{
        call: `${Address.normalize(m.package)}::${m.module}::${m.function}`,
        typeArguments: m.typeArguments,
        arguments: m.arguments.map(arg)
      }]
    }
    if (c.TransferObjects) return [{ transfer: c.TransferObjects.objects.map(arg), to: arg(c.TransferObjects.address) }]
    throw new Error(`unexpected command ${JSON.stringify(c)}`)
  })
  return {
    commands,
    coins: json.commands.filter(isWalCoin).map((c: Json) => ({ type: c.$Intent.data.type, amount: BigInt(c.$Intent.data.balance) })),
    destroyZero: json.commands.filter(isDestroyZero).map((c: Json) => c.MoveCall.typeArguments)
  }
}

const theirs = async (tx: { toJSON: (o: object) => Promise<string> }) =>
  canonical(JSON.parse(await tx.toJSON({ supportedIntents: ["CoinWithBalance"] })))

const ours = async <A, E>(recipe: Effect.Effect<A, E, Recipes.RecipeServices>) => {
  const json = await Effect.runPromise(
    Ptb.build(recipe).pipe(
      Effect.flatMap(({ draft }) => TransactionJson.toJson({ draft })),
      Effect.provide(System.layerFromState(state, walType))
    )
  )
  return { canonical: canonical(JSON.parse(JSON.stringify(json))), json: json as Json }
}

const systemMutability = (json: Json) =>
  json.inputs.map((i: Json) => i.Object?.SharedObject).filter((s: Json) => s !== undefined)
    .map((s: Json) => ({ objectId: Address.normalize(s.objectId), mutable: s.mutable, initialSharedVersion: String(s.initialSharedVersion) }))

const systemShared = (mutable: boolean) => [{
  objectId: state.systemObjectId,
  mutable,
  initialSharedVersion: state.initialSharedVersion.toString()
}]

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("register (registerBlobTransaction)", () => {
  for (const attributes of [undefined, { _walrusBlobType: "quilt", contentType: "text/plain" }]) {
    test(attributes === undefined ? "plain" : "with attributes", async () => {
      const them = await theirs(
        mysten.registerBlobTransaction({ size: LENGTH, epochs: 3, blobId: BLOB_ID, rootHash: ROOT, deletable: true, owner: OWNER, ...(attributes && { attributes }) })
      )
      const us = await ours(Effect.gen(function*() {
        const b = yield* Recipes.registerBlob({ blobId: BLOB_ID, rootHash: ROOT, unencodedLength: LENGTH, epochs: 3, deletable: true, ...(attributes && { attributes }) })
        yield* Ptb.transferObjects([b], yield* Ptb.address(OWNER))
      }))
      expect(us.canonical.commands).toEqual(them.commands)
      expect(us.canonical.commands[0].call).toBe(`${state.packageId}::system::reserve_space`)

      // The intended difference: one WAL coin for space and write, instead of two.
      expect(them.coins).toHaveLength(2)
      expect(them.destroyZero).toHaveLength(2)
      expect(us.canonical.coins).toEqual([{ type: them.coins[0].type, amount: them.coins[0].amount + them.coins[1].amount }])
      expect(us.canonical.destroyZero).toEqual([them.destroyZero[0]])
      expect(systemMutability(us.json)).toEqual(systemShared(true))
    })
  }
})

describe("certify (certifyBlobTransaction)", () => {
  for (const deletable of [false, true]) {
    test(deletable ? "deletable" : "permanent", async () => {
      const persistence: Messages.Persistence = deletable ? { _tag: "Deletable", objectId: BLOB_OBJECT } : { _tag: "Permanent" }
      const certificate: Certificate.Certificate = {
        epoch: state.epoch,
        signers: [1, 2, 5, 40, 41, 98],
        serializedMessage: Messages.confirmationMessage(state.epoch, BLOB_ID, persistence),
        signature: Uint8Array.from({ length: 96 }, (_, i) => i)
      }
      const them = await theirs(mysten.certifyBlobTransaction({
        blobId: BLOB_ID,
        blobObjectId: BLOB_OBJECT,
        deletable,
        certificate: { signers: [...certificate.signers], serializedMessage: certificate.serializedMessage, signature: certificate.signature }
      } as never))
      const us = await ours(Recipes.certifyBlob({ blobObjectId: BLOB_OBJECT, certificate }))
      expect(us.canonical.commands).toEqual(them.commands)
      expect(them.coins).toEqual([])
      expect(systemMutability(us.json)).toEqual(systemShared(false))
    })
  }
})

describe("the other recipes", () => {
  test("reserveSpace (createStorageTransaction)", async () => {
    const them = await theirs(mysten.createStorageTransaction({ size: LENGTH, epochs: 7, owner: OWNER }))
    const us = await ours(Effect.gen(function*() {
      const s = yield* Recipes.reserveSpace({ unencodedLength: LENGTH, epochs: 7 })
      yield* Ptb.transferObjects([s], yield* Ptb.address(OWNER))
    }))
    expect(us.canonical).toEqual(them)
  })

  test("deleteBlob (deleteBlobTransaction)", async () => {
    const them = await theirs(mysten.deleteBlobTransaction({ blobObjectId: BLOB_OBJECT, owner: OWNER }))
    const us = await ours(Effect.gen(function*() {
      const s = yield* Recipes.deleteBlob(BLOB_OBJECT)
      yield* Ptb.transferObjects([s], yield* Ptb.address(OWNER))
    }))
    expect(us.canonical).toEqual(them)
    expect(systemMutability(us.json)).toEqual(systemShared(false))
  })

  test("extendBlob (extendBlobTransaction)", async () => {
    const them = await theirs(await mysten.extendBlobTransaction({ blobObjectId: BLOB_OBJECT, epochs: 5 }))
    const storageSize = Encoding.encodedLength(LENGTH, state.nShards)
    const us = await ours(Recipes.extendBlob({ blobObjectId: BLOB_OBJECT, storageSize, epochs: 5 }))
    expect(us.canonical).toEqual(them)
    expect(systemMutability(us.json)).toEqual(systemShared(true))
  })
})
