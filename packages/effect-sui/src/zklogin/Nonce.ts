/**
 * The OAuth nonce that binds a JWT to an ephemeral key:
 * `base64url(poseidon(pk_hi, pk_lo, maxEpoch, randomness))` where `pk` is the
 * ephemeral key's `flag || bytes` read as a big-endian integer.
 */
import { base64urlnopad } from "@scure/base"
import type * as SignatureScheme from "../SignatureScheme.ts"
import * as Effect from "effect/Effect"
import { poseidon4 } from "poseidon-lite/poseidon4"
import { InvalidZkLoginInput, reasonOf } from "./Errors.ts"
import * as Parse from "./internal/parse.ts"
import * as Core from "./internal/poseidon.ts"
import { toPaddedBigEndianBytes } from "./PublicIdentifier.ts"

/** The nonce hashes four elements: only that arity ships (see `internal/poseidon.ts`). */
const poseidon = Core.make({ 4: poseidon4 })

export const NONCE_LENGTH = 27

const toBigIntBE = (bytes: Uint8Array): bigint =>
  bytes.length === 0 ? 0n : BigInt("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""))

/** 16 random bytes as a decimal string, the form provers and Enoki use. */
export const generateRandomness: Effect.Effect<string> = Effect.sync(() =>
  String(toBigIntBE(crypto.getRandomValues(new Uint8Array(16))))
)

/** The nonce for an ephemeral public key, the proof's `maxEpoch` and the randomness. */
export const generate = (
  ephemeralPublicKey: SignatureScheme.PublicKey,
  maxEpoch: bigint,
  randomness: bigint | string
): Effect.Effect<string, InvalidZkLoginInput> =>
  Effect.try({
    try: () => {
      const suiBytes = new Uint8Array(1 + ephemeralPublicKey.bytes.length)
      suiBytes[0] = ephemeralPublicKey.flag
      suiBytes.set(ephemeralPublicKey.bytes, 1)
      const pk = toBigIntBE(suiBytes)
      const hash = poseidon([pk / 2n ** 128n, pk % 2n ** 128n, Parse.epoch(maxEpoch), BigInt(randomness)])
      const nonce = base64urlnopad.encode(toPaddedBigEndianBytes(hash, 20))
      if (nonce.length !== NONCE_LENGTH) throw new Error(`nonce ${nonce} has length ${nonce.length}, expected ${NONCE_LENGTH}`)
      return nonce
    },
    catch: (e) => new InvalidZkLoginInput({ reason: reasonOf(e) })
  })
