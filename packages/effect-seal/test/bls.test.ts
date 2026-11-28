import { bls12_381 } from "@noble/curves/bls12-381.js"
import * as Address from "@unconfirmed/effect-sui/Address"
import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import { Bls, Kdf } from "../src/index.ts"
import { hex } from "./support.ts"

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}
const reason = <A, E extends { reason: string }>(r: Result.Result<A, E>): string => {
  if (Result.isSuccess(r)) throw new Error("expected failure")
  return r.failure.reason
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

  test("C6: GT in fastcrypto's layout (ibe.rs test_kdf_regression)", () => {
    const r = 12345n
    const gt = Bls.pairingBytes(Bls.g1Multiply(Bls.g1Generator, r), Bls.g2Generator)
    const nonce = Bls.g2ToBytes(Bls.g2Multiply(Bls.g2Generator, r))
    const gid = Bls.g1ToBytes(Kdf.gid(Uint8Array.of(0)))
    expect(hex(Kdf.kdf(gt, nonce, gid, Address.ZERO, 42))).toBe("89befdfd6aecdce1305ddbca891d1c29f0507cfd5225cd6b11e52e60f088ea87")
  })
})

describe("encodings", () => {
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
    expect(ok(Bls.scalarFromBytes(raw256(12345n, "le"), "le"))).toBe(12345n)
    expect(reason(Bls.scalarFromBytes(raw256(order)))).toBe("not below the group order")
    expect(reason(Bls.scalarFromBytes(raw256(order + 1n, "le"), "le"))).toBe("not below the group order")
    // noble's Fr.fromBytes would have reduced it:
    expect(bls12_381.fields.Fr.fromBytes(raw256(order + 1n))).toBe(1n)
    expect(reason(Bls.scalarFromBytes(new Uint8Array(31)))).toContain("expected 32 bytes")
  })
})
