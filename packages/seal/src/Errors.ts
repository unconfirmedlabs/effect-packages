/**
 * The package's error classes (§4.9), all pure `Schema.TaggedError`s, shared
 * by every module.
 *
 * This module is a leaf: it imports nothing but `effect/Schema`, so a program
 * that only parses encrypted objects pulls in no curve or HTTP code through
 * its errors. `InvalidEncoding` is re-exported by `Bls.ts`, and
 * `KeyServerError` (with `KeyServerErrorKind`) by `KeyServerApi.ts`, where
 * they belong conceptually.
 *
 * Each `extends` is marked `/* @__PURE__ *\/` so that bundlers drop the classes
 * a program never uses. No error carries key material, a session secret or an
 * API key.
 */
import * as Schema from "effect/Schema"

// -----------------------------------------------------------------------------
// Pure core
// -----------------------------------------------------------------------------

/** Bytes that are not a valid curve point or canonical scalar: bad length, off curve, wrong subgroup, infinity, out of range. */
export class InvalidEncoding extends /* @__PURE__ */ Schema.TaggedError<InvalidEncoding>()("InvalidEncoding", {
  /** `"G1"`, `"G2"` or `"Scalar"`. */
  what: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `invalid ${this.what} encoding: ${this.reason}`
  }
}

/** Shamir inputs that cannot be split or combined: empty, unequal lengths, duplicate or zero index, threshold out of range, wrong coefficient count. */
export class InvalidShares extends /* @__PURE__ */ Schema.TaggedError<InvalidShares>()("InvalidShares", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

/** The runtime has no WebCrypto (`crypto.subtle`), e.g. a browser page not served over HTTPS. Only AES-GCM needs it. */
export class CryptoUnavailable extends /* @__PURE__ */ Schema.TaggedError<CryptoUnavailable>()("CryptoUnavailable", {
  message: Schema.String
}) {}

/** The DEM rejected the ciphertext: a bad AES-GCM tag or HMAC-CTR mac (wrong key, tampered blob or aad). */
export class DecryptionFailed extends /* @__PURE__ */ Schema.TaggedError<DecryptionFailed>()("DecryptionFailed", {
  reason: /* @__PURE__ */ Schema.Literals(["tag", "mac"])
}) {
  override get message(): string {
    return `decryption failed: bad ${this.reason === "tag" ? "AES-GCM tag" : "HMAC-CTR mac"}`
  }
}

/** An encrypted object that breaks a rule of I4, or whose keys do not reconstruct a valid randomness. */
export class InvalidCiphertext extends /* @__PURE__ */ Schema.TaggedError<InvalidCiphertext>()("InvalidCiphertext", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

/** Encryption parameters out of range: threshold, share count, key or id sizes. */
export class InvalidEncryption extends /* @__PURE__ */ Schema.TaggedError<InvalidEncryption>()("InvalidEncryption", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

/** Fewer shares have keys than the object's threshold. */
export class NotEnoughKeys extends /* @__PURE__ */ Schema.TaggedError<NotEnoughKeys>()("NotEnoughKeys", {
  required: Schema.Number,
  available: Schema.Number
}) {
  override get message(): string {
    return `${this.available} keys available, needs ${this.required}`
  }
}

// -----------------------------------------------------------------------------
// Key server error kinds (used by key server loading and HTTP)
// -----------------------------------------------------------------------------

/** What went wrong with one key server (§4.4). Re-exported by `KeyServerApi.ts`. */
export const KeyServerErrorKind = /* @__PURE__ */ Schema.Literals([
  // no verdict
  "Unavailable",
  "Timeout",
  "RateLimited",
  "Unresolved",
  // the server's verdicts (H7)
  "NoAccess",
  "InvalidPtb",
  "InvalidPackage",
  "InvalidParameter",
  "InvalidSignature",
  "InvalidSessionSignature",
  "InvalidCertificate",
  "InvalidMvrName",
  // this server will not serve us
  "InvalidServiceId",
  "UnsupportedPackage",
  "SdkRejected",
  "Unauthorized",
  "Rejected",
  // what we concluded from an answer
  "Malformed",
  "InvalidKey",
  "MissingKey",
  "UnsupportedServerVersion"
])
export type KeyServerErrorKind = typeof KeyServerErrorKind.Type

const RETRYABLE: ReadonlySet<KeyServerErrorKind> = /* @__PURE__ */ new Set<KeyServerErrorKind>([
  "Unavailable",
  "RateLimited",
  "InvalidParameter"
])

const DEFINITIVE: ReadonlySet<KeyServerErrorKind> = /* @__PURE__ */ new Set<KeyServerErrorKind>([
  "NoAccess",
  "InvalidPtb",
  "InvalidPackage",
  "InvalidSignature",
  "InvalidSessionSignature",
  "InvalidCertificate",
  "InvalidMvrName"
])

/** @internal */
export const isRetryableKind = (kind: KeyServerErrorKind): boolean => RETRYABLE.has(kind)
/** @internal */
export const isDefinitiveKind = (kind: KeyServerErrorKind): boolean => DEFINITIVE.has(kind)

// -----------------------------------------------------------------------------
// Configuration and key servers
// -----------------------------------------------------------------------------

export class InvalidConfig extends /* @__PURE__ */ Schema.TaggedError<InvalidConfig>()("InvalidConfig", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

/**
 * A key server object that cannot be used: wrong type, unsupported version or key type, bad public key, configuration
 * mismatch, bad proof of possession. `kind` is set when the proof of possession could not be fetched
 * (`KeyServer.layerVerified`): the `KeyServerError` kind of that request.
 */
export class InvalidKeyServer extends /* @__PURE__ */ Schema.TaggedError<InvalidKeyServer>()("InvalidKeyServer", {
  objectId: Schema.String,
  reason: Schema.String,
  kind: /* @__PURE__ */ Schema.optionalKey(KeyServerErrorKind)
}) {
  /** Asking again may help: the proof of possession request failed with a retryable kind (`Unavailable`, `RateLimited`, ...). */
  get retryable(): boolean {
    return this.kind !== undefined && RETRYABLE.has(this.kind)
  }
  override get message(): string {
    return `invalid key server ${this.objectId}${this.kind === undefined ? "" : ` (${this.kind})`}: ${this.reason}`
  }
}

/** A policy package id that is not the package's first version (I1). */
export class NotFirstVersion extends /* @__PURE__ */ Schema.TaggedError<NotFirstVersion>()("NotFirstVersion", {
  packageId: Schema.String,
  version: Schema.BigInt
}) {
  override get message(): string {
    return `package ${this.packageId} is version ${this.version}, not the first`
  }
}

// -----------------------------------------------------------------------------
// Key server HTTP
// -----------------------------------------------------------------------------

/** One key server's failure. `status` is absent when no HTTP answer arrived. */
export class KeyServerError extends /* @__PURE__ */ Schema.TaggedError<KeyServerError>()("KeyServerError", {
  /** The key server's object id. */
  server: Schema.String,
  url: /* @__PURE__ */ Schema.optionalKey(Schema.String),
  kind: KeyServerErrorKind,
  status: /* @__PURE__ */ Schema.optionalKey(Schema.Number),
  /** The server's error name, verbatim. */
  error: /* @__PURE__ */ Schema.optionalKey(Schema.String),
  requestId: /* @__PURE__ */ Schema.optionalKey(Schema.String),
  /** `Retry-After` of a `429` or `503`, in ms (capped at an hour), when the server sent one. */
  retryAfter: /* @__PURE__ */ Schema.optionalKey(Schema.Number),
  /** The server's message (H7), or ours; never contains an API key. Bounded in length. */
  message: Schema.String
}) {
  /** Asking again may help: `Unavailable | RateLimited | InvalidParameter`. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind)
  }
  /**
   * The request itself was judged; another honest server will say the same:
   * `NoAccess | InvalidPtb | InvalidPackage | InvalidSignature | InvalidSessionSignature | InvalidCertificate | InvalidMvrName`.
   */
  get definitive(): boolean {
    return DEFINITIVE.has(this.kind)
  }
}

// -----------------------------------------------------------------------------
// Sessions and approvals
// -----------------------------------------------------------------------------

/** The session key has expired (or is within its safety margin). Times in ms since the epoch. */
export class SessionKeyExpired extends /* @__PURE__ */ Schema.TaggedError<SessionKeyExpired>()("SessionKeyExpired", {
  expiresAt: Schema.Number,
  now: Schema.Number
}) {
  override get message(): string {
    return `session key expired at ${this.expiresAt}, now ${this.now}`
  }
}

export class InvalidSessionKey extends /* @__PURE__ */ Schema.TaggedError<InvalidSessionKey>()("InvalidSessionKey", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

/** The session has neither a signer nor a signature. `message` is the personal message to sign, base64. */
export class SignatureRequired extends /* @__PURE__ */ Schema.TaggedError<SignatureRequired>()("SignatureRequired", {
  message: Schema.String
}) {}

/** A `seal_approve` transaction that breaks a rule of P1, with the server's wording. */
export class InvalidApproval extends /* @__PURE__ */ Schema.TaggedError<InvalidApproval>()("InvalidApproval", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

/** The object, the session and the approval do not belong together (another package, an id the approval lacks). */
export class ApprovalMismatch extends /* @__PURE__ */ Schema.TaggedError<ApprovalMismatch>()("ApprovalMismatch", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

// -----------------------------------------------------------------------------
// Fetching keys
// -----------------------------------------------------------------------------

const Failure = /* @__PURE__ */ Schema.Struct({ weight: Schema.Number, error: KeyServerError })
const Unsettled = /* @__PURE__ */ Schema.Struct({ server: Schema.String, weight: Schema.Number, started: Schema.Boolean })

/** Key servers weighing the threshold did not return valid keys. */
export class ThresholdNotMet extends /* @__PURE__ */ Schema.TaggedError<ThresholdNotMet>()("ThresholdNotMet", {
  /**
   * `insufficientWeight`: the askable servers weigh less than the threshold; nothing was sent.
   * `denied`: refusals of the request itself (`definitive` failures) explain the outcome on their own: they weigh the
   * threshold, or what is left without them could not reach it.
   * `unreachable`: anything else (servers down, mixed failures).
   */
  reason: /* @__PURE__ */ Schema.Literals(["insufficientWeight", "unreachable", "denied"]),
  threshold: Schema.Number,
  /** Weight obtained, cached keys included. */
  weight: Schema.Number,
  totalWeight: Schema.Number,
  /** Every server that failed for good, with its own typed error. */
  failures: /* @__PURE__ */ Schema.Array(Failure),
  /** Servers with no outcome when the call ended. */
  unsettled: /* @__PURE__ */ Schema.Array(Unsettled)
}) {
  /** Failed weight by kind, heaviest first (ties in order of first appearance): what `@mysten/seal` reduces to one "majority" error. */
  get kinds(): ReadonlyArray<readonly [KeyServerErrorKind, number]> {
    const byKind = new Map<KeyServerErrorKind, number>()
    for (const f of this.failures) byKind.set(f.error.kind, (byKind.get(f.error.kind) ?? 0) + f.weight)
    return Array.from(byKind).sort((a, b) => b[1] - a[1])
  }

  /** e.g. "threshold 2 not met: 0 reached, denied by 2 (NoAccess), 1 unsettled (total 3)". No ids, no keys. */
  override get message(): string {
    const head = `threshold ${this.threshold} not met`
    if (this.reason === "insufficientWeight") return `${head}: insufficient weight, total ${this.totalWeight}`
    const kinds = this.kinds
    const failed = kinds.reduce((n, [, w]) => n + w, 0)
    const unsettled = this.unsettled.reduce((n, u) => n + u.weight, 0)
    const detail = kinds.length === 1 ? kinds[0]![0] : kinds.map(([k, w]) => `${k} ${w}`).join(", ")
    const failures = failed === 0
      ? "0 failed"
      : `${this.reason === "denied" ? "denied by" : "failed"} ${failed} (${detail})`
    return `${head}: ${this.weight} reached, ${failures}, ${unsettled} unsettled (total ${this.totalWeight})`
  }
}
