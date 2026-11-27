import { bls12_381 } from "@noble/curves/bls12-381.js"
import * as Address from "@unconfirmed/sui/Address"
import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import { Bls, Kdf } from "../src/index.ts"
import { hex, seeded } from "./support.ts"

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}
const reason = <A, E extends { reason: string }>(r: Result.Result<A, E>): string => {
  if (Result.isSuccess(r)) throw new Error("expected failure")
  return r.failure.reason
}

const scalarBytes = (n: bigint, endian: "be" | "le" = "be") => {
  const be = Bls.scalarToBytes(n % 2n ** 256n)
  if (n >= 2n ** 256n) throw new Error("too large")
  return endian === "be" ? be : be.slice().reverse()
}
const raw256 = (n: bigint, endian: "be" | "le" = "be") => {
  const out = new Uint8Array(32)
  let x = n
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return endian === "be" ? out : out.reverse()
}

describe("Rust vectors", () => {
  test("C2: hash to G1 with Seal's prefix (lib.rs test_hash_with_prefix_regression)", () => {
    const fullId = Kdf.fullId(Address.normalize("0x0"), Uint8Array.of(1, 2, 3, 4))
    expect(hex(Bls.g1ToBytes(Kdf.gid(fullId)))).toBe(
      "a2f2624fda29c88ccacd286b560572d8c1261a5687e0c0cdbdcbef93bf0ec5c373563fac64a2cb5bb326cc6181ee65d7"
    )
  })

  test("C6: GT in fastcrypto's layout (ibe.rs test_kdf_regression); noble's own layout does not match", () => {
    const r = 12345n
    const gtFast = Bls.pairingBytes(Bls.g1Multiply(Bls.g1Generator, r), Bls.g2Generator)
    const nonce = Bls.g2ToBytes(Bls.g2Multiply(Bls.g2Generator, r))
    const gid = Bls.g1ToBytes(Bls.hashToG1(Uint8Array.of(...Kdf.DST_ID, 0)))
    const objectId = Address.normalize("0x0")
    const expected = "89befdfd6aecdce1305ddbca891d1c29f0507cfd5225cd6b11e52e60f088ea87"
    expect(hex(Kdf.kdf(gtFast, nonce, gid, objectId, 42))).toBe(expected)

    const gtNoble = bls12_381.fields.Fp12.toBytes(
      bls12_381.pairing(bls12_381.G1.Point.BASE.multiply(r), bls12_381.G2.Point.BASE)
    )
    expect(gtNoble.length).toBe(Bls.GT_BYTES)
    expect(hex(Kdf.kdf(gtNoble, nonce, gid, objectId, 42))).not.toBe(expected)
  })
})

describe("encodings", () => {
  const next = seeded("bls")

  test("points round trip", () => {
    for (let i = 0; i < 5; i++) {
      const s = Bls.scalarFromEntropy(next(48))
      const p1 = Bls.g1Multiply(Bls.g1Generator, s)
      const p2 = Bls.g2Multiply(Bls.g2Generator, s)
      const b1 = Bls.g1ToBytes(p1)
      const b2 = Bls.g2ToBytes(p2)
      expect(b1.length).toBe(Bls.G1_BYTES)
      expect(b2.length).toBe(Bls.G2_BYTES)
      expect(ok(Bls.g1FromBytes(b1)).equals(p1)).toBe(true)
      expect(ok(Bls.g2FromBytes(b2)).equals(p2)).toBe(true)
    }
  })

  test("rejects bad lengths, including the uncompressed forms", () => {
    const g1 = Bls.g1ToBytes(Bls.g1Generator)
    const g2 = Bls.g2ToBytes(Bls.g2Generator)
    expect(reason(Bls.g1FromBytes(g1.subarray(1)))).toContain("expected 48 bytes")
    expect(reason(Bls.g2FromBytes(g1))).toContain("expected 96 bytes")
    expect(reason(Bls.g1FromBytes(g2))).toContain("expected 48 bytes")
    expect(reason(Bls.g1FromBytes(bls12_381.G1.Point.BASE.toBytes(false)))).toContain("expected 48 bytes")
  })

  test("rejects the point at infinity (C18)", () => {
    const inf1 = new Uint8Array(48)
    inf1[0] = 0xc0
    const inf2 = new Uint8Array(96)
    inf2[0] = 0xc0
    expect(bls12_381.G1.Point.fromBytes(inf1).is0()).toBe(true) // noble accepts it
    expect(reason(Bls.g1FromBytes(inf1))).toBe("point at infinity")
    expect(reason(Bls.g2FromBytes(inf2))).toBe("point at infinity")
  })

  test("rejects points off the curve and outside the subgroup", () => {
    let offCurve: Uint8Array | undefined
    let offSubgroup: Uint8Array | undefined
    const Fp = bls12_381.fields.Fp
    for (let x = 1n; offCurve === undefined || offSubgroup === undefined; x++) {
      const bytes = raw256(x)
      const enc = new Uint8Array(48)
      enc.set(bytes, 16)
      enc[0]! |= 0x80
      const y2 = Fp.add(Fp.pow(x, 3n), 4n)
      let hasSqrt = true
      try {
        Fp.sqrt(y2)
      } catch {
        hasSqrt = false
      }
      if (!hasSqrt) offCurve ??= enc
      else offSubgroup ??= enc
    }
    expect(Result.isFailure(Bls.g1FromBytes(offCurve))).toBe(true)
    expect(Result.isFailure(Bls.g1FromBytes(offSubgroup))).toBe(true)
    // A garbage G2 encoding.
    const g2 = Bls.g2ToBytes(Bls.g2Generator)
    g2[95]! ^= 1
    expect(Result.isFailure(Bls.g2FromBytes(g2))).toBe(true)
  })

  test("scalars: canonical only, both endians (C8)", () => {
    const order = Bls.ORDER
    expect(ok(Bls.scalarFromBytes(raw256(0n)))).toBe(0n)
    expect(ok(Bls.scalarFromBytes(raw256(order - 1n)))).toBe(order - 1n)
    expect(ok(Bls.scalarFromBytes(raw256(order - 1n, "le"), "le"))).toBe(order - 1n)
    expect(ok(Bls.scalarFromBytes(raw256(12345n, "le"), "le"))).toBe(12345n)
    for (const n of [order, order + 1n, 2n ** 256n - 1n]) {
      expect(reason(Bls.scalarFromBytes(raw256(n)))).toBe("not below the group order")
      expect(reason(Bls.scalarFromBytes(raw256(n, "le"), "le"))).toBe("not below the group order")
    }
    // noble's Fr.fromBytes would have reduced it:
    expect(bls12_381.fields.Fr.fromBytes(raw256(order + 1n))).toBe(1n)
    expect(reason(Bls.scalarFromBytes(new Uint8Array(31)))).toContain("expected 32 bytes")
    expect(Bls.scalarToBytes(order - 1n)).toEqual(scalarBytes(order - 1n))
  })

  test("scalarFromEntropy is noble's randomSecretKey", () => {
    for (let i = 0; i < 20; i++) {
      const seed = next(48)
      expect(Bls.scalarToBytes(Bls.scalarFromEntropy(seed))).toEqual(bls12_381.utils.randomSecretKey(seed))
    }
    expect(Bls.scalarFromEntropy(new Uint8Array(48))).toBe(1n)
  })

  test("multiplication by zero is the identity", () => {
    expect(Bls.g1Multiply(Bls.g1Generator, 0n).is0()).toBe(true)
    expect(Bls.g2Multiply(Bls.g2Generator, 0n).is0()).toBe(true)
  })
})

describe("pairings", () => {
  const next = seeded("pairing")
  const pairing = (p: Bls.G1, q: Bls.G2) => bls12_381.pairing(p, q)
  const eq = (a: ReturnType<typeof pairing>, b: ReturnType<typeof pairing>) => bls12_381.fields.Fp12.eql(a, b)

  test("pairingsEqual agrees with two separate pairings", () => {
    for (let i = 0; i < 4; i++) {
      const a = Bls.scalarFromEntropy(next(48))
      const b = Bls.scalarFromEntropy(next(48))
      const p = Bls.g1Multiply(Bls.g1Generator, a)
      const q = Bls.g2Multiply(Bls.g2Generator, b)
      // e(a·G1, b·G2) = e(ab·G1, G2)
      const ab = (a * b) % Bls.ORDER
      const good = [Bls.g1Multiply(Bls.g1Generator, ab), Bls.g2Generator] as const
      const bad = [Bls.g1Multiply(Bls.g1Generator, (ab + 1n) % Bls.ORDER), Bls.g2Generator] as const
      expect(Bls.pairingsEqual([p, q], good)).toBe(eq(pairing(p, q), pairing(...good)))
      expect(Bls.pairingsEqual([p, q], good)).toBe(true)
      expect(Bls.pairingsEqual([p, q], bad)).toBe(eq(pairing(p, q), pairing(...bad)))
      expect(Bls.pairingsEqual([p, q], bad)).toBe(false)
    }
  })

  test("pairingsEqual treats infinity as the identity", () => {
    const p = Bls.g1Multiply(Bls.g1Generator, 7n)
    expect(Bls.pairingsEqual([Bls.g1Zero, Bls.g2Generator], [Bls.g1Zero, Bls.g2Generator])).toBe(true)
    expect(Bls.pairingsEqual([p, Bls.g2Generator], [Bls.g1Zero, Bls.g2Generator])).toBe(false)
  })

  test("pairingBytes is bilinear", () => {
    const x = Bls.pairingBytes(Bls.g1Multiply(Bls.g1Generator, 6n), Bls.g2Generator)
    const y = Bls.pairingBytes(Bls.g1Multiply(Bls.g1Generator, 2n), Bls.g2Multiply(Bls.g2Generator, 3n))
    expect(x).toEqual(y)
    expect(x.length).toBe(Bls.GT_BYTES)
  })
})
