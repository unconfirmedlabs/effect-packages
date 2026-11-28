/**
 * Secp256r1 for `@unconfirmed/effect-sui`: a `SignatureScheme` to install in the
 * registry, and signer constructors. Signatures are ECDSA over
 * `sha256(blake2b256(intentMessage))`, low-S, 64-byte compact `r || s`
 * (`@unconfirmed/effect-sui/Ecdsa` over noble's `p256`).
 *
 *   SignatureSchemes.layer(Ed25519.scheme, Secp256r1.scheme)
 *   const signer = yield* Secp256r1.fromSecretKey(secretKey)
 */
import { p256 } from "@noble/curves/nist.js"
import * as Ecdsa from "./Ecdsa.ts"

export const FLAG = 0x02

const ecdsa = /* @__PURE__ */ Ecdsa.make(p256, FLAG, "Secp256r1")

export const scheme = ecdsa.scheme

/** A signer over a 32-byte secret key. */
export const fromSecretKey = ecdsa.fromSecretKey

/** `fromSecretKey`, synchronously: a `Result` instead of an `Effect`. */
export const fromSecretKeyResult = ecdsa.fromSecretKeyResult

/** A fresh random 32-byte secret key, to keep or export (`PrivateKey.encode({ flag: FLAG, secretKey })`). */
export const generateSecretKey = ecdsa.generateSecretKey

/** A signer over a fresh random key. Use `generateSecretKey` to keep the key. */
export const generate = ecdsa.generate
