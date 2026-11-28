import { bls12_381 } from "@noble/curves/bls12-381.js"
import * as Address from "@unconfirmed/effect-sui/Address"
import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import { Bls, Ibe, Kdf } from "../src/index.ts"
import { seeded, utf8 } from "./support.ts"

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}

const next = seeded("ibe")
const randomScalar = () => Bls.scalarFromEntropy(next(48))
const server = (n: number) => {
  const masterKey = randomScalar()
  return { masterKey, objectId: Address.normalize(`0x${n.toString(16)}`), pk: ok(Bls.g2FromBytes(Ibe.publicKey(masterKey))) }
}

describe("derived key verification", () => {
  const servers = [server(1), server(2), server(3), server(2)]
  const fullId = Kdf.fullId(Address.normalize("0xcafe"), utf8("inner"))

  test("verifyUserSecretKey rejects another id, another server, a tweaked key, infinity", () => {
    const [a, b] = servers as [ReturnType<typeof server>, ReturnType<typeof server>]
    const usk = Ibe.extract(a.masterKey, fullId)
    expect(Ibe.verifyUserSecretKey(usk, fullId, a.pk)).toBe(true)
    expect(Ibe.verifyUserSecretKey(usk, Kdf.fullId(Address.normalize("0xcafe"), utf8("other")), a.pk)).toBe(false)
    expect(Ibe.verifyUserSecretKey(usk, fullId, b.pk)).toBe(false)
    expect(Ibe.verifyUserSecretKey(usk.add(Bls.g1Generator), fullId, a.pk)).toBe(false)
    expect(Ibe.verifyUserSecretKey(Bls.g1Zero, fullId, a.pk)).toBe(false)
    // A public key at infinity would "verify" a key at infinity (C18); both are refused.
    expect(Ibe.verifyUserSecretKey(Bls.g1Zero, fullId, Bls.g2Zero)).toBe(false)
  })

  test("verifyDerivedKeys (batched, SEAL-9) agrees with checking each key", () => {
    const [a, b] = servers as [ReturnType<typeof server>, ReturnType<typeof server>]
    const ids = [utf8("one"), utf8("two"), utf8("three")].map((id) => Kdf.fullId(Address.normalize("0xcafe"), id))
    const good = ids.map((id) => ({ userSecretKey: Ibe.extract(a.masterKey, id), gid: Kdf.gid(id) }))
    const rho = [0x1234567890abcdef1234567890abcdefn, 0xfedcba0987654321fedcba0987654321n, 3n]
    expect(Ibe.verifyDerivedKeys(good, a.pk, rho)).toBe(true)
    expect(Ibe.verifyDerivedKeys(good.slice(0, 1), a.pk, rho)).toBe(true)
    expect(Ibe.verifyDerivedKeys([], a.pk, [])).toBe(true)
    expect(Ibe.verifyDerivedKeys(good, b.pk, rho)).toBe(false)
    // One key from another server, one for another id, one tweaked, one at infinity.
    const swap = (i: number, k: Bls.G1) => good.map((g, j) => (j === i ? { ...g, userSecretKey: k } : g))
    expect(Ibe.verifyDerivedKeys(swap(1, Ibe.extract(b.masterKey, ids[1]!)), a.pk, rho)).toBe(false)
    expect(Ibe.verifyDerivedKeys(swap(2, Ibe.extract(a.masterKey, ids[0]!)), a.pk, rho)).toBe(false)
    expect(Ibe.verifyDerivedKeys(swap(0, good[0]!.userSecretKey.add(Bls.g1Generator)), a.pk, rho)).toBe(false)
    expect(Ibe.verifyDerivedKeys(swap(0, Bls.g1Zero), a.pk, rho)).toBe(false)
    // Coefficients must be non-zero scalars, one per key.
    expect(Ibe.verifyDerivedKeys(good, a.pk, [0n, 1n, 2n])).toBe(false)
    expect(Ibe.verifyDerivedKeys(good, a.pk, [1n, 2n])).toBe(false)
    expect(Ibe.verifyDerivedKeys(good, Bls.g2Zero, rho)).toBe(false)
  })
})

describe("proof of possession (C17)", () => {
  test("round trip, and it is a min-sig BLS signature", () => {
    const s = server(7)
    const pk = Ibe.publicKey(s.masterKey)
    const pop = Ibe.proofOfPossession(s.masterKey, s.objectId)
    expect(pop.length).toBe(48)
    expect(Ibe.verifyProofOfPossession(pop, pk, s.objectId)).toBe(true)
    expect(Ibe.verifyProofOfPossession(pop, pk, Address.normalize("0x8"))).toBe(false)
    expect(Ibe.verifyProofOfPossession(pop, Ibe.publicKey(randomScalar()), s.objectId)).toBe(false)
    expect(Ibe.verifyProofOfPossession(pop.subarray(1), pk, s.objectId)).toBe(false)
    const message = Kdf.concat([Kdf.DST_POP, pk, Kdf.addressBytes(s.objectId)])
    const sigs = bls12_381.shortSignatures
    expect(sigs.verify(pop, sigs.hash(message), pk)).toBe(true)
  })
})
