/**
 * zkLogin for `@unconfirmed/sui`: a `SignatureScheme` (flag 0x05) to install
 * in the registry and a `Signer` that wraps any ephemeral `Signer`.
 *
 *   SignatureSchemes.layer(Ed25519.scheme, ZkLogin.scheme, MultiSig.scheme)
 *     .pipe(Layer.provide(ZkLoginVerifierGrpc.layer), Layer.provide(GrpcWeb.layer({ url })))
 *
 *   const signer = yield* ZkLogin.signer({ ephemeral, inputs, maxEpoch })
 *   yield* Tx.run(recipe, { signer })
 *
 * Verification needs chain state, so `scheme` requires `ZkLoginVerifier`;
 * that requirement is carried by the registry layer until you provide it.
 * Because the scheme has `verifyMember`, multisigs with zkLogin members verify
 * through the same registry.
 */
import type * as Address from "@unconfirmed/sui/Address"
import * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Signer from "@unconfirmed/sui/Signer"
import * as Effect from "effect/Effect"
import { reasonOf } from "./Errors.ts"
import * as Parse from "./internal/parse.ts"
import { issuerOfUnsafe } from "./Jwt.ts"
import * as PublicIdentifier from "./PublicIdentifier.ts"
import * as Signature from "./Signature.ts"
import { ZkLoginVerifier } from "./ZkLoginVerifier.ts"
import * as Bytes from "@unconfirmed/bcs/Bytes"

export const FLAG = PublicIdentifier.FLAG
const NAME = "ZkLogin"

const invalid = (reason: string) => new SignatureScheme.InvalidSignature({ scheme: NAME, reason })

/** @internal The padded public identifier a signature's proof inputs commit to. */
const identifierOf = (inputs: Signature.ZkLoginSignatureInputs): Uint8Array =>
  PublicIdentifier.encode(Parse.seed(inputs.addressSeed), issuerOfUnsafe(inputs.issBase64Details), false)

const parse = (body: Uint8Array) =>
  Effect.flatMap(
    Effect.mapError(Signature.parseBody(body), (e) => invalid(e.reason)),
    (sig) =>
      Effect.try({
        try: () => ({ sig, identifier: identifierOf(sig.inputs) }),
        catch: (e) => invalid(`invalid proof inputs: ${reasonOf(e)}`)
      })
  )

const ask = (signature: Uint8Array, intentMessage: Uint8Array, address: Address.Address) =>
  Effect.flatMap(Effect.service(ZkLoginVerifier), (v) => v.verify({ signature, intentMessage, address }))

const withFlag = (body: Uint8Array) => {
  const out = new Uint8Array(1 + body.length)
  out[0] = FLAG
  out.set(body, 1)
  return out
}


export const scheme: SignatureScheme.SignatureScheme<ZkLoginVerifier> = {
  name: NAME,
  flag: FLAG,
  // The address of identifier bytes as given: padded bytes give the current
  // address, unpadded (legacy) bytes the legacy one, as in `@mysten/sui`.
  address: (publicKey) => PublicIdentifier.toAddress(publicKey),
  verify: (body, intentMessage) =>
    Effect.gen(function*() {
      const { identifier } = yield* parse(body)
      yield* ask(withFlag(body), intentMessage, PublicIdentifier.toAddress(identifier))
      return { flag: FLAG, bytes: identifier }
    }),
  // Both derivations an identifier may own: current (padded seed) and legacy (unpadded).
  addresses: (publicKey) => {
    const { current, legacy } = PublicIdentifier.addresses(publicKey)
    return current === legacy ? [current] : [current, legacy]
  },
  verifyMember: (publicKey, signature, intentMessage) =>
    Effect.gen(function*() {
      // Sui stores a zkLogin member's signature in full, `0x05 || body`, and so does the
      // multisig scheme when it hands it to us. Anything else is refused, as validators do.
      if (signature[0] !== FLAG) return yield* invalid("member signature is not a serialized zkLogin signature (0x05 || body)")
      const body = signature.subarray(1)
      const { identifier } = yield* parse(body)
      const member = yield* Effect.try({
        try: () => PublicIdentifier.normalizeUnsafe(publicKey, false),
        catch: () => invalid("malformed member public identifier")
      })
      if (!Bytes.equal(identifier, member)) return yield* invalid("signature is not from this member's zkLogin identity")
      yield* ask(signature, intentMessage, PublicIdentifier.toAddress(publicKey))
    })
}

// -----------------------------------------------------------------------------
// Signer
// -----------------------------------------------------------------------------

export interface SignerOptions {
  /** The ephemeral key the JWT's nonce committed to. Any `Signer`. */
  readonly ephemeral: Signer.Signer
  /** The proof inputs from the prover (or Enoki), including `addressSeed`. */
  readonly inputs: Signature.ZkLoginSignatureInputs
  /** The `maxEpoch` the nonce, and so the proof, was made for (a u64). */
  readonly maxEpoch: bigint
  /** The account uses the legacy (unpadded-seed) address. Default `false`. */
  readonly legacyAddress?: boolean
  /** The address you expect; a mismatch (e.g. a wrong `legacyAddress`) is refused. */
  readonly address?: Address.Address
}

/**
 * A `Signer` for a zkLogin account: signs with the ephemeral signer and wraps
 * that signature with the proof. Works anywhere a `Signer` does.
 */
export const signer = (options: SignerOptions): Effect.Effect<Signer.Signer, Signer.InvalidKey> =>
  Effect.gen(function*() {
    const refuse = (reason: string) => new Signer.InvalidKey({ scheme: NAME, reason })
    const { identifier, address, maxEpoch } = yield* Effect.try({
      try: () => {
        const iss = issuerOfUnsafe(options.inputs.issBase64Details)
        const seed = Parse.seed(options.inputs.addressSeed)
        return {
          identifier: PublicIdentifier.encode(seed, iss, false),
          address: PublicIdentifier.toAddress(PublicIdentifier.encode(seed, iss, options.legacyAddress ?? false)),
          maxEpoch: Parse.epoch(options.maxEpoch)
        }
      },
      catch: (e) => refuse(reasonOf(e))
    })
    if (options.address !== undefined && options.address !== address) {
      return yield* refuse(
        `proof does not match the expected address (derived ${address}, expected ${options.address}); check legacyAddress`
      )
    }
    const { ephemeral, inputs } = options
    return {
      address,
      publicKey: { flag: FLAG, bytes: identifier },
      sign: (intentMessage) =>
        ephemeral.sign(intentMessage).pipe(
          Effect.flatMap((userSignature) =>
            Signature.serialize({ inputs, maxEpoch, userSignature }).pipe(
              Effect.mapError((e) => new Signer.SigningError({ reason: "failed", message: e.reason }))
            )
          )
        )
    } satisfies Signer.Signer
  })
