/**
 * A signer is a value with an effectful `sign`. An in-memory key, a Ledger, a
 * KMS, a passkey and a multisig of any of those are the same type, so
 * everything that takes a `Signer` works with all of them.
 *
 * A browser wallet never signs raw intent messages: it signs a whole
 * transaction and may change it first. That is a `TransactionSigner`, which
 * `Tx.execute` and `Tx.run` accept alongside `Signer`s.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { Address } from "./Address.ts"
import * as Hash from "./Hash.ts"
import type { PublicKey } from "./SignatureScheme.ts"
import type { TransactionData } from "./TransactionData.ts"

export class SigningError extends /* @__PURE__ */ Schema.TaggedError<SigningError>()("SigningError", {
  reason: Schema.Literals(["rejected", "unavailable", "failed"]),
  message: Schema.String
}) {}

/** A secret key, mnemonic or public key that was refused. */
export class InvalidKey extends /* @__PURE__ */ Schema.TaggedError<InvalidKey>()("InvalidKey", {
  scheme: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `invalid ${this.scheme} key: ${this.reason}`
  }
}

export interface Signer {
  readonly address: Address
  readonly publicKey: PublicKey
  /** Sign an intent message; answer the serialized Sui signature (`flag || ...`). */
  readonly sign: (intentMessage: Uint8Array) => Effect.Effect<Uint8Array, SigningError>
}

/**
 * A signer that signs whole transactions rather than intent messages: a
 * browser wallet (`sui:signTransaction`), a remote signing service. It may
 * change the transaction before signing (a wallet re-resolving gas); `bytes`
 * is what it actually signed, and `Tx.execute` submits those bytes.
 */
export interface TransactionSigner {
  readonly address: Address
  readonly signTransaction: (data: TransactionData) => Effect.Effect<Signed, SigningError>
}

/** An intent-message `Signer` signs the exact bytes; anything else is a `TransactionSigner`. */
export const isTransactionSigner = (s: Signer | TransactionSigner): s is TransactionSigner => !("sign" in s)

export interface Signed {
  readonly bytes: Uint8Array
  readonly signature: Uint8Array
}

export const signTransaction = (signer: Signer, txBytes: Uint8Array): Effect.Effect<Signed, SigningError> =>
  Effect.map(signer.sign(Hash.transactionIntent(txBytes)), (signature) => ({ bytes: txBytes, signature }))

export const signPersonalMessage = (signer: Signer, message: Uint8Array): Effect.Effect<Signed, SigningError> =>
  Effect.map(signer.sign(Hash.personalMessageIntent(message)), (signature) => ({ bytes: message, signature }))
