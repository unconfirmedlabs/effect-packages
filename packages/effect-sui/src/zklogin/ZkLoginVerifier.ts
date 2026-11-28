/**
 * What zkLogin verification needs from the outside world.
 *
 * A zkLogin signature is valid only against chain state: the issuer's JWKs
 * active on chain, the current epoch (vs. the proof's `maxEpoch`), and the
 * Groth16 verifying key. Rather than fetch and replicate that, the scheme asks
 * this service, and its requirement surfaces on the registry:
 *
 *   SignatureSchemes.layer(Ed25519.scheme, ZkLogin.scheme)
 *   // Layer<SignatureSchemes, never, ZkLoginVerifier>
 *
 * `ZkLoginVerifierGrpc.layer` asks a full node; tests provide a stub.
 */
import type * as Address from "@unconfirmed/sui/Address"
import type * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

export interface VerifyRequest {
  /** The complete serialized zkLogin signature, `0x05 || BCS`. */
  readonly signature: Uint8Array
  /** The intent message that was signed (transaction data or a personal message). */
  readonly intentMessage: Uint8Array
  /** The zkLogin address the signature must belong to. */
  readonly address: Address.Address
}

export class ZkLoginVerifier extends Context.Service<ZkLoginVerifier, {
  /**
   * Succeed iff the signature is valid for the message and address. A
   * rejection is `InvalidSignature`; no verdict (the node couldn't be asked)
   * is `VerificationUnavailable`, retryable when the outage is.
   */
  readonly verify: (
    request: VerifyRequest
  ) => Effect.Effect<void, SignatureScheme.InvalidSignature | SignatureScheme.VerificationUnavailable>
}>()("@unconfirmed/sui-zklogin/ZkLoginVerifier") {}
