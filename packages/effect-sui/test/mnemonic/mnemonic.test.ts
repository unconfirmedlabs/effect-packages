import { decodeSuiPrivateKey, mnemonicToSeed } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { MLDSA65Keypair } from "@mysten/sui/keypairs/mldsa65"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import * as MlDsa65 from "@unconfirmed/sui-mldsa65"
import * as Secp256k1 from "@unconfirmed/sui-secp256k1"
import * as Secp256r1 from "@unconfirmed/sui-secp256r1"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Mnemonic from "../src/index.ts"

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)
const fail = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(e))
const secretOf = (kp: { getSecretKey(): string }) => decodeSuiPrivateKey(kp.getSecretKey()).secretKey

const FIXED = "film crazy soon outside stand loop subway crumble thrive popular green nuclear struggle pistol arm wife phrase warfare march wheat nephew ask sunny firm"

describe("Mnemonic", () => {
  test("generate gives a valid mnemonic of the requested length", async () => {
    const m = await run(Mnemonic.generate(24))
    expect(m.split(" ").length).toBe(24)
    expect(Mnemonic.isValid(m)).toBe(true)
  })

  test("seed matches @mysten/sui; input is normalized", async () => {
    expect(await run(Mnemonic.toSeed(FIXED))).toEqual(mnemonicToSeed(FIXED))
    expect(await run(Mnemonic.toSeed(`  ${FIXED.toUpperCase().replaceAll(" ", "  \n")} `))).toEqual(mnemonicToSeed(FIXED))
  })

  test("every scheme's derivation matches @mysten/sui, at the default path and a non-default one", async () => {
    const seed = await run(Mnemonic.toSeed(FIXED))
    for (const i of [{}, { account: 3, change: 1, index: 7 }]) {
      const ed = Ed25519Keypair.deriveKeypair(FIXED, Mnemonic.ed25519Path(i))
      const k1 = Secp256k1Keypair.deriveKeypair(FIXED, Mnemonic.secp256k1Path(i))
      const r1 = Secp256r1Keypair.deriveKeypair(FIXED, Mnemonic.secp256r1Path(i))
      const pq = MLDSA65Keypair.deriveKeypair(FIXED, Mnemonic.mldsa65Path(i))

      expect(await run(Mnemonic.ed25519SecretKey(FIXED, i))).toEqual(secretOf(ed))
      expect(await run(Mnemonic.ed25519SecretKey(seed, Mnemonic.ed25519Path(i)))).toEqual(secretOf(ed))
      expect((await run(Mnemonic.ed25519Signer(FIXED, i))).address).toBe(ed.toSuiAddress() as any)

      const k1sk = await run(Mnemonic.secp256k1SecretKey(seed, i))
      expect(k1sk).toEqual(secretOf(k1))
      expect((await run(Secp256k1.fromSecretKey(k1sk))).address).toBe(k1.toSuiAddress() as any)

      const r1sk = await run(Mnemonic.secp256r1SecretKey(FIXED, i))
      expect(r1sk).toEqual(secretOf(r1))
      expect((await run(Secp256r1.fromSecretKey(r1sk))).address).toBe(r1.toSuiAddress() as any)

      const pqsk = await run(Mnemonic.mldsa65SecretKey(seed, i))
      expect(pqsk).toEqual(secretOf(pq))
      expect((await run(MlDsa65.fromSecretKey(pqsk))).address).toBe(pq.toSuiAddress() as any)
    }
  })

  test("bad paths are typed InvalidPath", async () => {
    const cases = [
      Mnemonic.ed25519SecretKey(FIXED, "m/44'/784'/0'/0/0"), // ed25519 is hardened-only
      Mnemonic.ed25519SecretKey(FIXED, "m/44'/784'/2147483648'/0'/0'"), // index >= 2^31
      Mnemonic.ed25519SecretKey(FIXED, { account: -1 }),
      Mnemonic.secp256k1SecretKey(FIXED, "m/54'/784'/0'/0'/0'") // BIP32: change/index are not hardened
    ]
    for (const effect of cases) {
      expect((await fail(effect))._tag).toBe("InvalidPath")
    }
  })

  test("bad mnemonics and seeds are typed InvalidMnemonic, whose message never echoes the words", async () => {
    const words = FIXED.split(" ")
    const cases = [
      Mnemonic.toSeed(words.slice(0, 11).join(" ")),
      Mnemonic.toSeed([...words.slice(0, 23), words[0]].join(" ")), // bad checksum
      Mnemonic.ed25519SecretKey(new Uint8Array(15))
    ]
    for (const effect of cases) {
      const e = await fail(effect)
      expect(e._tag).toBe("InvalidMnemonic")
      expect(e.message).not.toContain(words[0])
    }
    expect(Mnemonic.isValid(words.slice(0, 11).join(" "))).toBe(false)
  })
})
