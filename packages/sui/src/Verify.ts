/**
 * Signature verification over whatever schemes are installed.
 *
 * Fails with `InvalidSignature` (wrong signature or signer),
 * `UnsupportedScheme` (scheme not installed) or `VerificationUnavailable`
 * (a service the scheme needs failed: no verdict, retry if `retryable`).
 */
import * as Effect from "effect/Effect"
import type { Address } from "./Address.ts"
import * as Hash from "./Hash.ts"
import { addressOf, InvalidSignature, type PublicKey, SignatureSchemes, type VerifyError } from "./SignatureScheme.ts"

export interface Verified {
  readonly publicKey: PublicKey
  readonly address: Address
}

/** Verify a serialized signature over an intent message; answer who signed. */
export const signature = /* @__PURE__ */ Effect.fn("Verify.signature")(function*(serialized: Uint8Array, intentMessage: Uint8Array) {
  const registry = yield* SignatureSchemes
  if (serialized.length === 0) return yield* new InvalidSignature({ scheme: "unknown", reason: "empty signature" })
  const scheme = yield* registry.get(serialized[0]!)
  const publicKey = yield* scheme.verify(serialized.subarray(1), intentMessage, registry)
  return { publicKey, address: yield* addressOf(publicKey) } satisfies Verified
}) as (serialized: Uint8Array, intentMessage: Uint8Array) => Effect.Effect<Verified, VerifyError, SignatureSchemes>

/** Accept `expected` when it is the key's address or, for schemes with several, any of its `addresses`. */
const expecting = (expected: Address | undefined) => (v: Verified) => {
  if (expected === undefined || v.address === expected) return Effect.succeed(v)
  const mismatch = new InvalidSignature({ scheme: "any", reason: `signed by ${v.address}, expected ${expected}` })
  return Effect.flatMap(Effect.service(SignatureSchemes), (r) => r.get(v.publicKey.flag)).pipe(
    Effect.flatMap((s) =>
      s.addresses?.(v.publicKey.bytes).includes(expected) ? Effect.succeed({ ...v, address: expected }) : Effect.fail(mismatch)
    )
  )
}

export const personalMessage = (message: Uint8Array, serialized: Uint8Array, options?: { readonly address?: Address }) =>
  Effect.flatMap(signature(serialized, Hash.personalMessageIntent(message)), expecting(options?.address))

export const transaction = (txBytes: Uint8Array, serialized: Uint8Array, options?: { readonly address?: Address }) =>
  Effect.flatMap(signature(serialized, Hash.transactionIntent(txBytes)), expecting(options?.address))
