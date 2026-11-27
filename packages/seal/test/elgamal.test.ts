import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import { Bls, ElGamal } from "../src/index.ts"

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}

describe("ElGamal (C16)", () => {
  test("malformed ciphertexts and an infinite result are InvalidEncoding", () => {
    const kp = ElGamal.keyPair(9n)
    const m = Bls.g1Multiply(Bls.g1Generator, 3n)
    const [c0, c1] = ok(ElGamal.encrypt(kp.publicKey, m, 4n))
    expect(Result.isFailure(ElGamal.decrypt(kp.secret, [c0.subarray(1), c1]))).toBe(true)
    const inf = new Uint8Array(48)
    inf[0] = 0xc0
    expect(Result.isFailure(ElGamal.decrypt(kp.secret, [c0, inf]))).toBe(true)
    // c1 = c0·sk exactly: the "key" would be infinity.
    const c0p = ok(Bls.g1FromBytes(c0))
    const r = ElGamal.decrypt(kp.secret, [c0, Bls.g1ToBytes(Bls.g1Multiply(c0p, kp.secret))])
    expect(Result.isFailure(r) && r.failure.reason).toBe("point at infinity")
    expect(Result.isFailure(ElGamal.encrypt(inf, m, 4n))).toBe(true)
  })
})
