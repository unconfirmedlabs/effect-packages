import { bls12_381 } from "@noble/curves/bls12-381.js"
import * as Address from "@unconfirmed/sui/Address"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { Bls, Dem, Ibe, Kdf, Shamir } from "../src/index.ts"
import { mystenBcs } from "./oracle.ts"
import { b64, seeded, utf8 } from "./support.ts"

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}
const xor = (a: Uint8Array, b: Uint8Array) => a.map((x, i) => x ^ b[i]!)

const next = seeded("ibe")
const randomScalar = () => Bls.scalarFromEntropy(next(48))
const server = (n: number) => {
  const masterKey = randomScalar()
  return { masterKey, objectId: Address.normalize(`0x${n.toString(16)}`), pk: ok(Bls.g2FromBytes(Ibe.publicKey(masterKey))) }
}

describe("shares", () => {
  const servers = [server(1), server(2), server(3), server(2)]
  const fullId = Kdf.fullId(Address.normalize("0xcafe"), utf8("inner"))
  const services = servers.map((s, i) => ({ objectId: s.objectId, index: i + 1 }))

  test("encrypt then decrypt with each server's derived key, one and several public keys", () => {
    for (const count of [1, servers.length]) {
      const r = randomScalar()
      const shares = Array.from({ length: count }, () => next(32))
      const { nonce, encryptedShares } = Ibe.encryptShares(
        r,
        shares,
        servers.slice(0, count).map((s) => s.pk),
        fullId,
        services.slice(0, count)
      )
      expect(nonce.length).toBe(96)
      const nonceP = ok(Bls.g2FromBytes(nonce))
      expect(Ibe.verifyNonce(nonceP, r)).toBe(true)
      expect(Ibe.verifyNonce(nonceP, (r + 1n) % Bls.ORDER)).toBe(false)
      for (let i = 0; i < count; i++) {
        expect(encryptedShares[i]).not.toEqual(shares[i])
        const usk = Ibe.extract(servers[i]!.masterKey, fullId)
        expect(Ibe.decryptShare(nonceP, usk, encryptedShares[i]!, fullId, services[i]!)).toEqual(shares[i]!)
        // Another index or another object id gives another mask.
        expect(Ibe.decryptShare(nonceP, usk, encryptedShares[i]!, fullId, { ...services[i]!, index: 99 })).not.toEqual(
          shares[i]!
        )
      }
      expect(Ibe.decryptAllShares(r, encryptedShares, servers.slice(0, count).map((s) => s.pk), fullId, services.slice(0, count)))
        .toEqual(shares)
    }
  })

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

describe("Rust vector: an object written by the TS SDK (lib.rs typescript_test_vector)", () => {
  const masterKeys = [
    "GpR7SBGd3si0yeCtH/Zf5SbMT8b7wwTi532/NPGNCZI=",
    "bbcjgCVjr8bl3To5S7cQdYEA/o1Tnr4jTk+uZ1ifs8A=",
    "QHBhV16RiH4JfZBofMLa4yHS4qX6Nv8Je0MlB4W2BV0="
  ].map((k) => ok(Bls.scalarFromBytes(b64(k))))
  const object = mystenBcs.EncryptedObject.parse(b64(
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAECAwQDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMeAgCEy0p0JVyGZjTiAwvuhfbZgRbVf6B/7mt4YBW+QVwzyxJvwg7EWKC3fsVYdwiazbEZrmUt+DVDuTiiIvecSoBHN0eOW5WN77xC9ZX5IDVDqyLgP0/CzLPZav3kQES7HlkDUTPTRQGs51AtW3VBP7XW8eVDynrkuNBIAlmK8VpacwqhfgGc9jEeEyI8Radr3vFWawYpBc9NHdRgvD9GRmqhg0aGM4iKmAvnny2XR2i+O59QCk8K77YYsMPCSybazYjQGnUB2DGYvu/mXWg1dle5PPqH004F0vjlyHbNU+IQ+j4AJ2JiOXauUC7qc6NHcDrPkrdwyo4vMO7sxDK54lb719lK5r0M86MwXQEEAQIDBA=="
  ))
  const ibe = object.encryptedShares.BonehFranklinBLS12381 as {
    nonce: Uint8Array
    encryptedShares: Array<Uint8Array>
    encryptedRandomness: Uint8Array
  }
  const services: Array<Ibe.Service> = (object.services as Array<[string, number]>).map(([id, index]) => ({
    objectId: Address.normalize(id),
    index
  }))
  const objectIds = services.map((s) => s.objectId)
  const fullId = Kdf.fullId(Address.ZERO, Uint8Array.of(1, 2, 3, 4))
  const publicKeys = masterKeys.map((k) => ok(Bls.g2FromBytes(Ibe.publicKey(k))))
  const nonce = ok(Bls.g2FromBytes(ibe.nonce))

  const decryptWith = async (indices: ReadonlyArray<number>, consistency: boolean) => {
    const shares = indices.map((i) => {
      const usk = Ibe.extract(masterKeys[i]!, fullId)
      expect(Ibe.verifyUserSecretKey(usk, fullId, publicKeys[i]!)).toBe(true)
      return { index: services[i]!.index, share: Ibe.decryptShare(nonce, usk, ibe.encryptedShares[i]!, fullId, services[i]!) }
    })
    const baseKey = ok(Shamir.combine(shares))
    const randomnessKey = Kdf.deriveKey("EncryptedRandomness", baseKey, ibe.encryptedShares, object.threshold, objectIds)
    const r = ok(Bls.scalarFromBytes(xor(ibe.encryptedRandomness, randomnessKey)))
    expect(Ibe.verifyNonce(nonce, r)).toBe(true)
    if (consistency) {
      const f = ok(Shamir.interpolate(shares))
      const all = Ibe.decryptAllShares(r, ibe.encryptedShares, publicKeys, fullId, services)
      all.forEach((share, i) => expect(f(services[i]!.index)).toEqual(share))
    }
    const demKey = Kdf.deriveKey("Dem", baseKey, ibe.encryptedShares, object.threshold, objectIds)
    const aes = object.ciphertext.Aes256Gcm as { blob: Uint8Array; aad: Uint8Array }
    return Effect.runPromise(
      Dem.decrypt({ _tag: "Aes256Gcm", blob: new Uint8Array(aes.blob), aad: Option.some(new Uint8Array(aes.aad)) }, demKey)
    )
  }

  test("indices 42, 194, 30; 2 of 3; AAD 01020304", () => {
    expect(services.map((s) => s.index)).toEqual([42, 194, 30])
    expect(object.threshold).toBe(2)
    expect(new Uint8Array(object.ciphertext.Aes256Gcm.aad)).toEqual(Uint8Array.of(1, 2, 3, 4))
  })

  test("every pair of keys decrypts, with and without the consistency check", async () => {
    for (const pair of [[0, 1], [1, 2], [0, 2], [0, 1, 2]]) {
      expect(new TextDecoder().decode(await decryptWith(pair, false))).toBe("My super secret message")
      expect(new TextDecoder().decode(await decryptWith(pair, true))).toBe("My super secret message")
    }
  })
})
