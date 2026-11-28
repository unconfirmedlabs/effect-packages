/**
 * The ECDSA schemes (Secp256k1, Secp256r1) over a curve passed in, so the
 * core links no curve: `@unconfirmed/sui-secp256k1` and `-secp256r1` give
 * their noble curve and flag. Signatures are ECDSA over
 * `sha256(blake2b256(intentMessage))`, low-S, 64-byte compact `r || s`;
 * public keys are 33-byte compressed points.
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Address from "./Address.ts"
import * as Hash from "./Hash.ts"
import * as SignatureScheme from "./SignatureScheme.ts"
import * as Signer from "./Signer.ts"

/** What the scheme needs from a noble curve (`secp256k1`, `p256`). */
export interface Curve {
  readonly verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array, options: { lowS: boolean; prehash: boolean }) => boolean
  readonly sign: (message: Uint8Array, secretKey: Uint8Array, options: { lowS: boolean; prehash: boolean }) => Uint8Array
  readonly getPublicKey: (secretKey: Uint8Array, compressed: boolean) => Uint8Array
  readonly utils: { readonly randomSecretKey: () => Uint8Array }
}

export interface Ecdsa {
  readonly scheme: SignatureScheme.SignatureScheme
  /** A signer over a 32-byte secret key. */
  readonly fromSecretKey: (secretKey: Uint8Array) => Effect.Effect<Signer.Signer, Signer.InvalidKey>
  /** `fromSecretKey`, synchronously: a `Result` instead of an `Effect`. */
  readonly fromSecretKeyResult: (secretKey: Uint8Array) => Result.Result<Signer.Signer, Signer.InvalidKey>
  /** A fresh random 32-byte secret key, to keep or export (`PrivateKey.encode({ flag, secretKey })`). */
  readonly generateSecretKey: Effect.Effect<Uint8Array>
  /** A signer over a fresh random key. Use `generateSecretKey` to keep the key. */
  readonly generate: Effect.Effect<Signer.Signer>
}

const SIG = 64
const PK = 33
// Explicit, not noble's defaults: Sui refuses high-S signatures, and the curve hashes with SHA-256.
const OPTIONS = { lowS: true, prehash: true }

export const make = (curve: Curve, flag: number, name: string): Ecdsa => {
  const check = (publicKey: Uint8Array, signature: Uint8Array, intentMessage: Uint8Array) => {
    let ok = false
    try {
      ok = curve.verify(signature, Hash.blake2b256(intentMessage), publicKey, OPTIONS)
    } catch {
      ok = false
    }
    return ok
      ? Effect.void
      : Effect.fail(new SignatureScheme.InvalidSignature({ scheme: name, reason: "signature does not verify" }))
  }

  const scheme: SignatureScheme.SignatureScheme = {
    name,
    flag,
    verify: (body, intentMessage) => {
      if (body.length !== SIG + PK) {
        return Effect.fail(
          new SignatureScheme.InvalidSignature({ scheme: name, reason: `expected ${SIG + PK} bytes, got ${body.length}` })
        )
      }
      const publicKey = body.subarray(SIG)
      return Effect.as(check(publicKey, body.subarray(0, SIG), intentMessage), { flag, bytes: publicKey.slice() })
    },
    verifyMember: (publicKey, signature, intentMessage) => check(publicKey, signature, intentMessage)
  }

  const fromSecretKeyResult = (secretKey: Uint8Array): Result.Result<Signer.Signer, Signer.InvalidKey> => {
    let pk: Uint8Array
    try {
      pk = curve.getPublicKey(secretKey, true)
    } catch {
      // A fixed reason: the curve library's message is not ours to vouch for (it must never carry key bytes).
      return Result.fail(
        new Signer.InvalidKey({ scheme: name, reason: "invalid secret key (expected 32 bytes, a non-zero scalar below the curve order)" })
      )
    }
    const sk = secretKey.slice()
    return Result.succeed({
      address: Address.fromPublicKey(flag, pk),
      publicKey: { flag, bytes: pk },
      sign: (intentMessage) =>
        Effect.sync(() => {
          const sig = curve.sign(Hash.blake2b256(intentMessage), sk, OPTIONS)
          const out = new Uint8Array(1 + SIG + PK)
          out[0] = flag
          out.set(sig, 1)
          out.set(pk, 1 + SIG)
          return out
        })
    })
  }

  const fromSecretKey = (secretKey: Uint8Array) => Effect.fromResult(fromSecretKeyResult(secretKey))
  const generateSecretKey = Effect.sync(() => curve.utils.randomSecretKey())
  return {
    scheme,
    fromSecretKey,
    fromSecretKeyResult,
    generateSecretKey,
    generate: Effect.flatMap(generateSecretKey, (sk) => Effect.orDie(fromSecretKey(sk)))
  }
}
