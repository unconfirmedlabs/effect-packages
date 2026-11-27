/**
 * Poseidon over BN254, as the zkLogin circuit uses it (`poseidon-lite`).
 * Up to 16 inputs hash directly; 17 to 64 are hashed in chunks of 16 and the
 * chunk hashes hashed again.
 */
import * as Effect from "effect/Effect"
import {
  poseidon1,
  poseidon10,
  poseidon11,
  poseidon12,
  poseidon13,
  poseidon14,
  poseidon15,
  poseidon16,
  poseidon2,
  poseidon3,
  poseidon4,
  poseidon5,
  poseidon6,
  poseidon7,
  poseidon8,
  poseidon9
} from "poseidon-lite"
import { InvalidZkLoginInput, reasonOf } from "./Errors.ts"

const BY_ARITY = [
  poseidon1,
  poseidon2,
  poseidon3,
  poseidon4,
  poseidon5,
  poseidon6,
  poseidon7,
  poseidon8,
  poseidon9,
  poseidon10,
  poseidon11,
  poseidon12,
  poseidon13,
  poseidon14,
  poseidon15,
  poseidon16
]

export const BN254_FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

export type Input = number | bigint | string

/** @internal Throws on inputs outside the field or an unsupported length. */
export const hashUnsafe = (inputs: ReadonlyArray<Input>): bigint => {
  const values = inputs.map((x) => {
    const b = BigInt(x)
    if (b < 0n || b >= BN254_FIELD_SIZE) throw new Error(`Element ${b} not in the BN254 field`)
    return b
  })
  const f = BY_ARITY[values.length - 1]
  if (f) return f(values)
  if (values.length > 16 && values.length <= 64) {
    const chunks: Array<bigint> = []
    for (let i = 0; i < values.length; i += 16) chunks.push(hashUnsafe(values.slice(i, i + 16)))
    return hashUnsafe(chunks)
  }
  throw new Error(`cannot hash ${values.length} elements (1 to 64 supported)`)
}

/** Poseidon hash of 1 to 64 field elements. */
export const hash = (inputs: ReadonlyArray<Input>): Effect.Effect<bigint, InvalidZkLoginInput> =>
  Effect.try({ try: () => hashUnsafe(inputs), catch: (e) => new InvalidZkLoginInput({ reason: reasonOf(e) }) })
