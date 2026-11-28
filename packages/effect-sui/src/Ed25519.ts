/**
 * Ed25519: the default scheme, and the only one the core ships. It is still
 * just a `SignatureScheme` value: nothing in the core special-cases it.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Address from "./Address.ts"
import * as Hash from "./Hash.ts"
import { InvalidSignature, type SignatureScheme } from "./SignatureScheme.ts"
import { InvalidKey, type Signer } from "./Signer.ts"

export const FLAG = 0x00
const SIG = 64
const PK = 32

const check = (publicKey: Uint8Array, signature: Uint8Array, intentMessage: Uint8Array) => {
  let ok = false
  try {
    ok = ed25519.verify(signature, Hash.blake2b256(intentMessage), publicKey)
  } catch {
    ok = false
  }
  return ok ? Effect.void : Effect.fail(new InvalidSignature({ scheme: "ED25519", reason: "signature does not verify" }))
}

export const scheme: SignatureScheme = {
  name: "ED25519",
  flag: FLAG,
  verify: (body, intentMessage) => {
    if (body.length !== SIG + PK) {
      return Effect.fail(new InvalidSignature({ scheme: "ED25519", reason: `expected ${SIG + PK} bytes, got ${body.length}` }))
    }
    const publicKey = body.subarray(SIG)
    return Effect.as(check(publicKey, body.subarray(0, SIG), intentMessage), { flag: FLAG, bytes: publicKey.slice() })
  },
  verifyMember: (publicKey, signature, intentMessage) => check(publicKey, signature, intentMessage)
}

/**
 * Whether `signature` is `publicKey`'s Ed25519 signature over `message` itself, not over an intent
 * message: what Move's `sui::ed25519::ed25519_verify` checks (e.g. a Nautilus enclave's
 * signatures). Malformed keys or signatures are `false`. Sui transactions and personal messages
 * are verified through `scheme` instead.
 */
export const verifyRaw = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean => {
  try {
    return ed25519.verify(signature, message, publicKey)
  } catch {
    return false
  }
}

/** `fromSecretKey`, synchronously: a `Result` instead of an `Effect`. */
export const fromSecretKeyResult = (secretKey: Uint8Array): Result.Result<Signer, InvalidKey> => {
  if (secretKey.length !== 32) {
    return Result.fail(new InvalidKey({ scheme: "ED25519", reason: `expected 32 bytes, got ${secretKey.length}` }))
  }
  const sk = secretKey.slice()
  const pk = ed25519.getPublicKey(sk)
  return Result.succeed({
    address: Address.fromPublicKey(FLAG, pk),
    publicKey: { flag: FLAG, bytes: pk },
    sign: (intentMessage) =>
      Effect.sync(() => {
        const sig = ed25519.sign(Hash.blake2b256(intentMessage), sk)
        const out = new Uint8Array(1 + SIG + PK)
        out[0] = FLAG
        out.set(sig, 1)
        out.set(pk, 1 + SIG)
        return out
      })
  })
}

/** A signer over a 32-byte secret key (seed). */
export const fromSecretKey = (secretKey: Uint8Array): Effect.Effect<Signer, InvalidKey> =>
  Effect.fromResult(fromSecretKeyResult(secretKey))

/** A fresh random 32-byte secret key, to keep or export (`PrivateKey.encode({ flag: FLAG, secretKey })`). */
export const generateSecretKey: Effect.Effect<Uint8Array> = /* @__PURE__ */ Effect.sync(() => crypto.getRandomValues(new Uint8Array(32)))

/** A signer over a fresh random key. Use `generateSecretKey` to keep the key. */
export const generate: Effect.Effect<Signer> = /* @__PURE__ */ Effect.flatMap(generateSecretKey, (sk) => Effect.orDie(fromSecretKey(sk)))
