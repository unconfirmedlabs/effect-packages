import { sha3_256 } from "@noble/hashes/sha3.js"
import * as Address from "@unconfirmed/sui/Address"
import { describe, expect, test } from "bun:test"
import { Bls, Kdf } from "../src/index.ts"
import { hex, seeded, utf8 } from "./support.ts"

describe("Kdf", () => {
  test("DSTs (C1)", () => {
    expect(Kdf.DST_ID).toEqual(utf8("SUI-SEAL-IBE-BLS12381-00"))
    expect(Kdf.DST_KDF).toEqual(utf8("SUI-SEAL-IBE-BLS12381-H2-00"))
    expect(Kdf.DST_DERIVE_KEY).toEqual(utf8("SUI-SEAL-IBE-BLS12381-H3-00"))
    expect(Kdf.DST_POP).toEqual(utf8("SUI-SEAL-IBE-BLS12381-POP-00"))
  })

  test("fullId is package ‖ inner id (I1)", () => {
    const id = Kdf.fullId(Address.normalize("0xab"), Uint8Array.of(1, 2))
    expect(id.length).toBe(34)
    expect(id[31]).toBe(0xab)
    expect(id.subarray(32)).toEqual(Uint8Array.of(1, 2))
  })

  test("Rust vector C2 (lib.rs test_hash_with_prefix_regression)", () => {
    const gid = Kdf.gid(Kdf.fullId(Address.ZERO, Uint8Array.of(1, 2, 3, 4)))
    expect(hex(Bls.g1ToBytes(gid))).toBe(
      "a2f2624fda29c88ccacd286b560572d8c1261a5687e0c0cdbdcbef93bf0ec5c373563fac64a2cb5bb326cc6181ee65d7"
    )
  })

  test("Rust vector C5/C6 (ibe.rs test_kdf_regression)", () => {
    const r = 12345n
    const gt = Bls.pairingBytes(Bls.g1Multiply(Bls.g1Generator, r), Bls.g2Generator)
    const nonce = Bls.g2ToBytes(Bls.g2Multiply(Bls.g2Generator, r))
    const gid = Bls.g1ToBytes(Kdf.gid(Uint8Array.of(0)))
    expect(hex(Kdf.kdf(gt, nonce, gid, Address.ZERO, 42))).toBe(
      "89befdfd6aecdce1305ddbca891d1c29f0507cfd5225cd6b11e52e60f088ea87"
    )
  })

  test("deriveKey hashes exactly C7's layout; purposes differ", () => {
    const next = seeded("kdf")
    const baseKey = next(32)
    const shares = [next(32), next(32), next(32)]
    const ids = [Address.normalize("0x1"), Address.normalize("0x2"), Address.normalize("0x1")]
    const manual = (purpose: number) =>
      sha3_256(
        Kdf.concat([
          Kdf.DST_DERIVE_KEY,
          baseKey,
          Uint8Array.of(purpose, 2),
          ...shares,
          ...ids.map(Kdf.addressBytes)
        ])
      )
    const randomness = Kdf.deriveKey("EncryptedRandomness", baseKey, shares, 2, ids)
    const dem = Kdf.deriveKey("Dem", baseKey, shares, 2, ids)
    expect(randomness).toEqual(manual(0))
    expect(dem).toEqual(manual(1))
    expect(randomness).not.toEqual(dem)
    expect(Kdf.deriveKey("Dem", baseKey, shares, 3, ids)).not.toEqual(dem)
  })
})
