import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import { Shamir } from "../src/index.ts"
import { b64, seeded, utf8 } from "./support.ts"

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}
const reason = <A>(r: Result.Result<A, Shamir.InvalidShares>): string => {
  if (Result.isSuccess(r)) throw new Error("expected failure")
  return r.failure.reason
}

/** Carry-less multiplication reduced by the AES polynomial, bit by bit. */
const slowMul = (a: number, b: number): number => {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p
}

const subsets = <A>(xs: ReadonlyArray<A>, k: number): Array<Array<A>> =>
  k === 0 ? [[]] : xs.flatMap((x, i) => subsets(xs.slice(i + 1), k - 1).map((rest) => [x, ...rest]))

describe("GF(2⁸)", () => {
  test("mul agrees with a slow reference on every pair; div inverts it; 0x03 generates the group", () => {
    let mismatches = 0
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        if (Shamir.mul(a, b) !== slowMul(a, b)) mismatches++
        if (b > 0 && Shamir.div(Shamir.mul(a, b), b) !== a) mismatches++
      }
    }
    expect(mismatches).toBe(0)
    expect(new Set(Shamir.tables.exp.subarray(0, 255)).size).toBe(255)
  })
})

describe("Rust vector (tss.rs typescript_test_vector)", () => {
  const secret = utf8("My super secret message")
  const shares = ["C7rQzQ0iL+L+fBcIAZipXBhtZsUju7ot", "lO0Boejog7ARBVXjjLUMqAFP/Iut0ZpZ", "FsrVroJ5+eWfw7sFgXq8Y3AWDN2Ogvc9"]
    .map(b64)
    .map((bytes) => ({ index: bytes[23]!, share: bytes.subarray(0, 23) }))

  test("every 2-subset and all 3 recombine; 1 does not; interpolate gives each share", () => {
    for (const subset of [...subsets(shares, 2), shares]) expect(ok(Shamir.combine(subset))).toEqual(secret)
    expect(ok(Shamir.combine(shares.slice(0, 1)))).not.toEqual(secret)
    const f = ok(Shamir.interpolate(shares.slice(1)))
    expect(shares.map((s) => f(s.index))).toEqual(shares.map((s) => s.share))
  })
})

describe("split / combine", () => {
  const next = seeded("shamir")

  test("any t of n recombine; interpolate reproduces every share; 255 shares in any order", () => {
    for (const [t, n] of [[1, 3], [2, 3], [3, 5], [4, 6]] as const) {
      for (const len of [0, 1, 33]) {
        const secret = next(len)
        const shares = ok(Shamir.split(secret, t, n, next(len * (t - 1))))
        expect(shares.map((s) => s.index)).toEqual(Array.from({ length: n }, (_, i) => i + 1))
        for (const subset of subsets(shares, t)) {
          expect(ok(Shamir.combine(subset))).toEqual(secret)
          if (len > 0) {
            const f = ok(Shamir.interpolate(subset))
            expect(shares.map((s) => f(s.index))).toEqual(shares.map((s) => s.share))
          }
        }
      }
    }
    const secret = next(32)
    const shares = ok(Shamir.split(secret, 3, 255, next(64)))
    expect(ok(Shamir.combine([shares[254]!, shares[7]!, shares[100]!]))).toEqual(secret)
  })

  test("InvalidShares", () => {
    const s = Uint8Array.of(1, 2)
    expect(reason(Shamir.split(s, 0, 3, new Uint8Array(0)))).toContain("threshold 0")
    expect(reason(Shamir.split(s, 4, 3, new Uint8Array(6)))).toContain("threshold 4")
    expect(reason(Shamir.split(s, 1, 0, new Uint8Array(0)))).toContain("total 0")
    expect(reason(Shamir.split(s, 2, 256, new Uint8Array(2)))).toContain("total 256")
    expect(reason(Shamir.split(s, 2, 3, new Uint8Array(3)))).toContain("expected 2 coefficient bytes")
    expect(reason(Shamir.combine([]))).toBe("no shares")
    expect(reason(Shamir.combine([{ index: 0, share: s }]))).toContain("index 0")
    expect(reason(Shamir.combine([{ index: 256, share: s }]))).toContain("index 256")
    expect(reason(Shamir.combine([{ index: 1.5, share: s }]))).toContain("index 1.5")
    expect(reason(Shamir.combine([{ index: 1, share: s }, { index: 1, share: s }]))).toContain("duplicate")
    expect(reason(Shamir.combine([{ index: 1, share: s }, { index: 2, share: s.subarray(1) }]))).toContain("lengths")
    expect(reason(Shamir.interpolate([{ index: 3, share: s }, { index: 3, share: s }]))).toContain("duplicate")
  })
})
