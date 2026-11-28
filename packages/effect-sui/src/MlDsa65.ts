/**
 * ML-DSA-65 (FIPS 204, post-quantum) for `@unconfirmed/sui`: a
 * `SignatureScheme` to install in the registry, and signer constructors.
 *
 * As in Sui and `@mysten/sui`: flag `0x07`, 1952-byte public keys, 3309-byte
 * signatures, pure ML-DSA-65 with an empty context over
 * `blake2b256(intentMessage)`. The secret key is the 32-byte keygen seed (what
 * `suiprivkey` stores). Signing is hedged: each signature mixes in fresh
 * randomness, so signing twice gives two different valid signatures.
 *
 *   SignatureSchemes.layer(Ed25519.scheme, MlDsa65.scheme)
 *   const signer = yield* MlDsa65.fromSecretKey(seed)
 */
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js"
import * as Address from "@unconfirmed/sui/Address"
import * as Hash from "@unconfirmed/sui/Hash"
import * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Signer from "@unconfirmed/sui/Signer"
import * as Effect from "effect/Effect"

export const FLAG = 0x07
export const PUBLIC_KEY_SIZE = 1952
export const SIGNATURE_SIZE = 3309
export const SECRET_KEY_SIZE = 32
const NAME = "MLDSA65"

const check = (publicKey: Uint8Array, signature: Uint8Array, intentMessage: Uint8Array) => {
  let ok = false
  if (publicKey.length === PUBLIC_KEY_SIZE && signature.length === SIGNATURE_SIZE) {
    try {
      ok = ml_dsa65.verify(signature, Hash.blake2b256(intentMessage), publicKey)
    } catch {
      ok = false
    }
  }
  return ok
    ? Effect.void
    : Effect.fail(new SignatureScheme.InvalidSignature({ scheme: NAME, reason: "signature does not verify" }))
}

export const scheme: SignatureScheme.SignatureScheme = {
  name: NAME,
  flag: FLAG,
  verify: (body, intentMessage) => {
    if (body.length !== SIGNATURE_SIZE + PUBLIC_KEY_SIZE) {
      return Effect.fail(
        new SignatureScheme.InvalidSignature({
          scheme: NAME,
          reason: `expected ${SIGNATURE_SIZE + PUBLIC_KEY_SIZE} bytes, got ${body.length}`
        })
      )
    }
    const publicKey = body.subarray(SIGNATURE_SIZE)
    return Effect.as(check(publicKey, body.subarray(0, SIGNATURE_SIZE), intentMessage), {
      flag: FLAG,
      bytes: publicKey.slice()
    })
  },
  verifyMember: (publicKey, signature, intentMessage) => check(publicKey, signature, intentMessage)
}

/** A signer over a 32-byte secret key (the FIPS 204 keygen seed). */
export const fromSecretKey = (secretKey: Uint8Array): Effect.Effect<Signer.Signer, Signer.InvalidKey> => {
  if (secretKey.length !== SECRET_KEY_SIZE) {
    return Effect.fail(new Signer.InvalidKey({ scheme: NAME, reason: `expected a ${SECRET_KEY_SIZE}-byte seed, got ${secretKey.length}` }))
  }
  return Effect.sync(() => {
    const { publicKey: pk, secretKey: expanded } = ml_dsa65.keygen(secretKey.slice())
    return {
      address: Address.fromPublicKey(FLAG, pk),
      publicKey: { flag: FLAG, bytes: pk },
      sign: (intentMessage) =>
        Effect.sync(() => {
          const sig = ml_dsa65.sign(Hash.blake2b256(intentMessage), expanded)
          const out = new Uint8Array(1 + SIGNATURE_SIZE + PUBLIC_KEY_SIZE)
          out[0] = FLAG
          out.set(sig, 1)
          out.set(pk, 1 + SIGNATURE_SIZE)
          return out
        })
    }
  })
}

/** For ML-DSA-65 the seed is the secret key: same as `fromSecretKey`. */
export const fromSeed = fromSecretKey

/** A fresh random 32-byte secret key, to keep or export (`PrivateKey.encode({ flag: FLAG, secretKey })`). */
export const generateSecretKey: Effect.Effect<Uint8Array> = Effect.sync(() => crypto.getRandomValues(new Uint8Array(SECRET_KEY_SIZE)))

/** A signer over a fresh random key. Use `generateSecretKey` to keep the key. */
export const generate: Effect.Effect<Signer.Signer> = Effect.flatMap(generateSecretKey, (sk) => Effect.orDie(fromSecretKey(sk)))
