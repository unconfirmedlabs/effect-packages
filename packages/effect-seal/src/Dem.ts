/**
 * Seal's data encapsulation (C12–C14): what encrypts the payload under the
 * DEM key.
 *
 * - `AesGcm256`: AES-256-GCM with Seal's fixed 16-byte IV (the key is never
 *   reused), tag appended to the blob. Runs on WebCrypto; a runtime without
 *   `crypto.subtle` gets `CryptoUnavailable`.
 * - `Hmac256Ctr`: HMAC-SHA3-256 in counter mode with an HMAC-SHA3-256 MAC, the
 *   only mode Move can decrypt. Synchronous, on noble (`hmacCtr`).
 * - `Plain`: no data; "decrypting" returns the DEM key itself (`seal-cli`'s
 *   key derivation). Unverified keys yield a wrong key silently in this mode.
 *
 * An absent `aad` is written as `Some(empty)`, as `@mysten/seal` does (byte
 * parity); both forms read the same. No curve code.
 */
import { hmac } from "@noble/hashes/hmac.js"
import { sha3_256 } from "@noble/hashes/sha3.js"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { concat, utf8 } from "./bytes.ts"
import { CryptoUnavailable, DecryptionFailed } from "./Errors.ts"

export { CryptoUnavailable, DecryptionFailed }

/** What to encrypt. */
export type Input =
  | { readonly _tag: "AesGcm256"; readonly data: Uint8Array; readonly aad?: Uint8Array }
  | { readonly _tag: "Hmac256Ctr"; readonly data: Uint8Array; readonly aad?: Uint8Array }
  | { readonly _tag: "Plain" }

/**
 * The `ciphertext` field of an encrypted object (I2), in `@unconfirmed/effect-bcs`'s enum shape: the
 * decoded type of `EncryptedObject.Ciphertext`.
 */
export type Ciphertext =
  | { readonly _tag: "Aes256Gcm"; readonly blob: Uint8Array; readonly aad: Option.Option<Uint8Array> }
  | {
    readonly _tag: "Hmac256Ctr"
    readonly blob: Uint8Array
    readonly aad: Option.Option<Uint8Array>
    readonly mac: Uint8Array
  }
  | { readonly _tag: "Plain" }

export const KEY_BYTES = 32

/** Seal's fixed AES-GCM IV, `8a3799fdc62e79dba0805907d69c94dc` (C12). */
export const AES_IV: Uint8Array = /* @__PURE__ */ Uint8Array.of(
  0x8a, 0x37, 0x99, 0xfd, 0xc6, 0x2e, 0x79, 0xdb, 0xa0, 0x80, 0x59, 0x07, 0xd6, 0x9c, 0x94, 0xdc
)

const EMPTY = /* @__PURE__ */ new Uint8Array(0)

const checkKey = (key: Uint8Array): Effect.Effect<void> =>
  key.length === KEY_BYTES ? Effect.void : Effect.die(new Error(`DEM key must be ${KEY_BYTES} bytes, got ${key.length}`))

// -----------------------------------------------------------------------------
// HMAC-SHA3-256 CTR (C13)
// -----------------------------------------------------------------------------

const ENC_TAG = /* @__PURE__ */ utf8("HMAC-CTR-ENC")
const MAC_TAG = /* @__PURE__ */ utf8("HMAC-CTR-MAC")
const BLOCK = 32

const u64le = (n: number): Uint8Array => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true)
  return out
}

/** Block `i` XORed with `hmac(key, "HMAC-CTR-ENC" ‖ u64le(i))`; its own inverse. */
const ctr = (key: Uint8Array, input: Uint8Array): Uint8Array => {
  const out = new Uint8Array(input.length)
  const counter = concat([ENC_TAG, new Uint8Array(8)])
  const view = new DataView(counter.buffer, ENC_TAG.length, 8)
  const mac = hmac.create(sha3_256, key)
  for (let i = 0, offset = 0; offset < input.length; i++, offset += BLOCK) {
    view.setBigUint64(0, BigInt(i), true)
    const pad = mac.clone().update(counter).digest()
    const end = Math.min(input.length, offset + BLOCK)
    for (let j = offset; j < end; j++) out[j] = input[j]! ^ pad[j - offset]!
  }
  return out
}

/** `hmac(key, "HMAC-CTR-MAC" ‖ u64le(len(aad)) ‖ aad ‖ ciphertext)`. */
const computeMac = (key: Uint8Array, aad: Uint8Array, blob: Uint8Array): Uint8Array =>
  hmac.create(sha3_256, key).update(MAC_TAG).update(u64le(aad.length)).update(aad).update(blob).digest()

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** The synchronous half, also usable on its own. One 32-byte key for both encryption and MAC. */
export const hmacCtr: {
  readonly encrypt: (key: Uint8Array, data: Uint8Array, aad: Uint8Array) => { readonly blob: Uint8Array; readonly mac: Uint8Array }
  readonly decrypt: (key: Uint8Array, blob: Uint8Array, mac: Uint8Array, aad: Uint8Array) => Result.Result<Uint8Array, DecryptionFailed>
} = {
  encrypt: (key, data, aad) => {
    const blob = ctr(key, data)
    return { blob, mac: computeMac(key, aad, blob) }
  },
  decrypt: (key, blob, mac, aad) =>
    constantTimeEqual(computeMac(key, aad, blob), mac)
      ? Result.succeed(ctr(key, blob))
      : Result.fail(new DecryptionFailed({ reason: "mac" }))
}

// -----------------------------------------------------------------------------
// AES-256-GCM on WebCrypto (C12)
// -----------------------------------------------------------------------------

const unavailable = (cause: unknown) =>
  new CryptoUnavailable({
    message: `WebCrypto AES-GCM is unavailable${cause instanceof Error ? `: ${cause.message}` : ""}`
  })

const subtle: Effect.Effect<SubtleCrypto, CryptoUnavailable> = /* @__PURE__ */ Effect.suspend(() => {
  const s = globalThis.crypto?.subtle
  return s === undefined
    ? Effect.fail(new CryptoUnavailable({ message: "crypto.subtle is not available (insecure context?)" }))
    : Effect.succeed(s)
})

const importAes = (key: Uint8Array, usage: "encrypt" | "decrypt") =>
  Effect.flatMap(subtle, (s) =>
    Effect.tryPromise({
      try: () => s.importKey("raw", key as Uint8Array<ArrayBuffer>, "AES-GCM", false, [usage]),
      catch: unavailable
    }).pipe(Effect.map((k) => [s, k] as const)))

const aesParams = (aad: Uint8Array): AesGcmParams => ({
  name: "AES-GCM",
  iv: AES_IV as Uint8Array<ArrayBuffer>,
  additionalData: aad as Uint8Array<ArrayBuffer>
})

const aesEncrypt = (key: Uint8Array, data: Uint8Array, aad: Uint8Array) =>
  Effect.flatMap(importAes(key, "encrypt"), ([s, k]) =>
    Effect.tryPromise({
      try: () => s.encrypt(aesParams(aad), k, data as Uint8Array<ArrayBuffer>),
      catch: unavailable
    }).pipe(Effect.map((buffer) => new Uint8Array(buffer))))

const aesDecrypt = (key: Uint8Array, blob: Uint8Array, aad: Uint8Array) =>
  Effect.flatMap(importAes(key, "decrypt"), ([s, k]) =>
    Effect.tryPromise({
      try: () => s.decrypt(aesParams(aad), k, blob as Uint8Array<ArrayBuffer>),
      catch: () => new DecryptionFailed({ reason: "tag" })
    }).pipe(Effect.map((buffer) => new Uint8Array(buffer))))

// -----------------------------------------------------------------------------
// The DEM
// -----------------------------------------------------------------------------

/** Encrypt under a 32-byte DEM key (another length is a defect). */
export const encrypt = (input: Input, key: Uint8Array): Effect.Effect<Ciphertext, CryptoUnavailable> =>
  Effect.flatMap(checkKey(key), (): Effect.Effect<Ciphertext, CryptoUnavailable> => {
    switch (input._tag) {
      case "Plain":
        return Effect.succeed({ _tag: "Plain" })
      case "Hmac256Ctr": {
        const aad = input.aad ?? EMPTY
        const { blob, mac } = hmacCtr.encrypt(key, input.data, aad)
        return Effect.succeed({ _tag: "Hmac256Ctr", blob, aad: Option.some(aad), mac })
      }
      case "AesGcm256": {
        const aad = input.aad ?? EMPTY
        return Effect.map(aesEncrypt(key, input.data, aad), (blob) => ({ _tag: "Aes256Gcm", blob, aad: Option.some(aad) }))
      }
    }
  })

/** Decrypt under a 32-byte DEM key (another length is a defect). `Plain` returns a copy of the key. */
export const decrypt = (
  ciphertext: Ciphertext,
  key: Uint8Array
): Effect.Effect<Uint8Array, DecryptionFailed | CryptoUnavailable> =>
  Effect.flatMap(checkKey(key), (): Effect.Effect<Uint8Array, DecryptionFailed | CryptoUnavailable> => {
    switch (ciphertext._tag) {
      case "Plain":
        return Effect.succeed(key.slice())
      case "Hmac256Ctr":
        return Effect.fromResult(
          hmacCtr.decrypt(key, ciphertext.blob, ciphertext.mac, Option.getOrElse(ciphertext.aad, () => EMPTY))
        )
      case "Aes256Gcm":
        return aesDecrypt(key, ciphertext.blob, Option.getOrElse(ciphertext.aad, () => EMPTY))
    }
  })
