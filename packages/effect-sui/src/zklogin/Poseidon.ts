/**
 * Poseidon over BN254, as the zkLogin circuit uses it (`poseidon-lite`).
 * Up to 16 inputs hash directly; 17 to 64 are hashed in chunks of 16 and the
 * chunk hashes hashed again.
 *
 * This module loads all sixteen arities (about 590 KB minified). `Nonce` and
 * the default address-seed path don't import it: they load only the arities
 * the circuit uses (1, 2, 4 and 5).
 */
import * as Effect from "effect/Effect"
import { poseidon1 } from "poseidon-lite/poseidon1"
import { poseidon10 } from "poseidon-lite/poseidon10"
import { poseidon11 } from "poseidon-lite/poseidon11"
import { poseidon12 } from "poseidon-lite/poseidon12"
import { poseidon13 } from "poseidon-lite/poseidon13"
import { poseidon14 } from "poseidon-lite/poseidon14"
import { poseidon15 } from "poseidon-lite/poseidon15"
import { poseidon16 } from "poseidon-lite/poseidon16"
import { poseidon2 } from "poseidon-lite/poseidon2"
import { poseidon3 } from "poseidon-lite/poseidon3"
import { poseidon4 } from "poseidon-lite/poseidon4"
import { poseidon5 } from "poseidon-lite/poseidon5"
import { poseidon6 } from "poseidon-lite/poseidon6"
import { poseidon7 } from "poseidon-lite/poseidon7"
import { poseidon8 } from "poseidon-lite/poseidon8"
import { poseidon9 } from "poseidon-lite/poseidon9"
import { InvalidZkLoginInput, reasonOf } from "./Errors.ts"
import * as Core from "./internal/poseidon.ts"

export const BN254_FIELD_SIZE = Core.BN254_FIELD_SIZE

export type Input = Core.Input

/** A Poseidon hash that throws on inputs it can't hash (what `AddressSeedOptions.poseidon` takes). */
export type Hasher = Core.Hasher

/**
 * Poseidon of 1 to 64 field elements, every arity loaded. Throws on inputs
 * outside the field or an unsupported length; `hash` is the `Effect` form.
 */
export const hashUnsafe: Hasher = Core.make({
  1: poseidon1,
  2: poseidon2,
  3: poseidon3,
  4: poseidon4,
  5: poseidon5,
  6: poseidon6,
  7: poseidon7,
  8: poseidon8,
  9: poseidon9,
  10: poseidon10,
  11: poseidon11,
  12: poseidon12,
  13: poseidon13,
  14: poseidon14,
  15: poseidon15,
  16: poseidon16
})

/** Poseidon hash of 1 to 64 field elements. */
export const hash = (inputs: ReadonlyArray<Input>): Effect.Effect<bigint, InvalidZkLoginInput> =>
  Effect.try({ try: () => hashUnsafe(inputs), catch: (e) => new InvalidZkLoginInput({ reason: reasonOf(e) }) })
