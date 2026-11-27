/**
 * @internal Parsing of the numbers a zkLogin signature carries. Both throw
 * plain errors; the public functions convert them to typed failures.
 */
import { BN254_FIELD_SIZE } from "./poseidon.ts"

const DECIMAL = /^(0|[1-9][0-9]*)$/

/**
 * An address seed: a BN254 field element. As a string it is canonical decimal
 * (no sign, no `0x`, no whitespace, no leading zeros), the form validators
 * parse; `BigInt` alone would also take `""` (0), `"0x10"` and `" 16 "`.
 */
export const seed = (value: string | bigint): bigint => {
  let n: bigint
  if (typeof value === "bigint") n = value
  else if (typeof value === "string" && DECIMAL.test(value)) n = BigInt(value)
  else throw new Error(`address seed ${JSON.stringify(String(value))} is not a decimal number`)
  if (n < 0n || n >= BN254_FIELD_SIZE) throw new Error(`address seed ${n} is not in the BN254 field`)
  return n
}

const U64_MAX = 2n ** 64n - 1n

/** A `maxEpoch`: a u64, given as a bigint, a safe integer or a decimal string. */
export const epoch = (value: bigint | number | string): bigint => {
  let n: bigint
  if (typeof value === "bigint") n = value
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value)
  else if (typeof value === "string" && DECIMAL.test(value)) n = BigInt(value)
  else throw new Error(`maxEpoch ${JSON.stringify(String(value))} is not an integer`)
  if (n < 0n || n > U64_MAX) throw new Error(`maxEpoch ${n} is not a u64`)
  return n
}
