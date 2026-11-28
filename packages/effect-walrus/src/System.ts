/**
 * The Walrus system object (C1, C2, C7): the current epoch, shard count,
 * prices, the BLS committee, and where Move calls go.
 *
 * `System { id, version, package_id, new_package_id }` holds its real state in
 * a dynamic field named by `version`; for version 1 of the inner layout that
 * is `SystemStateInnerV1`. Calls go to `package_id` (it moves on upgrade);
 * type strings use the type-origin package, the address in the object's type.
 */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as DynamicFields from "@unconfirmed/effect-sui/DynamicFields"
import * as Move from "@unconfirmed/effect-sui/Move"
import * as Objects from "@unconfirmed/effect-sui/Objects"
import * as Packages from "@unconfirmed/effect-sui/Packages"
import type { RpcError } from "@unconfirmed/effect-sui/RpcError"
import * as TypeTag from "@unconfirmed/effect-sui/TypeTag"
import { WalrusConfig } from "./Config.ts"
import { UnsupportedSystemVersion } from "./Errors.ts"
import * as system from "./generated/walrus/system.ts"
import * as system_state_inner from "./generated/walrus/system_state_inner.ts"

export interface SystemMember {
  readonly nodeId: Address.Address
  /** Shards held. */
  readonly weight: number
  /** The 96-byte uncompressed G1 point (M5). */
  readonly publicKey: Uint8Array
}

export interface SystemState {
  /** The system object itself, and its initial shared version: recipes pass it as a shared input. */
  readonly systemObjectId: Address.Address
  readonly initialSharedVersion: bigint
  readonly epoch: number
  readonly nShards: number
  /** Where Move calls go (C2). */
  readonly packageId: Address.Address
  /** For type strings: `${typeOrigin}::blob::Blob`. */
  readonly typeOrigin: Address.Address
  /** Per storage unit per epoch, and per unit once (C7), in FROST. */
  readonly storagePrice: bigint
  readonly writePrice: bigint
  /** The BLS committee in on-chain order: certificate signer indices refer to it (M3). */
  readonly members: ReadonlyArray<SystemMember>
}

export type SystemError = RpcError | Objects.ObjectNotFound | Objects.ObjectDecodeError | UnsupportedSystemVersion

export class System extends Context.Service<System, {
  /** Cached for `STATE_TTL` (prices, the package id and the epoch move); `refresh` drops the cache. */
  readonly state: Effect.Effect<SystemState, SystemError>
  readonly refresh: Effect.Effect<SystemState, SystemError>
  /** `Coin<T>`'s `T` in `system::reserve_space`'s `payment` parameter; cached for the layer's life. */
  readonly walType: Effect.Effect<string, SystemError>
}>()("@unconfirmed/effect-walrus/System") {}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

const encodeU64 = /* @__PURE__ */ Bcs.encodeSync(Bcs.u64)

/** The id of the dynamic field `version` (a `u64`) under `parent`: where the inner state lives (C1). */
export const innerId = (parent: string, version: bigint): Address.Address => DynamicFields.deriveId(parent, "u64", encodeU64(version))

/** The address in a `0x…::module::Name` type string. */
export const typeAddress = (type: string): Address.Address => {
  const tag = TypeTag.parse(type)
  if (tag._tag !== "struct") throw new Error(`not a struct type: ${type}`)
  return Address.normalize(tag.address)
}

const decodeError = (o: Objects.SuiObject, issue: string) =>
  new Objects.ObjectDecodeError({ objectId: o.objectId, type: o.type, issue })

/**
 * Read a versioned Walrus object (`System` or `Staking`) and its inner state:
 * checks the outer type, derives the field id, checks that the field holds
 * `${typeOrigin}::${module}::${name}`, and decodes it.
 */
export const readVersioned = <A, E>(options: {
  readonly objectId: Address.Address
  readonly outer: { readonly module: string; readonly name: string }
  readonly inner: { readonly module: string; readonly name: string; readonly schema: Bcs.BcsSchema<A, E> }
}) =>
  Effect.gen(function*() {
    const objects = yield* Effect.service(Objects.Objects)
    const outerObject = yield* objects.get(options.objectId)
    const tag = yield* Effect.try({ try: () => TypeTag.parse(outerObject.type), catch: () => decodeError(outerObject, "unparseable type") })
    if (tag._tag !== "struct" || tag.module !== options.outer.module || tag.name !== options.outer.name) {
      return yield* decodeError(outerObject, `expected a ${options.outer.module}::${options.outer.name}`)
    }
    const typeOrigin = Address.normalize(tag.address)
    const outer = yield* Objects.decode(system.System)(outerObject) // `Staking` has the same layout
    const field = yield* objects.get(innerId(options.objectId, outer.version))
    const expected = `0x2::dynamic_field::Field<u64, ${typeOrigin}::${options.inner.module}::${options.inner.name}>`
    const actual = yield* Effect.try({ try: () => TypeTag.normalizeString(field.type), catch: () => decodeError(field, "unparseable type") })
    if (actual !== TypeTag.normalizeString(expected)) {
      return yield* new UnsupportedSystemVersion({ objectId: options.objectId, version: outer.version })
    }
    const inner = yield* Objects.decode(Move.Field(Bcs.u64, options.inner.schema))(field)
    return { object: outerObject, outer, typeOrigin, inner: inner.value }
  })

/** Read the system state once (no cache). */
export const load: Effect.Effect<SystemState, SystemError, WalrusConfig | Objects.Objects> = Effect.gen(function*() {
  const config = yield* Effect.service(WalrusConfig)
  const { inner, object, outer, typeOrigin } = yield* readVersioned({
    objectId: Address.normalize(config.systemObjectId),
    outer: { module: "system", name: "System" },
    inner: { module: "system_state_inner", name: "SystemStateInnerV1", schema: system_state_inner.SystemStateInnerV1 }
  })
  if (object.owner._tag !== "Shared") return yield* decodeError(object, "the system object is not shared")
  return {
    systemObjectId: object.objectId,
    initialSharedVersion: object.owner.initialSharedVersion,
    epoch: inner.committee.epoch,
    nShards: inner.committee.n_shards,
    packageId: outer.package_id,
    typeOrigin,
    storagePrice: inner.storage_price_per_unit_size,
    writePrice: inner.write_price_per_unit_size,
    members: inner.committee.members.map((m) => ({ nodeId: m.node_id, weight: m.weight, publicKey: m.public_key.bytes }))
  }
})

/** `T` of the `Coin<T>` that `system::reserve_space` takes as payment. */
export const loadWalType = (packageId: Address.Address): Effect.Effect<string, SystemError, Packages.Packages> =>
  Effect.gen(function*() {
    const packages = yield* Effect.service(Packages.Packages)
    const f = yield* packages.getFunction({ package: packageId, module: "system", function: "reserve_space" })
    const coin = f.parameters.find((p) => p.typeName === `${Address.SUI_FRAMEWORK}::coin::Coin`)
    const wal = coin?.typeArguments?.[0]
    if (wal === undefined) {
      return yield* new Objects.ObjectDecodeError({
        objectId: packageId,
        type: "package",
        issue: "system::reserve_space has no Coin<T> parameter with a known T"
      })
    }
    return TypeTag.normalizeString(wal)
  })

const successForever = (exit: Exit.Exit<unknown, unknown>) => Exit.isSuccess(exit) ? Duration.infinity : Duration.zero

/** How long `System.state` is reused: the committee's default TTL. Register transactions pay exact prices. */
export const STATE_TTL: Duration.Duration = /* @__PURE__ */ Duration.minutes(1)
const successForTtl = (exit: Exit.Exit<unknown, unknown>) => Exit.isSuccess(exit) ? STATE_TTL : Duration.zero

export const layer: Layer.Layer<System, never, WalrusConfig | Objects.Objects | Packages.Packages> = Layer.effect(
  System,
  Effect.gen(function*() {
    const context = yield* Effect.context<WalrusConfig | Objects.Objects | Packages.Packages>()
    const [state, invalidate] = yield* Effect.cachedInvalidateWithTTL(Effect.provideContext(load, context), successForTtl)
    const [walType] = yield* Effect.cachedInvalidateWithTTL(
      Effect.flatMap(state, (s) => loadWalType(s.packageId)).pipe(Effect.provideContext(context)),
      successForever
    )
    return System.of({ state, refresh: Effect.andThen(invalidate, state), walType })
  })
)

/** A fixed state, for tests and offline builds. */
export const layerFromState = (state: SystemState, walType: string): Layer.Layer<System> =>
  Layer.succeed(System, System.of({ state: Effect.succeed(state), refresh: Effect.succeed(state), walType: Effect.succeed(walType) }))
