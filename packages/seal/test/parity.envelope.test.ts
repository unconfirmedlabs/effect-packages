/**
 * Parity with `@mysten/seal` 2.0.1 (§6.2): the encrypted object's BCS, encryption byte for byte
 * under recorded randomness, and decryption in both directions.
 */
import * as Address from "@unconfirmed/sui/Address"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { Bls, Dem, EncryptedObject, Entropy, Envelope, Ibe, Kdf, Shamir } from "../src/index.ts"
import {
  mystenBls,
  mystenDecrypt,
  mystenDem,
  mystenEncrypt,
  mystenEncryptedObject,
  type MystenG1,
  withRandomValuesAsync
} from "./oracle.ts"
import { b64, hex, seeded, utf8 } from "./support.ts"

const RUST_VECTOR = b64(
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAECAwQDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMeAgCEy0p0JVyGZjTiAwvuhfbZgRbVf6B/7mt4YBW+QVwzyxJvwg7EWKC3fsVYdwiazbEZrmUt+DVDuTiiIvecSoBHN0eOW5WN77xC9ZX5IDVDqyLgP0/CzLPZav3kQES7HlkDUTPTRQGs51AtW3VBP7XW8eVDynrkuNBIAlmK8VpacwqhfgGc9jEeEyI8Radr3vFWawYpBc9NHdRgvD9GRmqhg0aGM4iKmAvnny2XR2i+O59QCk8K77YYsMPCSybazYjQGnUB2DGYvu/mXWg1dle5PPqH004F0vjlyHbNU+IQ+j4AJ2JiOXauUC7qc6NHcDrPkrdwyo4vMO7sxDK54lb719lK5r0M86MwXQEEAQIDBA=="
)

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
const failsWith = async <A, E>(effect: Effect.Effect<A, E>): Promise<string> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined || reason._tag !== "Fail") throw new Error(`expected a typed failure, got ${String(exit.cause)}`)
  return (reason.error as { _tag: string })._tag
}
const rejects = async (promise: Promise<unknown>): Promise<boolean> => promise.then(() => false, () => true)

const next = seeded("parity-envelope")
const int = (max: number) => next(4).reduce((n, b) => (n * 256 + b) % 2 ** 31, 0) % max

interface Server {
  readonly objectId: Address.Address
  readonly masterKey: Bls.Scalar
  readonly publicKey: Uint8Array
}
const SERVERS: ReadonlyArray<Server> = Array.from({ length: 5 }, () => {
  const masterKey = Bls.scalarFromEntropy(next(48))
  return { objectId: Address.fromBytes(next(32)), masterKey, publicKey: Ibe.publicKey(masterKey) }
})

/** Our object in `@mysten/sui/bcs`'s input shape. */
const toMysten = (o: EncryptedObject.EncryptedObject) => ({
  version: o.version,
  packageId: o.packageId,
  id: hex(o.id),
  services: o.services.map(([id, index]) => [id, index]),
  threshold: o.threshold,
  encryptedShares: {
    BonehFranklinBLS12381: {
      nonce: o.encryptedShares.nonce,
      encryptedShares: o.encryptedShares.encryptedShares,
      encryptedRandomness: o.encryptedShares.encryptedRandomness
    }
  },
  ciphertext: o.ciphertext._tag === "Plain"
    ? { Plain: {} }
    : o.ciphertext._tag === "Aes256Gcm"
    ? { Aes256Gcm: { blob: o.ciphertext.blob, aad: Option.getOrNull(o.ciphertext.aad) } }
    : { Hmac256Ctr: { blob: o.ciphertext.blob, aad: Option.getOrNull(o.ciphertext.aad), mac: o.ciphertext.mac } }
})

/** `@mysten/seal`'s key store: `${fullId hex}:${objectId}` → G1. */
const mystenKeys = (object: EncryptedObject.EncryptedObject, servers: ReadonlyArray<Server>) => {
  const fullId = EncryptedObject.fullId(object)
  return new Map<string, MystenG1>(
    servers.map((s) => [`${hex(fullId)}:${s.objectId}`, mystenBls.G1Element.fromBytes(Bls.g1ToBytes(Ibe.extract(s.masterKey, fullId)))])
  )
}
const ourKeys = (object: EncryptedObject.EncryptedObject, servers: ReadonlyArray<Server>) =>
  new Map(servers.map((s) => [s.objectId, Bls.g1ToBytes(Ibe.extract(s.masterKey, EncryptedObject.fullId(object)))]))

type Dem = "AesGcm256" | "Hmac256Ctr"

/** `@mysten/seal`'s `encrypt` with a chosen base key and recorded `getRandomValues` draws. */
const mystenSeal = async (o: {
  packageId: Address.Address
  id: Uint8Array
  recipients: ReadonlyArray<Server>
  threshold: number
  dem: Dem
  data: Uint8Array
  aad: Uint8Array | undefined
  baseKey: Uint8Array
  seed: string
}) => {
  const input = o.dem === "AesGcm256"
    ? new mystenDem.AesGcm256(o.data, o.aad as Uint8Array)
    // Its Hmac256Ctr throws without an aad (its client always passes one).
    : new mystenDem.Hmac256Ctr(o.data, o.aad ?? new Uint8Array(0))
  const { result, draws } = await withRandomValuesAsync(seeded(o.seed), () =>
    mystenEncrypt.encrypt({
      keyServers: o.recipients.map((s) => ({ objectId: s.objectId, pk: s.publicKey })),
      kemType: 0,
      threshold: o.threshold,
      packageId: o.packageId,
      id: hex(o.id),
      encryptionInput: { generateKey: async () => o.baseKey, encrypt: (key) => input.encrypt(key) }
    }))
  // 32 draws of t − 1 coefficient bytes (one per secret byte), the 48 bytes behind `r`, then
  // noble 2.4's 16-byte blinding draws, one per constant-time multiplication.
  expect(draws.slice(0, 32).every((d) => d.length === o.threshold - 1)).toBe(true)
  expect(draws[32]!.length).toBe(48)
  expect(draws.slice(33).every((d) => d.length === 16)).toBe(true)
  const randomness: Envelope.Randomness = {
    baseKey: o.baseKey,
    coefficients: Kdf.concat(draws.slice(0, 32)),
    r: Bls.scalarFromEntropy(draws[32]!)
  }
  return { ...result, randomness }
}

const ourSeal = (o: {
  packageId: Address.Address
  id: Uint8Array
  recipients: ReadonlyArray<Server>
  threshold: number
  input: Dem.Input
  randomness: Envelope.Randomness
}) => run(Envelope.seal(o))

describe("BCS", () => {
  test("the Rust vector: each side parses it and writes the same bytes", () => {
    const ours = ok(EncryptedObject.parse(RUST_VECTOR))
    const theirs = mystenEncryptedObject.parse(RUST_VECTOR)
    expect(mystenEncryptedObject.serialize(theirs).toBytes()).toEqual(RUST_VECTOR)
    expect(mystenEncryptedObject.serialize(toMysten(ours)).toBytes()).toEqual(RUST_VECTOR)
  })

  test("same bytes for the same value, and each side parses the other's output", () => {
    const ciphertexts: ReadonlyArray<Dem.Ciphertext> = [
      { _tag: "Aes256Gcm", blob: next(40), aad: Option.some(next(5)) },
      { _tag: "Aes256Gcm", blob: next(3), aad: Option.none() },
      { _tag: "Hmac256Ctr", blob: next(70), aad: Option.some(new Uint8Array(0)), mac: next(32) },
      { _tag: "Hmac256Ctr", blob: new Uint8Array(0), aad: Option.none(), mac: next(32) },
      { _tag: "Plain" }
    ]
    for (const [i, ciphertext] of ciphertexts.entries()) {
      const n = 1 + int(6)
      const services = Array.from({ length: n }, (_, j) => [SERVERS[int(SERVERS.length)]!.objectId, 1 + j * 7] as const)
      const object: EncryptedObject.EncryptedObject = {
        version: 0,
        packageId: Address.fromBytes(next(32)),
        id: next(int(50)),
        services,
        threshold: 1 + int(n),
        encryptedShares: {
          _tag: "BonehFranklinBLS12381",
          nonce: next(96),
          encryptedShares: services.map(() => next(32)),
          encryptedRandomness: next(32)
        },
        ciphertext
      }
      const ours = EncryptedObject.serialize(object)
      const theirs = mystenEncryptedObject.serialize(toMysten(object)).toBytes()
      expect(ours, `case ${i}`).toEqual(theirs)
      expect(ok(EncryptedObject.parse(theirs))).toEqual(object)
      expect(mystenEncryptedObject.serialize(mystenEncryptedObject.parse(ours)).toBytes()).toEqual(ours)
    }
  })
})

describe("encryption: byte for byte under recorded randomness", () => {
  const cases: Array<{ dem: Dem; threshold: number; recipients: ReadonlyArray<Server>; aad: Uint8Array | undefined }> = []
  for (const dem of ["AesGcm256", "Hmac256Ctr"] as const) {
    for (const threshold of [1, 2, 3, 4, 5]) {
      for (const withAad of [false, true]) {
        // Repeated servers: the first one appears twice; n ranges from t to t + 2.
        const n = threshold + (threshold % 3)
        const recipients = Array.from({ length: n }, (_, i) => SERVERS[i === n - 1 && n > 1 ? 0 : i % SERVERS.length]!)
        cases.push({ dem, threshold, recipients, aad: withAad ? next(1 + int(20)) : undefined })
      }
    }
  }

  test(`${cases.length} cases: both DEMs, thresholds 1–5, repeated servers, with and without aad`, async () => {
    for (const [i, c] of cases.entries()) {
      const packageId = Address.fromBytes(next(32))
      const id = next(int(40))
      const data = next(int(200))
      const baseKey = next(32)
      const theirs = await mystenSeal({ packageId, id, data, baseKey, seed: `enc-${i}`, ...c })
      const input: Dem.Input = c.aad === undefined ? { _tag: c.dem, data } : { _tag: c.dem, data, aad: c.aad }
      const ours = await ourSeal({ packageId, id, recipients: c.recipients, threshold: c.threshold, input, randomness: theirs.randomness })
      expect(hex(ours.bytes), `case ${i}`).toBe(hex(theirs.encryptedObject))
      expect(ours.key).toEqual(theirs.key)
    }
  }, 60_000)
})

/** An object whose last share is off the polynomial, the derived keys committing to it. */
const sealInconsistent = (recipients: ReadonlyArray<Server>, threshold: number, data: Uint8Array) =>
  Effect.gen(function*() {
    const { baseKey, coefficients, r } = yield* Envelope.randomness(threshold)
    const shares = ok(Shamir.split(baseKey, threshold, recipients.length, coefficients)).map((s, i, all) =>
      i === all.length - 1 ? { ...s, share: s.share.map((b) => b ^ 0xa5) } : s
    )
    const packageId = Address.fromBytes(next(32))
    const id = next(8)
    const services = recipients.map((s, i) => ({ objectId: s.objectId, index: shares[i]!.index }))
    const objectIds = services.map((s) => s.objectId)
    const fullId = Kdf.fullId(packageId, id)
    const { nonce, encryptedShares } = Ibe.encryptShares(
      r,
      shares.map((s) => s.share),
      recipients.map((s) => ok(Bls.g2FromBytes(s.publicKey))),
      fullId,
      services
    )
    const rKey = Kdf.deriveKey("EncryptedRandomness", baseKey, encryptedShares, threshold, objectIds)
    const demKey = Kdf.deriveKey("Dem", baseKey, encryptedShares, threshold, objectIds)
    const ciphertext = yield* Dem.encrypt({ _tag: "AesGcm256", data }, demKey)
    const object: EncryptedObject.EncryptedObject = {
      version: 0,
      packageId,
      id,
      services: services.map((s) => [s.objectId, s.index] as const),
      threshold,
      encryptedShares: {
        _tag: "BonehFranklinBLS12381",
        nonce,
        encryptedShares,
        encryptedRandomness: Bls.scalarToBytes(r).map((b, i) => b ^ rKey[i]!)
      },
      ciphertext
    }
    return object
  }).pipe(Effect.provideService(Entropy.Entropy, seeded("parity-inconsistent")))

describe("decryption", () => {
  const data = utf8("parity plaintext")

  test("objects from each side decrypt on the other, with and without the consistency check", async () => {
    for (const [i, threshold] of [1, 2, 3].entries()) {
      for (const dem of ["AesGcm256", "Hmac256Ctr"] as const) {
        const recipients = SERVERS.slice(0, threshold + 1)
        const packageId = Address.fromBytes(next(32))
        const id = next(6)
        const aad = next(3)
        const theirs = await mystenSeal({ packageId, id, recipients, threshold, dem, data, aad, baseKey: next(32), seed: `dec-${i}-${dem}` })
        const randomness = await run(Envelope.randomness(threshold).pipe(Effect.provideService(Entropy.Entropy, seeded(`ours-${i}-${dem}`))))
        const ours = await ourSeal({ packageId, id, recipients, threshold, input: { _tag: dem, data, aad }, randomness })
        const holders = recipients.slice(1)
        const publicKeys = recipients.map((s) => s.publicKey)

        // Theirs, opened by us.
        const parsed = ok(EncryptedObject.parse(theirs.encryptedObject))
        expect(await run(Envelope.open({ object: parsed, keys: ourKeys(parsed, holders) }))).toEqual(data)
        expect(await run(Envelope.open({ object: parsed, keys: ourKeys(parsed, holders), publicKeys }))).toEqual(data)

        // Ours, opened by them.
        const encryptedObject = mystenEncryptedObject.parse(ours.bytes)
        const keys = mystenKeys(ours.object, holders)
        expect(await mystenDecrypt.decrypt({ encryptedObject, keys })).toEqual(data)
        const pks = publicKeys.map((pk) => mystenBls.G2Element.fromBytes(pk))
        expect(await mystenDecrypt.decrypt({ encryptedObject, keys, publicKeys: pks })).toEqual(data)
      }
    }
  })

  test("checkShareConsistency agrees on an object whose shares are not on one polynomial", async () => {
    const recipients = SERVERS.slice(0, 3)
    const object = await run(sealInconsistent(recipients, 2, data))
    const holders = recipients.slice(0, 2)
    const publicKeys = recipients.map((s) => s.publicKey)
    const encryptedObject = mystenEncryptedObject.parse(EncryptedObject.serialize(object))
    const keys = mystenKeys(object, holders)

    expect(await run(Envelope.open({ object, keys: ourKeys(object, holders) }))).toEqual(data)
    expect(await mystenDecrypt.decrypt({ encryptedObject, keys })).toEqual(data)

    expect(await failsWith(Envelope.open({ object, keys: ourKeys(object, holders), publicKeys }))).toBe("InvalidCiphertext")
    const pks = publicKeys.map((pk) => mystenBls.G2Element.fromBytes(pk))
    expect(await rejects(mystenDecrypt.decrypt({ encryptedObject, keys, publicKeys: pks }))).toBe(true)
  })

  test("checkLEEncoding agrees with legacyNonce on a little-endian r", async () => {
    const recipients = SERVERS.slice(0, 3)
    const threshold = 2
    const randomness = await run(Envelope.randomness(threshold).pipe(Effect.provideService(Entropy.Entropy, seeded("le"))))
    const packageId = Address.fromBytes(next(32))
    const sealed = await ourSeal({ packageId, id: next(4), recipients, threshold, input: { _tag: "Hmac256Ctr", data }, randomness })
    const ibe = sealed.object.encryptedShares
    const rKey = Kdf.deriveKey("EncryptedRandomness", randomness.baseKey, ibe.encryptedShares, threshold, recipients.map((s) => s.objectId))
    const le = Bls.scalarToBytes(randomness.r).reverse().map((b, i) => b ^ rKey[i]!)
    const object = { ...sealed.object, encryptedShares: { ...ibe, encryptedRandomness: le } }

    const holders = recipients.slice(0, 2)
    const encryptedObject = mystenEncryptedObject.parse(EncryptedObject.serialize(object))
    const keys = mystenKeys(object, holders)
    for (const legacy of [false, true]) {
      const theirs = await mystenDecrypt.decrypt({ encryptedObject, keys, checkLEEncoding: legacy }).then(
        (plaintext) => ({ plaintext }),
        () => undefined
      )
      const ours = await Effect.runPromiseExit(Envelope.open({ object, keys: ourKeys(object, holders), legacyNonce: legacy }))
      expect(theirs === undefined).toBe(!legacy)
      expect(Exit.isSuccess(ours)).toBe(legacy)
      if (legacy && Exit.isSuccess(ours)) expect(ours.value).toEqual(theirs!.plaintext)
    }
    // And both accept the big-endian original with the legacy flag on.
    expect(await run(Envelope.open({ object: sealed.object, keys: ourKeys(object, holders), legacyNonce: true }))).toEqual(data)
    expect(
      await mystenDecrypt.decrypt({
        encryptedObject: mystenEncryptedObject.parse(sealed.bytes),
        keys,
        checkLEEncoding: true
      })
    ).toEqual(data)
  })
})
