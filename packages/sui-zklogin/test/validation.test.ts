/**
 * Inputs the chain can't represent are refused with typed errors instead of
 * deriving an address nobody can sign for (review SIGN-8, SIGN-9), and the
 * default paths load only the Poseidon arities they need (SIGN-1).
 */
import * as Theirs from "@mysten/sui/zklogin"
import { Ed25519 } from "@unconfirmed/sui"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as AddressSeed from "../src/AddressSeed.ts"
import * as Nonce from "../src/Nonce.ts"
import * as Poseidon from "../src/Poseidon.ts"
import * as PublicIdentifier from "../src/PublicIdentifier.ts"
import * as Signature from "../src/Signature.ts"
import * as ZkLogin from "../src/ZkLogin.ts"
import * as ZkLoginAddress from "../src/ZkLoginAddress.ts"
import { claims, inputs } from "@unconfirmed/test-support/zklogin"

const flip = <A, E>(e: Effect.Effect<A, E>) => Effect.runSync(Effect.flip(e))
const iss = claims.iss

describe("address seeds", () => {
  test("fromSeed refuses seeds outside the BN254 field instead of truncating them", () => {
    const seven = Effect.runSync(ZkLoginAddress.fromSeed(7n, iss))
    for (const seed of [2n ** 300n + 7n, -5n, Poseidon.BN254_FIELD_SIZE, 2n ** 256n]) {
      expect(flip(ZkLoginAddress.fromSeed(seed, iss))._tag).toBe("InvalidZkLoginInput")
    }
    expect(Effect.runSync(ZkLoginAddress.fromSeed(Poseidon.BN254_FIELD_SIZE - 1n, iss))).not.toBe(seven)
    expect(flip(PublicIdentifier.make(-1n, iss))._tag).toBe("InvalidZkLoginInput")
  })

  test("identifier bytes with a seed outside the field don't parse", () => {
    const bytes = new Uint8Array([1, 0x61, ...new Uint8Array(32).fill(0xff)])
    expect(flip(PublicIdentifier.parse(bytes))._tag).toBe("InvalidZkLoginInput")
  })

  test("ZkLogin.signer takes the seed only as canonical decimal in the field", async () => {
    const ephemeral = await Effect.runPromise(Ed25519.generate)
    const good = String(Theirs.genAddressSeed(1n, "sub", claims.sub, claims.aud))
    await Effect.runPromise(ZkLogin.signer({ ephemeral, inputs: inputs(good), maxEpoch: 10 }))
    for (const seed of ["", "0x10", " 16 ", "-1", "016", "1e3", String(Poseidon.BN254_FIELD_SIZE)]) {
      const err = await Effect.runPromise(Effect.flip(ZkLogin.signer({ ephemeral, inputs: inputs(seed), maxEpoch: 10 })))
      expect(err._tag, JSON.stringify(seed)).toBe("InvalidKey")
    }
  })

  test("ZkLogin.signer refuses a maxEpoch that is not a u64", async () => {
    const ephemeral = await Effect.runPromise(Ed25519.generate)
    const zk = inputs(String(Theirs.genAddressSeed(1n, "sub", claims.sub, claims.aud)))
    for (const maxEpoch of [10, 10n, "10", 2n ** 64n - 1n]) {
      await Effect.runPromise(ZkLogin.signer({ ephemeral, inputs: zk, maxEpoch }))
    }
    for (const maxEpoch of ["", "0x10", " 1", -1, 1.5, -1n, 2n ** 64n, Number.MAX_SAFE_INTEGER + 2]) {
      const err = await Effect.runPromise(Effect.flip(ZkLogin.signer({ ephemeral, inputs: zk, maxEpoch })))
      expect(err._tag, String(maxEpoch)).toBe("InvalidKey")
    }
    const serialize = Signature.serialize({ inputs: zk, maxEpoch: "", userSignature: new Uint8Array(97) })
    expect(flip(serialize)._tag).toBe("InvalidZkLoginInput")
    expect(flip(Nonce.generate({ flag: 0, bytes: new Uint8Array(32) }, 2n ** 64n, 1n))._tag).toBe("InvalidZkLoginInput")
  })
})

describe("claim strings", () => {
  test("a non-ASCII claim is refused rather than hashed as something the circuit never sees", () => {
    for (const [name, value, aud] of [["sub", "é", claims.aud], ["sub", claims.sub, "аud"], ["süb", claims.sub, claims.aud]]) {
      expect(flip(AddressSeed.genAddressSeed(1n, name!, value!, aud!))._tag).toBe("InvalidZkLoginInput")
    }
    const err = flip(ZkLoginAddress.compute({ claimName: "sub", claimValue: "δ", userSalt: 1n, iss, aud: claims.aud }))
    expect(err.reason).toContain("non-ASCII")
    // ASCII up to 0x7F (DEL) is fine.
    expect(Effect.runSync(AddressSeed.genAddressSeed(1n, "sub", "a\u007f", claims.aud))).toBe(
      Theirs.genAddressSeed(1n, "sub", "a\u007f", claims.aud)
    )
  })

  test("hashASCIIStrToField refuses a character wider than a byte, as Sui's hash_ascii_str_to_field does", () => {
    expect(flip(AddressSeed.hashASCIIStrToField("abĀ", 32))._tag).toBe("InvalidZkLoginInput")
    // Latin-1 is one byte per character, in Sui's Rust and in @mysten/sui alike.
    expect(Effect.runSync(AddressSeed.hashASCIIStrToField("café", 32))).toBe(Theirs.hashASCIIStrToField("café", 32))
  })
})

describe("Poseidon arities", () => {
  test("the default address-seed path carries only what it needs; other lengths take the full table", () => {
    // 200 chars is 7 chunks: arity 7 is not loaded on the default path.
    const long = "a".repeat(150)
    const err = flip(AddressSeed.hashASCIIStrToField(long, 200))
    expect(err.reason).toContain("Poseidon.hashUnsafe")
    expect(Effect.runSync(AddressSeed.hashASCIIStrToField(long, 200, { poseidon: Poseidon.hashUnsafe }))).toBe(
      Theirs.hashASCIIStrToField(long, 200)
    )
    const options = { maxValueLength: 200, poseidon: Poseidon.hashUnsafe }
    expect(Effect.runSync(AddressSeed.genAddressSeed(3n, "sub", long, claims.aud, options))).toBe(
      Theirs.genAddressSeed(3n, "sub", long, claims.aud, 32, 200)
    )
  })
})
