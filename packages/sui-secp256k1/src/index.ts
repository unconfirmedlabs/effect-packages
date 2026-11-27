/**
 * Secp256k1 for `@unconfirmed/sui`: a `SignatureScheme` to install in the
 * registry, and signer constructors. Signatures are ECDSA over
 * `sha256(blake2b256(intentMessage))`, low-S, 64-byte compact `r || s`
 * (`@unconfirmed/sui/Ecdsa` over noble's `secp256k1`).
 *
 *   SignatureSchemes.layer(Ed25519.scheme, Secp256k1.scheme)
 *   const signer = yield* Secp256k1.fromSecretKey(secretKey)
 */
import { secp256k1 } from "@noble/curves/secp256k1.js"
import * as Ecdsa from "@unconfirmed/sui/Ecdsa"

export const FLAG = 0x01

const ecdsa = /* @__PURE__ */ Ecdsa.make(secp256k1, FLAG, "Secp256k1")

export const scheme = ecdsa.scheme

/** A signer over a 32-byte secret key. */
export const fromSecretKey = ecdsa.fromSecretKey

/** A fresh random 32-byte secret key, to keep or export (`PrivateKey.encode({ flag: FLAG, secretKey })`). */
export const generateSecretKey = ecdsa.generateSecretKey

/** A signer over a fresh random key. Use `generateSecretKey` to keep the key. */
export const generate = ecdsa.generate
