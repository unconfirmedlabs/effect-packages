/**
 * ElGamal on G1, how key servers return derived keys (C16).
 *
 * The client picks `sk` and sends `enc_key = G1·sk` with
 * `enc_verification_key = G2·sk`; a server answers
 * `(c0, c1) = (G1·k, enc_key·k + usk)`; the client recovers `usk = c1 − c0·sk`.
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Bls from "./Bls.ts"
import * as Entropy from "./Entropy.ts"

export interface KeyPair {
  readonly secret: Bls.Scalar
  /** `G1·sk`, 48 bytes: the request's `enc_key`. */
  readonly publicKey: Uint8Array
  /** `G2·sk`, 96 bytes: the request's `enc_verification_key`. */
  readonly verificationKey: Uint8Array
}

export const keyPair = (secret: Bls.Scalar): KeyPair => ({
  secret,
  publicKey: Bls.g1ToBytes(Bls.g1Multiply(Bls.g1Generator, secret)),
  verificationKey: Bls.g2ToBytes(Bls.g2Multiply(Bls.g2Generator, secret))
})

/** A fresh key pair from 48 bytes of `Entropy`. */
export const generate: Effect.Effect<KeyPair> = /* @__PURE__ */ Effect.map(
  /* @__PURE__ */ Entropy.bytes(48),
  (bytes) => keyPair(Bls.scalarFromEntropy(bytes))
)

/** `c1 − c0·sk`. Fails on a malformed or infinite `c0`/`c1`, and when the result is the point at infinity. */
export const decrypt = (
  secret: Bls.Scalar,
  ciphertext: readonly [Uint8Array, Uint8Array]
): Result.Result<Bls.G1, Bls.InvalidEncoding> =>
  Result.flatMap(Bls.g1FromBytes(ciphertext[0]), (c0) =>
    Result.flatMap(Bls.g1FromBytes(ciphertext[1]), (c1) => {
      const m = c1.subtract(Bls.g1Multiply(c0, secret))
      return m.is0() ? Result.fail(new Bls.InvalidEncoding({ what: "G1", reason: "point at infinity" })) : Result.succeed(m)
    }))

/** `(G1·k, pk·k + message)`, for tests and local servers. `k` must be non-zero. */
export const encrypt = (
  publicKey: Uint8Array,
  message: Bls.G1,
  k: Bls.Scalar
): Result.Result<readonly [Uint8Array, Uint8Array], Bls.InvalidEncoding> =>
  Result.map(Bls.g1FromBytes(publicKey), (pk) =>
    [
      Bls.g1ToBytes(Bls.g1Multiply(Bls.g1Generator, k)),
      Bls.g1ToBytes(Bls.g1Multiply(pk, k).add(message))
    ] as const)
