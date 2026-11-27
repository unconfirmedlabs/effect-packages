/**
 * Sui addresses and object ids: 32 bytes, shown as `0x` + 64 lowercase hex.
 */
import { blake2b } from "@noble/hashes/blake2.js"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

/** The branded, normalized address. Also its BCS layout (32 raw bytes). */
export const Address = Bcs.Address
export type Address = Bcs.Address

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

/** Normalize `0x2`, `0X02` or unprefixed hex. Throws on anything else: use for literals you control. */
export const normalize = (s: string): Address => {
  const h = s.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{1,64}$/.test(h)) throw new Error(`invalid Sui address: ${s}`)
  return ("0x" + h.padStart(64, "0")) as Address
}

/** Decode a value someone typed: exactly 64 hex digits, `0x` optional. A truncated paste is an error, not a padded address. */
export const Strict: Schema.Codec<Address, string> = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(0x)?[0-9a-fA-F]{64}$/)),
  Schema.decodeTo(
    Address,
    SchemaTransformation.transform<string, string>({ decode: (s) => normalize(s), encode: (a) => a }) as any
  )
) as any

export const fromBytes = (bytes: Uint8Array): Address => ("0x" + hex(bytes)) as Address

/** `blake2b256(flag || publicKey)`, the address of a single-key scheme. */
export const fromPublicKey = (flag: number, publicKey: Uint8Array): Address => {
  const input = new Uint8Array(1 + publicKey.length)
  input[0] = flag
  input.set(publicKey, 1)
  return fromBytes(blake2b(input, { dkLen: 32 }))
}

export const ZERO = normalize("0x0")
export const SUI_FRAMEWORK = normalize("0x2")
export const SUI_SYSTEM = normalize("0x3")
export const CLOCK = normalize("0x6")
export const RANDOM = normalize("0x8")
