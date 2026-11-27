/**
 * `suiprivkey` and `sui.keystore`: both directions agree with @mysten/sui.
 */
import { decodeSuiPrivateKey, encodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { MLDSA65Keypair } from "@mysten/sui/keypairs/mldsa65"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { bech32 } from "@scure/base"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Ed25519, PrivateKey, Signer } from "../src/index.ts"

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)
const fail = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(e))
const secret = (n: number) => new Uint8Array(32).map((_, i) => (i * 7 + n) & 0xff)

const SCHEMES = ["ED25519", "Secp256k1", "Secp256r1", "MLDSA65"] as const

describe("PrivateKey", () => {
  test("encode and decode agree with @mysten/sui for every scheme", async () => {
    for (const [i, scheme] of SCHEMES.entries()) {
      const sk = secret(i + 1)
      const ours = await run(PrivateKey.encode({ flag: PrivateKey.Scheme[scheme], secretKey: sk }))
      expect(ours).toBe(encodeSuiPrivateKey(sk, scheme))
      expect(ours.startsWith("suiprivkey1")).toBe(true)
      const back = await run(PrivateKey.decode(encodeSuiPrivateKey(sk, scheme)))
      expect(back).toEqual({ flag: PrivateKey.Scheme[scheme], scheme, secretKey: sk })
      expect(decodeSuiPrivateKey(ours).secretKey).toEqual(sk)
    }
  })

  test("keys exported by @mysten/sui keypairs import, and ours import there", async () => {
    const pairs = [
      Ed25519Keypair.generate(),
      Secp256k1Keypair.generate(),
      Secp256r1Keypair.generate(),
      MLDSA65Keypair.generate()
    ]
    for (const kp of pairs) {
      const decoded = await run(PrivateKey.decode(kp.getSecretKey()))
      expect(decoded.scheme).toBe(kp.getKeyScheme() as PrivateKey.Scheme)
      expect(await run(PrivateKey.encode(decoded))).toBe(kp.getSecretKey())
    }
    // An Ed25519 key generated here, exported, then loaded by @mysten/sui: same address.
    const sk = await run(Ed25519.generateSecretKey)
    const signer = await run(Ed25519.fromSecretKey(sk))
    const exported = await run(PrivateKey.encode({ flag: Ed25519.FLAG, secretKey: sk }))
    expect(Ed25519Keypair.fromSecretKey(exported).toSuiAddress()).toBe(signer.address)
    // And back through decode with an expected scheme.
    const again = await run(Effect.flatMap(PrivateKey.decode(exported, Ed25519.FLAG), (k) => Ed25519.fromSecretKey(k.secretKey)))
    expect(again.address).toBe(signer.address)
  })

  test("refusals are typed InvalidKey", async () => {
    const good = encodeSuiPrivateKey(secret(1), "ED25519")
    const flipped = good.slice(0, -1) + (good.endsWith("q") ? "p" : "q")
    const cases: Array<[Effect.Effect<unknown, Signer.InvalidKey>, RegExp]> = [
      [PrivateKey.decode("not a key"), /bech32/],
      [PrivateKey.decode(flipped), /bech32/],
      [PrivateKey.decode(bech32.encode("suipubkey", bech32.toWords(new Uint8Array(33)))), /prefix/],
      [PrivateKey.decode(bech32.encode("suiprivkey", bech32.toWords(new Uint8Array([0, 1, 2])))), /32-byte/],
      [PrivateKey.decode(bech32.encode("suiprivkey", bech32.toWords(new Uint8Array(33).fill(3)))), /flag 0x03/],
      [PrivateKey.decode(good, PrivateKey.Scheme.Secp256k1), /expected a Secp256k1 key, got ED25519/],
      [PrivateKey.encode({ flag: 0x05, secretKey: secret(1) }), /flag 0x05/],
      [PrivateKey.encode({ flag: 0x00, secretKey: new Uint8Array(64) }), /32-byte/]
    ]
    for (const [effect, reason] of cases) {
      const e = await fail(effect)
      expect(e._tag).toBe("InvalidKey")
      expect(e.reason).toMatch(reason)
    }
  })

  test("sui.keystore round-trips and matches the CLI's base64 flag || secret entries", async () => {
    const keys = [Ed25519Keypair.generate(), Secp256k1Keypair.generate(), Secp256r1Keypair.generate()]
    // What the Sui CLI writes: a pretty-printed JSON array of base64(flag || secret).
    const file = JSON.stringify(keys.map((kp) => {
      const { secretKey } = decodeSuiPrivateKey(kp.getSecretKey())
      return Buffer.concat([Buffer.from([kp.getPublicKey().flag()]), secretKey]).toString("base64")
    }), null, 2)
    const parsed = await run(PrivateKey.decodeKeystore(file))
    expect(parsed.map((k) => k.scheme)).toEqual(["ED25519", "Secp256k1", "Secp256r1"])
    expect(await run(Effect.forEach(parsed, PrivateKey.encode))).toEqual(keys.map((k) => k.getSecretKey()))
    expect(await run(PrivateKey.encodeKeystore(parsed))).toBe(file)

    for (const [input, reason] of [["{", /not JSON/], ["{}", /array/], ["[1]", /entry 0: expected a base64 string/], ['["AAAA"]', /entry 0/]] as const) {
      const e = await fail(PrivateKey.decodeKeystore(input))
      expect(e._tag).toBe("InvalidKey")
      expect(e.reason).toMatch(reason)
    }
  })

  test("refusals never echo key material", async () => {
    const sk = new Uint8Array(32).fill(0x5a)
    const good = await Effect.runPromise(PrivateKey.encode({ flag: 0, secretKey: sk }))
    const typo = good.slice(0, -1) + (good.endsWith("q") ? "p" : "q")
    const prefix = good.replace("suiprivkey", "suiprivkex")
    for (const s of [typo, prefix]) {
      const e = await Effect.runPromise(Effect.flip(PrivateKey.decode(s)))
      expect(e.reason).not.toContain(s.slice(12, 40))
    }
    const entry = Buffer.from([0, ...sk]).toString("base64")
    const e = await Effect.runPromise(Effect.flip(PrivateKey.decodeKeystore(`[${entry}]`)))
    expect(e.reason).not.toContain(entry.slice(0, 20))
  })
})

