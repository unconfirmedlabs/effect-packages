/**
 * Key servers registered on Sui (K1–K5, §4.3): the on-chain BCS, `read`
 * through the versioned dynamic field, and the cached `KeyServers` service.
 *
 * `KeyServer { id, first_version, last_version }` keeps its data in a dynamic
 * field named by the version (`u64`): `KeyServerV1` at 1, `KeyServerV2` at 2.
 * The BCS is hand-written: key servers come from at least five package
 * deployments (K4), so neither the object's type nor a generated binding can
 * identify one. Trust comes from the configured object id alone; the type
 * check below looks at module and name only.
 *
 * Stricter than `@mysten/seal`: the version range, the field's name and id,
 * the object's own id and the public key (a valid G2 point, not infinity) are
 * all checked, and trailing bytes are refused (`Bcs.decode`).
 */
import { bytesToHex } from "@noble/hashes/utils.js"
import * as Cache from "effect/Cache"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { type Address, SUI_FRAMEWORK } from "@unconfirmed/sui/Address"
import * as DynamicFields from "@unconfirmed/sui/DynamicFields"
import * as Move from "@unconfirmed/sui/Move"
import * as Objects from "@unconfirmed/sui/Objects"
import type { RpcError } from "@unconfirmed/sui/RpcError"
import * as TypeTag from "@unconfirmed/sui/TypeTag"
import * as Bls from "./Bls.ts"
import { find, isHttpUrl, SealConfig, type SealConfigService, type ServerConfig } from "./Config.ts"
import { InvalidKeyServer } from "./Errors.ts"
import * as Ibe from "./Ibe.ts"
import { normalizeObjectId } from "./ids.ts"
import { KeyServerApi } from "./KeyServerApi.ts"

export { InvalidKeyServer }

// -----------------------------------------------------------------------------
// BCS (K1)
// -----------------------------------------------------------------------------

/** `key_server::KeyServer`, the object itself. */
export const KeyServerBcs = /* @__PURE__ */ Bcs.struct({
  id: Move.UID,
  firstVersion: Bcs.u64,
  lastVersion: Bcs.u64
})

/** `key_server::KeyServerV1`, the field at version 1 (always independent). */
export const KeyServerV1Bcs = /* @__PURE__ */ Bcs.struct({
  name: Bcs.string,
  url: Bcs.string,
  keyType: Bcs.u8,
  pk: Bcs.byteVector
})

/** `key_server::PartialKeyServer`, a committee member. */
export const PartialKeyServerBcs = /* @__PURE__ */ Bcs.struct({
  name: Bcs.string,
  url: Bcs.string,
  partialPk: Bcs.byteVector,
  partyId: Bcs.u16
})

/** `key_server::ServerType`. */
export const ServerTypeBcs = /* @__PURE__ */ Bcs.enum({
  Independent: /* @__PURE__ */ Bcs.struct({ url: Bcs.string }),
  Committee: /* @__PURE__ */ Bcs.struct({
    version: Bcs.u32,
    threshold: Bcs.u16,
    partialKeyServers: /* @__PURE__ */ Bcs.vector(PartialKeyServerBcs)
  })
})

/** `key_server::KeyServerV2`, the field at version 2. */
export const KeyServerV2Bcs = /* @__PURE__ */ Bcs.struct({
  name: Bcs.string,
  keyType: Bcs.u8,
  pk: Bcs.byteVector,
  serverType: ServerTypeBcs
})

const FieldV1 = /* @__PURE__ */ Move.Field(Bcs.u64, KeyServerV1Bcs)
const FieldV2 = /* @__PURE__ */ Move.Field(Bcs.u64, KeyServerV2Bcs)

/** The versions this module reads, preferred first (K2). */
export const SUPPORTED_VERSIONS = [2, 1] as const

/** `key_type` 0: Boneh-Franklin over BLS12-381. */
export const KEY_TYPE_BF_BLS12381 = 0

const encodeU64 = /* @__PURE__ */ Bcs.encodeSync(Bcs.u64)

/** The id of the dynamic field holding version `version` of a key server. */
export const fieldId = (objectId: Address, version: number | bigint): Address =>
  DynamicFields.deriveId(objectId, "u64", encodeU64(BigInt(version)))

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export interface CommitteeMember {
  readonly name: string
  readonly url: string
  readonly partyId: number
  readonly partialPublicKey: Uint8Array
}

/** A key server as the chain describes it. */
export interface OnChain {
  readonly objectId: Address
  readonly name: string
  /** 96 bytes, a valid G2 point (not infinity). */
  readonly publicKey: Uint8Array
  /** Which versioned field was read. */
  readonly layout: 1 | 2
  readonly type:
    | { readonly _tag: "Independent"; readonly url: string }
    | {
      readonly _tag: "Committee"
      readonly version: number
      readonly threshold: number
      readonly members: ReadonlyArray<CommitteeMember>
    }
}

export type KeyServerLoadError = InvalidKeyServer | Objects.ObjectNotFound | RpcError

const invalid = (objectId: string, reason: string) => new InvalidKeyServer({ objectId, reason })

const structTag = (type: string): (TypeTag.TypeTag & { readonly _tag: "struct" }) | undefined => {
  try {
    const t = TypeTag.parse(type)
    return t._tag === "struct" ? t : undefined
  } catch {
    return undefined
  }
}

const isKeyServerType = (t: TypeTag.TypeTag | undefined, name: string): boolean =>
  t !== undefined && t._tag === "struct" && t.module === "key_server" && t.name === name && t.typeParams.length === 0

const decodeWith = <T, E>(objectId: Address, what: string, schema: Bcs.BcsSchema<T, E>, bytes: Uint8Array) =>
  Result.mapError(Bcs.decode(schema)(bytes), (e) => invalid(objectId, `${what} does not decode: ${e.message}`))

/**
 * Decode a key server's versioned field (`version` from `chooseVersion`).
 * Pure: `read` is `chooseVersion` and this, after two `Objects.get`s.
 */
export const decode = (
  objectId: Address,
  field: Objects.SuiObject,
  version: 1 | 2
): Result.Result<OnChain, InvalidKeyServer> =>
  Result.gen(function*() {
    if (field.objectId !== fieldId(objectId, version)) {
      return yield* Result.fail(invalid(objectId, `field ${field.objectId} is not version ${version}'s`))
    }
    const tag = structTag(field.type)
    if (
      tag === undefined || tag.address !== SUI_FRAMEWORK || tag.module !== "dynamic_field" || tag.name !== "Field" ||
      tag.typeParams.length !== 2 ||
      tag.typeParams[0]!._tag !== "u64" || !isKeyServerType(tag.typeParams[1], `KeyServerV${version}`)
    ) {
      return yield* Result.fail(invalid(objectId, `field type ${field.type} is not a KeyServerV${version} field`))
    }
    const decoded = version === 1
      ? yield* decodeWith(objectId, "KeyServerV1", FieldV1, field.contents)
      : yield* decodeWith(objectId, "KeyServerV2", FieldV2, field.contents)
    if (decoded.id !== field.objectId || decoded.name !== BigInt(version)) {
      return yield* Result.fail(invalid(objectId, `field ${field.objectId} names another field`))
    }
    const value = decoded.value
    if (value.keyType !== KEY_TYPE_BF_BLS12381) {
      return yield* Result.fail(invalid(objectId, `unsupported key type ${value.keyType}`))
    }
    if (Result.isFailure(Bls.g2FromBytes(value.pk))) {
      return yield* Result.fail(invalid(objectId, "public key is not a valid G2 point"))
    }
    const publicKey = Uint8Array.from(value.pk)
    if ("url" in value) {
      return { objectId, name: value.name, publicKey, layout: 1, type: { _tag: "Independent", url: value.url } } as const
    }
    const st = value.serverType
    const type: OnChain["type"] = st._tag === "Independent"
      ? { _tag: "Independent", url: st.url }
      : {
        _tag: "Committee",
        version: st.version,
        threshold: st.threshold,
        members: st.partialKeyServers.map((m) => ({
          name: m.name,
          url: m.url,
          partyId: m.partyId,
          partialPublicKey: Uint8Array.from(m.partialPk)
        }))
      }
    return { objectId, name: value.name, publicKey, layout: 2, type } as const
  })

/** Check the outer object and choose the version to read: the highest of 2, 1 within `[first, last]` (K2). */
export const chooseVersion = (objectId: Address, object: Objects.SuiObject): Result.Result<1 | 2, InvalidKeyServer> =>
  Result.gen(function*() {
    if (object.objectId !== objectId) return yield* Result.fail(invalid(objectId, `got object ${object.objectId}`))
    if (!isKeyServerType(structTag(object.type), "KeyServer")) {
      return yield* Result.fail(invalid(objectId, `type ${object.type} is not a key_server::KeyServer`))
    }
    const ks = yield* decodeWith(objectId, "KeyServer", KeyServerBcs, object.contents)
    if (ks.id !== objectId) return yield* Result.fail(invalid(objectId, `object holds id ${ks.id}`))
    if (ks.firstVersion < 1n || ks.firstVersion > ks.lastVersion) {
      return yield* Result.fail(invalid(objectId, `invalid version range [${ks.firstVersion}, ${ks.lastVersion}]`))
    }
    const version = SUPPORTED_VERSIONS.find((v) => BigInt(v) >= ks.firstVersion && BigInt(v) <= ks.lastVersion)
    if (version === undefined) {
      return yield* Result.fail(
        invalid(objectId, `no supported version in [${ks.firstVersion}, ${ks.lastVersion}] (supported: 1, 2)`)
      )
    }
    return version
  })

/**
 * One round trip: the object and both candidate versioned fields (their ids
 * are derivable up front) are read together through the batched
 * `Objects.get`, then the version is chosen. A missing object is
 * `ObjectNotFound`; a missing chosen field, like every other inconsistency,
 * is `InvalidKeyServer`. A field that is absent but not chosen costs nothing
 * more than its slot in the batch.
 */
export const read = (objectId: Address): Effect.Effect<OnChain, KeyServerLoadError, Objects.Objects> =>
  Effect.gen(function*() {
    const id = normalizeObjectId(objectId)
    if (id === undefined) return yield* invalid(objectId, "not an object id")
    const objects = yield* Effect.service(Objects.Objects)
    const field = (version: 1 | 2) =>
      objects.get(fieldId(id, version)).pipe(
        Effect.map((f): Objects.SuiObject | undefined => f),
        Effect.catchTag("ObjectNotFound", () => Effect.succeed(undefined))
      )
    const [object, v2, v1] = yield* Effect.all([objects.get(id), field(2), field(1)], { concurrency: "unbounded" })
    const version = yield* Effect.fromResult(chooseVersion(id, object))
    const chosen = version === 2 ? v2 : v1
    if (chosen === undefined) return yield* invalid(id, `versioned field ${version} not found`)
    return yield* Effect.fromResult(decode(id, chosen, version))
  }).pipe(Effect.withSpan("KeyServer.read"))

// -----------------------------------------------------------------------------
// The service
// -----------------------------------------------------------------------------

/** A key server ready for use. */
export interface KeyServer {
  readonly objectId: Address
  readonly name: string
  /** 96 bytes, valid G2. */
  readonly publicKey: Uint8Array
  readonly type: "Independent" | "Committee"
  /**
   * Where to send requests: the on-chain URL of a configured independent
   * server, or a configured committee's aggregator. Absent for a server that
   * is not configured: it is never asked (open question 8).
   */
  readonly url: string | undefined
  readonly apiKey: { readonly name: string; readonly value: Redacted.Redacted<string> } | undefined
}

/**
 * Combine what the chain says with the configuration (K5). Refuses a
 * configured committee without `aggregatorUrl`, a configured independent
 * server with one, and a configured independent server whose on-chain URL is
 * not http(s).
 */
export const resolve = (onChain: OnChain, config: ServerConfig | undefined): Result.Result<KeyServer, InvalidKeyServer> => {
  const base = { objectId: onChain.objectId, name: onChain.name, publicKey: onChain.publicKey }
  const apiKey = config?.apiKey
  if (onChain.type._tag === "Committee") {
    if (config === undefined) return Result.succeed({ ...base, type: "Committee", url: undefined, apiKey: undefined })
    if (config.aggregatorUrl === undefined) {
      return Result.fail(invalid(onChain.objectId, "a committee server needs aggregatorUrl in the configuration"))
    }
    return Result.succeed({ ...base, type: "Committee", url: config.aggregatorUrl, apiKey })
  }
  if (config === undefined) return Result.succeed({ ...base, type: "Independent", url: undefined, apiKey: undefined })
  if (config.aggregatorUrl !== undefined) {
    return Result.fail(invalid(onChain.objectId, "an independent server must not have aggregatorUrl in the configuration"))
  }
  if (!isHttpUrl(onChain.type.url)) {
    return Result.fail(invalid(onChain.objectId, `on-chain URL ${JSON.stringify(onChain.type.url)} is not http(s)`))
  }
  return Result.succeed({ ...base, type: "Independent", url: onChain.type.url, apiKey })
}

/**
 * Check a key server's proof of possession (C17, H10) through `/v1/service`.
 * A server without `url` (unconfigured) and a committee (whose aggregator
 * does not implement the route) are accepted as they are. A failed request is
 * `InvalidKeyServer` too, with the request's `KeyServerError` kind in `kind`
 * (and in its reason), so a transient failure is `retryable`; it is not
 * cached.
 */
export const verify = (server: KeyServer): Effect.Effect<KeyServer, InvalidKeyServer, KeyServerApi> =>
  Effect.gen(function*() {
    if (server.type === "Committee" || server.url === undefined) return server
    const api = yield* Effect.service(KeyServerApi)
    const answer = yield* api.service({
      objectId: server.objectId,
      url: server.url,
      ...(server.apiKey !== undefined && { apiKey: server.apiKey })
    }).pipe(
      Effect.mapError((e) =>
        new InvalidKeyServer({
          objectId: server.objectId,
          reason: `proof of possession unavailable (${e.kind}): ${e.message}`,
          kind: e.kind
        })
      )
    )
    if (normalizeObjectId(answer.serviceId) !== server.objectId) {
      return yield* invalid(server.objectId, `proof of possession names another id: ${answer.serviceId}`)
    }
    if (!Ibe.verifyProofOfPossession(answer.pop, server.publicKey, server.objectId)) {
      return yield* invalid(server.objectId, "proof of possession does not verify")
    }
    return server
  })

export interface KeyServersService {
  /** Cached. Works for any object id; `url` is set only for configured servers. */
  readonly get: (objectId: Address) => Effect.Effect<KeyServer, KeyServerLoadError>
  /** Read again now, replacing the cached entry. */
  readonly refresh: (objectId: Address) => Effect.Effect<KeyServer, KeyServerLoadError>
}

export class KeyServers extends /* @__PURE__ */ Context.Service<KeyServers, KeyServersService>()(
  "@unconfirmed/seal/KeyServers"
) {}

export interface LayerOptions {
  /** How long a loaded server is kept: URLs change (K3). Default 10 minutes; failures are not cached. */
  readonly ttl?: Duration.Input
}

/** Cache capacity, in servers. */
export const CACHE_CAPACITY = 256

const load = (config: SealConfigService, objectId: Address) =>
  Effect.flatMap(read(objectId), (onChain) => Effect.fromResult(resolve(onChain, find(config, onChain.objectId))))

const makeService = <R>(
  lookup: (objectId: Address) => Effect.Effect<KeyServer, KeyServerLoadError, R>,
  options: LayerOptions | undefined
) =>
  Effect.gen(function*() {
    const ttl = Duration.fromInputUnsafe(options?.ttl ?? Duration.minutes(10))
    const cache = yield* Cache.makeWith(lookup, {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => Exit.isSuccess(exit) ? ttl : Duration.zero
    })
    const key = (objectId: Address) => {
      const id = normalizeObjectId(objectId)
      return id === undefined ? Effect.fail(invalid(objectId, "not an object id")) : Effect.succeed(id)
    }
    return KeyServers.of({
      get: (objectId) => Effect.flatMap(key(objectId), (id) => Cache.get(cache, id)),
      refresh: (objectId) => Effect.flatMap(key(objectId), (id) => Cache.refresh(cache, id))
    })
  })

/** Key servers read from chain, cached per object id (capacity 256) for `ttl`. */
export const layer = (options?: LayerOptions): Layer.Layer<KeyServers, never, SealConfig | Objects.Objects> =>
  Layer.effect(
    KeyServers,
    Effect.gen(function*() {
      const config = yield* Effect.service(SealConfig)
      return yield* makeService((id) => load(config, id), options)
    })
  )

/**
 * As `layer`, and also checks each configured independent server's proof of
 * possession (C17, H10); committee servers and unconfigured servers are not
 * checked. Off by default (open question 13).
 *
 * The proof covers only `(public key, object id)`, neither of which changes
 * (K3), so a verified pair is remembered for the life of the layer: reloads
 * after the TTL (for URL changes) and `refresh` do not ask again unless the
 * public key changed. A failed proof request is not remembered; when it was
 * transient, the `InvalidKeyServer` is `retryable` and `Keys.fetch` retries
 * it like an unavailable server.
 */
export const layerVerified = (
  options?: LayerOptions
): Layer.Layer<KeyServers, never, SealConfig | Objects.Objects | KeyServerApi> =>
  Layer.effect(
    KeyServers,
    Effect.gen(function*() {
      const config = yield* Effect.service(SealConfig)
      const verified = new Set<string>()
      const pair = (s: KeyServer) => `${s.objectId}:${bytesToHex(s.publicKey)}`
      const check = (server: KeyServer) =>
        verified.has(pair(server))
          ? Effect.succeed(server)
          : Effect.tap(verify(server), () => Effect.sync(() => verified.add(pair(server))))
      return yield* makeService((id) => Effect.flatMap(load(config, id), check), options)
    })
  )

/**
 * Fixed servers: pinned public keys, tests, offline encryption. An id not in
 * the list is `ObjectNotFound`. Nothing is checked: the caller vouches for
 * the keys.
 */
export const layerFromServers = (servers: ReadonlyArray<KeyServer>): Layer.Layer<KeyServers> => {
  const byId = new Map(servers.map((s) => [normalizeObjectId(s.objectId) ?? s.objectId, s]))
  const get = (objectId: Address) =>
    Effect.suspend(() => {
      const s = byId.get(normalizeObjectId(objectId) ?? objectId)
      return s === undefined ? Effect.fail(new Objects.ObjectNotFound({ objectId })) : Effect.succeed(s)
    })
  return Layer.succeed(KeyServers, KeyServers.of({ get, refresh: get }))
}
