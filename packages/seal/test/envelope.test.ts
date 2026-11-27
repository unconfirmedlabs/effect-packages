import * as Address from "@unconfirmed/sui/Address"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import { Bls, Dem, EncryptedObject, Entropy, Envelope, Ibe, Kdf, Shamir } from "../src/index.ts"
import { b64, seeded, utf8 } from "./support.ts"

const RUST_VECTOR = b64(
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAECAwQDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMeAgCEy0p0JVyGZjTiAwvuhfbZgRbVf6B/7mt4YBW+QVwzyxJvwg7EWKC3fsVYdwiazbEZrmUt+DVDuTiiIvecSoBHN0eOW5WN77xC9ZX5IDVDqyLgP0/CzLPZav3kQES7HlkDUTPTRQGs51AtW3VBP7XW8eVDynrkuNBIAlmK8VpacwqhfgGc9jEeEyI8Radr3vFWawYpBc9NHdRgvD9GRmqhg0aGM4iKmAvnny2XR2i+O59QCk8K77YYsMPCSybazYjQGnUB2DGYvu/mXWg1dle5PPqH004F0vjlyHbNU+IQ+j4AJ2JiOXauUC7qc6NHcDrPkrdwyo4vMO7sxDK54lb719lK5r0M86MwXQEEAQIDBA=="
)
const RUST_MASTER_KEYS = [
  "GpR7SBGd3si0yeCtH/Zf5SbMT8b7wwTi532/NPGNCZI=",
  "bbcjgCVjr8bl3To5S7cQdYEA/o1Tnr4jTk+uZ1ifs8A=",
  "QHBhV16RiH4JfZBofMLa4yHS4qX6Nv8Je0MlB4W2BV0="
]

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
/** The typed failure; `reason` for the errors that carry one. */
const fails = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>
): Promise<E & { readonly reason?: string }> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (error === undefined || error._tag !== "Fail") throw new Error(`expected a typed failure, got ${String(exit.cause)}`)
  return error.error
}

const next = seeded("envelope")

interface Server {
  readonly objectId: Address.Address
  readonly masterKey: Bls.Scalar
  readonly publicKey: Uint8Array
}
const server = (n: number): Server => {
  const masterKey = Bls.scalarFromEntropy(next(48))
  return { objectId: Address.normalize(`0x${n.toString(16)}`), masterKey, publicKey: Ibe.publicKey(masterKey) }
}
const SERVERS = [server(1), server(2), server(3), server(4), server(5)]
const PACKAGE = Address.normalize("0xc0ffee")
const ID = utf8("inner id")

/** Derived keys of `servers` for the object's full id. */
const keysFor = (object: EncryptedObject.EncryptedObject, servers: ReadonlyArray<Server>) =>
  new Map(servers.map((s) => [s.objectId, Bls.g1ToBytes(Ibe.extract(s.masterKey, EncryptedObject.fullId(object)))]))

const sealWith = (
  recipients: ReadonlyArray<Server>,
  threshold: number,
  input: Dem.Input = { _tag: "AesGcm256", data: utf8("hello seal") },
  seed: string = "seal"
) =>
  Effect.gen(function*() {
    const randomness = yield* Envelope.randomness(threshold)
    const sealed = yield* Envelope.seal({ packageId: PACKAGE, id: ID, recipients, threshold, input, randomness })
    return { ...sealed, randomness }
  }).pipe(Effect.provideService(Entropy.Entropy, seeded(seed)))

const subsets = <A>(items: ReadonlyArray<A>, size: number): Array<Array<A>> =>
  size === 0
    ? [[]]
    : items.flatMap((x, i) => subsets(items.slice(i + 1), size - 1).map((rest) => [x, ...rest]))

describe("the Rust vector (an object written by the TS SDK)", () => {
  const object = ok(EncryptedObject.parse(RUST_VECTOR))
  const masterKeys = RUST_MASTER_KEYS.map((k) => ok(Bls.scalarFromBytes(b64(k))))
  const servers = object.services.map(([objectId], i): Server => ({
    objectId,
    masterKey: masterKeys[i]!,
    publicKey: Ibe.publicKey(masterKeys[i]!)
  }))
  const publicKeys = servers.map((s) => s.publicKey)

  test("every pair and all three keys open it, with and without the consistency check", async () => {
    for (const subset of [...subsets(servers, 2), servers]) {
      const keys = keysFor(object, subset)
      expect(new TextDecoder().decode(await run(Envelope.open({ object, keys })))).toBe("My super secret message")
      expect(new TextDecoder().decode(await run(Envelope.open({ object, keys, publicKeys })))).toBe(
        "My super secret message"
      )
    }
  })

  test("one key is NotEnoughKeys", async () => {
    const error = await fails(Envelope.open({ object, keys: keysFor(object, servers.slice(0, 1)) }))
    expect(error).toMatchObject({ _tag: "NotEnoughKeys", required: 2, available: 1 })
  })
})

describe("round trips", () => {
  const inputs: ReadonlyArray<Dem.Input> = [
    { _tag: "AesGcm256", data: utf8("aes"), aad: Uint8Array.of(9, 9) },
    { _tag: "AesGcm256", data: new Uint8Array(0) },
    { _tag: "Hmac256Ctr", data: next(100), aad: Uint8Array.of(1) },
    { _tag: "Hmac256Ctr", data: next(64) }
  ]

  test("both DEMs, thresholds 1, n and in between; every t-subset opens, t − 1 does not", async () => {
    const recipients = SERVERS.slice(0, 4)
    for (const [i, input] of inputs.entries()) {
      for (const threshold of [1, 2, 3, 4]) {
        const { object, bytes } = await run(sealWith(recipients, threshold, input, `rt-${i}-${threshold}`))
        expect(ok(EncryptedObject.parse(bytes))).toEqual(object)
        expect(object.services.map(([, index]) => index)).toEqual([1, 2, 3, 4])
        const data = input._tag === "Plain" ? undefined : input.data
        for (const subset of subsets(recipients, threshold)) {
          expect(await run(Envelope.open({ object, keys: keysFor(object, subset) }))).toEqual(data!)
        }
        for (const subset of subsets(recipients, threshold - 1)) {
          const error = await fails(Envelope.open({ object, keys: keysFor(object, subset) }))
          expect(error).toMatchObject({ _tag: "NotEnoughKeys", required: threshold, available: threshold - 1 })
        }
      }
    }
  })

  test("Plain: no data, opening returns the DEM key", async () => {
    const { object, key } = await run(sealWith(SERVERS.slice(0, 3), 2, { _tag: "Plain" }))
    expect(object.ciphertext._tag).toBe("Plain")
    expect(await run(Envelope.open({ object, keys: keysFor(object, SERVERS.slice(1, 3)) }))).toEqual(key)
  })

  test("the returned key is the DEM key", async () => {
    const input: Dem.Input = { _tag: "Hmac256Ctr", data: utf8("dem key") }
    const { object, key } = await run(sealWith(SERVERS.slice(0, 2), 1, input))
    expect(await run(Dem.decrypt(object.ciphertext, key))).toEqual(utf8("dem key"))
  })

  test("repeated servers: a server's key opens all its shares", async () => {
    const [s1, s2, s3] = SERVERS as [Server, Server, Server]
    const recipients = [s1, s2, s1, s3, s1]
    const { object } = await run(sealWith(recipients, 3))
    expect([...EncryptedObject.weights(object)]).toEqual([[s1.objectId, 3], [s2.objectId, 1], [s3.objectId, 1]])
    expect(await run(Envelope.open({ object, keys: keysFor(object, [s1]) }))).toEqual(utf8("hello seal"))
    expect(await fails(Envelope.open({ object, keys: keysFor(object, [s2, s3]) }))).toMatchObject({
      _tag: "NotEnoughKeys",
      required: 3,
      available: 2
    })
    const publicKeys = recipients.map((s) => s.publicKey)
    expect(await run(Envelope.open({ object, keys: keysFor(object, [s1, s2]), publicKeys }))).toEqual(utf8("hello seal"))
  })

  test("deterministic under the same entropy, different under another", async () => {
    const a = await run(sealWith(SERVERS.slice(0, 3), 2, undefined, "same"))
    const b = await run(sealWith(SERVERS.slice(0, 3), 2, undefined, "same"))
    const c = await run(sealWith(SERVERS.slice(0, 3), 2, undefined, "other"))
    expect(a.bytes).toEqual(b.bytes)
    expect(a.bytes).not.toEqual(c.bytes)
  })

  test("randomness draws 32 + 32(t − 1) + 48 bytes", async () => {
    const draws: Array<number> = []
    const source = seeded("count")
    await run(Envelope.randomness(3).pipe(Effect.provideService(Entropy.Entropy, (n: number) => {
      draws.push(n)
      return source(n)
    })))
    expect(draws).toEqual([32, 64, 48])
  })
})

describe("failures", () => {
  test("a key for another id, or from another server, is InvalidCiphertext", async () => {
    const recipients = SERVERS.slice(0, 3)
    const { object } = await run(sealWith(recipients, 2))
    const wrongId = new Map(recipients.map((s) => [s.objectId, Bls.g1ToBytes(Ibe.extract(s.masterKey, Kdf.fullId(PACKAGE, utf8("other"))))]))
    expect(await fails(Envelope.open({ object, keys: wrongId }))).toMatchObject({ _tag: "InvalidCiphertext" })
    const swapped = keysFor(object, recipients)
    swapped.set(recipients[0]!.objectId, swapped.get(recipients[1]!.objectId)!)
    expect(await fails(Envelope.open({ object, keys: swapped }))).toMatchObject({ _tag: "InvalidCiphertext" })
  })

  test("a malformed derived key, nonce or public key is InvalidCiphertext", async () => {
    const recipients = SERVERS.slice(0, 2)
    const { object } = await run(sealWith(recipients, 2))
    const keys = keysFor(object, recipients)
    keys.set(recipients[0]!.objectId, new Uint8Array(48))
    expect((await fails(Envelope.open({ object, keys }))).reason).toContain("invalid derived key")
    const good = keysFor(object, recipients)
    const badNonce = { ...object, encryptedShares: { ...object.encryptedShares, nonce: new Uint8Array(96) } }
    expect((await fails(Envelope.open({ object: badNonce, keys: good }))).reason).toContain("invalid nonce")
    const short = await fails(Envelope.open({ object, keys: good, publicKeys: [recipients[0]!.publicKey] }))
    expect(short.reason).toContain("expected 2 public keys")
  })

  test("a tampered blob is DecryptionFailed; a tampered share InvalidCiphertext", async () => {
    const recipients = SERVERS.slice(0, 3)
    const { object } = await run(sealWith(recipients, 2, { _tag: "Hmac256Ctr", data: utf8("x") }))
    if (object.ciphertext._tag !== "Hmac256Ctr") throw new Error("unreachable")
    const blob = object.ciphertext.blob.slice()
    blob[0]! ^= 1
    const tampered = { ...object, ciphertext: { ...object.ciphertext, blob } }
    expect(await fails(Envelope.open({ object: tampered, keys: keysFor(object, recipients) }))).toMatchObject({
      _tag: "DecryptionFailed",
      reason: "mac"
    })
    const shares = object.encryptedShares.encryptedShares.map((s) => s.slice())
    shares[0]![0]! ^= 1
    const badShare = { ...object, encryptedShares: { ...object.encryptedShares, encryptedShares: shares } }
    expect(await fails(Envelope.open({ object: badShare, keys: keysFor(object, recipients) }))).toMatchObject({
      _tag: "InvalidCiphertext"
    })
  })

  test("open re-checks the rules of I4 on hand-built objects", async () => {
    const { object } = await run(sealWith(SERVERS.slice(0, 2), 2))
    const keys = keysFor(object, SERVERS.slice(0, 2))
    expect(await fails(Envelope.open({ object: { ...object, threshold: 3 }, keys }))).toMatchObject({ _tag: "InvalidCiphertext" })
  })

  test("seal refuses bad parameters with InvalidEncryption", async () => {
    const randomness = await run(Envelope.randomness(2).pipe(Effect.provideService(Entropy.Entropy, seeded("bad"))))
    const base = {
      packageId: PACKAGE,
      id: ID,
      recipients: SERVERS.slice(0, 3),
      threshold: 2,
      input: { _tag: "AesGcm256", data: utf8("x") } as Dem.Input,
      randomness
    }
    const refused = async (o: Partial<Envelope.SealOptions>, contains: string) => {
      const error = await fails(Envelope.seal({ ...base, ...o }))
      expect(error._tag).toBe("InvalidEncryption")
      expect(error.reason).toContain(contains)
    }
    await refused({ threshold: 0 }, "threshold 0")
    await refused({ threshold: 4 }, "threshold 4")
    await refused({ threshold: 1.5 }, "threshold 1.5")
    await refused({ recipients: [] }, "recipients")
    await refused({ recipients: Array.from({ length: 256 }, () => SERVERS[0]!), threshold: 2 }, "recipients")
    await refused({ packageId: "0xC0FFEE" as Address.Address }, "package id")
    await refused({ recipients: [{ objectId: SERVERS[0]!.objectId, publicKey: new Uint8Array(96) }, ...SERVERS.slice(1, 3)] }, "public key")
    await refused({ recipients: [{ objectId: "0x1" as Address.Address, publicKey: SERVERS[0]!.publicKey }, ...SERVERS.slice(1, 3)] }, "object id")
    await refused({ randomness: { ...randomness, baseKey: new Uint8Array(31) } }, "base key")
    await refused({ randomness: { ...randomness, coefficients: new Uint8Array(31) } }, "coefficient")
    await refused({ randomness: { ...randomness, r: 0n } }, "r must be")
    await refused({ randomness: { ...randomness, r: Bls.ORDER } }, "r must be")
  })
})

/**
 * An object whose share for the last service is not on the polynomial: built by hand with the
 * primitives so that the derived keys commit to the bad share.
 */
const sealInconsistent = (recipients: ReadonlyArray<Server>, threshold: number, data: Uint8Array) =>
  Effect.gen(function*() {
    const { baseKey, coefficients, r } = yield* Envelope.randomness(threshold)
    const shares = ok(Shamir.split(baseKey, threshold, recipients.length, coefficients)).map((s, i, all) =>
      i === all.length - 1 ? { ...s, share: s.share.map((b) => b ^ 0x5a) } : s
    )
    const services = recipients.map((s, i) => ({ objectId: s.objectId, index: shares[i]!.index }))
    const objectIds = services.map((s) => s.objectId)
    const fullId = Kdf.fullId(PACKAGE, ID)
    const publicKeys = recipients.map((s) => ok(Bls.g2FromBytes(s.publicKey)))
    const { nonce, encryptedShares } = Ibe.encryptShares(r, shares.map((s) => s.share), publicKeys, fullId, services)
    const rKey = Kdf.deriveKey("EncryptedRandomness", baseKey, encryptedShares, threshold, objectIds)
    const demKey = Kdf.deriveKey("Dem", baseKey, encryptedShares, threshold, objectIds)
    const ciphertext = yield* Dem.encrypt({ _tag: "Hmac256Ctr", data }, demKey)
    const object: EncryptedObject.EncryptedObject = {
      version: 0,
      packageId: PACKAGE,
      id: ID,
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
  }).pipe(Effect.provideService(Entropy.Entropy, seeded("inconsistent")))

/** The same object with `r` stored little-endian, as legacy writers did (C9). */
const toLittleEndian = (object: EncryptedObject.EncryptedObject, randomness: Envelope.Randomness) => {
  const ibe = object.encryptedShares
  const rKey = Kdf.deriveKey(
    "EncryptedRandomness",
    randomness.baseKey,
    ibe.encryptedShares,
    object.threshold,
    object.services.map(([id]) => id)
  )
  const le = Bls.scalarToBytes(randomness.r).reverse()
  return { ...object, encryptedShares: { ...ibe, encryptedRandomness: le.map((b, i) => b ^ rKey[i]!) } }
}

describe("share consistency (C10) and legacy nonces (C9)", () => {
  test("inconsistent shares open without the check and fail with it", async () => {
    const recipients = SERVERS.slice(0, 3)
    const object = await run(sealInconsistent(recipients, 2, utf8("split brain")))
    const publicKeys = recipients.map((s) => s.publicKey)
    const honest = keysFor(object, recipients.slice(0, 2))
    expect(await run(Envelope.open({ object, keys: honest }))).toEqual(utf8("split brain"))
    expect(await fails(Envelope.open({ object, keys: honest, publicKeys }))).toMatchObject({
      _tag: "InvalidCiphertext",
      reason: "inconsistent shares"
    })
    // A subset including the bad share recovers another base key: the nonce check catches it.
    expect(await fails(Envelope.open({ object, keys: keysFor(object, [recipients[0]!, recipients[2]!]) })))
      .toMatchObject({ _tag: "InvalidCiphertext" })
  })

  test("a little-endian r opens only with legacyNonce; big-endian opens either way", async () => {
    const recipients = SERVERS.slice(0, 3)
    const { object, randomness } = await run(sealWith(recipients, 2))
    const legacy = toLittleEndian(object, randomness)
    const keys = keysFor(object, recipients.slice(1))
    expect(await fails(Envelope.open({ object: legacy, keys }))).toMatchObject({ _tag: "InvalidCiphertext" })
    expect(await run(Envelope.open({ object: legacy, keys, legacyNonce: true }))).toEqual(utf8("hello seal"))
    expect(await run(Envelope.open({ object, keys, legacyNonce: true }))).toEqual(utf8("hello seal"))
    // The consistency check uses the r that matched, whatever its encoding.
    const publicKeys = recipients.map((s) => s.publicKey)
    expect(await run(Envelope.open({ object: legacy, keys, legacyNonce: true, publicKeys }))).toEqual(utf8("hello seal"))
  })
})

describe("limits (I5)", () => {
  test("255 shares", async () => {
    const recipients = Array.from({ length: 255 }, (_, i) => SERVERS[i % SERVERS.length]!)
    const { object, bytes } = await run(sealWith(recipients, 255, { _tag: "Hmac256Ctr", data: utf8("many") }))
    expect(object.services.at(-1)).toEqual([recipients[254]!.objectId, 255])
    const parsed = ok(EncryptedObject.parse(bytes))
    expect(await run(Envelope.open({ object: parsed, keys: keysFor(object, SERVERS) }))).toEqual(utf8("many"))
    expect(await fails(Envelope.open({ object: parsed, keys: keysFor(object, SERVERS.slice(1)) }))).toMatchObject({
      _tag: "NotEnoughKeys",
      required: 255,
      available: 204
    })
  }, 30_000)
})
