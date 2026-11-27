/**
 * A signer is a value with an effectful `sign`. An in-memory key, a Ledger, a
 * KMS, a browser wallet, a passkey and a multisig of any of those are the same
 * type, so everything that takes a `Signer` works with all of them.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { Address } from "./Address.ts"
import * as Hash from "./Hash.ts"
import type { PublicKey } from "./SignatureScheme.ts"

export class SigningError extends Schema.TaggedError<SigningError>()("SigningError", {
  reason: Schema.Literals(["rejected", "unavailable", "failed"]),
  message: Schema.String
}) {}

/** A secret key, mnemonic or public key that was refused. */
export class InvalidKey extends Schema.TaggedError<InvalidKey>()("InvalidKey", {
  scheme: Schema.String,
  reason: Schema.String
}) {}

export interface Signer {
  readonly address: Address
  readonly publicKey: PublicKey
  /** Sign an intent message; answer the serialized Sui signature (`flag || ...`). */
  readonly sign: (intentMessage: Uint8Array) => Effect.Effect<Uint8Array, SigningError>
}

export interface Signed {
  readonly bytes: Uint8Array
  readonly signature: Uint8Array
}

export const signTransaction = (signer: Signer, txBytes: Uint8Array): Effect.Effect<Signed, SigningError> =>
  Effect.map(signer.sign(Hash.transactionIntent(txBytes)), (signature) => ({ bytes: txBytes, signature }))

export const signPersonalMessage = (signer: Signer, message: Uint8Array): Effect.Effect<Signed, SigningError> =>
  Effect.map(signer.sign(Hash.personalMessageIntent(message)), (signature) => ({ bytes: message, signature }))
