/**
 * Shamir secret sharing over GF(2⁸) (C11), byte-compatible with Seal's Rust
 * `tss.rs` and `@mysten/seal`'s `shamir.ts`.
 *
 * The field is AES's (`x⁸ + x⁴ + x³ + x + 1`, generator `0x03`). Each secret
 * byte gets its own polynomial of degree `t − 1` whose constant term is the
 * byte; share `i` holds every polynomial evaluated at `i`. Secrets can be any
 * length. Randomness is the caller's: `split` takes the coefficients.
 *
 * No curve code: a program that only combines shares ships no BLS.
 */
import * as Result from "effect/Result"
import { InvalidShares } from "./Errors.ts"

export { InvalidShares }

export interface Share {
  /** 1..255. */
  readonly index: number
  readonly share: Uint8Array
}

// -----------------------------------------------------------------------------
// GF(2⁸)
// -----------------------------------------------------------------------------

/** @internal `exp[i] = 3^i` for i in 0..509 (doubled to skip a modulo), `log[3^i] = i`. */
export const tables = /* @__PURE__ */ (() => {
  const exp = new Uint8Array(510)
  const log = new Uint8Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = x
    exp[i + 255] = x
    log[x] = i
    // x·3 = x·2 ⊕ x, reduced by the AES polynomial.
    const x2 = (x << 1) ^ (x & 0x80 ? 0x11b : 0)
    x = x2 ^ x
  }
  return { exp, log }
})()

/** @internal */
export const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : tables.exp[tables.log[a]! + tables.log[b]!]!

/** @internal `a / b`, `b ≠ 0`. */
export const div = (a: number, b: number): number =>
  a === 0 ? 0 : tables.exp[tables.log[a]! + 255 - tables.log[b]!]!

// -----------------------------------------------------------------------------
// Split
// -----------------------------------------------------------------------------

const fail = (reason: string) => Result.fail(new InvalidShares({ reason }))

const isByte = (n: number, min: number) => Number.isInteger(n) && n >= min && n <= 255

/**
 * Split `secret` into `total` shares, any `threshold` of which recombine.
 *
 * `coefficients` holds `secret.length × (threshold − 1)` bytes: byte i's coefficients for
 * x¹..x^(t−1) at [i(t−1), (i+1)(t−1)) — the order in which `@mysten/seal` draws them.
 * Shares get indices 1..total.
 */
export const split = (
  secret: Uint8Array,
  threshold: number,
  total: number,
  coefficients: Uint8Array
): Result.Result<ReadonlyArray<Share>, InvalidShares> => {
  if (!isByte(total, 1)) return fail(`total ${total} is not in 1..255`)
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > total) {
    return fail(`threshold ${threshold} is not in 1..${total}`)
  }
  const degree = threshold - 1
  if (coefficients.length !== secret.length * degree) {
    return fail(`expected ${secret.length * degree} coefficient bytes, got ${coefficients.length}`)
  }
  const shares: Array<Share> = []
  for (let x = 1; x <= total; x++) {
    const share = new Uint8Array(secret.length)
    for (let i = 0; i < secret.length; i++) {
      // Horner, from the highest coefficient down to the constant term.
      let y = 0
      for (let k = degree - 1; k >= 0; k--) y = mul(y, x) ^ coefficients[i * degree + k]!
      share[i] = mul(y, x) ^ secret[i]!
    }
    shares.push({ index: x, share })
  }
  return Result.succeed(shares)
}

// -----------------------------------------------------------------------------
// Combine and interpolate
// -----------------------------------------------------------------------------

const validate = (shares: ReadonlyArray<Share>): Result.Result<number, InvalidShares> => {
  if (shares.length === 0) return fail("no shares")
  const length = shares[0]!.share.length
  const seen = new Set<number>()
  for (const { index, share } of shares) {
    if (!isByte(index, 1)) return fail(`share index ${index} is not in 1..255`)
    if (seen.has(index)) return fail(`duplicate share index ${index}`)
    seen.add(index)
    if (share.length !== length) return fail("shares have different lengths")
  }
  return Result.succeed(length)
}

/** Lagrange basis values at `x`: `l_j(x) = Π_{i≠j} (x − x_i) / (x_j − x_i)` (subtraction is xor). */
const basis = (xs: ReadonlyArray<number>, x: number): Array<number> =>
  xs.map((xj, j) => {
    let num = 1
    let den = 1
    for (let i = 0; i < xs.length; i++) {
      if (i === j) continue
      num = mul(num, x ^ xs[i]!)
      den = mul(den, xj ^ xs[i]!)
    }
    return div(num, den)
  })

const evaluate = (shares: ReadonlyArray<Share>, length: number, x: number): Uint8Array => {
  const l = basis(shares.map((s) => s.index), x)
  const out = new Uint8Array(length)
  for (let j = 0; j < shares.length; j++) {
    const lj = l[j]!
    if (lj === 0) continue
    const share = shares[j]!.share
    for (let i = 0; i < length; i++) out[i]! ^= mul(lj, share[i]!)
  }
  return out
}

/** The secret (the polynomials at 0). With fewer than the threshold's shares the result is unrelated to the secret. */
export const combine = (shares: ReadonlyArray<Share>): Result.Result<Uint8Array, InvalidShares> =>
  Result.map(validate(shares), (length) => evaluate(shares, length, 0))

/**
 * The polynomials through the given shares, as a function of the index (0..255; 0 gives the
 * secret). Used to check that every share lies on them (C10).
 */
export const interpolate = (shares: ReadonlyArray<Share>): Result.Result<(index: number) => Uint8Array, InvalidShares> =>
  Result.map(validate(shares), (length) => {
    const copy = shares.map((s) => ({ index: s.index, share: s.share.slice() }))
    return (index: number) => evaluate(copy, length, index & 0xff)
  })
