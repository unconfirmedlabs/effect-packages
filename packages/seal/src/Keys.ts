/**
 * Fetching derived keys (§4.7, §5): one `fetch_key` request body for every
 * server, sent through `Quorum.run` weighted by what each server counts for,
 * every returned key verified against the server's on-chain public key, the
 * session's cache filled with verified keys only.
 *
 * The only module that imports `@unconfirmed/quorum`.
 *
 * Every per-server outcome is a typed `KeyServerError`: an unloadable key
 * server object is `Unresolved` (or `Unavailable` for a retryable `RpcError`),
 * a key that does not verify is `InvalidKey`, an id left out is `MissingKey`,
 * and a defect inside a member becomes `Unavailable`, because a defect would
 * sink the whole quorum. Retries are per server (`retry`, transient kinds
 * only). Refusals that judge the request itself (`definitive`) end the call
 * once they weigh the threshold, after `denialGrace` (§5).
 */
import { bytesToHex } from "@noble/hashes/utils.js"
import * as Quorum from "@unconfirmed/quorum/Quorum"
import type { Address } from "@unconfirmed/sui/Address"
import { RpcError } from "@unconfirmed/sui/RpcError"
import type * as Signer from "@unconfirmed/sui/Signer"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import type { Approval } from "./Approval.ts"
import * as Bls from "./Bls.ts"
import { normalizeObjectId } from "./Config.ts"
import * as ElGamal from "./ElGamal.ts"
import { KeyServerError, SessionKeyExpired, type SignatureRequired, ThresholdNotMet } from "./Errors.ts"
import * as Ibe from "./Ibe.ts"
import * as Kdf from "./Kdf.ts"
import { type KeyServer, KeyServers } from "./KeyServer.ts"
import * as KeyServerApi from "./KeyServerApi.ts"
import * as SessionKey from "./SessionKey.ts"

/** A verified derived key: what one server gave for one full id. */
export interface DerivedKey {
  readonly server: Address
  /** `package id ‖ inner id` (I1). */
  readonly fullId: Uint8Array
  /** 48-byte compressed G1, verified against the server's public key (C3). */
  readonly key: Uint8Array
}

/** A server that may be asked, with what it counts for toward the threshold (its share count in the object). */
export interface WeightedServer {
  readonly objectId: Address
  readonly weight: number
}

export interface FetchOptions {
  readonly session: SessionKey.SessionKey
  readonly approval: Approval
  /** Who may be asked and what each counts for. Ids are normalised; a duplicate is a defect. */
  readonly servers: ReadonlyArray<WeightedServer>
  /** A positive integer. */
  readonly threshold: number
  /** Per server, transient kinds only (`KeyServerApi.retryable`). Default: `defaultRetry()`. */
  readonly retry?: Schedule.Schedule<unknown, KeyServerError>
  /** How long to keep waiting for other servers once denials weigh `threshold` (§5). Default 2 seconds. */
  readonly denialGrace?: Duration.Input
}

export type FetchError = ThresholdNotMet | SessionKeyExpired | SignatureRequired | Signer.SigningError

/** The default `denialGrace`. */
export const DEFAULT_DENIAL_GRACE: Duration.Duration = /* @__PURE__ */ Duration.seconds(2)

/** Exponential from 250 ms, each delay capped at 2 s, 3 retries. */
export const defaultRetry = (): Schedule.Schedule<unknown, KeyServerError> =>
  Schedule.max([
    Schedule.exponential("250 millis").pipe(
      Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(2))))
    ),
    Schedule.recurs(3)
  ])

// -----------------------------------------------------------------------------
// The cache
// -----------------------------------------------------------------------------

/** What the session already holds for a full id, one key per server. Fails when the session has expired (item 10). */
export const cached = (
  session: SessionKey.SessionKey,
  fullId: Uint8Array
): Effect.Effect<ReadonlyArray<DerivedKey>, SessionKeyExpired> => SessionKey.keyCache(session).lookup(fullId)

/** Drop every derived key the session holds. */
export const forget = (session: SessionKey.SessionKey): Effect.Effect<void> => SessionKey.keyCache(session).clear

// -----------------------------------------------------------------------------
// Fetching
// -----------------------------------------------------------------------------

interface Member {
  readonly objectId: Address
  readonly weight: number
}

/** Verified keys of one server, by hex full id. */
type Keys = ReadonlyMap<string, Uint8Array>

const keyServerError = (
  server: Address,
  kind: KeyServerApi.KeyServerErrorKind,
  message: string,
  url?: string
): KeyServerError => new KeyServerError({ server, kind, message, ...(url !== undefined && { url }) })

const validate = (options: FetchOptions): Effect.Effect<ReadonlyArray<Member>> =>
  Effect.suspend(() => {
    const { threshold } = options
    if (!(Number.isInteger(threshold) && threshold >= 1)) {
      return Effect.die(new Error(`Keys.fetch: threshold must be a positive integer, got ${threshold}`))
    }
    const seen = new Set<string>()
    const members: Array<Member> = []
    for (const s of options.servers) {
      const objectId = normalizeObjectId(s.objectId)
      if (objectId === undefined) return Effect.die(new Error(`Keys.fetch: not an object id: ${s.objectId}`))
      if (seen.has(objectId)) return Effect.die(new Error(`Keys.fetch: server ${objectId} is listed twice`))
      if (!(Number.isFinite(s.weight) && s.weight >= 0)) {
        return Effect.die(new Error(`Keys.fetch: weight of ${objectId} must be a finite number >= 0, got ${s.weight}`))
      }
      seen.add(objectId)
      members.push({ objectId, weight: s.weight })
    }
    return Effect.succeed(members)
  })

/** `reason` from the failures alone (§4.7 step 6), whichever quorum check ended the run. */
const reasonOf = (
  failures: ReadonlyArray<{ readonly weight: number; readonly error: KeyServerError }>,
  threshold: number,
  askableWeight: number,
  cachedWeight: number
): "denied" | "unreachable" => {
  const denied = Quorum.failedWeight(failures as ReadonlyArray<Quorum.Failure<unknown, KeyServerError>>, KeyServerApi.definitive)
  return denied >= threshold || askableWeight - denied < threshold - cachedWeight ? "denied" : "unreachable"
}

/**
 * Keys for every id of the approval from servers weighing `threshold`,
 * cached keys included.
 *
 * 1. An expired session fails before the cache is consulted (item 10).
 * 2. Full ids are `session.packageId ‖ id` for each id of the approval, duplicates removed.
 * 3. Servers whose keys for every full id are cached count at once; if they weigh `threshold`, nothing is sent and nobody is prompted.
 * 4. Otherwise: the certificate (one prompt at most), a fresh ElGamal key, one signed request for every server.
 * 5. `Quorum.run` over the other servers for `threshold − cached weight`; each member loads the key server, asks it, and verifies every key.
 * 6. The verified keys of every server that answered go into the session's cache, also when the threshold is not met.
 *
 * Fails with `ThresholdNotMet` carrying every server's `KeyServerError`.
 */
export const fetch = (
  options: FetchOptions
): Effect.Effect<ReadonlyArray<DerivedKey>, FetchError, KeyServers | KeyServerApi.KeyServerApi> =>
  Effect.gen(function*() {
    const { session, approval, threshold } = options
    const members = yield* validate(options)

    // 1. Expiry, before the cache.
    const now = yield* Clock.currentTimeMillis
    if (yield* session.isExpired) return yield* new SessionKeyExpired({ expiresAt: session.expiresAt, now })

    // 2. Full ids, deduplicated (H6: the answer has one entry per command).
    const fullIds = new Map<string, Uint8Array>()
    for (const id of approval.ids) {
      const fullId = Kdf.fullId(session.packageId, id)
      fullIds.set(bytesToHex(fullId), fullId)
    }

    // 3. Complete servers from the cache.
    const cache = SessionKey.keyCache(session)
    const complete: Array<{ readonly objectId: Address; readonly keys: Keys }> = []
    const incomplete: Array<Member> = []
    let cachedWeight = 0
    for (const m of members) {
      const keys = new Map<string, Uint8Array>()
      for (const [h, fullId] of fullIds) {
        const hit = yield* cache.get(fullId, m.objectId)
        if (Option.isSome(hit)) keys.set(h, hit.value)
      }
      if (keys.size === fullIds.size) {
        complete.push({ objectId: m.objectId, keys })
        cachedWeight += m.weight
      } else {
        incomplete.push(m)
      }
    }
    const totalWeight = Quorum.weightOf(members)
    if (totalWeight < threshold) {
      return yield* new ThresholdNotMet({
        reason: "insufficientWeight",
        threshold,
        weight: cachedWeight,
        totalWeight,
        failures: [],
        unsettled: incomplete.filter((m) => m.weight > 0).map((m) => ({ server: m.objectId, weight: m.weight, started: false }))
      })
    }

    const derived = (servers: ReadonlyArray<{ readonly objectId: Address; readonly keys: Keys }>): ReadonlyArray<DerivedKey> =>
      servers.flatMap((s) =>
        Array.from(fullIds, ([h, fullId]) => ({ server: s.objectId, fullId: fullId.slice(), key: s.keys.get(h)!.slice() }))
      )
    if (cachedWeight >= threshold) return derived(complete)

    // 4. One request for every server.
    const certificate = yield* session.certificate
    const enc = yield* ElGamal.generate
    const requestSignature = yield* SessionKey.signRequest(session, approval.bytes, enc.publicKey, enc.verificationKey)
    const request: KeyServerApi.FetchKeyRequest = {
      ptb: approval.bytes,
      encKey: enc.publicKey,
      encVerificationKey: enc.verificationKey,
      requestSignature,
      certificate
    }

    // 5. The quorum.
    const servers = yield* Effect.service(KeyServers)
    const api = yield* Effect.service(KeyServerApi.KeyServerApi)
    const ask = (m: Member): Effect.Effect<Keys, KeyServerError> => {
      let url: string | undefined
      return Effect.gen(function*() {
        const server = yield* servers.get(m.objectId).pipe(
          Effect.mapError((e) =>
            e instanceof RpcError && e.retryable
              ? keyServerError(m.objectId, "Unavailable", `key server object unavailable: ${e.message}`)
              : keyServerError(m.objectId, "Unresolved", `key server object not usable: ${describeLoadError(e)}`)
          )
        )
        if (server.url === undefined) {
          return yield* keyServerError(m.objectId, "Unresolved", "key server has no URL: it is not configured for requests")
        }
        url = server.url
        const answer = yield* api.fetchKey(
          { objectId: server.objectId, url: server.url, ...(server.apiKey !== undefined && { apiKey: server.apiKey }) },
          request
        )
        return yield* Effect.fromResult(verify(server, answer, enc.secret, fullIds))
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(keyServerError(m.objectId, "Unavailable", `unexpected defect: ${String(defect)}`, url))
        )
      )
    }
    const grace = options.denialGrace ?? DEFAULT_DENIAL_GRACE
    const outcome = yield* Effect.result(
      Quorum.run(incomplete, {
        weight: (m) => m.weight,
        threshold: threshold - cachedWeight,
        run: ask,
        schedule: options.retry ?? defaultRetry(),
        while: KeyServerApi.retryable,
        giveUp: { when: KeyServerApi.definitive, weight: threshold, grace }
      })
    )

    // 6. Cache whatever verified, then decide.
    const answered = Result.isSuccess(outcome) ? outcome.success.successes : outcome.failure.successes
    for (const s of answered) {
      for (const [h, key] of s.value) yield* cache.set(fullIds.get(h)!, s.member.objectId, key)
    }
    if (Result.isSuccess(outcome)) {
      return derived([...complete, ...answered.map((s) => ({ objectId: s.member.objectId, keys: s.value }))])
    }
    const e = outcome.failure
    const failures = e.failures.map((f) => ({ weight: f.weight, error: f.error }))
    return yield* new ThresholdNotMet({
      reason: e.reason === "insufficientWeight"
        ? "insufficientWeight"
        : reasonOf(failures, threshold, totalWeight, cachedWeight),
      threshold,
      weight: cachedWeight + e.weight,
      totalWeight,
      failures,
      unsettled: e.unsettled.map((u) => ({ server: u.member.objectId, weight: u.weight, started: u.started }))
    })
  })

const describeLoadError = (e: { readonly _tag: string; readonly message?: string; readonly reason?: string }): string =>
  e._tag === "InvalidKeyServer" ? e.reason ?? e._tag : e._tag === "ObjectNotFound" ? "object not found" : `${e._tag}: ${e.message ?? ""}`

/**
 * Open and verify one server's answer (C3, C16): every entry for a full id
 * we asked for must decrypt to a finite G1 point that verifies against the
 * server's public key, else the whole server is `InvalidKey` (item 9);
 * entries for other ids are ignored; every full id must be present, else
 * `MissingKey` (item 7).
 */
const verify = (
  server: KeyServer,
  answer: ReadonlyArray<KeyServerApi.EncryptedKey>,
  secret: Bls.Scalar,
  fullIds: ReadonlyMap<string, Uint8Array>
): Result.Result<Keys, KeyServerError> => {
  const fail = (kind: KeyServerApi.KeyServerErrorKind, message: string) =>
    Result.fail(keyServerError(server.objectId, kind, message, server.url))
  const pk = Bls.g2FromBytes(server.publicKey)
  if (Result.isFailure(pk)) return fail("Unresolved", `invalid public key: ${pk.failure.reason}`)
  const keys = new Map<string, Uint8Array>()
  for (const entry of answer) {
    const h = bytesToHex(entry.fullId)
    const fullId = fullIds.get(h)
    if (fullId === undefined) continue
    const usk = ElGamal.decrypt(secret, entry.ciphertext)
    if (Result.isFailure(usk)) return fail("InvalidKey", `the key for an id does not decode: ${usk.failure.reason}`)
    if (!Ibe.verifyUserSecretKey(usk.success, fullId, pk.success)) {
      return fail("InvalidKey", "a returned key does not verify against the server's public key")
    }
    keys.set(h, Bls.g1ToBytes(usk.success))
  }
  if (keys.size < fullIds.size) {
    return fail("MissingKey", `the answer lacks ${fullIds.size - keys.size} of ${fullIds.size} requested ids`)
  }
  return Result.succeed(keys)
}
