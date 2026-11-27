/**
 * Private keys as the Sui CLI and wallets exchange them.
 *
 * - `suiprivkey1…`: bech32 of `flag || 32-byte secret`, what `sui keytool
 *   export` prints and wallets import.
 * - `sui.keystore`: the CLI's key file, a JSON array of base64 `flag || secret`.
 *
 * The core can't build a signer for a scheme it doesn't ship (secp256k1/r1 and
 * ML-DSA-65 are plugins), so decoding answers bytes and the scheme package
 * makes the signer:
 *
 *   const { flag, secretKey } = yield* PrivateKey.decode(s)
 *   const signer = yield* Secp256k1.fromSecretKey(secretKey)
 *
 *   // or insist on one scheme:
 *   const signer = yield* Ed25519.fromSecretKey((yield* PrivateKey.decode(s, Ed25519.FLAG)).secretKey)
 *
 *   // and back:
 *   const secretKey = yield* Ed25519.generateSecretKey
 *   const exported = yield* PrivateKey.encode({ flag: Ed25519.FLAG, secretKey })
 */
import { base64, bech32 } from "@scure/base"
import * as Effect from "effect/Effect"
import { InvalidKey } from "./Signer.ts"

export const PREFIX = "suiprivkey"
export const SECRET_KEY_SIZE = 32

/** The schemes that have exportable private keys, by the flag Sui gives them. */
export const Scheme = {
  ED25519: 0x00,
  Secp256k1: 0x01,
  Secp256r1: 0x02,
  MLDSA65: 0x07
} as const
export type Scheme = keyof typeof Scheme

const NAMES: Record<number, Scheme> = { 0x00: "ED25519", 0x01: "Secp256k1", 0x02: "Secp256r1", 0x07: "MLDSA65" }

/**
 * A decoded key: the scheme's flag and name, and its 32-byte secret (the
 * Ed25519 seed, the secp scalar, the ML-DSA-65 keygen seed).
 */
export interface PrivateKey {
  readonly flag: number
  readonly scheme: Scheme
  readonly secretKey: Uint8Array
}

const flagHex = (flag: number) => `0x${flag.toString(16).padStart(2, "0")}`

/** `flag || secret`, validated. */
const parse = (format: string, raw: Uint8Array, expected: number | undefined): Effect.Effect<PrivateKey, InvalidKey> => {
  const flag = raw[0]
  const fail = (scheme: string, reason: string) => Effect.fail(new InvalidKey({ scheme, reason }))
  if (flag === undefined) return fail(format, "empty key")
  const scheme = NAMES[flag]
  if (!scheme) return fail(format, `flag ${flagHex(flag)} is not a scheme with private keys`)
  if (expected !== undefined && flag !== expected) {
    return fail(NAMES[expected] ?? format, `expected a ${NAMES[expected] ?? flagHex(expected)} key, got ${scheme}`)
  }
  if (raw.length !== 1 + SECRET_KEY_SIZE) return fail(scheme, `expected a ${SECRET_KEY_SIZE}-byte secret, got ${raw.length - 1} bytes`)
  return Effect.succeed({ flag, scheme, secretKey: raw.slice(1) })
}

const serialize = (key: { readonly flag: number; readonly secretKey: Uint8Array }): Effect.Effect<Uint8Array, InvalidKey> => {
  const scheme = NAMES[key.flag]
  if (!scheme) return Effect.fail(new InvalidKey({ scheme: PREFIX, reason: `flag ${flagHex(key.flag)} is not a scheme with private keys` }))
  if (key.secretKey.length !== SECRET_KEY_SIZE) {
    return Effect.fail(new InvalidKey({ scheme, reason: `expected a ${SECRET_KEY_SIZE}-byte secret, got ${key.secretKey.length} bytes` }))
  }
  const out = new Uint8Array(1 + SECRET_KEY_SIZE)
  out[0] = key.flag
  out.set(key.secretKey, 1)
  return Effect.succeed(out)
}

// -----------------------------------------------------------------------------
// suiprivkey
// -----------------------------------------------------------------------------

/**
 * Decode a `suiprivkey1…` string. With `expectedFlag`, a key of another scheme
 * is an `InvalidKey` too.
 */
export const decode = (encoded: string, expectedFlag?: number): Effect.Effect<PrivateKey, InvalidKey> =>
  Effect.suspend(() => {
    let decoded: { prefix: string; words: Array<number> }
    let raw: Uint8Array
    try {
      decoded = bech32.decode(encoded.trim())
      raw = bech32.fromWords(decoded.words)
    } catch (e) {
      return Effect.fail(new InvalidKey({ scheme: PREFIX, reason: "not a valid bech32 string (bad checksum, prefix or characters)" }))
    }
    if (decoded.prefix !== PREFIX) {
      return Effect.fail(new InvalidKey({ scheme: PREFIX, reason: `expected prefix "${PREFIX}", got "${decoded.prefix}"` }))
    }
    return parse(PREFIX, raw, expectedFlag)
  })

/** Encode a secret as `suiprivkey1…`. */
export const encode = (key: { readonly flag: number; readonly secretKey: Uint8Array }): Effect.Effect<string, InvalidKey> =>
  Effect.map(serialize(key), (raw) => bech32.encode(PREFIX, bech32.toWords(raw)))

// -----------------------------------------------------------------------------
// sui.keystore
// -----------------------------------------------------------------------------

const KEYSTORE = "sui.keystore"

/** Parse the contents of a Sui CLI `sui.keystore` file (a JSON array of base64 `flag || secret`). */
export const decodeKeystore = (json: string): Effect.Effect<ReadonlyArray<PrivateKey>, InvalidKey> =>
  Effect.suspend(() => {
    let entries: unknown
    try {
      entries = JSON.parse(json)
    } catch (e) {
      return Effect.fail(new InvalidKey({ scheme: KEYSTORE, reason: "not JSON" }))
    }
    if (!Array.isArray(entries)) return Effect.fail(new InvalidKey({ scheme: KEYSTORE, reason: "expected a JSON array" }))
    return Effect.forEach(entries, (entry: unknown, i) => {
      if (typeof entry !== "string") return Effect.fail(new InvalidKey({ scheme: KEYSTORE, reason: `entry ${i}: expected a base64 string` }))
      let raw: Uint8Array
      try {
        raw = base64.decode(entry)
      } catch {
        return Effect.fail(new InvalidKey({ scheme: KEYSTORE, reason: `entry ${i}: not base64` }))
      }
      return Effect.mapError(parse(KEYSTORE, raw, undefined), (e) => new InvalidKey({ scheme: e.scheme, reason: `entry ${i}: ${e.reason}` }))
    })
  })

/** Serialize keys as a `sui.keystore` file the Sui CLI reads. */
export const encodeKeystore = (
  keys: ReadonlyArray<{ readonly flag: number; readonly secretKey: Uint8Array }>
): Effect.Effect<string, InvalidKey> =>
  Effect.map(Effect.forEach(keys, serialize), (raws) => JSON.stringify(raws.map((r) => base64.encode(r)), null, 2))
