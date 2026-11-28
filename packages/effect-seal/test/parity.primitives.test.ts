/**
 * Parity with `@mysten/seal` 2.0.1 (§6.2, "Primitives"): byte for byte on
 * seeded random inputs, values crossing between the two sides as bytes.
 */
import * as Address from "@unconfirmed/sui/Address"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { Bls, Dem, ElGamal, Ibe, Kdf, Shamir } from "../src/index.ts"
import { mystenBls, mystenDem, mystenElGamal, mystenIbe, mystenKdf, mystenShamir, mystenUtils, withRandomValues } from "./oracle.ts"
import { hex, seeded } from "./support.ts"

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}

const next = seeded("parity")
const int = (max: number) => next(4).reduce((n, b) => (n * 256 + b) % 2 ** 31, 0) % max
const scalar = () => Bls.scalarFromEntropy(next(48))
const address = () => Address.fromBytes(next(32))
const ROUNDS = 6

describe("hashing and key derivation", () => {
  test("hashToG1 (with Seal's prefix) and createFullId", () => {
    for (let i = 0; i < ROUNDS; i++) {
      const pkg = address()
      const inner = next(int(40))
      const fullId = Kdf.fullId(pkg, inner)
      expect(hex(fullId)).toBe(mystenUtils.createFullId(pkg, hex(inner)))
      expect(Bls.g1ToBytes(Kdf.gid(fullId))).toEqual(mystenKdf.hashToG1(fullId).toBytes())
      const raw = next(int(100))
      expect(Bls.g1ToBytes(Bls.hashToG1(raw))).toEqual(mystenBls.G1Element.hashToCurve(raw).toBytes())
    }
  })

  test("GT bytes and kdf", () => {
    for (let i = 0; i < 2; i++) {
      const a = scalar()
      const b = scalar()
      const p = Bls.g1Multiply(Bls.g1Generator, a)
      const q = Bls.g2Multiply(Bls.g2Generator, b)
      const mp = mystenBls.G1Element.fromBytes(Bls.g1ToBytes(p))
      const mq = mystenBls.G2Element.fromBytes(Bls.g2ToBytes(q))
      const gt = Bls.pairingBytes(p, q)
      expect(gt).toEqual(mp.pairing(mq).toBytes())
      const fullId = next(36)
      const objectId = address()
      const index = int(256)
      expect(Kdf.kdf(gt, Bls.g2ToBytes(q), Bls.g1ToBytes(Kdf.gid(fullId)), objectId, index)).toEqual(
        mystenKdf.kdf(mp.pairing(mq), mq, fullId, objectId, index)
      )
    }
  })

  test("deriveKey, both purposes", () => {
    for (let i = 0; i < ROUNDS; i++) {
      const n = 1 + int(8)
      const threshold = 1 + int(n)
      const baseKey = next(32)
      const shares = Array.from({ length: n }, () => next(32))
      const ids = Array.from({ length: n }, () => address())
      expect(Kdf.deriveKey("EncryptedRandomness", baseKey, shares, threshold, ids)).toEqual(
        mystenKdf.deriveKey(mystenKdf.KeyPurpose.EncryptedRandomness, baseKey, shares, threshold, ids)
      )
      expect(Kdf.deriveKey("Dem", baseKey, shares, threshold, ids)).toEqual(
        mystenKdf.deriveKey(mystenKdf.KeyPurpose.DEM, baseKey, shares, threshold, ids)
      )
    }
  })
})

describe("IBE", () => {
  test("verifyUserSecretKey, valid and invalid", () => {
    for (let i = 0; i < 2; i++) {
      const mk = scalar()
      const pk = Ibe.publicKey(mk)
      const fullId = next(40)
      const good = Ibe.extract(mk, fullId)
      const bad = Ibe.extract(scalar(), fullId)
      for (const usk of [good, bad]) {
        const ours = Ibe.verifyUserSecretKey(usk, fullId, ok(Bls.g2FromBytes(pk)))
        const theirs = mystenIbe.BonehFranklinBLS12381Services.verifyUserSecretKey(
          mystenBls.G1Element.fromBytes(Bls.g1ToBytes(usk)),
          hex(fullId),
          mystenBls.G2Element.fromBytes(pk)
        )
        expect(ours).toBe(theirs)
        expect(ours).toBe(usk === good)
      }
    }
  })

  test("encryptShares equals encryptBatched under the same randomness; each side decrypts the other's shares", () => {
    for (let i = 0; i < 2; i++) {
      const n = 2 + int(3)
      const threshold = 1 + int(n)
      const masterKeys = Array.from({ length: n }, () => scalar())
      const servers = masterKeys.map((mk) => ({ objectId: address(), pk: Ibe.publicKey(mk) }))
      const shares = Array.from({ length: n }, (_, j) => ({ index: j + 1, share: next(32) }))
      const fullId = next(36)
      const baseKey = next(32)
      const source = seeded(`batched-${i}`)
      const { result: theirs, draws } = withRandomValues(
        source,
        () => new mystenIbe.BonehFranklinBLS12381Services(servers).encryptBatched(fullId, shares, baseKey, threshold)
      )
      // The first draw is the 48 bytes behind `r`; noble 2.4 then draws 16 bytes per constant-time
      // multiplication for blinding, which does not affect any result.
      expect(draws[0]!.length).toBe(48)
      expect(draws.slice(1).every((d) => d.length === 16)).toBe(true)
      const r = Bls.scalarFromEntropy(draws[0]!)
      const services = servers.map((s, j) => ({ objectId: s.objectId, index: shares[j]!.index }))
      const ours = Ibe.encryptShares(
        r,
        shares.map((s) => s.share),
        servers.map((s) => ok(Bls.g2FromBytes(s.pk))),
        fullId,
        services
      )
      const bf = theirs.BonehFranklinBLS12381
      expect(ours.nonce).toEqual(bf.nonce)
      expect(ours.encryptedShares).toEqual(bf.encryptedShares)
      const randomnessKey = Kdf.deriveKey("EncryptedRandomness", baseKey, ours.encryptedShares, threshold, services.map((s) => s.objectId))
      expect(new Uint8Array(Bls.scalarToBytes(r).map((b, j) => b ^ randomnessKey[j]!))).toEqual(
        new Uint8Array(bf.encryptedRandomness)
      )

      const nonce = ok(Bls.g2FromBytes(bf.nonce))
      services.forEach((service, j) => {
        const usk = Ibe.extract(masterKeys[j]!, fullId)
        const mine = Ibe.decryptShare(nonce, usk, bf.encryptedShares[j]!, fullId, service)
        const mysten = mystenIbe.BonehFranklinBLS12381Services.decrypt(
          mystenBls.G2Element.fromBytes(bf.nonce),
          mystenBls.G1Element.fromBytes(Bls.g1ToBytes(usk)),
          ours.encryptedShares[j]!,
          fullId,
          [service.objectId, service.index]
        )
        expect(mine).toEqual(shares[j]!.share)
        expect(mysten).toEqual(shares[j]!.share)
      })
    }
  })
})

describe("ElGamal", () => {
  test("their key derivation and decryption agree with ours", () => {
    for (let i = 0; i < 3; i++) {
      const kp = ElGamal.keyPair(scalar())
      const sk = Bls.scalarToBytes(kp.secret)
      expect(mystenElGamal.toPublicKey(sk)).toEqual(kp.publicKey)
      expect(mystenElGamal.toVerificationKey(sk)).toEqual(kp.verificationKey)
      const message = Bls.g1Multiply(Bls.g1Generator, scalar())
      const ct = ok(ElGamal.encrypt(kp.publicKey, message, scalar()))
      const theirs = mystenElGamal.elgamalDecrypt(sk, [ct[0], ct[1]])
      expect(Bls.g1ToBytes(ok(ElGamal.decrypt(kp.secret, ct)))).toEqual(theirs)
      expect(theirs).toEqual(Bls.g1ToBytes(message))
    }
  })
})

describe("Shamir", () => {
  const subset = <A>(xs: ReadonlyArray<A>, k: number): Array<A> => {
    const pool = xs.slice()
    const out: Array<A> = []
    while (out.length < k) out.push(pool.splice(int(pool.length), 1)[0]!)
    return out
  }

  test("their split, our combine and interpolate; our split, their combine and interpolate", () => {
    for (let i = 0; i < ROUNDS; i++) {
      const total = 1 + int(10)
      const threshold = 1 + int(total)
      const secret = next(1 + int(40))
      const coefficients = next(secret.length * (threshold - 1))
      const { result: theirShares, draws } = withRandomValues(
        seeded(`split-${i}`),
        () => mystenShamir.split(secret, threshold, total)
      )
      // They draw t − 1 coefficients per secret byte, in byte order: our layout.
      const drawn = Kdf.concat(draws)
      expect(ok(Shamir.split(secret, threshold, total, drawn))).toEqual(theirShares)

      const k = threshold + int(total - threshold + 1)
      const theirsPicked = subset(theirShares, k)
      expect(ok(Shamir.combine(theirsPicked))).toEqual(secret)
      const f = ok(Shamir.interpolate(theirsPicked))
      for (let x = 0; x < 256; x += 17) expect(f(x)).toEqual(mystenShamir.interpolate(theirsPicked)(x))

      const ourShares = ok(Shamir.split(secret, threshold, total, coefficients))
      const oursPicked = subset(ourShares, k)
      expect(mystenShamir.combine(oursPicked.slice())).toEqual(secret)
      const g = mystenShamir.interpolate(oursPicked.slice())
      for (const s of ourShares) expect(g(s.index)).toEqual(s.share)
    }
  })

  test("arbitrary distinct indices (the Rust vector uses 42, 194, 30)", () => {
    for (let i = 0; i < ROUNDS; i++) {
      const count = 1 + int(6)
      const indices = subset(Array.from({ length: 255 }, (_, j) => j + 1), count)
      const shares = indices.map((index) => ({ index, share: next(32) }))
      expect(ok(Shamir.combine(shares))).toEqual(mystenShamir.combine(shares))
    }
  })
})

describe("DEMs, both directions", () => {
  const theirCiphertext = (ct: Dem.Ciphertext) => {
    switch (ct._tag) {
      case "Aes256Gcm":
        return { Aes256Gcm: { blob: ct.blob, aad: Option.getOrNull(ct.aad) } }
      case "Hmac256Ctr":
        return { Hmac256Ctr: { blob: ct.blob, aad: Option.getOrNull(ct.aad), mac: ct.mac } }
      case "Plain":
        throw new Error("no Plain in @mysten/seal")
    }
  }
  const ourCiphertext = (ct: any): Dem.Ciphertext =>
    "Aes256Gcm" in ct
      ? { _tag: "Aes256Gcm", blob: new Uint8Array(ct.Aes256Gcm.blob), aad: Option.some(new Uint8Array(ct.Aes256Gcm.aad)) }
      : {
        _tag: "Hmac256Ctr",
        blob: new Uint8Array(ct.Hmac256Ctr.blob),
        aad: Option.some(new Uint8Array(ct.Hmac256Ctr.aad)),
        mac: new Uint8Array(ct.Hmac256Ctr.mac)
      }

  test("same bytes from the same key; each decrypts the other's", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const key = next(32)
      // The last round spans 282 HMAC-CTR blocks (a two-byte counter).
      const data = next(i === ROUNDS - 1 ? 9000 : int(200))
      const aad = i % 3 === 0 ? undefined : next(int(20))
      for (const [tag, Their] of [["AesGcm256", mystenDem.AesGcm256], ["Hmac256Ctr", mystenDem.Hmac256Ctr]] as const) {
        const ours = await Effect.runPromise(Dem.encrypt(aad === undefined ? { _tag: tag, data } : { _tag: tag, data, aad }, key))
        // `@mysten/seal`'s callers always pass an aad (its Hmac256Ctr crashes without one).
        const theirs = ourCiphertext(await new Their(data, aad ?? new Uint8Array(0)).encrypt(key))
        expect(ours).toEqual(theirs)
        expect(await Their.decrypt(key, theirCiphertext(ours) as any)).toEqual(data)
        expect(await Effect.runPromise(Dem.decrypt(theirs, key))).toEqual(data)
      }
    }
  })
})
