/**
 * The address seed: `poseidon(hash(claimName), hash(claimValue), hash(aud), poseidon(salt))`.
 * It is what the proof commits to and, with the issuer, what the address is
 * derived from.
 *
 * With the default lengths this ships only the Poseidon arities the circuit
 * uses (1, 2, 4, 5). Other lengths need other arities: pass
 * `poseidon: Poseidon.hashUnsafe`, which loads all of them.
 */
import * as Effect from "effect/Effect"
import { poseidon1 } from "poseidon-lite/poseidon1"
import { poseidon2 } from "poseidon-lite/poseidon2"
import { poseidon4 } from "poseidon-lite/poseidon4"
import { poseidon5 } from "poseidon-lite/poseidon5"
import { InvalidZkLoginInput, reasonOf } from "./Errors.ts"
import * as Core from "./internal/poseidon.ts"

export const MAX_KEY_CLAIM_NAME_LENGTH = 32
export const MAX_KEY_CLAIM_VALUE_LENGTH = 115
export const MAX_AUD_VALUE_LENGTH = 145
const PACK_WIDTH = 248

/**
 * Poseidon over the arities the default lengths need: the salt (1), a 32-char
 * claim name (2 chunks), a 115-char value (4), a 145-char `aud` (5), the seed (4).
 */
const circuitPoseidon: Core.Hasher = Core.make({ 1: poseidon1, 2: poseidon2, 4: poseidon4, 5: poseidon5 })

/** Split into chunks of `size`; when uneven, the *first* chunk is the short one. */
const chunkFromEnd = <T>(array: ReadonlyArray<T>, size: number): Array<Array<T>> => {
  const out: Array<Array<T>> = []
  for (let end = array.length; end > 0; end -= size) out.unshift(array.slice(Math.max(0, end - size), end))
  return out
}

const bytesBEToBigInt = (bytes: ReadonlyArray<number>): bigint =>
  bytes.length === 0 ? 0n : BigInt("0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join(""))

/**
 * @internal Each character is one byte, as in Sui's `hash_ascii_str_to_field`,
 * which refuses a character wider than 8 bits. (`@mysten/sui` doesn't: a code
 * unit above 0xFF prints as 3-4 hex digits and shifts every byte after it.)
 */
export const hashASCIIStrToFieldUnsafe = (str: string, maxSize: number, poseidon: Core.Hasher = circuitPoseidon): bigint => {
  if (str.length > maxSize) throw new Error(`String ${str} is longer than ${maxSize} chars`)
  const padded = str.padEnd(maxSize, String.fromCharCode(0)).split("").map((c) => c.charCodeAt(0))
  const wide = padded.findIndex((c) => c > 0xff)
  if (wide !== -1) throw new Error(`character ${wide} (code ${padded[wide]}) does not fit in a byte`)
  return poseidon(chunkFromEnd(padded, PACK_WIDTH / 8).map(bytesBEToBigInt))
}

/** Hash an ASCII string (zero-padded to `maxSize`) to a field element. */
export const hashASCIIStrToField = (
  str: string,
  maxSize: number,
  options?: { readonly poseidon?: Core.Hasher }
): Effect.Effect<bigint, InvalidZkLoginInput> =>
  Effect.try({
    try: () => hashASCIIStrToFieldUnsafe(str, maxSize, options?.poseidon),
    catch: (e) => new InvalidZkLoginInput({ reason: reasonOf(e) })
  })

/**
 * The circuit hashes the raw JWT bytes of a claim. A claim whose decoded form
 * reveals a JSON escape (`"`, `\`, a control character) or a non-ASCII
 * character (raw UTF-8 or `\u` escaped in the token, while the hash here takes
 * one byte per character) would derive an address the proof can't sign for.
 * `@mysten/sui` derives one anyway; we refuse.
 */
const assertCircuitSafe = (value: string, label: string) => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20 || c === 0x22 || c === 0x5c) {
      throw new Error(
        `zkLogin ${label} contains a JSON-escaped character (code ${c}); the circuit hashes raw JWT bytes, ` +
          `so claim values with escapes are not supported`
      )
    }
    if (c > 0x7f) {
      throw new Error(
        `zkLogin ${label} contains a non-ASCII character (code ${c}); the circuit hashes raw JWT bytes, ` +
          `so the address can't be derived locally (use the prover's addressSeed with ZkLoginAddress.fromSeed)`
      )
    }
  }
}

export interface AddressSeedOptions {
  readonly maxNameLength?: number
  readonly maxValueLength?: number
  readonly maxAudLength?: number
  /**
   * The Poseidon hash to use. The default loads only the arities the default
   * lengths need; pass `Poseidon.hashUnsafe` with lengths that need others.
   */
  readonly poseidon?: Core.Hasher
}

/** @internal */
export const genAddressSeedUnsafe = (
  salt: string | bigint,
  name: string,
  value: string,
  aud: string,
  options?: AddressSeedOptions
): bigint => {
  assertCircuitSafe(name, "key claim name")
  assertCircuitSafe(value, "key claim value")
  assertCircuitSafe(aud, "aud")
  const poseidon = options?.poseidon ?? circuitPoseidon
  return poseidon([
    hashASCIIStrToFieldUnsafe(name, options?.maxNameLength ?? MAX_KEY_CLAIM_NAME_LENGTH, poseidon),
    hashASCIIStrToFieldUnsafe(value, options?.maxValueLength ?? MAX_KEY_CLAIM_VALUE_LENGTH, poseidon),
    hashASCIIStrToFieldUnsafe(aud, options?.maxAudLength ?? MAX_AUD_VALUE_LENGTH, poseidon),
    poseidon([BigInt(salt)])
  ])
}

/** `genAddressSeed(salt, "sub", sub, aud)`. */
export const genAddressSeed = (
  salt: string | bigint,
  name: string,
  value: string,
  aud: string,
  options?: AddressSeedOptions
): Effect.Effect<bigint, InvalidZkLoginInput> =>
  Effect.try({
    try: () => genAddressSeedUnsafe(salt, name, value, aud, options),
    catch: (e) => new InvalidZkLoginInput({ reason: reasonOf(e) })
  })
