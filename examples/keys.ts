/**
 * README examples (Keys), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import * as Effect from "effect/Effect"
import * as PrivateKey from "@unconfirmed/sui/PrivateKey"
import * as Mnemonic from "@unconfirmed/sui-mnemonic"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as MlDsa65 from "@unconfirmed/sui-mldsa65"
import * as MultiSig from "@unconfirmed/sui-multisig"
import * as Secp256k1 from "@unconfirmed/sui-secp256k1"
import { SignatureSchemes } from "./shared.ts"

declare const s: string
declare const json: string
declare const seed32: Uint8Array

export const keys = Effect.gen(function*() {
  // #region readme
  const { flag, scheme, secretKey } = yield* PrivateKey.decode(s)           // InvalidKey on a bad string
  const signer = yield* Secp256k1.fromSecretKey(secretKey)
  const ed = yield* Ed25519.fromSecretKey((yield* PrivateKey.decode(s, Ed25519.FLAG)).secretKey)  // insist on a scheme

  // `generate` gives a Signer only; to keep the key, generate the secret:
  const sk = yield* Ed25519.generateSecretKey                               // also Secp256k1/r1, MlDsa65
  const exported = yield* PrivateKey.encode({ flag: Ed25519.FLAG, secretKey: sk })

  // The CLI's ~/.sui/sui_config/sui.keystore (JSON array of base64 flag || secret)
  const keys = yield* PrivateKey.decodeKeystore(json)                       // and encodeKeystore(keys)
  // #endregion
})

export const mnemonics = Effect.gen(function*() {
  // #region readme
  const m = yield* Mnemonic.generate()                                        // 12 words; 24 with generate(24)
  const signer = yield* Mnemonic.ed25519Signer(m)                             // m/44'/784'/0'/0'/0'
  const k1 = yield* Secp256k1.fromSecretKey(yield* Mnemonic.secp256k1SecretKey(m, { account: 1 }))  // m/54'/784'/1'/0/0
  const seed = yield* Mnemonic.toSeed(m)                                      // derive many keys without re-running PBKDF2
  const pq = yield* MlDsa65.fromSecretKey(yield* Mnemonic.mldsa65SecretKey(seed, "m/94'/784'/0'/0'/3'"))
  // #endregion
})

export const mldsa = (ed: { readonly publicKey: { readonly flag: number; readonly bytes: Uint8Array } }) =>
  Effect.gen(function*() {
    // #region readme
    SignatureSchemes.layer(Ed25519.scheme, MlDsa65.scheme, MultiSig.scheme)
    const signer = yield* MlDsa65.fromSecretKey(seed32)                         // or MlDsa65.generate
    const pk = yield* MultiSig.publicKey({ members: [{ publicKey: ed.publicKey, weight: 1 }, { publicKey: signer.publicKey, weight: 1 }], threshold: 1 })
    // #endregion
  })
