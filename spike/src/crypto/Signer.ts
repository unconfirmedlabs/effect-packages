/**
 * Signers are values with an effectful `sign`, so a hardware wallet, a KMS, a
 * browser wallet and an in-memory key are the same shape and the same type.
 *
 * Ed25519 goes through `effect/crypto` (WebCrypto). Sui also needs BLAKE2b,
 * secp256k1 and BLS12-381, which WebCrypto lacks; those come from @noble.
 */
import { blake2b } from "@noble/hashes/blake2.js"
import { Effect, Schema } from "effect"
import { Signature } from "effect/crypto"
import type { CryptoError } from "effect/crypto/CryptoError"
import * as T from "../sui/Types.ts"

export type Scheme = "ED25519" | "Secp256k1" | "Secp256r1" | "MultiSig" | "ZkLogin" | "Passkey"
const FLAG: Record<"ED25519", number> = { ED25519: 0x00 }

export class SigningError extends Schema.TaggedError<SigningError>()("SigningError", {
  reason: Schema.Literals(["rejected", "unavailable", "failed"]),
  message: Schema.String
}) {}

export interface Signer {
  readonly address: T.Address
  readonly scheme: Scheme
  readonly publicKey: Uint8Array
  /** Sign the 32-byte intent-message digest; returns the serialized Sui signature. */
  readonly signDigest: (digest: Uint8Array) => Effect.Effect<Uint8Array, SigningError>
}

const blake2b256 = (b: Uint8Array) => blake2b(b, { dkLen: 32 })

export const addressOf = (flag: number, publicKey: Uint8Array): T.Address => {
  const h = blake2b256(Uint8Array.of(flag, ...publicKey))
  return T.address(Array.from(h, (x) => x.toString(16).padStart(2, "0")).join(""))
}

/** `blake2b256(intent || bcs)`: what every Sui signature scheme signs. */
export const intentDigest = (scope: number, bytes: Uint8Array) => {
  const msg = new Uint8Array(3 + bytes.length)
  msg.set([scope, 0, 0])
  msg.set(bytes, 3)
  return blake2b256(msg)
}

export const signTransaction = (signer: Signer, txBytes: Uint8Array) =>
  signer.signDigest(intentDigest(T.IntentScope.TransactionData, txBytes))

/** An in-memory Ed25519 key from a 32-byte seed. */
export const ed25519 = Effect.fn("Signer.ed25519")(function*(seed: Uint8Array) {
  const crypto = yield* Signature.Signature
  const sk = yield* Signature.privateKey(Signature.ed25519, seed)
  const pk = yield* Signature.toBytes(yield* crypto.publicKeyOf(sk))
  return {
    address: addressOf(FLAG.ED25519, pk),
    scheme: "ED25519",
    publicKey: pk,
    signDigest: (digest) =>
      crypto.sign(sk, digest).pipe(
        Effect.map((sig) => Uint8Array.of(FLAG.ED25519, ...sig, ...pk)),
        Effect.mapError((e: CryptoError) => new SigningError({ reason: "failed", message: e.message }))
      )
  } satisfies Signer
})
