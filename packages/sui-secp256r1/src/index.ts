/**
 * Secp256r1 for `@unconfirmed/sui`: a `SignatureScheme` to install in the
 * registry, and signer constructors. Signatures are ECDSA over
 * `sha256(blake2b256(intentMessage))`, low-S, 64-byte compact `r || s`.
 *
 *   SignatureSchemes.layer(Ed25519.scheme, Secp256r1.scheme)
 *   const signer = yield* Secp256r1.fromSecretKey(secretKey)
 */
import { p256 } from "@noble/curves/nist.js"
import * as Address from "@unconfirmed/sui/Address"
import * as Hash from "@unconfirmed/sui/Hash"
import * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Signer from "@unconfirmed/sui/Signer"
import * as Effect from "effect/Effect"

export const FLAG = 0x02
const NAME = "Secp256r1"
const SIG = 64
const PK = 33

const check = (publicKey: Uint8Array, signature: Uint8Array, intentMessage: Uint8Array) => {
  let ok = false
  try {
    // Explicit, not noble's defaults: Sui refuses high-S signatures, and the curve hashes with SHA-256.
    ok = p256.verify(signature, Hash.blake2b256(intentMessage), publicKey, { lowS: true, prehash: true })
  } catch {
    ok = false
  }
  return ok
    ? Effect.void
    : Effect.fail(new SignatureScheme.InvalidSignature({ scheme: NAME, reason: "signature does not verify" }))
}

export const scheme: SignatureScheme.SignatureScheme = {
  name: NAME,
  flag: FLAG,
  verify: (body, intentMessage) => {
    if (body.length !== SIG + PK) {
      return Effect.fail(
        new SignatureScheme.InvalidSignature({ scheme: NAME, reason: `expected ${SIG + PK} bytes, got ${body.length}` })
      )
    }
    const publicKey = body.subarray(SIG)
    return Effect.as(check(publicKey, body.subarray(0, SIG), intentMessage), { flag: FLAG, bytes: publicKey.slice() })
  },
  verifyMember: (publicKey, signature, intentMessage) => check(publicKey, signature, intentMessage)
}

/** A signer over a 32-byte secret key. */
export const fromSecretKey = (secretKey: Uint8Array): Effect.Effect<Signer.Signer, Signer.InvalidKey> => {
  let pk: Uint8Array
  try {
    pk = p256.getPublicKey(secretKey, true)
  } catch {
    // A fixed reason: the curve library's message is not ours to vouch for (it must never carry key bytes).
    return Effect.fail(new Signer.InvalidKey({ scheme: NAME, reason: "invalid secret key (expected 32 bytes, a non-zero scalar below the curve order)" }))
  }
  const sk = secretKey.slice()
  return Effect.succeed({
    address: Address.fromPublicKey(FLAG, pk),
    publicKey: { flag: FLAG, bytes: pk },
    sign: (intentMessage) =>
      Effect.sync(() => {
        const sig = p256.sign(Hash.blake2b256(intentMessage), sk, { lowS: true, prehash: true })
        const out = new Uint8Array(1 + SIG + PK)
        out[0] = FLAG
        out.set(sig, 1)
        out.set(pk, 1 + SIG)
        return out
      })
  })
}

/** A fresh random 32-byte secret key, to keep or export (`PrivateKey.encode({ flag: FLAG, secretKey })`). */
export const generateSecretKey: Effect.Effect<Uint8Array> = Effect.sync(() => p256.utils.randomSecretKey())

/** A signer over a fresh random key. Use `generateSecretKey` to keep the key. */
export const generate: Effect.Effect<Signer.Signer> = Effect.flatMap(generateSecretKey, (sk) => Effect.orDie(fromSecretKey(sk)))
