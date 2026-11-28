/**
 * PTB recipes for Walrus storage operations (C8). Each is an ordinary recipe
 * step (`Ptb.PtbBuilder`), built on the generated call builders with the
 * package id read from the system object (never the generated default), so
 * they work on any deployment and after upgrades.
 *
 *   const blob = yield* Recipes.registerBlob({ blobId, rootHash, unencodedLength, epochs: 3, deletable: true })
 *   yield* Ptb.transferObjects([blob], yield* Ptb.address(owner))
 *
 * WAL is paid with one `Ptb.coin` intent per recipe, exact for the prices read
 * at build time, and the emptied coin is destroyed (`0x2::coin::destroy_zero`).
 * A price change before execution aborts the transaction: nothing but gas is
 * spent, and the step can be rebuilt.
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Address from "@unconfirmed/effect-sui/Address"
import type * as Move from "@unconfirmed/effect-sui/Move"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import * as BlobId from "./BlobId.ts"
import type { Certificate } from "./Certificate.ts"
import { signersBitmap } from "./Certificate.ts"
import * as Encoding from "./Encoding.ts"
import type { BlobTooLarge } from "./Errors.ts"
import { Package } from "./generated/walrus/$package.ts"
import * as blob from "./generated/walrus/blob.ts"
import * as metadata from "./generated/walrus/metadata.ts"
import * as storage_resource from "./generated/walrus/storage_resource.ts"
import * as system from "./generated/walrus/system.ts"
import { System, type SystemError, type SystemState } from "./System.ts"

export type RecipeServices = Ptb.PtbBuilder | System
export type RecipeError = SystemError | Ptb.InvalidPureValue | BlobTooLarge

/** `${typeOrigin}::blob::Blob`: the type of registered blobs on this deployment. */
export const blobType: Effect.Effect<string, SystemError, System> = Effect.map(
  Effect.flatMap(Effect.service(System), (s) => s.state),
  (state) => `${state.typeOrigin}::blob::Blob`
)

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Run `f` with the system state, calls pointed at `state.packageId`. */
const withSystem = <A, E, R>(f: (state: SystemState, system: System["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const service = yield* Effect.service(System)
    const state = yield* service.state
    return yield* f(state, service).pipe(Effect.provideService(Package, state.packageId))
  })

/** The system object as a shared input (deduplicated; a later mutable use widens it). */
const systemArg = (state: SystemState, mutable: boolean) => Ptb.sharedObject(state.systemObjectId, state.initialSharedVersion, mutable)

/** `unencodedLength`'s encoded length, or `BlobTooLarge` (checked before any size formula that would throw). */
const encodedLength = (unencodedLength: number, nShards: number): Effect.Effect<number, BlobTooLarge> =>
  Result.match(Encoding.symbolSize(unencodedLength, nShards), {
    onFailure: Effect.fail,
    onSuccess: () => Effect.succeed(Encoding.encodedLength(unencodedLength, nShards))
  })

/** A WAL coin of `amount`, handed to `f`, then destroyed (it must be empty by then). */
const withWal = <A, E, R>(
  amount: bigint,
  walType: string,
  f: (coin: Move.Argument) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const coin = yield* Ptb.coin({ amount, type: walType })
    const result = yield* f(coin)
    yield* Ptb.moveCall({ target: "0x2::coin::destroy_zero", typeArguments: [walType], arguments: [coin] })
    return result
  })

/** Little-endian `u256` of 32 bytes, as Move takes the root hash (E6). */
const u256LE = (bytes: Uint8Array): bigint => {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!)
  return n
}

const objectArg = (id: Address.Address | string) => Ptb.object(Address.normalize(id))

// -----------------------------------------------------------------------------
// Recipes
// -----------------------------------------------------------------------------

const reserve = (state: SystemState, encoded: number, epochs: number, payment: Move.Argument) =>
  Effect.gen(function*() {
    const [storage] = yield* system.reserveSpace({ arguments: [yield* systemArg(state, true), BigInt(encoded), epochs, payment] })
    return storage
  })

/**
 * `system::reserve_space` for a blob of `unencodedLength` bytes over `epochs`
 * epochs: a `Storage` resource. Without `payment`, a WAL coin of exactly the
 * storage cost is created and destroyed around the call.
 */
export const reserveSpace = (o: {
  readonly unencodedLength: number
  readonly epochs: number
  readonly payment?: Move.Argument
}): Effect.Effect<Move.Argument, RecipeError, RecipeServices> =>
  withSystem((state, service) =>
    Effect.gen(function*() {
      const encoded = yield* encodedLength(o.unencodedLength, state.nShards)
      if (o.payment !== undefined) return yield* reserve(state, encoded, o.epochs, o.payment)
      const walType = yield* service.walType
      const amount = BigInt(Encoding.storageUnits(encoded)) * state.storagePrice * BigInt(o.epochs)
      return yield* withWal(amount, walType, (coin) => reserve(state, encoded, o.epochs, coin))
    })
  )

/**
 * Register a blob (`system::register_blob`): a `Blob` the caller transfers.
 * Without `storage`, one WAL coin pays for both the space (`reserve_space`)
 * and the write; with `storage`, only the write. `attributes` become the
 * blob's metadata (`metadata::new`, `blob::add_metadata`, one
 * `insert_or_update_metadata_pair` per entry, in key order of the record).
 */
export const registerBlob = (o: {
  readonly blobId: BlobId.BlobId
  readonly rootHash: Uint8Array
  readonly unencodedLength: number
  readonly epochs: number
  readonly deletable: boolean
  readonly attributes?: Readonly<Record<string, string>>
  readonly storage?: Move.Argument
}): Effect.Effect<Move.Argument, RecipeError, RecipeServices> =>
  withSystem((state, service) =>
    Effect.gen(function*() {
      const encoded = yield* encodedLength(o.unencodedLength, state.nShards)
      const walType = yield* service.walType
      const units = BigInt(Encoding.storageUnits(encoded))
      const write = units * state.writePrice
      const storageCost = o.storage === undefined ? units * state.storagePrice * BigInt(o.epochs) : 0n
      // The system input comes first, as in `@mysten/walrus`.
      const sys = yield* systemArg(state, true)
      return yield* withWal(storageCost + write, walType, (coin) =>
        Effect.gen(function*() {
          const storage = o.storage ?? (yield* reserve(state, encoded, o.epochs, coin))
          const [registered] = yield* system.registerBlob({
            arguments: [
              sys,
              storage,
              BlobId.toU256(o.blobId),
              u256LE(o.rootHash),
              BigInt(o.unencodedLength),
              Encoding.RS2,
              o.deletable,
              coin
            ]
          })
          if (o.attributes !== undefined) yield* addAttributes(registered, o.attributes)
          return registered
        }))
    })
  )

const addAttributes = (target: Move.Argument, attributes: Readonly<Record<string, string>>) =>
  Effect.gen(function*() {
    const [meta] = yield* metadata.new()
    yield* blob.addMetadata({ arguments: [target, meta] })
    for (const [key, value] of Object.entries(attributes)) {
      yield* blob.insertOrUpdateMetadataPair({ arguments: [target, key, value] })
    }
  })

/**
 * Set attributes on an existing `Blob` (`blob::insert_or_update_metadata_pair`
 * per entry, which creates the metadata when there is none): idempotent, so it
 * is safe on a `Blob` that already carries them.
 */
export const setAttributes = (o: {
  readonly blobObjectId: Address.Address
  readonly attributes: Readonly<Record<string, string>>
}): Effect.Effect<void, RecipeError, RecipeServices> =>
  withSystem(() =>
    Effect.gen(function*() {
      const target = yield* objectArg(o.blobObjectId)
      for (const [key, value] of Object.entries(o.attributes)) {
        yield* blob.insertOrUpdateMetadataPair({ arguments: [target, key, value] })
      }
    })
  )

/**
 * `system::certify_blob` with the certificate's aggregate signature, its
 * signers as a bitmap over the system committee (M3), and its message. The
 * system object is an immutable shared input. The chain checks the epoch
 * (M4): a certificate from another epoch aborts.
 */
export const certifyBlob = (o: {
  readonly blobObjectId: Address.Address
  readonly certificate: Certificate
}): Effect.Effect<void, RecipeError, RecipeServices> =>
  withSystem((state) =>
    Effect.gen(function*() {
      const bitmap = yield* Effect.try({
        try: () => signersBitmap(o.certificate.signers, state.members.length),
        catch: (e) => new Ptb.InvalidPureValue({ issue: `certificate signers: ${(e as Error).message}` })
      })
      yield* system.certifyBlob({
        arguments: [
          yield* systemArg(state, false),
          yield* objectArg(o.blobObjectId),
          o.certificate.signature,
          bitmap,
          o.certificate.serializedMessage
        ]
      })
    })
  )

/** `system::delete_blob` (deletable blobs only): returns the blob's `Storage`, for reuse or `storage_resource::destroy`. */
export const deleteBlob = (blobObjectId: Address.Address): Effect.Effect<Move.Argument, RecipeError, RecipeServices> =>
  withSystem((state) =>
    Effect.gen(function*() {
      const [storage] = yield* system.deleteBlob({ arguments: [yield* systemArg(state, false), yield* objectArg(blobObjectId)] })
      return storage
    })
  )

/**
 * `system::extend_blob` by `epochs` epochs. `storageSize` is the blob's
 * `storage.storage_size` (its encoded length); a WAL coin of exactly
 * `units × storage price × epochs` pays.
 */
export const extendBlob = (o: {
  readonly blobObjectId: Address.Address
  readonly storageSize: number
  readonly epochs: number
}): Effect.Effect<void, RecipeError, RecipeServices> =>
  withSystem((state, service) =>
    Effect.gen(function*() {
      const walType = yield* service.walType
      const amount = BigInt(Encoding.storageUnits(o.storageSize)) * state.storagePrice * BigInt(o.epochs)
      const sys = yield* systemArg(state, true)
      const target = yield* objectArg(o.blobObjectId)
      yield* withWal(amount, walType, (coin) => system.extendBlob({ arguments: [sys, target, o.epochs, coin] }))
    })
  )

/** `blob::burn`: destroy a `Blob` (certified or not, expired or not) and its storage. */
export const burnBlob = (blobObjectId: Address.Address): Effect.Effect<void, RecipeError, RecipeServices> =>
  withSystem(() => Effect.asVoid(Effect.flatMap(objectArg(blobObjectId), (b) => blob.burn({ arguments: [b] }))))

/** `storage_resource::destroy`: drop a `Storage` resource (e.g. after `deleteBlob`). */
export const destroyStorage = (storage: Move.Argument): Effect.Effect<void, RecipeError, RecipeServices> =>
  withSystem(() => Effect.asVoid(storage_resource.destroy({ arguments: [storage] })))
