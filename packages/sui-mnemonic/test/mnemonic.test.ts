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
const INDICES = [{}, { account: 1 }, { account: 3, change: 1, index: 7 }] as const

describe("Mnemonic", () => {
  test("generate gives valid mnemonics of the requested length", async () => {
    for (const words of [12, 15, 18, 21, 24] as const) {
      const m = await run(Mnemonic.generate(words))
      expect(m.split(" ").length).toBe(words)
      expect(Mnemonic.isValid(m)).toBe(true)
    }
    expect((await run(Mnemonic.generate())).split(" ").length).toBe(12)
  })

  test("seed matches @mysten/sui; input is normalized", async () => {
    expect(await run(Mnemonic.toSeed(FIXED))).toEqual(mnemonicToSeed(FIXED))
    expect(await run(Mnemonic.toSeed(`  ${FIXED.toUpperCase().replaceAll(" ", "  \n")} `))).toEqual(mnemonicToSeed(FIXED))
  })

  test("every scheme's derivation matches @mysten/sui at several paths", async () => {
    for (const m of [FIXED, await run(Mnemonic.generate()), await run(Mnemonic.generate(24))]) {
      const seed = await run(Mnemonic.toSeed(m))
      for (const i of INDICES) {
        const ed = Ed25519Keypair.deriveKeypair(m, Mnemonic.ed25519Path(i))
        const k1 = Secp256k1Keypair.deriveKeypair(m, Mnemonic.secp256k1Path(i))
        const r1 = Secp256r1Keypair.deriveKeypair(m, Mnemonic.secp256r1Path(i))
        const pq = MLDSA65Keypair.deriveKeypair(m, Mnemonic.mldsa65Path(i))

        expect(await run(Mnemonic.ed25519SecretKey(m, i))).toEqual(secretOf(ed))
        expect(await run(Mnemonic.ed25519SecretKey(seed, Mnemonic.ed25519Path(i)))).toEqual(secretOf(ed))
        expect((await run(Mnemonic.ed25519Signer(m, i))).address).toBe(ed.toSuiAddress() as any)

        const k1sk = await run(Mnemonic.secp256k1SecretKey(seed, i))
        expect(k1sk).toEqual(secretOf(k1))
        expect((await run(Secp256k1.fromSecretKey(k1sk))).address).toBe(k1.toSuiAddress() as any)

        const r1sk = await run(Mnemonic.secp256r1SecretKey(m, i))
        expect(r1sk).toEqual(secretOf(r1))
        expect((await run(Secp256r1.fromSecretKey(r1sk))).address).toBe(r1.toSuiAddress() as any)

        const pqsk = await run(Mnemonic.mldsa65SecretKey(seed, i))
        expect(pqsk).toEqual(secretOf(pq))
        expect((await run(MlDsa65.fromSecretKey(pqsk))).address).toBe(pq.toSuiAddress() as any)
      }
    }
  })

  test("default paths", () => {
    expect(Mnemonic.ed25519Path()).toBe("m/44'/784'/0'/0'/0'")
    expect(Mnemonic.secp256k1Path()).toBe("m/54'/784'/0'/0/0")
    expect(Mnemonic.secp256r1Path()).toBe("m/74'/784'/0'/0/0")
    expect(Mnemonic.mldsa65Path()).toBe("m/94'/784'/0'/0'/0'")
  })

  test("bad paths are typed InvalidPath", async () => {
    const cases = [
      Mnemonic.ed25519SecretKey(FIXED, "m/44'/784'/0'/0/0"), // ed25519 is hardened-only
      Mnemonic.ed25519SecretKey(FIXED, "m/54'/784'/0'/0'/0'"), // wrong purpose
      Mnemonic.ed25519SecretKey(FIXED, "m/44'/784'/2147483648'/0'/0'"), // index >= 2^31
      Mnemonic.ed25519SecretKey(FIXED, { account: -1 }),
      Mnemonic.ed25519SecretKey(FIXED, { account: 1.5 }),
      Mnemonic.secp256k1SecretKey(FIXED, "m/54'/784'/0'/0'/0'"), // change/index are not hardened
      Mnemonic.secp256k1SecretKey(FIXED, "m/74'/784'/0'/0/0"), // that is secp256r1's purpose
      Mnemonic.secp256r1SecretKey(FIXED, "m/74'/784'/0'/0"),
      Mnemonic.mldsa65SecretKey(FIXED, "m/44'/784'/0'/0'/0'")
    ]
    for (const effect of cases) {
      const e = await fail(effect)
      expect(e._tag).toBe("InvalidPath")
    }
    const e = await fail(Mnemonic.secp256k1SecretKey(FIXED, "m/54'/784'/0'/0'/0'"))
    if (e._tag !== "InvalidPath") throw e
    expect(e.reason).toBe("expected m/54'/784'/{account}'/{change}/{index}")
  })

  test("bad mnemonics and seeds are typed InvalidMnemonic", async () => {
    const words = FIXED.split(" ")
    const cases = [
      Mnemonic.toSeed(""),
      Mnemonic.toSeed(words.slice(0, 11).join(" ")),
      Mnemonic.toSeed([...words.slice(0, 23), words[0]].join(" ")), // bad checksum
      Mnemonic.toSeed([...words.slice(0, 23), "notaword"].join(" ")),
      Mnemonic.ed25519SecretKey(new Uint8Array(15)),
      Mnemonic.ed25519SecretKey(new Uint8Array(65))
    ]
    for (const effect of cases) {
      const e = await fail(effect)
      expect(e._tag).toBe("InvalidMnemonic")
    }
    expect(Mnemonic.isValid(words.slice(0, 11).join(" "))).toBe(false)
  })
})
