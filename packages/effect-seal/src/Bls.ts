/**
 * BLS12-381 for Seal: point and scalar encodings, hashing to G1, pairings.
 *
 * The only module that imports `@noble/curves`. `G1` points are 48 bytes
 * compressed, `G2` 96, scalars 32 bytes big-endian, GT elements 576 bytes in
 * fastcrypto's layout (C6).
 *
 * Decoders reject the point at infinity (C18) and non-canonical scalars (C8:
 * noble's `Fr.fromBytes` reduces instead of rejecting, so it is not used).
 * Scalar multiplications go through `g1Multiply` / `g2Multiply`, which accept
 * zero (noble's `multiply` refuses it) and are constant-time otherwise.
 */
import { bls12_381 } from "@noble/curves/bls12-381.js"
import { mapHashToField } from "@noble/curves/abstract/modular.js"
import * as Result from "effect/Result"
import { InvalidEncoding } from "./Errors.ts"

export { InvalidEncoding }

export type G1 = typeof bls12_381.G1.Point.BASE
export type G2 = typeof bls12_381.G2.Point.BASE
export type Scalar = bigint

export const G1_BYTES = 48
export const G2_BYTES = 96
export const GT_BYTES = 576
export const SCALAR_BYTES = 32

/** The order of G1, G2 and GT (the scalar field's modulus). */
export const ORDER: bigint = /* @__PURE__ */ (() => bls12_381.fields.Fr.ORDER)()

export const g1Generator: G1 = /* @__PURE__ */ (() => bls12_381.G1.Point.BASE)()
export const g2Generator: G2 = /* @__PURE__ */ (() => bls12_381.G2.Point.BASE)()
export const g1Zero: G1 = /* @__PURE__ */ (() => bls12_381.G1.Point.ZERO)()
export const g2Zero: G2 = /* @__PURE__ */ (() => bls12_381.G2.Point.ZERO)()

// -----------------------------------------------------------------------------
// Encodings
// -----------------------------------------------------------------------------

const decodePoint = <P extends { is0(): boolean }>(
  what: "G1" | "G2",
  size: number,
  bytes: Uint8Array,
  fromBytes: (b: Uint8Array) => P
): Result.Result<P, InvalidEncoding> => {
  if (bytes.length !== size) {
    return Result.fail(new InvalidEncoding({ what, reason: `expected ${size} bytes, got ${bytes.length}` }))
  }
  let point: P
  try {
    point = fromBytes(bytes)
  } catch (e) {
    return Result.fail(new InvalidEncoding({ what, reason: e instanceof Error ? e.message : "invalid point" }))
  }
  return point.is0() ? Result.fail(new InvalidEncoding({ what, reason: "point at infinity" })) : Result.succeed(point)
}

/** A compressed G1 point. Rejects bad length, off-curve, wrong subgroup, and the point at infinity (C18). */
export const g1FromBytes = (bytes: Uint8Array): Result.Result<G1, InvalidEncoding> =>
  decodePoint("G1", G1_BYTES, bytes, (b) => bls12_381.G1.Point.fromBytes(b))

/** A compressed G2 point. Rejects bad length, off-curve, wrong subgroup, and the point at infinity (C18). */
export const g2FromBytes = (bytes: Uint8Array): Result.Result<G2, InvalidEncoding> =>
  decodePoint("G2", G2_BYTES, bytes, (b) => bls12_381.G2.Point.fromBytes(b))

export const g1ToBytes = (p: G1): Uint8Array => p.toBytes(true)
export const g2ToBytes = (p: G2): Uint8Array => p.toBytes(true)

const toBigInt = (bytes: Uint8Array): bigint => {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
}

/** Canonical only: exactly 32 bytes and a value below the group order (C8). Zero is accepted. */
export const scalarFromBytes = (bytes: Uint8Array, endian: "be" | "le" = "be"): Result.Result<Scalar, InvalidEncoding> => {
  if (bytes.length !== SCALAR_BYTES) {
    return Result.fail(new InvalidEncoding({ what: "Scalar", reason: `expected ${SCALAR_BYTES} bytes, got ${bytes.length}` }))
  }
  const n = toBigInt(endian === "be" ? bytes : bytes.slice().reverse())
  return n < ORDER ? Result.succeed(n) : Result.fail(new InvalidEncoding({ what: "Scalar", reason: "not below the group order" }))
}

/** 32 bytes, big-endian. */
export const scalarToBytes = (s: Scalar): Uint8Array => {
  const out = new Uint8Array(SCALAR_BYTES)
  let n = s
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}

/**
 * A uniform non-zero scalar from at least 48 random bytes (noble's `mapHashToField`), exactly what
 * `bls12_381.utils.randomSecretKey` and so `@mysten/seal` do with their 48 random bytes.
 */
export const scalarFromEntropy = (bytes48: Uint8Array): Scalar => toBigInt(mapHashToField(bytes48, ORDER))

// -----------------------------------------------------------------------------
// Group operations
// -----------------------------------------------------------------------------

/** `p·s` for any `0 ≤ s < order`. */
export const g1Multiply = (p: G1, s: Scalar): G1 => (s === 0n ? g1Zero : p.multiply(s))
/** `p·s` for any `0 ≤ s < order`. */
export const g2Multiply = (p: G2, s: Scalar): G2 => (s === 0n ? g2Zero : p.multiply(s))

/** Hash to G1 with noble's default suite DST `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` (C2, without Seal's prefix). */
export const hashToG1 = (message: Uint8Array): G1 => bls12_381.G1.Point.fromAffine(bls12_381.G1.hashToCurve(message).toAffine())

// -----------------------------------------------------------------------------
// Pairings
// -----------------------------------------------------------------------------

const PAIR_ORDER = [0, 3, 1, 4, 2, 5] as const
const PAIR_BYTES = GT_BYTES / 6

/**
 * `e(p, q)` serialised in fastcrypto's layout (C6): noble's `Fp12.toBytes` as six 96-byte
 * pairs, reordered `[0, 3, 1, 4, 2, 5]`. Neither point may be at infinity.
 */
export const pairingBytes = (p: G1, q: G2): Uint8Array => {
  const bytes = bls12_381.fields.Fp12.toBytes(bls12_381.pairing(p, q))
  const out = new Uint8Array(GT_BYTES)
  for (let i = 0; i < PAIR_ORDER.length; i++) {
    const from = PAIR_ORDER[i]! * PAIR_BYTES
    out.set(bytes.subarray(from, from + PAIR_BYTES), i * PAIR_BYTES)
  }
  return out
}

/** `e(a1, a2) == e(b1, b2)`, with one final exponentiation. A pair with a point at infinity counts as the identity. */
export const pairingsEqual = (a: readonly [G1, G2], b: readonly [G1, G2]): boolean => {
  const pairs: Array<{ g1: G1; g2: G2 }> = []
  if (!a[0].is0() && !a[1].is0()) pairs.push({ g1: a[0], g2: a[1] })
  if (!b[0].is0() && !b[1].is0()) pairs.push({ g1: b[0].negate(), g2: b[1] })
  const Fp12 = bls12_381.fields.Fp12
  return Fp12.eql(bls12_381.pairingBatch(pairs), Fp12.ONE)
}
