import * as Address from "@unconfirmed/sui/Address"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { Bls, ElGamal, Entropy, Ibe, Kdf } from "../src/index.ts"
import { seeded, utf8 } from "./support.ts"

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}

describe("ElGamal (C16)", () => {
  const next = seeded("elgamal")

  test("keyPair: G1·sk and G2·sk", () => {
    const kp = ElGamal.keyPair(5n)
    expect(kp.publicKey).toEqual(Bls.g1ToBytes(Bls.g1Multiply(Bls.g1Generator, 5n)))
    expect(kp.verificationKey).toEqual(Bls.g2ToBytes(Bls.g2Multiply(Bls.g2Generator, 5n)))
    expect(kp.publicKey.length).toBe(48)
    expect(kp.verificationKey.length).toBe(96)
  })

  test("generate draws 48 bytes from Entropy, deterministically under a seeded source", () => {
    const run = (seed: string) => Effect.runSync(ElGamal.generate.pipe(Effect.provideService(Entropy.Entropy, seeded(seed))))
    const a = run("x")
    expect(run("x")).toEqual(a)
    expect(run("y").secret).not.toBe(a.secret)
    expect(a.secret).toBe(Bls.scalarFromEntropy(seeded("x")(48)))
    // The default source works and is random.
    const d1 = Effect.runSync(ElGamal.generate)
    const d2 = Effect.runSync(ElGamal.generate)
    expect(d1.secret).not.toBe(d2.secret)
  })

  test("round trip of a derived key, as a key server returns it", () => {
    const masterKey = Bls.scalarFromEntropy(next(48))
    const fullId = Kdf.fullId(Address.normalize("0x1"), utf8("id"))
    const usk = Ibe.extract(masterKey, fullId)
    const kp = ElGamal.keyPair(Bls.scalarFromEntropy(next(48)))
    const ct = ok(ElGamal.encrypt(kp.publicKey, usk, Bls.scalarFromEntropy(next(48))))
    const back = ok(ElGamal.decrypt(kp.secret, ct))
    expect(back.equals(usk)).toBe(true)
    expect(Ibe.verifyUserSecretKey(back, fullId, ok(Bls.g2FromBytes(Ibe.publicKey(masterKey))))).toBe(true)
    // The wrong secret yields some other point.
    expect(ok(ElGamal.decrypt(kp.secret + 1n, ct)).equals(usk)).toBe(false)
  })

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
