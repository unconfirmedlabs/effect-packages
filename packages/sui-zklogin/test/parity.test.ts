/**
 * Byte-for-byte parity with `@mysten/sui/zklogin`.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import * as Theirs from "@mysten/sui/zklogin"
import { Ed25519, Signer } from "@unconfirmed/sui"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import * as AddressSeed from "../src/AddressSeed.ts"
import * as Jwt from "../src/Jwt.ts"
import * as Nonce from "../src/Nonce.ts"
import * as Poseidon from "../src/Poseidon.ts"
import * as PublicIdentifier from "../src/PublicIdentifier.ts"
import * as Signature from "../src/Signature.ts"
import * as ZkLogin from "../src/ZkLogin.ts"
import * as ZkLoginAddress from "../src/ZkLoginAddress.ts"
import { claims, inputs, jwt, makeJwt } from "@unconfirmed/test-support/zklogin"

const run = Effect.runSync
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const seed = (n: number) => new Uint8Array(32).fill(n)
const msg = new TextEncoder().encode("zkLogin parity")

const SALTS = ["0", "1", "129390038577185583942388216820280642146", 2n ** 120n + 7n]

/** A salt whose address seed has a leading zero byte, so the legacy address differs. */
const legacySalt = (() => {
  for (let s = 1n; s < 5000n; s++) {
    if (Theirs.genAddressSeed(s, "sub", claims.sub, claims.aud) < 2n ** 248n) return s
  }
  throw new Error("no legacy salt found")
})()

describe("zkLogin parity with @mysten/sui", () => {
  test("poseidon (1..16, chunked 17..64)", () => {
    for (const n of [1, 2, 3, 4, 7, 16, 17, 20, 33, 64]) {
      const xs = Array.from({ length: n }, (_, i) => BigInt(i * 7919 + 1) ** 3n)
      expect(run(Poseidon.hash(xs))).toBe(Theirs.poseidonHash(xs))
    }
    expect(Effect.runSync(Effect.flip(Poseidon.hash([Poseidon.BN254_FIELD_SIZE])))._tag).toBe("InvalidZkLoginInput")
    expect(Effect.runSync(Effect.flip(Poseidon.hash([])))._tag).toBe("InvalidZkLoginInput")
  })

  test("hashASCIIStrToField and genAddressSeed", () => {
    expect(run(AddressSeed.hashASCIIStrToField("sub", 32))).toBe(Theirs.hashASCIIStrToField("sub", 32))
    expect(run(AddressSeed.hashASCIIStrToField(claims.aud, 145))).toBe(Theirs.hashASCIIStrToField(claims.aud, 145))
    for (const salt of SALTS) {
      expect(run(AddressSeed.genAddressSeed(salt, "sub", claims.sub, claims.aud))).toBe(
        Theirs.genAddressSeed(salt, "sub", claims.sub, claims.aud)
      )
    }
    const escaped = Effect.runSync(Effect.flip(AddressSeed.genAddressSeed(1n, "sub", 'a"b', claims.aud)))
    expect(escaped._tag).toBe("InvalidZkLoginInput")
  })

  test("computeZkLoginAddress, current and legacy", () => {
    expect(legacySalt).toBeDefined()
    for (const salt of [...SALTS, legacySalt]) {
      for (const legacyAddress of [false, true]) {
        const options = { claimName: "sub", claimValue: claims.sub, iss: claims.iss, aud: claims.aud, userSalt: salt }
        expect(run(ZkLoginAddress.compute({ ...options, legacyAddress }))).toBe(
          Theirs.computeZkLoginAddress({ ...options, legacyAddress }) as any
        )
      }
    }
    // The legacy salt really does give two different addresses.
    const o = { claimName: "sub", claimValue: claims.sub, iss: claims.iss, aud: claims.aud, userSalt: legacySalt }
    expect(run(ZkLoginAddress.compute({ ...o, legacyAddress: true }))).not.toBe(run(ZkLoginAddress.compute(o)))
  })

  test("jwtToAddress (incl. accounts.google.com normalization)", () => {
    const google = makeJwt({ ...claims, iss: "accounts.google.com" })
    for (const token of [jwt, google]) {
      for (const legacyAddress of [false, true]) {
        expect(run(ZkLoginAddress.fromJwt(token, legacySalt, { legacyAddress }))).toBe(
          Theirs.jwtToAddress(token, legacySalt, legacyAddress) as any
        )
      }
    }
  })

  test("decodeJwt", () => {
    const unicode = makeJwt({ ...claims, name: "Zoë Žižek 🦀", groups: ["a", "b"] })
    for (const token of [jwt, makeJwt({ ...claims, iss: "accounts.google.com" }), unicode]) {
      expect(run(Jwt.decode(token)) as unknown).toEqual(Theirs.decodeJwt(token))
    }
    const arrayAud = Effect.runSync(Effect.flip(Jwt.decode(makeJwt({ ...claims, aud: ["x", "y"] }))))
    expect(arrayAud._tag).toBe("InvalidJwt")
    const noSub = Effect.runSync(Effect.flip(Jwt.decode(makeJwt({ iss: claims.iss, aud: claims.aud }))))
    expect(noSub._tag).toBe("InvalidJwt")
    expect(Effect.runSync(Effect.flip(Jwt.decode("not-a-jwt")))._tag).toBe("InvalidJwt")
    expect(run(Jwt.decodeHeader(jwt)).kid).toBe("a50f6e70ef4b548a5fd9142eecd1fb8f54dce9ee")
  })

  test("nonce for a fixed key, randomness and epoch", () => {
    const kp = Ed25519Keypair.fromSecretKey(seed(7))
    const ours = run(Ed25519.fromSecretKey(seed(7)))
    for (const [maxEpoch, randomness] of [[10, "100681567828351849884072155819400689117"], [954, 5n], [0, "0"]] as const) {
      expect(run(Nonce.generate(ours.publicKey, maxEpoch, randomness))).toBe(
        Theirs.generateNonce(kp.getPublicKey(), maxEpoch, randomness)
      )
    }
    const r = run(Nonce.generateRandomness)
    expect(/^\d+$/.test(r) && BigInt(r) < 2n ** 128n).toBe(true)
  })

  test("public identifier, current and legacy", () => {
    for (const salt of [...SALTS, legacySalt]) {
      const addressSeed = Theirs.genAddressSeed(salt, "sub", claims.sub, claims.aud)
      for (const legacyAddress of [false, true]) {
        const theirs = Theirs.toZkLoginPublicIdentifier(addressSeed, claims.iss, { legacyAddress })
        const ours = run(PublicIdentifier.make(addressSeed, claims.iss))
        expect(b64(ours)).toBe(b64(theirs.toRawBytes()))
        expect(PublicIdentifier.toAddress(ours, { legacyAddress })).toBe(theirs.toSuiAddress() as any)
      }
      const parsed = run(PublicIdentifier.parse(run(PublicIdentifier.make(addressSeed, claims.iss))))
      expect(parsed).toEqual({ iss: claims.iss, addressSeed })
    }
  })

  test("signature serialization from fixed inputs, and parsing back", () => {
    const addressSeed = String(Theirs.genAddressSeed(legacySalt, "sub", claims.sub, claims.aud))
    const zk = inputs(addressSeed)
    const userSignature = new Uint8Array(97).map((_, i) => i)
    const ours = run(Signature.serialize({ inputs: zk, maxEpoch: 954n, userSignature }))
    expect(b64(ours)).toBe(Theirs.getZkLoginSignature({ inputs: zk, maxEpoch: "954", userSignature }))
    const parsed = run(Signature.parse(ours))
    const ref = Theirs.parseZkLoginSignature(ours.subarray(1))
    expect(parsed.maxEpoch).toBe(BigInt(ref.maxEpoch))
    expect(parsed.inputs).toEqual(ref.inputs as any)
    expect(b64(parsed.userSignature)).toBe(b64(Uint8Array.from(ref.userSignature)))
    // The prover's JSON decodes with the same schema.
    expect(Schema.decodeUnknownSync(Signature.ZkLoginSignatureInputs)(JSON.parse(JSON.stringify(zk)))).toEqual(zk)
  })

  test("ZkLogin.signer produces ZkLoginSigner's bytes and address", async () => {
    const addressSeed = String(Theirs.genAddressSeed(legacySalt, "sub", claims.sub, claims.aud))
    const zk = inputs(addressSeed)
    for (const legacyAddress of [false, true]) {
      const theirs = new Theirs.ZkLoginSigner({
        ephemeralSigner: Ed25519Keypair.fromSecretKey(seed(9)),
        inputs: zk,
        maxEpoch: 954,
        legacyAddress
      })
      const { signer, signed } = run(Effect.gen(function*() {
        const ephemeral = yield* Ed25519.fromSecretKey(seed(9))
        const signer = yield* ZkLogin.signer({ ephemeral, inputs: zk, maxEpoch: 954, legacyAddress })
        return { signer, signed: yield* Signer.signPersonalMessage(signer, msg) }
      }))
      expect(signer.address).toBe(theirs.toSuiAddress() as any)
      expect(b64(signer.publicKey.bytes)).toBe(b64(theirs.getPublicKey().toRawBytes()))
      expect(b64(signed.signature)).toBe((await theirs.signPersonalMessage(msg)).signature)
    }
    // A wrong legacy flag against an expected address is refused.
    const expected = new Theirs.ZkLoginSigner({
      ephemeralSigner: Ed25519Keypair.fromSecretKey(seed(9)),
      inputs: zk,
      maxEpoch: 954,
      legacyAddress: true
    }).toSuiAddress()
    const refused = run(Effect.flip(Effect.flatMap(Ed25519.fromSecretKey(seed(9)), (ephemeral) =>
      ZkLogin.signer({ ephemeral, inputs: zk, maxEpoch: 954, address: expected as any }))))
    expect(refused._tag).toBe("InvalidKey")
  })
})
