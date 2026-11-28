/**
 * Session keys (§4.5): a short-lived Ed25519 key that the user authorises,
 * once, with a personal-message signature (the certificate, R1). Key requests
 * are then signed by the session key (R4) with no further prompt.
 *
 * A session is a plain value, not a scoped resource. Its secret and its
 * derived-key cache live in a module-private `WeakMap` keyed by the value:
 * they are not properties, so they never show up in logs, `JSON.stringify`
 * or a spread copy. The secret leaves only through `toExported`, wrapped in
 * `Redacted`.
 *
 * Time comes from `Clock`, so `TestClock` drives creation and expiry.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { base64 } from "@scure/base"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import type { Address } from "@unconfirmed/effect-sui/Address"
import * as Ed25519 from "@unconfirmed/effect-sui/Ed25519"
import * as PrivateKey from "@unconfirmed/effect-sui/PrivateKey"
import type * as SignatureScheme from "@unconfirmed/effect-sui/SignatureScheme"
import * as Signer from "@unconfirmed/effect-sui/Signer"
import * as Verify from "@unconfirmed/effect-sui/Verify"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Entropy from "./Entropy.ts"
import { utf8 } from "./bytes.ts"
import { InvalidSessionKey, SessionKeyExpired, SignatureRequired } from "./Errors.ts"
import { strictId } from "./ids.ts"
import type { Certificate } from "./KeyServerApi.ts"

// -----------------------------------------------------------------------------
// Signers
// -----------------------------------------------------------------------------

/**
 * Who signs the certificate: a key `Signer` (`@unconfirmed/effect-sui/Signer`, signed
 * through `Signer.signPersonalMessage`), or anything that signs personal
 * messages itself. `@unconfirmed/effect-sui/wallet`'s `WalletSigner` fits as it is.
 * Structural on purpose: Seal does not depend on `@unconfirmed/effect-sui/wallet`.
 */
export type MessageSigner = Signer.Signer | PersonalMessageSigner

export interface PersonalMessageSigner {
  readonly address: Address
  readonly signPersonalMessage: (
    message: Uint8Array
  ) => Effect.Effect<{ readonly signature: Uint8Array }, { readonly _tag: string; readonly message?: string }>
}

const signMessage = (signer: MessageSigner, message: Uint8Array): Effect.Effect<Uint8Array, Signer.SigningError> => {
  if ("signPersonalMessage" in signer) {
    return signer.signPersonalMessage(message).pipe(
      Effect.map((s) => s.signature),
      Effect.mapError((e) =>
        e instanceof Signer.SigningError
          ? e
          : new Signer.SigningError({ reason: "unavailable", message: e.message ? `${e._tag}: ${e.message}` : e._tag })
      )
    )
  }
  return Effect.map(Signer.signPersonalMessage(signer, message), (s) => s.signature)
}

// -----------------------------------------------------------------------------
// Pure formats (R1, R4)
// -----------------------------------------------------------------------------

/** The text the user signs (R1). `creationTime` in ms; the message shows it truncated to seconds, in UTC. */
export const personalMessage = (o: {
  /** The MVR name if any, else the canonical package id. */
  readonly packageName: string
  readonly ttlMin: number
  readonly creationTime: number
  /** The session's 32-byte Ed25519 public key. */
  readonly sessionVk: Uint8Array
}): Uint8Array => {
  const time = new Date(Math.floor(o.creationTime / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ")
  return utf8(
    `Accessing keys of package ${o.packageName} for ${o.ttlMin} mins from ${time} UTC, session key ${
      base64.encode(o.sessionVk)
    }`
  )
}

const RequestFormat = /* @__PURE__ */ Bcs.struct({
  ptb: Bcs.byteVector,
  encKey: Bcs.byteVector,
  encVerificationKey: Bcs.byteVector
})

/** The bytes the session key signs for a key request (R4): BCS `{ ptb, enc_key, enc_verification_key }`. */
export const requestMessage = (ptb: Uint8Array, encKey: Uint8Array, encVerificationKey: Uint8Array): Uint8Array =>
  Bcs.encodeSync(RequestFormat)({ ptb, encKey, encVerificationKey })

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/**
 * Strict: `0x` followed by exactly 64 hex digits, either case; answers the
 * canonical lower-case form (item 14). Short and unprefixed forms are refused.
 */
export const normalizeId = (what: string, s: string): Effect.Effect<Address, InvalidSessionKey> => {
  const id = strictId(s)
  return id !== undefined
    ? Effect.succeed(id)
    : Effect.fail(new InvalidSessionKey({ reason: `${what} must be 0x followed by 64 hex digits, got ${JSON.stringify(s)}` }))
}

const SIGNATURE_LENGTHS: Readonly<Record<number, number | undefined>> = {
  0x00: 97, // Ed25519
  0x01: 98, // Secp256k1
  0x02: 98, // Secp256r1
  0x03: undefined, // multisig
  0x05: undefined, // zkLogin
  0x06: undefined, // passkey
  0x07: undefined // ML-DSA-65
}

/** The shape of a serialized Sui signature: a known flag and, for single-key schemes, the exact length. */
const signatureShape = (sig: Uint8Array): string | undefined => {
  if (sig.length < 2) return "signature is empty"
  const flag = sig[0]!
  if (!(flag in SIGNATURE_LENGTHS)) return `unknown signature scheme flag 0x${flag.toString(16).padStart(2, "0")}`
  const expected = SIGNATURE_LENGTHS[flag]
  if (expected !== undefined && sig.length !== expected) return `expected a ${expected}-byte signature, got ${sig.length}`
  return undefined
}

const ttlMinutes = (ttl: Duration.Input): Effect.Effect<number, InvalidSessionKey> => {
  const d = Duration.fromInput(ttl)
  const ms = Option.isSome(d) ? Duration.toMillis(d.value) : NaN
  const min = ms / 60_000
  return Number.isInteger(min) && min >= 1 && min <= 30
    ? Effect.succeed(min)
    : Effect.fail(new InvalidSessionKey({ reason: `ttl must be whole minutes from 1 to 30, got ${ms} ms` }))
}

const ttlMinValid = (ttlMin: number) => Number.isInteger(ttlMin) && ttlMin >= 1 && ttlMin <= 30

const nonNegativeMillis = (what: string, input: Duration.Input): Effect.Effect<number, InvalidSessionKey> => {
  const d = Duration.fromInput(input)
  const ms = Option.isSome(d) ? Duration.toMillis(d.value) : NaN
  return Number.isFinite(ms) && ms >= 0
    ? Effect.succeed(Math.floor(ms))
    : Effect.fail(new InvalidSessionKey({ reason: `${what} must be a finite, non-negative duration` }))
}

const positiveInt = (what: string, n: number): Effect.Effect<number, InvalidSessionKey> =>
  Number.isInteger(n) && n > 0
    ? Effect.succeed(n)
    : Effect.fail(new InvalidSessionKey({ reason: `${what} must be a positive integer, got ${n}` }))

// -----------------------------------------------------------------------------
// The session
// -----------------------------------------------------------------------------

export interface Options {
  /** The first version of the policy package: `0x` + 64 hex digits (normalised to lower case, item 14). */
  readonly packageId: string
  readonly signer?: MessageSigner
  /** Default: the signer's address. Give it when the signer is an alias of the user (R3), or when there is no signer. */
  readonly address?: string
  readonly mvrName?: string
  /** Whole minutes, 1 to 30 (R2). Default 10 minutes. */
  readonly ttl?: Duration.Input
  /**
   * Date the certificate this far in the past, so a client clock that runs ahead does not invalidate it (R2). Default 10
   * seconds. Must leave the session usable: `clockSkew + 10 s` (the expiry margin) below `ttl`.
   */
  readonly clockSkew?: Duration.Input
  /** Derived keys kept for this session. Default 1024. */
  readonly cacheCapacity?: number
}

export interface SessionKey {
  readonly address: Address
  readonly packageId: Address
  readonly mvrName: string | undefined
  /** ms since the epoch: what the certificate says. */
  readonly createdAt: number
  readonly ttlMinutes: number
  /** `createdAt + ttl`. */
  readonly expiresAt: number
  /** The session's 32-byte Ed25519 verification key. */
  readonly publicKey: Uint8Array
  /** The text of R1, UTF-8. */
  readonly personalMessage: Uint8Array
  /** Signs at most once: concurrent callers share one prompt; a failure is not remembered. Fails when expired. */
  readonly certificate: Effect.Effect<Certificate, SessionKeyExpired | SignatureRequired | Signer.SigningError>
  /** True from 10 s before `expiresAt` (the margin `@mysten/seal` uses). */
  readonly isExpired: Effect.Effect<boolean>
}

/** The safety margin before `expiresAt`. */
export const EXPIRY_MARGIN_MS = 10_000
const DEFAULT_TTL_MIN = 10
const DEFAULT_CLOCK_SKEW_MS = 10_000
const DEFAULT_CACHE_CAPACITY = 1024

interface Internal {
  readonly secret: Redacted.Redacted<Uint8Array>
  readonly signer: MessageSigner | undefined
  /** Set once a signature is known (given, imported or signed). */
  signature: Uint8Array | undefined
  readonly cache: CacheState
}

const internals = /* @__PURE__ */ new WeakMap<SessionKey, Internal>()

const internal = (session: SessionKey): Effect.Effect<Internal> => {
  const i = internals.get(session)
  return i ? Effect.succeed(i) : Effect.die(new Error("not a session made by SessionKey.make / fromExported"))
}

/** Fail with `SessionKeyExpired` from `EXPIRY_MARGIN_MS` before `expiresAt`. */
const ensureLive = (expiresAt: number): Effect.Effect<void, SessionKeyExpired> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    now >= expiresAt - EXPIRY_MARGIN_MS ? Effect.fail(new SessionKeyExpired({ expiresAt, now })) : Effect.void)

const successForever = (exit: Exit.Exit<unknown, unknown>) => Exit.isSuccess(exit) ? Duration.infinity : Duration.zero

interface Parts {
  readonly address: Address
  readonly packageId: Address
  readonly mvrName: string | undefined
  readonly createdAt: number
  readonly ttlMin: number
  readonly secret: Redacted.Redacted<Uint8Array>
  readonly signer: MessageSigner | undefined
  readonly signature: Uint8Array | undefined
  readonly cache: CacheState
}

const assemble = (p: Parts): Effect.Effect<SessionKey> =>
  Effect.gen(function*() {
    const publicKey = ed25519.getPublicKey(Redacted.value(p.secret))
    const expiresAt = p.createdAt + p.ttlMin * 60_000
    const message = personalMessage({
      packageName: p.mvrName ?? p.packageId,
      ttlMin: p.ttlMin,
      creationTime: p.createdAt,
      sessionVk: publicKey
    })
    const state: Internal = { secret: p.secret, signer: p.signer, signature: p.signature, cache: p.cache }
    const certificateOf = (signature: Uint8Array): Certificate => ({
      user: p.address,
      sessionVk: publicKey.slice(),
      creationTime: p.createdAt,
      ttlMin: p.ttlMin,
      signature,
      ...(p.mvrName !== undefined && { mvrName: p.mvrName })
    })
    const signer = p.signer
    const sign: Effect.Effect<Uint8Array, SignatureRequired | Signer.SigningError> = signer === undefined
      ? Effect.fail(new SignatureRequired({ message: base64.encode(message) }))
      : yield* Effect.cachedWithTTL(
        Effect.tap(signMessage(signer, message), (sig) => Effect.sync(() => (state.signature = sig))),
        successForever
      )
    const session: SessionKey = {
      address: p.address,
      packageId: p.packageId,
      mvrName: p.mvrName,
      createdAt: p.createdAt,
      ttlMinutes: p.ttlMin,
      expiresAt,
      publicKey,
      personalMessage: message,
      certificate: Effect.andThen(
        ensureLive(expiresAt),
        Effect.suspend(() => state.signature !== undefined ? Effect.succeed(state.signature) : sign)
      ).pipe(Effect.map(certificateOf)),
      isExpired: Effect.map(Clock.currentTimeMillis, (now) => now >= expiresAt - EXPIRY_MARGIN_MS)
    }
    internals.set(session, state)
    return session
  })

/** A new session. No I/O and no prompt: the certificate is signed on first use. Whether `packageId` is a first version is `Seal.session`'s job. */
export const make = (options: Options): Effect.Effect<SessionKey, InvalidSessionKey> =>
  Effect.gen(function*() {
    const packageId = yield* normalizeId("packageId", options.packageId)
    const addressInput = options.address ?? options.signer?.address
    if (addressInput === undefined) {
      return yield* new InvalidSessionKey({ reason: "give a signer or an address" })
    }
    const address = yield* normalizeId("address", addressInput)
    if (options.mvrName !== undefined && options.mvrName.length === 0) {
      return yield* new InvalidSessionKey({ reason: "mvrName is empty" })
    }
    const ttlMin = options.ttl === undefined ? DEFAULT_TTL_MIN : yield* ttlMinutes(options.ttl)
    const skew = options.clockSkew === undefined
      ? DEFAULT_CLOCK_SKEW_MS
      : yield* nonNegativeMillis("clockSkew", options.clockSkew)
    if (skew + EXPIRY_MARGIN_MS >= ttlMin * 60_000) {
      return yield* new InvalidSessionKey({
        reason: `clockSkew (${skew} ms) plus the ${EXPIRY_MARGIN_MS / 1000} s expiry margin must be shorter than ttl (${ttlMin} min)`
      })
    }
    const capacity = yield* positiveInt("cacheCapacity", options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY)
    const now = yield* Clock.currentTimeMillis
    const createdAt = now - skew
    const secret = Redacted.make(yield* Entropy.bytes(32), { label: "session key" })
    return yield* assemble({
      address,
      packageId,
      mvrName: options.mvrName,
      createdAt,
      ttlMin,
      secret,
      signer: options.signer,
      signature: undefined,
      cache: new CacheState(capacity)
    })
  })

/**
 * The same session with a signature that arrived from elsewhere (a popup,
 * another device). Checks its shape, not its validity (`verify` does that).
 * The new value shares the original's secret and derived-key cache.
 */
export const withSignature = (session: SessionKey, signature: Uint8Array): Effect.Effect<SessionKey, InvalidSessionKey> =>
  Effect.gen(function*() {
    const shape = signatureShape(signature)
    if (shape !== undefined) return yield* new InvalidSessionKey({ reason: shape })
    const i = yield* internal(session)
    return yield* assemble({
      address: session.address,
      packageId: session.packageId,
      mvrName: session.mvrName,
      createdAt: session.createdAt,
      ttlMin: session.ttlMinutes,
      secret: i.secret,
      signer: i.signer,
      signature: signature.slice(),
      cache: i.cache
    })
  })

/** Sign a key request (R4): raw Ed25519 (no intent, no hash) over `requestMessage(ptb, encKey, encVerificationKey)`. */
export const signRequest = (
  session: SessionKey,
  ptb: Uint8Array,
  encKey: Uint8Array,
  encVerificationKey: Uint8Array
): Effect.Effect<Uint8Array, SessionKeyExpired> =>
  Effect.gen(function*() {
    yield* ensureLive(session.expiresAt)
    const i = yield* internal(session)
    return ed25519.sign(requestMessage(ptb, encKey, encVerificationKey), Redacted.value(i.secret))
  })

/**
 * Check the certificate's signature locally with the installed schemes (signs
 * first if needed). A signer that is an on-chain alias of `address` (R3) fails
 * here although key servers accept it.
 */
export const verify = (
  session: SessionKey
): Effect.Effect<
  Verify.Verified,
  SessionKeyExpired | SignatureRequired | Signer.SigningError | SignatureScheme.VerifyError,
  SignatureScheme.SignatureSchemes
> =>
  Effect.flatMap(
    session.certificate,
    (cert) => Verify.personalMessage(session.personalMessage, cert.signature, { address: session.address })
  )

// -----------------------------------------------------------------------------
// Export / import
// -----------------------------------------------------------------------------

/**
 * The same field names as `@mysten/seal`'s `ExportedSessionKey`. `sessionKey`
 * is a `suiprivkey1…` string: decoding wraps it in `Redacted`, encoding
 * reveals it (`Schema.encodeSync(Exported)` gives the plain object to store).
 * `mvrName` and `personalMessageSignature` accept `undefined`, which
 * `@mysten/seal` writes for absent values.
 */
export const Exported = /* @__PURE__ */ Schema.Struct({
  address: Schema.String,
  packageId: Schema.String,
  mvrName: /* @__PURE__ */ Schema.optional(Schema.String),
  creationTimeMs: Schema.Number,
  ttlMin: Schema.Number,
  /** base64 of the serialized Sui signature. */
  personalMessageSignature: /* @__PURE__ */ Schema.optional(Schema.String),
  sessionKey: /* @__PURE__ */ Schema.RedactedFromValue(Schema.String, { label: "session key" })
})
export type Exported = typeof Exported.Type

/** The session with its secret (as `Redacted`) and its signature, if known. The derived-key cache is not exported. */
export const toExported = (session: SessionKey): Effect.Effect<Exported> =>
  Effect.gen(function*() {
    const i = yield* internal(session)
    const sessionKey = yield* Effect.orDie(PrivateKey.encode({ flag: Ed25519.FLAG, secretKey: Redacted.value(i.secret) }))
    return {
      address: session.address,
      packageId: session.packageId,
      ...(session.mvrName !== undefined && { mvrName: session.mvrName }),
      creationTimeMs: session.createdAt,
      ttlMin: session.ttlMinutes,
      ...(i.signature !== undefined && { personalMessageSignature: base64.encode(i.signature) }),
      sessionKey: Redacted.make(sessionKey, { label: "session key" })
    }
  })

const decodeExported = /* @__PURE__ */ Schema.decodeUnknownEffect(Exported)

/**
 * Restore a session from `toExported` (decoded or encoded) or from
 * `@mysten/seal`'s `export()`. The input is decoded through `Exported`; ids
 * are normalised strictly; an expired session, a TTL outside 1–30, a secret
 * that is not an Ed25519 `suiprivkey`, or a malformed signature is refused.
 * The signature itself is not verified (`verify` does that). The new session
 * starts with an empty derived-key cache.
 */
export const fromExported = (
  exported: unknown,
  options?: { readonly signer?: MessageSigner; readonly cacheCapacity?: number }
): Effect.Effect<SessionKey, SessionKeyExpired | InvalidSessionKey> =>
  Effect.gen(function*() {
    const raw = typeof exported === "object" && exported !== null && Redacted.isRedacted((exported as any).sessionKey)
      ? { ...exported, sessionKey: Redacted.value((exported as any).sessionKey) }
      : exported
    const e = yield* decodeExported(raw).pipe(
      Effect.mapError(() => new InvalidSessionKey({ reason: "not an exported session key" }))
    )
    const address = yield* normalizeId("address", e.address)
    const packageId = yield* normalizeId("packageId", e.packageId)
    if (!ttlMinValid(e.ttlMin)) {
      return yield* new InvalidSessionKey({ reason: `ttlMin must be an integer from 1 to 30, got ${e.ttlMin}` })
    }
    if (!Number.isSafeInteger(e.creationTimeMs) || e.creationTimeMs < 0) {
      return yield* new InvalidSessionKey({ reason: "creationTimeMs must be a non-negative integer" })
    }
    if (e.mvrName !== undefined && e.mvrName.length === 0) {
      return yield* new InvalidSessionKey({ reason: "mvrName is empty" })
    }
    const capacity = yield* positiveInt("cacheCapacity", options?.cacheCapacity ?? DEFAULT_CACHE_CAPACITY)
    const key = yield* PrivateKey.decode(Redacted.value(e.sessionKey), Ed25519.FLAG).pipe(
      Effect.mapError((k) => new InvalidSessionKey({ reason: `sessionKey: ${k.reason}` }))
    )
    let signature: Uint8Array | undefined
    if (e.personalMessageSignature !== undefined) {
      try {
        signature = base64.decode(e.personalMessageSignature)
      } catch {
        return yield* new InvalidSessionKey({ reason: "personalMessageSignature is not base64" })
      }
      const shape = signatureShape(signature)
      if (shape !== undefined) return yield* new InvalidSessionKey({ reason: `personalMessageSignature: ${shape}` })
    }
    yield* ensureLive(e.creationTimeMs + e.ttlMin * 60_000)
    return yield* assemble({
      address,
      packageId,
      mvrName: e.mvrName,
      createdAt: e.creationTimeMs,
      ttlMin: e.ttlMin,
      secret: Redacted.make(key.secretKey, { label: "session key" }),
      signer: options?.signer,
      signature,
      cache: new CacheState(capacity)
    })
  })

// -----------------------------------------------------------------------------
// The derived-key cache (filled by Keys, S6)
// -----------------------------------------------------------------------------

/** @internal A derived key held by a session: verified, 48-byte G1. */
export interface CachedKey {
  readonly server: Address
  readonly fullId: Uint8Array
  readonly key: Uint8Array
}

class CacheState {
  readonly entries = new Map<string, CachedKey>()
  constructor(readonly capacity: number) {}
}

/**
 * @internal The session's derived-key cache, for `Keys`.
 *
 * Every operation checks the session first: expired (with the 10 s margin) →
 * `SessionKeyExpired`, and the cache is emptied. Only then is anything read or
 * written. The cache is created with the session and shared only by sessions
 * with the same owner and package (`withSignature`). A full id of another package is never in the cache (`get` and
 * `lookup` find nothing) and storing one is a defect. Bounded: least recently
 * used entries go first. Keys are copied in and out.
 */
export interface KeyCache {
  /** The key one server gave for one full id, if held. */
  readonly get: (fullId: Uint8Array, server: Address) => Effect.Effect<Option.Option<Uint8Array>, SessionKeyExpired>
  /** Every key held for a full id, one per server. */
  readonly lookup: (fullId: Uint8Array) => Effect.Effect<ReadonlyArray<CachedKey>, SessionKeyExpired>
  /** Store a verified key. */
  readonly set: (fullId: Uint8Array, server: Address, key: Uint8Array) => Effect.Effect<void, SessionKeyExpired>
  /** Drop everything (`Keys.forget`). */
  readonly clear: Effect.Effect<void>
  readonly size: Effect.Effect<number>
}

/** @internal */
export const keyCache = (session: SessionKey): KeyCache => {
  const guarded = <A>(f: (state: CacheState) => A): Effect.Effect<A, SessionKeyExpired> =>
    Effect.gen(function*() {
      const { cache } = yield* internal(session)
      const live = yield* Effect.exit(ensureLive(session.expiresAt))
      if (Exit.isFailure(live)) {
        cache.entries.clear()
        return yield* Effect.failCause(live.cause)
      }
      return f(cache)
    })
  const prefix = (session: SessionKey) => session.packageId.slice(2)
  const inPackage = (fullId: Uint8Array) => fullId.length >= 32 && bytesToHex(fullId.subarray(0, 32)) === prefix(session)
  const keyOf = (fullId: Uint8Array, server: Address) => `${bytesToHex(fullId)}:${server}`
  return {
    get: (fullId, server) =>
      guarded((c) => {
        if (!inPackage(fullId)) return Option.none()
        const k = keyOf(fullId, server)
        const hit = c.entries.get(k)
        if (hit === undefined) return Option.none()
        c.entries.delete(k)
        c.entries.set(k, hit)
        return Option.some(hit.key.slice())
      }),
    lookup: (fullId) =>
      guarded((c) => {
        if (!inPackage(fullId)) return []
        const p = `${bytesToHex(fullId)}:`
        const out: Array<CachedKey> = []
        for (const [k, v] of c.entries) {
          if (k.startsWith(p)) out.push({ server: v.server, fullId: v.fullId.slice(), key: v.key.slice() })
        }
        return out
      }),
    set: (fullId, server, key) =>
      Effect.flatMap(
        guarded((c) => {
          if (!inPackage(fullId)) return false
          const k = keyOf(fullId, server)
          c.entries.delete(k)
          c.entries.set(k, { server, fullId: fullId.slice(), key: key.slice() })
          while (c.entries.size > c.capacity) c.entries.delete(c.entries.keys().next().value!)
          return true
        }),
        (ok) => ok ? Effect.void : Effect.die(new Error("a full id of another package cannot be cached in this session"))
      ),
    clear: Effect.flatMap(internal(session), (i) => Effect.sync(() => i.cache.entries.clear())),
    size: Effect.map(internal(session), (i) => i.cache.entries.size)
  }
}
