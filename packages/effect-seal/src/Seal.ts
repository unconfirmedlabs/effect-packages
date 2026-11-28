/**
 * The facade (§4.8): encrypt to the configured key servers, decrypt with a
 * session key and an approval transaction, and the one-line layer.
 *
 * - **Weights come from the ciphertext.** Decryption asks the servers that
 *   the object names *and* the configuration lists, each weighing its number
 *   of shares in the object. Servers the object names but the configuration
 *   does not are never contacted (open question 8); their public keys are
 *   still read from chain for the consistency check.
 * - **Strict ids.** Package and user ids are `0x` + 64 hex digits; key
 *   server ids are 64 hex digits, `0x` optional (as in `Config`). The object,
 *   the session and the approval must belong together (`ApprovalMismatch`)
 *   before anything is sent.
 * - Key fetching is `Keys.fetch`: one wallet prompt per session, verified
 *   keys only, the session's cache checked after its expiry, and
 *   `ThresholdNotMet` carrying every server's failure.
 *
 * A program with pinned public keys can call `Envelope.seal` / `open`
 * directly and needs none of the services used here.
 */
import { bytesToHex } from "@noble/hashes/utils.js"
import type { Address } from "@unconfirmed/effect-sui/Address"
import * as Objects from "@unconfirmed/effect-sui/Objects"
import type { RpcError } from "@unconfirmed/effect-sui/RpcError"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as Schedule from "effect/Schedule"
import type { Approval } from "./Approval.ts"
import * as Config from "./Config.ts"
import * as EncryptedObject from "./EncryptedObject.ts"
import * as Envelope from "./Envelope.ts"
import {
  ApprovalMismatch,
  type CryptoUnavailable,
  type DecryptionFailed,
  type InvalidCiphertext,
  type InvalidConfig,
  InvalidEncryption,
  type InvalidSessionKey,
  type KeyServerError,
  type NotEnoughKeys,
  NotFirstVersion
} from "./Errors.ts"
import { normalizeObjectId, strictId } from "./ids.ts"
import * as KeyServer from "./KeyServer.ts"
import * as KeyServerApi from "./KeyServerApi.ts"
import * as Keys from "./Keys.ts"
import * as SessionKey from "./SessionKey.ts"

export type EncryptError = InvalidEncryption | NotFirstVersion | KeyServer.KeyServerLoadError | CryptoUnavailable
export type DecryptError =
  | Keys.FetchError
  | InvalidCiphertext
  | ApprovalMismatch
  | NotEnoughKeys
  | DecryptionFailed
  | KeyServer.KeyServerLoadError
  | CryptoUnavailable
export type FetchKeysError = Keys.FetchError | InvalidCiphertext | ApprovalMismatch

// -----------------------------------------------------------------------------
// First versions (I1)
// -----------------------------------------------------------------------------

/** Package versions by id, per `Objects` service: packages are immutable, so a read answer never changes. */
const packageVersions = /* @__PURE__ */ new WeakMap<object, Map<Address, bigint>>()

/**
 * The package's id if it is a package at version 1, the namespace of every
 * Seal identity (I1). An upgraded version is `NotFirstVersion`; an id that is
 * not `0x` + 64 hex digits, or an object that is not a package, is
 * `ObjectNotFound` (there is no such package). Cached per `Objects` service.
 */
export const checkFirstVersion = (
  packageId: string
): Effect.Effect<Address, NotFirstVersion | Objects.ObjectNotFound | RpcError, Objects.Objects> =>
  Effect.gen(function*() {
    const id = strictId(packageId)
    if (id === undefined) return yield* new Objects.ObjectNotFound({ objectId: packageId })
    const objects = yield* Effect.service(Objects.Objects)
    let cache = packageVersions.get(objects)
    if (cache === undefined) packageVersions.set(objects, cache = new Map())
    let version = cache.get(id)
    if (version === undefined) {
      const object = yield* objects.get(id)
      if (object.type !== "package") return yield* new Objects.ObjectNotFound({ objectId: id })
      version = object.version
      cache.set(id, version)
    }
    if (version !== 1n) return yield* new NotFirstVersion({ packageId: id, version })
    return id
  })

/** `SessionKey.make` after checking that `packageId` is a first version (I1): `make` itself reads nothing. */
export const session = (
  options: SessionKey.Options
): Effect.Effect<SessionKey.SessionKey, InvalidSessionKey | NotFirstVersion | Objects.ObjectNotFound | RpcError, Objects.Objects> =>
  Effect.gen(function*() {
    const packageId = yield* SessionKey.normalizeId("packageId", options.packageId)
    yield* checkFirstVersion(packageId)
    return yield* SessionKey.make({ ...options, packageId })
  })

// -----------------------------------------------------------------------------
// Encrypt
// -----------------------------------------------------------------------------

export interface EncryptOptions {
  /** The policy package's first version, `0x` + 64 hex digits. Checked on chain unless `checkPackage: false`. */
  readonly packageId: string
  /** The inner id: what the policy's `seal_approve*` receives as its first argument. */
  readonly id: Uint8Array
  readonly data: Uint8Array
  /** Shares needed to decrypt: `1 ≤ threshold ≤ total weight`. */
  readonly threshold: number
  readonly aad?: Uint8Array
  /** Default `"AesGcm256"`. `"Hmac256Ctr"` is the mode Move can decrypt on chain. */
  readonly dem?: "AesGcm256" | "Hmac256Ctr"
  /** Default: every configured server with its configured weight, in configuration order. */
  readonly servers?: ReadonlyArray<{ readonly objectId: string; readonly weight: number }>
  /** Default true. */
  readonly checkPackage?: boolean
}

export interface Encrypted {
  /** BCS of the encrypted object: store or send this. */
  readonly encryptedObject: Uint8Array
  /** The DEM key (C15): it decrypts this object without any key server. Keep it secret or drop it. */
  readonly key: Redacted.Redacted<Uint8Array>
}

const invalidEncryption = (reason: string) => Effect.fail(new InvalidEncryption({ reason }))

/**
 * Encrypt `data` under `packageId ‖ id` to the key servers, any `threshold`
 * shares of which decrypt. Every server must load (a missing key server means
 * no encryption); a server of weight `w` gets `w` shares, in order (what
 * `@mysten/seal` does).
 */
export const encrypt = (
  options: EncryptOptions
): Effect.Effect<Encrypted, EncryptError, Config.SealConfig | KeyServer.KeyServers | Objects.Objects> =>
  Effect.gen(function*() {
    const packageId = strictId(options.packageId)
    if (packageId === undefined) {
      return yield* invalidEncryption(`package id must be 0x followed by 64 hex digits, got ${JSON.stringify(options.packageId)}`)
    }
    if (!(options.id instanceof Uint8Array) || !(options.data instanceof Uint8Array)) {
      return yield* invalidEncryption("id and data must be bytes")
    }
    const config = yield* Effect.service(Config.SealConfig)
    const servers: Array<{ readonly objectId: Address; readonly weight: number }> = []
    const seen = new Set<Address>()
    for (const s of options.servers ?? config.servers) {
      const objectId = normalizeObjectId(s.objectId)
      if (objectId === undefined) return yield* invalidEncryption(`key server id ${JSON.stringify(s.objectId)} is not 64 hex digits`)
      if (seen.has(objectId)) return yield* invalidEncryption(`key server ${objectId} is listed twice`)
      if (!Number.isSafeInteger(s.weight) || s.weight < 1) return yield* invalidEncryption(`weight ${s.weight} of ${objectId} is not a positive integer`)
      seen.add(objectId)
      servers.push({ objectId, weight: s.weight })
    }
    const total = servers.reduce((n, s) => n + s.weight, 0)
    if (total < 1 || total > Envelope.MAX_SHARES) return yield* invalidEncryption(`need 1 to ${Envelope.MAX_SHARES} shares, got ${total}`)
    const { threshold } = options
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > total) {
      return yield* invalidEncryption(`threshold ${threshold} out of range for ${total} shares`)
    }
    // The package check and the server loads in one round: concurrent reads share one batch.
    const keyServers = yield* Effect.service(KeyServer.KeyServers)
    const [, loaded] = yield* Effect.all([
      options.checkPackage !== false ? checkFirstVersion(packageId) : Effect.void,
      Effect.forEach(servers, (s) => keyServers.get(s.objectId), { concurrency: "unbounded" })
    ], { concurrency: "unbounded" })
    const recipients = servers.flatMap((s, i) =>
      Array.from({ length: s.weight }, (): Envelope.Recipient => ({ objectId: s.objectId, publicKey: loaded[i]!.publicKey }))
    )
    const randomness = yield* Envelope.randomness(threshold)
    const sealed = yield* Envelope.seal({
      packageId,
      id: options.id,
      recipients,
      threshold,
      input: {
        _tag: options.dem ?? "AesGcm256",
        data: options.data,
        ...(options.aad !== undefined && { aad: options.aad })
      },
      randomness
    })
    return { encryptedObject: sealed.bytes, key: Redacted.make(sealed.key, { label: "DEM key" }) }
  }).pipe(Effect.withSpan("Seal.encrypt", { attributes: { "seal.threshold": options.threshold } }))

// -----------------------------------------------------------------------------
// Decrypt
// -----------------------------------------------------------------------------

export interface DecryptOptions {
  /** The encrypted object's bytes, or the object already parsed. */
  readonly data: Uint8Array | EncryptedObject.EncryptedObject
  readonly session: SessionKey.SessionKey
  /** Must call the object's package (any version) for the object's id among its ids. */
  readonly approval: Approval
  /** Re-derive every share and require them on one polynomial (C10). Costs one pairing per share. Default false. */
  readonly checkShareConsistency?: boolean
  /** Also accept a little-endian randomness (C9), for objects written by old SDKs. Default false. */
  readonly legacyNonce?: boolean
  /** Per server, transient kinds only. Default `Keys.defaultRetry()`. */
  readonly retry?: Schedule.Schedule<unknown, KeyServerError>
  /** How long to keep waiting once denials weigh the threshold (§5). Default 2 seconds. */
  readonly denialGrace?: Duration.Input
}

export type FetchKeysOptions = Omit<DecryptOptions, "data" | "checkShareConsistency" | "legacyNonce"> & {
  readonly objects: ReadonlyArray<Uint8Array | EncryptedObject.EncryptedObject>
}

export type DerivedKeysOptions = Omit<DecryptOptions, "checkShareConsistency" | "legacyNonce">

const parse = (data: Uint8Array | EncryptedObject.EncryptedObject): Effect.Effect<EncryptedObject.EncryptedObject, InvalidCiphertext> =>
  Effect.suspend(() => Effect.fromResult(data instanceof Uint8Array ? EncryptedObject.parse(data) : EncryptedObject.validate(data)))

/** Items 15 and 17: the object, the session and the approval must belong together. */
const belongs = (
  object: EncryptedObject.EncryptedObject,
  session: SessionKey.SessionKey,
  approval: Approval
): Effect.Effect<void, ApprovalMismatch> => {
  if (object.packageId !== session.packageId) {
    return Effect.fail(
      new ApprovalMismatch({ reason: `the object is for package ${object.packageId}, the session for ${session.packageId}` })
    )
  }
  const id = bytesToHex(object.id)
  if (!approval.ids.some((a) => bytesToHex(a) === id)) {
    return Effect.fail(new ApprovalMismatch({ reason: `the approval does not cover the object's id 0x${id}` }))
  }
  return Effect.void
}

/** Servers the object names that the configuration lists, each weighing its share count in the object (§4.8 step 3). */
const askable = (config: Config.SealConfigService, object: EncryptedObject.EncryptedObject): ReadonlyArray<Keys.WeightedServer> =>
  Array.from(EncryptedObject.weights(object), ([objectId, weight]) => ({ objectId, weight })).filter((s) =>
    Config.find(config, s.objectId) !== undefined
  )

const fetchAttributes = (object: EncryptedObject.EncryptedObject, servers: ReadonlyArray<Keys.WeightedServer>) => ({
  "seal.threshold": object.threshold,
  "seal.shares": object.services.length,
  "seal.servers": servers.length
})

/** Parse, check, fetch: the keys of `object`'s full id, by server. */
const keysFor = (options: DerivedKeysOptions) =>
  Effect.gen(function*() {
    const object = yield* parse(options.data)
    yield* belongs(object, options.session, options.approval)
    const config = yield* Effect.service(Config.SealConfig)
    const servers = askable(config, object)
    yield* Effect.annotateCurrentSpan(fetchAttributes(object, servers))
    const keys = yield* Keys.fetch({
      session: options.session,
      approval: options.approval,
      servers,
      threshold: object.threshold,
      ...(options.retry !== undefined && { retry: options.retry }),
      ...(options.denialGrace !== undefined && { denialGrace: options.denialGrace })
    })
    const fullId = bytesToHex(EncryptedObject.fullId(object))
    return { object, keys: keys.filter((k) => bytesToHex(k.fullId) === fullId) }
  })

/**
 * Decrypt: parse; check that object, session and approval belong together;
 * fetch keys from configured servers weighing the object's threshold (one
 * prompt at most, cached keys first); open. With `checkShareConsistency`,
 * every service's public key is read from chain, configured or not.
 */
export const decrypt = (
  options: DecryptOptions
): Effect.Effect<Uint8Array, DecryptError, Config.SealConfig | KeyServer.KeyServers | KeyServerApi.KeyServerApi> =>
  Effect.gen(function*() {
    const { object, keys } = yield* keysFor(options)
    let publicKeys: ReadonlyArray<Uint8Array> | undefined
    if (options.checkShareConsistency === true) {
      const keyServers = yield* Effect.service(KeyServer.KeyServers)
      const servers = Array.from(EncryptedObject.weights(object).keys())
      const loaded = yield* Effect.forEach(servers, (id) => keyServers.get(id), { concurrency: "unbounded" })
      const byId = new Map(loaded.map((s, i) => [servers[i]!, s.publicKey]))
      publicKeys = object.services.map(([server]) => byId.get(server)!)
    }
    return yield* Envelope.open({
      object,
      keys: new Map(keys.map((k) => [k.server, k.key])),
      publicKeys,
      legacyNonce: options.legacyNonce === true
    })
  }).pipe(Effect.withSpan("Seal.decrypt"))

/**
 * One round of requests for several objects under one approval; afterwards
 * `decrypt` of each makes no request (while the session lives). Objects are
 * grouped by their askable servers, weights and threshold; each group is one
 * `Keys.fetch` with the whole approval, so later groups usually find their
 * servers complete in the cache.
 */
export const fetchKeys = (
  options: FetchKeysOptions
): Effect.Effect<void, FetchKeysError, Config.SealConfig | KeyServer.KeyServers | KeyServerApi.KeyServerApi> =>
  Effect.gen(function*() {
    const config = yield* Effect.service(Config.SealConfig)
    const groups = new Map<string, { readonly servers: ReadonlyArray<Keys.WeightedServer>; readonly threshold: number }>()
    for (const data of options.objects) {
      const object = yield* parse(data)
      yield* belongs(object, options.session, options.approval)
      const servers = askable(config, object)
      const key = JSON.stringify([object.threshold, servers.map((s) => [s.objectId, s.weight])])
      if (!groups.has(key)) groups.set(key, { servers, threshold: object.threshold })
    }
    for (const { servers, threshold } of groups.values()) {
      yield* Keys.fetch({
        session: options.session,
        approval: options.approval,
        servers,
        threshold,
        ...(options.retry !== undefined && { retry: options.retry }),
        ...(options.denialGrace !== undefined && { denialGrace: options.denialGrace })
      })
    }
  }).pipe(Effect.withSpan("Seal.fetchKeys", { attributes: { "seal.objects": options.objects.length } }))

/**
 * Verified derived keys for the object's full id from servers weighing its
 * threshold, for on-chain decryption (`bf_hmac_encryption::verify_derived_keys`).
 */
export const derivedKeys = (
  options: DerivedKeysOptions
): Effect.Effect<ReadonlyArray<Keys.DerivedKey>, FetchKeysError, Config.SealConfig | KeyServer.KeyServers | KeyServerApi.KeyServerApi> =>
  Effect.map(keysFor(options), (r) => r.keys).pipe(Effect.withSpan("Seal.derivedKeys"))

// -----------------------------------------------------------------------------
// The layer
// -----------------------------------------------------------------------------

export interface SealOptions {
  readonly servers: ReadonlyArray<Config.ServerInput>
  /** Check each configured independent server's proof of possession when it is loaded (C17). Default false. */
  readonly verifyKeyServers?: boolean
  readonly keyServers?: KeyServer.LayerOptions
  readonly api?: KeyServerApi.KeyServerApiOptions
}

/** Configuration, key servers read from chain, and the key server HTTP client. Needs an `HttpClient` and `Objects`. */
export const layer = (
  options: SealOptions
): Layer.Layer<Config.SealConfig | KeyServer.KeyServers | KeyServerApi.KeyServerApi, InvalidConfig, HttpClient.HttpClient | Objects.Objects> => {
  const base = Layer.merge(Config.layer(options.servers), KeyServerApi.layer(options.api))
  const keyServers = options.verifyKeyServers === true
    ? KeyServer.layerVerified(options.keyServers)
    : KeyServer.layer(options.keyServers)
  return keyServers.pipe(Layer.provideMerge(base))
}
