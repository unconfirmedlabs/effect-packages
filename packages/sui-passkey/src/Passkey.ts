/**
 * Passkeys (WebAuthn, SIP-9) for `@unconfirmed/sui`: the flag-0x06 scheme to
 * install in the registry, a `Signer` over any authenticator, and recovery of
 * a returning user's public key.
 *
 *   SignatureSchemes.layer(Ed25519.scheme, Passkey.scheme)
 *   const signer = yield* Passkey.create(Passkey.browserProvider("My app"))   // new passkey
 *   const signer = yield* Passkey.recover(provider)                          // existing passkey
 *
 * A passkey signature is `0x06 || bcs(PasskeyAuthenticator)`. The authenticator
 * signs `authenticatorData || sha256(clientDataJSON)` with P-256, and the
 * WebAuthn challenge inside `clientDataJSON` is `blake2b256(intentMessage)`, so
 * the signature commits to the intent message through the challenge.
 *
 * The authenticator is a `Provider` value (create a credential, get an
 * assertion), so the signer is the same against a browser, a native bridge, or
 * the software authenticator used in tests.
 */
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { base64urlnopad } from "@scure/base"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as Hash from "@unconfirmed/sui/Hash"
import * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Signer from "@unconfirmed/sui/Signer"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

export const FLAG = 0x06
const NAME = "Passkey"
const SECP256R1_FLAG = 0x02
/** A passkey public key: a compressed P-256 point. */
export const PUBLIC_KEY_SIZE = 33
const SIG = 64
const USER_SIGNATURE_SIZE = 1 + SIG + PUBLIC_KEY_SIZE

/** Sui's `PasskeyAuthenticator`. `userSignature` is a Secp256r1 signature: `0x02 || r || s || publicKey`. */
export const PasskeyAuthenticatorBcs = Bcs.struct({
  authenticatorData: Bcs.byteVector,
  clientDataJson: Bcs.string,
  userSignature: Bcs.byteVector
})

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

/** A newly created credential. */
export interface Credential {
  /** The credential id (`rawId`). */
  readonly id: Uint8Array
  /** The public key as DER SubjectPublicKeyInfo (`AuthenticatorAttestationResponse.getPublicKey()`). */
  readonly publicKey: Uint8Array
}

/** A WebAuthn assertion (`AuthenticatorAssertionResponse`), as raw bytes. */
export interface Assertion {
  /** The id of the credential that signed (`rawId`). */
  readonly credentialId: Uint8Array
  readonly authenticatorData: Uint8Array
  readonly clientDataJSON: Uint8Array
  /** DER-encoded ECDSA signature over `authenticatorData || sha256(clientDataJSON)`. */
  readonly signature: Uint8Array
}

/**
 * An authenticator. `browserProvider` speaks to `navigator.credentials`,
 * `softwareProvider` is an in-memory P-256 key for tests and servers; anything
 * else (a native bridge, a remote device) only has to implement these two.
 *
 * Fail with `SigningError` reason `"rejected"` when the user cancels and
 * `"unavailable"` when there is no authenticator to ask.
 */
export interface Provider {
  readonly create: () => Effect.Effect<Credential, Signer.SigningError>
  /** Ask for an assertion over `challenge`, restricted to `credentialId` when given. */
  readonly get: (challenge: Uint8Array, credentialId?: Uint8Array) => Effect.Effect<Assertion, Signer.SigningError>
}

// -----------------------------------------------------------------------------
// Keys and addresses
// -----------------------------------------------------------------------------

/** DER header of a P-256 SubjectPublicKeyInfo, up to the uncompressed point. */
const SPKI_HEADER = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
])

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

const invalidKey = (reason: string) => new Signer.InvalidKey({ scheme: NAME, reason })

/** The compressed public key in a P-256 DER SubjectPublicKeyInfo, as WebAuthn returns it on creation. */
export const publicKeyFromSpki = (der: Uint8Array): Effect.Effect<Uint8Array, Signer.InvalidKey> => {
  if (der.length !== SPKI_HEADER.length + 65) {
    return Effect.fail(invalidKey(`expected a ${SPKI_HEADER.length + 65}-byte P-256 SubjectPublicKeyInfo, got ${der.length} bytes`))
  }
  if (!sameBytes(der.subarray(0, SPKI_HEADER.length), SPKI_HEADER)) {
    return Effect.fail(invalidKey("not a P-256 SubjectPublicKeyInfo (is the credential ES256?)"))
  }
  if (der[SPKI_HEADER.length] !== 0x04) return Effect.fail(invalidKey("public key is not an uncompressed point"))
  try {
    return Effect.succeed(p256.Point.fromBytes(der.subarray(SPKI_HEADER.length)).toBytes(true))
  } catch {
    return Effect.fail(invalidKey("public key is not on P-256"))
  }
}

/** A compressed P-256 public key as a DER SubjectPublicKeyInfo. */
export const spkiFromPublicKey = (publicKey: Uint8Array): Effect.Effect<Uint8Array, Signer.InvalidKey> => {
  if (publicKey.length !== PUBLIC_KEY_SIZE) {
    return Effect.fail(invalidKey(`expected a ${PUBLIC_KEY_SIZE}-byte compressed P-256 key, got ${publicKey.length} bytes`))
  }
  let point: Uint8Array
  try {
    point = p256.Point.fromBytes(publicKey).toBytes(false)
  } catch {
    return Effect.fail(invalidKey("public key is not on P-256"))
  }
  const out = new Uint8Array(SPKI_HEADER.length + 65)
  out.set(SPKI_HEADER)
  out.set(point, SPKI_HEADER.length)
  return Effect.succeed(out)
}

/** `blake2b256(0x06 || publicKey)`. */
export const address = (publicKey: Uint8Array): Address.Address => Address.fromPublicKey(FLAG, publicKey)

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

const invalid = (reason: string) => new SignatureScheme.InvalidSignature({ scheme: NAME, reason })

const decodeAuthenticator = Bcs.decode(PasskeyAuthenticatorBcs)
const encodeAuthenticator = Bcs.encodeSync(PasskeyAuthenticatorBcs)
const utf8 = new TextEncoder()

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** What the authenticator signs: `authenticatorData || sha256(clientDataJSON)`. */
const signedMessage = (authenticatorData: Uint8Array, clientDataJSON: Uint8Array) =>
  concat(authenticatorData, sha256(clientDataJSON))

/** `serde_json`'s recursion limit: a container nested this deep (the outer object is 1) is refused. */
const SERDE_MAX_DEPTH = 128

/**
 * What `JSON.parse` accepts but `serde_json` (which validators parse
 * `clientDataJSON` with) refuses, in any key, known or not: a number out of
 * `f64` range (`1e999`, which parses to `Infinity`) and nesting at its
 * recursion limit. Duplicate keys and lone surrogates remain accepted gaps.
 */
const serdeRefuses = (value: unknown): string | undefined => {
  const stack: Array<[unknown, number]> = [[value, 1]]
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!
    if (typeof v === "number" && !Number.isFinite(v)) return "has a number out of range"
    if (typeof v === "object" && v !== null) {
      if (depth >= SERDE_MAX_DEPTH) return `nests ${SERDE_MAX_DEPTH} levels deep or more`
      for (const child of Object.values(v)) stack.push([child, depth + 1])
    }
  }
  return undefined
}

/**
 * The `clientDataJSON` checks validators make: it parses as WebAuthn
 * `CollectedClientData` (so `type` and `origin` are present), `type` is
 * `webauthn.get`, and `challenge` is unpadded base64url of exactly
 * `blake2b256(intentMessage)`.
 */
const checkClientData = (clientDataJson: string, intentMessage: Uint8Array): SignatureScheme.InvalidSignature | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(clientDataJson)
  } catch {
    return invalid("clientDataJSON is not JSON")
  }
  const serdeError = serdeRefuses(parsed)
  if (serdeError) return invalid(`clientDataJSON ${serdeError}`)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid("clientDataJSON is not an object")
  const { type, challenge, origin, crossOrigin } = parsed as Record<string, unknown>
  if (type !== "webauthn.get") return invalid(`clientDataJSON type is ${JSON.stringify(type)}, expected "webauthn.get"`)
  if (typeof origin !== "string") return invalid("clientDataJSON has no origin")
  if (typeof challenge !== "string") return invalid("clientDataJSON has no challenge")
  // WebAuthn's CollectedClientData has `crossOrigin: Option<bool>`; validators refuse anything else.
  if (crossOrigin !== undefined && crossOrigin !== null && typeof crossOrigin !== "boolean") {
    return invalid("clientDataJSON crossOrigin is not a boolean")
  }
  let decoded: Uint8Array
  try {
    decoded = base64urlnopad.decode(challenge)
  } catch {
    return invalid("clientDataJSON challenge is not unpadded base64url")
  }
  if (!sameBytes(decoded, Hash.blake2b256(intentMessage))) return invalid("clientDataJSON challenge is not this intent message's digest")
  return undefined
}

/** Verify a passkey signature body (after the 0x06 flag) over an intent message; answer the public key. */
const verifyBody = (body: Uint8Array, intentMessage: Uint8Array): Effect.Effect<Uint8Array, SignatureScheme.InvalidSignature> => {
  const decoded = decodeAuthenticator(body)
  if (Result.isFailure(decoded)) return Effect.fail(invalid(`malformed PasskeyAuthenticator: ${decoded.failure.message}`))
  const { authenticatorData, clientDataJson, userSignature } = decoded.success
  if (userSignature.length !== USER_SIGNATURE_SIZE) {
    return Effect.fail(invalid(`userSignature must be ${USER_SIGNATURE_SIZE} bytes, got ${userSignature.length}`))
  }
  if (userSignature[0] !== SECP256R1_FLAG) return Effect.fail(invalid("userSignature is not a Secp256r1 signature"))
  const clientDataError = checkClientData(clientDataJson, intentMessage)
  if (clientDataError) return Effect.fail(clientDataError)
  const signature = userSignature.subarray(1, 1 + SIG)
  const publicKey = userSignature.slice(1 + SIG)
  let ok = false
  try {
    // prehash: sha256 of the message; lowS: high-S signatures are refused, as validators do.
    ok = p256.verify(signature, signedMessage(authenticatorData, utf8.encode(clientDataJson)), publicKey, {
      lowS: true,
      prehash: true
    })
  } catch {
    ok = false
  }
  return ok ? Effect.succeed(publicKey) : Effect.fail(invalid("signature does not verify"))
}

export const scheme: SignatureScheme.SignatureScheme = {
  name: NAME,
  flag: FLAG,
  verify: (body, intentMessage) => Effect.map(verifyBody(body, intentMessage), (bytes) => ({ flag: FLAG, bytes })),
  verifyMember: (publicKey, signature, intentMessage) => {
    // Sui stores a passkey member's signature in full, `0x06 || body`, and the multisig scheme hands it over as is.
    if (signature[0] !== FLAG) return Effect.fail(invalid("member signature is not a serialized passkey signature (0x06 || body)"))
    return Effect.flatMap(verifyBody(signature.subarray(1), intentMessage), (signer) =>
      sameBytes(signer, publicKey) ? Effect.void : Effect.fail(invalid("signature is not from this member's passkey")))
  }
}

// -----------------------------------------------------------------------------
// Signing
// -----------------------------------------------------------------------------

export interface PasskeySigner extends Signer.Signer {
  /** Restricts assertions to this credential; `undefined` lets the authenticator offer any passkey for the site. */
  readonly credentialId: Uint8Array | undefined
}

const failed = (message: string) => new Signer.SigningError({ reason: "failed", message })

const parseDer = (der: Uint8Array) => {
  try {
    return Result.succeed(p256.Signature.fromBytes(der, "der"))
  } catch (e) {
    return Result.fail(failed(`the authenticator returned a malformed signature: ${String(e)}`))
  }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** Turn an assertion into a passkey signature body, as `@mysten/sui` does (the signature normalized to low-S). */
const authenticatorBody = (assertion: Assertion, publicKey: Uint8Array): Effect.Effect<Uint8Array, Signer.SigningError> => {
  const sig = parseDer(assertion.signature)
  if (Result.isFailure(sig)) return Effect.fail(sig.failure)
  const s = sig.success
  const compact = (s.hasHighS() ? new p256.Signature(s.r, p256.Point.Fn.neg(s.s)) : s).toBytes("compact")
  let clientDataJson: string
  try {
    clientDataJson = strictUtf8.decode(assertion.clientDataJSON)
  } catch {
    return Effect.fail(failed("the authenticator's clientDataJSON is not UTF-8"))
  }
  const userSignature = new Uint8Array(USER_SIGNATURE_SIZE)
  userSignature[0] = SECP256R1_FLAG
  userSignature.set(compact, 1)
  userSignature.set(publicKey, 1 + SIG)
  return Effect.succeed(encodeAuthenticator({ authenticatorData: assertion.authenticatorData, clientDataJson, userSignature }))
}

/**
 * A signer over a passkey whose public key you know (stored from `create`, or
 * found by `recover`). Pass the `credentialId` to keep the authenticator from
 * offering the user a different passkey.
 */
export const fromPublicKey = (
  provider: Provider,
  publicKey: Uint8Array,
  options?: { readonly credentialId?: Uint8Array | undefined }
): Effect.Effect<PasskeySigner, Signer.InvalidKey> => {
  if (publicKey.length !== PUBLIC_KEY_SIZE) {
    return Effect.fail(invalidKey(`expected a ${PUBLIC_KEY_SIZE}-byte compressed P-256 key, got ${publicKey.length} bytes`))
  }
  try {
    p256.Point.fromBytes(publicKey)
  } catch {
    return Effect.fail(invalidKey("public key is not on P-256"))
  }
  const pk = publicKey.slice()
  const credentialId = options?.credentialId?.slice()
  return Effect.succeed({
    address: address(pk),
    publicKey: { flag: FLAG, bytes: pk },
    credentialId,
    sign: (intentMessage) =>
      Effect.gen(function*() {
        const assertion = yield* provider.get(Hash.blake2b256(intentMessage), credentialId)
        const body = yield* authenticatorBody(assertion, pk)
        // Never hand out a signature that won't verify: the user may have picked another passkey.
        const checked = yield* Effect.result(verifyBody(body, intentMessage))
        if (Result.isFailure(checked)) {
          return yield* failed(`the assertion does not verify for this passkey (was another passkey used?): ${checked.failure.reason}`)
        }
        const out = new Uint8Array(1 + body.length)
        out[0] = FLAG
        out.set(body, 1)
        return out
      })
  })
}

/** Create a new passkey with the provider and answer its signer. For first-time users; returning users `recover`. */
export const create = (provider: Provider): Effect.Effect<PasskeySigner, Signer.SigningError | Signer.InvalidKey> =>
  Effect.flatMap(provider.create(), (credential) =>
    Effect.flatMap(publicKeyFromSpki(credential.publicKey), (pk) => fromPublicKey(provider, pk, { credentialId: credential.id })))

// -----------------------------------------------------------------------------
// Recovery
// -----------------------------------------------------------------------------

/** No single public key is common to both recovery candidate sets. */
export class NoUniquePublicKey extends Schema.TaggedError<NoUniquePublicKey>()("NoUniquePublicKey", {
  matches: Schema.Number
}) {
  override get message() {
    return this.matches === 0
      ? "no public key is common to both assertions (were they made by different passkeys?)"
      : `${this.matches} public keys are common to both assertions`
  }
}

export interface Recovered {
  /** Every public key (up to 4) that verifies the assertion. */
  readonly publicKeys: ReadonlyArray<Uint8Array>
  /** The credential that signed. */
  readonly credentialId: Uint8Array
}

/**
 * Ask the authenticator to sign `message` and recover every public key the
 * signature could be from. An assertion doesn't carry the public key, so a
 * returning user's key is found by intersecting two of these
 * (`findCommonPublicKey`), or by checking each candidate address on chain.
 */
export const recoverPublicKeys = (
  provider: Provider,
  message: Uint8Array,
  options?: { readonly credentialId?: Uint8Array | undefined }
): Effect.Effect<Recovered, Signer.SigningError> =>
  Effect.flatMap(provider.get(message, options?.credentialId), (assertion) => {
    const sig = parseDer(assertion.signature)
    if (Result.isFailure(sig)) return Effect.fail(sig.failure)
    const hash = sha256(signedMessage(assertion.authenticatorData, assertion.clientDataJSON))
    const publicKeys: Array<Uint8Array> = []
    for (let bit = 0; bit < 4; bit++) {
      try {
        publicKeys.push(sig.success.addRecoveryBit(bit).recoverPublicKey(hash).toBytes(true))
      } catch {
        continue
      }
    }
    return Effect.succeed({ publicKeys, credentialId: assertion.credentialId })
  })

/** The one public key present in both candidate sets. */
export const findCommonPublicKey = (
  a: ReadonlyArray<Uint8Array>,
  b: ReadonlyArray<Uint8Array>
): Effect.Effect<Uint8Array, NoUniquePublicKey> => {
  const matches = a.filter((x) => b.some((y) => sameBytes(x, y)))
  return matches.length === 1 ? Effect.succeed(matches[0]!) : Effect.fail(new NoUniquePublicKey({ matches: matches.length }))
}

/**
 * Recover a returning user's passkey signer: two assertions over distinct
 * messages (random by default), the second restricted to the credential the
 * user chose for the first, and the public key common to both.
 */
export const recover = (
  provider: Provider,
  options?: { readonly messages?: readonly [Uint8Array, Uint8Array] }
): Effect.Effect<PasskeySigner, Signer.SigningError | NoUniquePublicKey> =>
  Effect.gen(function*() {
    const [m1, m2] = options?.messages ?? [crypto.getRandomValues(new Uint8Array(32)), crypto.getRandomValues(new Uint8Array(32))]
    const first = yield* recoverPublicKeys(provider, m1)
    const second = yield* recoverPublicKeys(provider, m2, { credentialId: first.credentialId })
    const publicKey = yield* findCommonPublicKey(first.publicKeys, second.publicKeys)
    // A recovered point is always a valid 33-byte key.
    return yield* Effect.orDie(fromPublicKey(provider, publicKey, { credentialId: first.credentialId }))
  })
