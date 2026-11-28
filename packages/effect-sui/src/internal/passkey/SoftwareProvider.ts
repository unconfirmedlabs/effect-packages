/**
 * A software authenticator: a P-256 key in memory answering WebAuthn the way a
 * platform authenticator does (DER signatures, which may be high-S;
 * `authenticatorData = sha256(rpId) || flags || signCount`; a `clientDataJSON`
 * with type, challenge, origin and crossOrigin). For tests and for running the
 * passkey signer outside a browser. It is not a secure place for a key.
 *
 *   const provider = yield* SoftwareProvider.softwareProvider()
 *   const signer = yield* Passkey.create(provider)
 */
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { base64urlnopad } from "@scure/base"
import * as Signer from "../../Signer.ts"
import * as Effect from "effect/Effect"
import * as Passkey from "./Passkey.ts"

export interface SoftwareProviderOptions {
  /** A 32-byte P-256 secret key. Random by default. */
  readonly secretKey?: Uint8Array
  /** Random 16 bytes by default. */
  readonly credentialId?: Uint8Array
  /** Default `"localhost"`. */
  readonly rpId?: string
  /** Default `https://${rpId}`. */
  readonly origin?: string
  /** The signature counter written into `authenticatorData`. Default 0 (synced passkeys don't count). */
  readonly signCount?: number
}

export interface SoftwareProvider extends Passkey.Provider {
  readonly secretKey: Uint8Array
  readonly credentialId: Uint8Array
  /** The compressed public key. */
  readonly publicKey: Uint8Array
}

const FLAG_USER_PRESENT = 0x01
const FLAG_USER_VERIFIED = 0x04

const utf8 = new TextEncoder()

export const softwareProvider = (options?: SoftwareProviderOptions): Effect.Effect<SoftwareProvider, Signer.InvalidKey> =>
  Effect.suspend(() => {
    const secretKey = options?.secretKey?.slice() ?? p256.utils.randomSecretKey()
    let publicKey: Uint8Array
    try {
      publicKey = p256.getPublicKey(secretKey, true)
    } catch {
      // A fixed reason: the curve library's message is not ours to vouch for (it must never carry key bytes).
      return Effect.fail(
        new Signer.InvalidKey({
          scheme: "Passkey",
          reason: "invalid secret key (expected 32 bytes, a non-zero scalar below the curve order)"
        })
      )
    }
    const credentialId = options?.credentialId?.slice() ?? crypto.getRandomValues(new Uint8Array(16))
    const rpId = options?.rpId ?? "localhost"
    const origin = options?.origin ?? `https://${rpId}`
    const authenticatorData = new Uint8Array(37)
    authenticatorData.set(sha256(utf8.encode(rpId)))
    authenticatorData[32] = FLAG_USER_PRESENT | FLAG_USER_VERIFIED
    new DataView(authenticatorData.buffer).setUint32(33, options?.signCount ?? 0)
    const sameId = (id: Uint8Array) => id.length === credentialId.length && id.every((x, i) => x === credentialId[i])

    return Effect.succeed<SoftwareProvider>({
      secretKey,
      credentialId,
      publicKey,
      // `publicKey` came from the curve, so it always encodes.
      create: () =>
        Effect.map(Effect.orDie(Passkey.spkiFromPublicKey(publicKey)), (spki) => ({ id: credentialId.slice(), publicKey: spki })),
      get: (challenge, allowed) =>
        Effect.suspend(() => {
          if (allowed !== undefined && !sameId(allowed)) {
            return Effect.fail(new Signer.SigningError({ reason: "failed", message: "no credential matches the requested credential id" }))
          }
          const clientDataJSON = utf8.encode(
            JSON.stringify({ type: "webauthn.get", challenge: base64urlnopad.encode(challenge), origin, crossOrigin: false })
          )
          const message = new Uint8Array(authenticatorData.length + 32)
          message.set(authenticatorData)
          message.set(sha256(clientDataJSON), authenticatorData.length)
          // Authenticators don't normalize S; the signer must.
          const signature = p256.sign(message, secretKey, { lowS: false, format: "der" })
          return Effect.succeed({ credentialId: credentialId.slice(), authenticatorData: authenticatorData.slice(), clientDataJSON, signature })
        })
    })
  })
