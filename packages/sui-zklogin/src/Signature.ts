/**
 * zkLogin signatures: `0x05 || BCS(ZkLoginSignature)`, where the BCS struct
 * holds the proof inputs, the proof's `maxEpoch` and the ephemeral key's own
 * serialized signature.
 *
 * `ZkLoginSignatureInputs` is both the BCS layout and the Schema for the JSON
 * a prover (or Enoki's `zklogin/zkp`) returns: decode that JSON with it.
 */
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { InvalidZkLoginInput, reasonOf } from "./Errors.ts"
import * as Parse from "./internal/parse.ts"
import { FLAG } from "./PublicIdentifier.ts"

export const ZkLoginSignatureInputs = Bcs.struct({
  proofPoints: Bcs.struct({
    a: Bcs.vector(Bcs.string),
    b: Bcs.vector(Bcs.vector(Bcs.string)),
    c: Bcs.vector(Bcs.string)
  }),
  issBase64Details: Bcs.struct({ value: Bcs.string, indexMod4: Bcs.u8 }),
  headerBase64: Bcs.string,
  addressSeed: Bcs.string
})
export type ZkLoginSignatureInputs = typeof ZkLoginSignatureInputs.Type

export const ZkLoginSignature = Bcs.struct({
  inputs: ZkLoginSignatureInputs,
  maxEpoch: Bcs.u64,
  userSignature: Bcs.byteVector
})
export type ZkLoginSignature = typeof ZkLoginSignature.Type

/**
 * The largest serialized body we produce: `@mysten/sui`'s BCS serializer caps
 * a zkLogin signature at 2048 bytes (`{ maxSize: 2048 }`), so we refuse larger
 * ones the same way. This is a serializer limit; no validator limit of this
 * size is confirmed.
 */
export const MAX_SIZE = 2048

const encodeBody = Bcs.encode(ZkLoginSignature)
const decodeBody = Bcs.decode(ZkLoginSignature)

export interface SerializeInput {
  readonly inputs: ZkLoginSignatureInputs
  readonly maxEpoch: bigint | number | string
  /** The ephemeral signer's serialized signature (`flag || sig || pk`). */
  readonly userSignature: Uint8Array
}

/** `0x05 || BCS(ZkLoginSignature)`. */
export const serialize = (input: SerializeInput): Effect.Effect<Uint8Array, InvalidZkLoginInput> =>
  Effect.suspend(() => {
    let maxEpoch: bigint
    try {
      maxEpoch = Parse.epoch(input.maxEpoch)
    } catch (e) {
      return Effect.fail(new InvalidZkLoginInput({ reason: reasonOf(e) }))
    }
    return Result.match(encodeBody({ inputs: input.inputs, maxEpoch, userSignature: input.userSignature }), {
      onFailure: (e) => Effect.fail(new InvalidZkLoginInput({ reason: e.message })),
      onSuccess: (body) => {
        if (body.length > MAX_SIZE) {
          return Effect.fail(new InvalidZkLoginInput({ reason: `signature is ${body.length} bytes, at most ${MAX_SIZE}` }))
        }
        const out = new Uint8Array(1 + body.length)
        out[0] = FLAG
        out.set(body, 1)
        return Effect.succeed(out)
      }
    })
  })

/** Parse the BCS body (everything after the flag byte). */
export const parseBody = (body: Uint8Array): Effect.Effect<ZkLoginSignature, InvalidZkLoginInput> =>
  Result.match(decodeBody(body), {
    onFailure: (e) => Effect.fail(new InvalidZkLoginInput({ reason: `malformed zkLogin signature: ${e.message}` })),
    onSuccess: Effect.succeed
  })

/** Parse a serialized zkLogin signature (`0x05 || ...`). */
export const parse = (serialized: Uint8Array): Effect.Effect<ZkLoginSignature, InvalidZkLoginInput> =>
  serialized[0] === FLAG
    ? parseBody(serialized.subarray(1))
    : Effect.fail(new InvalidZkLoginInput({ reason: "not a zkLogin signature (flag 0x05)" }))
