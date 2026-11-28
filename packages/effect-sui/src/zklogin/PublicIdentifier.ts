/**
 * The zkLogin public identifier: `len(iss) || iss || addressSeed`, the bytes a
 * zkLogin "public key" has (in multisig, and for address derivation).
 *
 * The seed is 32 bytes big-endian. Before Sui fixed it, seeds with leading
 * zero bytes were stored *unpadded*: those accounts have a different
 * ("legacy") address. Identifier bytes here are always the padded form, as in
 * `@mysten/sui`; legacy-ness is a property of the address you derive.
 */
import * as Bytes from "@unconfirmed/effect-bcs/Bytes"
import * as Address from "../Address.ts"
import type * as SignatureScheme from "../SignatureScheme.ts"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { InvalidZkLoginInput, reasonOf } from "./Errors.ts"
import * as Parse from "./internal/parse.ts"
import { BN254_FIELD_SIZE } from "./internal/poseidon.ts"

export const FLAG = 0x05

/** `num` as `width` big-endian bytes, left-padded with zeros (truncated if wider). */
export const toPaddedBigEndianBytes = (num: bigint, width: number): Uint8Array =>
  Bytes.fromHex(num.toString(16).padStart(width * 2, "0").slice(-width * 2))

/** `num` as big-endian bytes without leading zeros (`[0]` for zero). */
export const toBigEndianBytes = (num: bigint, width: number): Uint8Array => {
  const bytes = toPaddedBigEndianBytes(num, width)
  const first = bytes.findIndex((b) => b !== 0)
  return first === -1 ? new Uint8Array([0]) : bytes.slice(first)
}

/** Google's tokens say `accounts.google.com`; addresses use `https://accounts.google.com`. */
export const normalizeIssuer = (iss: string): string => (iss === "accounts.google.com" ? "https://accounts.google.com" : iss)

const seedBytes = (seed: bigint, legacyAddress: boolean) =>
  legacyAddress ? toBigEndianBytes(seed, 32) : toPaddedBigEndianBytes(seed, 32)

/** @internal `len || iss || seed`, the seed padded or (legacy) not. Throws on a seed outside the BN254 field. */
export const encode = (addressSeed: bigint, iss: string, legacyAddress: boolean): Uint8Array => {
  Parse.seed(addressSeed)
  const issBytes = new TextEncoder().encode(normalizeIssuer(iss))
  if (issBytes.length > 255) throw new Error(`issuer is ${issBytes.length} bytes, at most 255 allowed`)
  const seed = seedBytes(addressSeed, legacyAddress)
  const out = new Uint8Array(1 + issBytes.length + seed.length)
  out[0] = issBytes.length
  out.set(issBytes, 1)
  out.set(seed, 1 + issBytes.length)
  return out
}

/** `make`, synchronously: a `Result` instead of an `Effect`. */
export const makeResult = (addressSeed: bigint, iss: string): Result.Result<Uint8Array, InvalidZkLoginInput> =>
  Result.try({ try: () => encode(addressSeed, iss, false), catch: (e) => new InvalidZkLoginInput({ reason: reasonOf(e) }) })

/** The (padded) public identifier for an address seed and issuer. */
export const make = (addressSeed: bigint, iss: string): Effect.Effect<Uint8Array, InvalidZkLoginInput> =>
  Effect.fromResult(makeResult(addressSeed, iss))

/**
 * Identifier bytes as a zkLogin `PublicKey` (flag 0x05): a multisig member, or the key
 * `SignatureScheme.toSuiBytes` / `Address.fromPublicKey` take.
 *
 *   const pk = Result.map(PublicIdentifier.makeResult(addressSeed, iss), PublicIdentifier.toPublicKey)
 */
export const toPublicKey = (bytes: Uint8Array): SignatureScheme.PublicKey => ({ flag: FLAG, bytes })

export interface Parsed {
  readonly iss: string
  readonly addressSeed: bigint
}

/** Split identifier bytes into issuer and seed. */
export const parse = (bytes: Uint8Array): Effect.Effect<Parsed, InvalidZkLoginInput> => {
  const issLength = bytes[0]
  if (issLength === undefined || bytes.length < 1 + issLength + 1) {
    return Effect.fail(new InvalidZkLoginInput({ reason: "public identifier is too short" }))
  }
  const seed = bytes.subarray(1 + issLength)
  if (seed.length > 32) return Effect.fail(new InvalidZkLoginInput({ reason: "address seed is longer than 32 bytes" }))
  const addressSeed = BigInt("0x" + Bytes.toHex(seed))
  if (addressSeed >= BN254_FIELD_SIZE) return Effect.fail(new InvalidZkLoginInput({ reason: "address seed is not in the BN254 field" }))
  return Effect.succeed({ iss: new TextDecoder().decode(bytes.subarray(1, 1 + issLength)), addressSeed })
}

/** @internal Re-encode identifier bytes with a padded (or legacy) seed. Assumes `bytes` parse. */
export const normalizeUnsafe = (bytes: Uint8Array, legacyAddress: boolean): Uint8Array => {
  const issEnd = bytes[0]! + 1
  const seedHex = Bytes.toHex(bytes.subarray(issEnd))
  const seed = seedBytes(seedHex.length === 0 ? 0n : BigInt("0x" + seedHex), legacyAddress)
  const out = new Uint8Array(issEnd + seed.length)
  out.set(bytes.subarray(0, issEnd))
  out.set(seed, issEnd)
  return out
}

/** Whether identifier bytes carry an unpadded (legacy) seed. */
export const isLegacy = (bytes: Uint8Array): boolean => bytes.length !== (bytes[0] ?? 0) + 1 + 32

/**
 * The address of identifier bytes: `blake2b256(0x05 || bytes)`. Padded bytes
 * give the current address; pass `legacyAddress: true` for the legacy one.
 * Bytes that are themselves unpadded already derive the legacy address.
 */
export const toAddress = (bytes: Uint8Array, options?: { readonly legacyAddress?: boolean }): Address.Address =>
  Address.fromPublicKey(FLAG, options?.legacyAddress ? normalizeUnsafe(bytes, true) : bytes)

/** Both addresses an identifier may own. */
export const addresses = (bytes: Uint8Array): { readonly current: Address.Address; readonly legacy: Address.Address } => ({
  current: Address.fromPublicKey(FLAG, normalizeUnsafe(bytes, false)),
  legacy: Address.fromPublicKey(FLAG, normalizeUnsafe(bytes, true))
})
