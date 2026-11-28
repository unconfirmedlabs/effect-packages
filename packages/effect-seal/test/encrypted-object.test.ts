import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Address from "@unconfirmed/effect-sui/Address"
import { describe, expect, test } from "bun:test"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { EncryptedObject } from "../src/index.ts"
import { b64, seeded } from "./support.ts"

/** The object written by an older TS SDK in the Rust tests (`lib.rs` `typescript_test_vector`, :685). */
const RUST_VECTOR = b64(
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAECAwQDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMeAgCEy0p0JVyGZjTiAwvuhfbZgRbVf6B/7mt4YBW+QVwzyxJvwg7EWKC3fsVYdwiazbEZrmUt+DVDuTiiIvecSoBHN0eOW5WN77xC9ZX5IDVDqyLgP0/CzLPZav3kQES7HlkDUTPTRQGs51AtW3VBP7XW8eVDynrkuNBIAlmK8VpacwqhfgGc9jEeEyI8Radr3vFWawYpBc9NHdRgvD9GRmqhg0aGM4iKmAvnny2XR2i+O59QCk8K77YYsMPCSybazYjQGnUB2DGYvu/mXWg1dle5PPqH004F0vjlyHbNU+IQ+j4AJ2JiOXauUC7qc6NHcDrPkrdwyo4vMO7sxDK54lb719lK5r0M86MwXQEEAQIDBA=="
)

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}

const raw = Bcs.encodeSync(EncryptedObject.EncryptedObjectBcs)
type Raw = typeof EncryptedObject.EncryptedObjectBcs.Type

const failure = (bytes: Uint8Array): string => {
  const r = EncryptedObject.parse(bytes)
  if (Result.isSuccess(r)) throw new Error("expected InvalidCiphertext")
  expect(r.failure._tag).toBe("InvalidCiphertext")
  return r.failure.reason
}

const next = seeded("encrypted-object")
const a = Address.normalize("0xa")
const b = Address.normalize("0xb")

const sample = (overrides: Partial<Raw> = {}): Raw => ({
  version: 0,
  packageId: Address.normalize("0xcafe"),
  id: Uint8Array.of(1, 2, 3),
  services: [[a, 1], [b, 2], [a, 3]],
  threshold: 2,
  encryptedShares: {
    _tag: "BonehFranklinBLS12381",
    nonce: next(96),
    encryptedShares: [next(32), next(32), next(32)],
    encryptedRandomness: next(32)
  },
  ciphertext: { _tag: "Hmac256Ctr", blob: next(40), aad: Option.none(), mac: next(32) },
  ...overrides
})

describe("the Rust vector", () => {
  test("parses, and re-serialises to the same bytes", () => {
    const object = ok(EncryptedObject.parse(RUST_VECTOR))
    expect(object.services.map(([, index]) => index)).toEqual([42, 194, 30])
    expect(object.threshold).toBe(2)
    expect(EncryptedObject.serialize(object)).toEqual(RUST_VECTOR)
  })
})

describe("round trips", () => {
  test("every ciphertext variant, aad absent and present", () => {
    for (
      const ciphertext of [
        { _tag: "Aes256Gcm", blob: next(17), aad: Option.some(next(4)) },
        { _tag: "Aes256Gcm", blob: new Uint8Array(0), aad: Option.none() },
        { _tag: "Hmac256Ctr", blob: next(33), aad: Option.some(new Uint8Array(0)), mac: next(32) },
        { _tag: "Plain" }
      ] as const
    ) {
      const value = sample({ ciphertext })
      const object = ok(EncryptedObject.parse(raw(value)))
      expect(object).toEqual(value as EncryptedObject.EncryptedObject)
      expect(EncryptedObject.serialize(object)).toEqual(raw(value))
    }
  })

  test("weights with repeated servers, in order of first appearance", () => {
    expect([...EncryptedObject.weights(sample())]).toEqual([[a, 2], [b, 1]])
  })

  test("a 16 MiB blob round trips in under a second", () => {
    const blob = new Uint8Array(16 * 1024 * 1024).map((_, i) => i & 0xff)
    const value = sample({ ciphertext: { _tag: "Aes256Gcm", blob, aad: Option.none() } })
    const start = performance.now()
    const bytes = EncryptedObject.serialize(value as EncryptedObject.EncryptedObject)
    const object = ok(EncryptedObject.parse(bytes))
    const elapsed = performance.now() - start
    expect(object.ciphertext._tag === "Aes256Gcm" && object.ciphertext.blob.length).toBe(blob.length)
    expect(elapsed).toBeLessThan(1000)
  })
})

describe("the rules of I4", () => {
  test("version 0; 1 ≤ threshold ≤ n; one share per service; distinct non-zero indices", () => {
    expect(failure(raw(sample({ version: 1 })))).toContain("version 1")
    expect(failure(raw(sample({ threshold: 0 })))).toContain("threshold 0")
    expect(failure(raw(sample({ threshold: 4 })))).toContain("threshold 4")
    const value = sample()
    const fewer = { ...value.encryptedShares, encryptedShares: value.encryptedShares.encryptedShares.slice(0, 2) }
    expect(failure(raw(sample({ encryptedShares: fewer })))).toContain("2 encrypted shares for 3 services")
    expect(failure(raw(sample({ services: [[a, 1], [b, 0], [a, 3]] })))).toContain("share index 0")
    expect(failure(raw(sample({ services: [[a, 1], [b, 3], [a, 3]] })))).toContain("duplicate share index 3")
  })

  test("SEAL-10: a hand-built object with a non-integer threshold is InvalidCiphertext", () => {
    const object = ok(EncryptedObject.parse(raw(sample())))
    for (const threshold of [1.5, NaN]) {
      const r = EncryptedObject.validate({ ...object, threshold })
      expect(Result.isFailure(r) && r.failure.reason).toContain("threshold")
    }
  })

  test("no trailing bytes, no truncation, no unknown variant", () => {
    const bytes = raw(sample())
    expect(failure(Uint8Array.of(...bytes, 0))).toContain("trailing")
    expect(failure(bytes.subarray(0, bytes.length - 1))).toContain("malformed")
    const plain = raw(sample({ ciphertext: { _tag: "Plain" } }))
    plain[plain.length - 1] = 3
    expect(failure(plain)).toContain("unknown enum variant")
  })

  test("validate also refuses hand-built objects with malformed ids or share sizes", () => {
    const bad = (overrides: Partial<Raw>) => Result.isFailure(EncryptedObject.validate(sample(overrides)))
    expect(bad({ packageId: "0x1" as Address.Address })).toBe(true)
    expect(bad({ services: [[a, 1], ["0xB" as Address.Address, 2], [a, 3]] })).toBe(true)
    const value = sample()
    expect(bad({ encryptedShares: { ...value.encryptedShares, encryptedShares: [next(32), next(31), next(32)] } })).toBe(true)
  })
})

describe("bundling", () => {
  test("parsing an object pulls in no curve code", async () => {
    const result = await Bun.build({
      entrypoints: [new URL("../src/EncryptedObject.ts", import.meta.url).pathname],
      target: "browser",
      minify: false
    })
    expect(result.success).toBe(true)
    const code = await result.outputs[0]!.text()
    expect(code).not.toContain("bls12")
    expect(code).not.toContain("pairing")
  })
})
