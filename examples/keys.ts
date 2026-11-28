/**
 * README examples (Keys), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as PrivateKey from "@unconfirmed/effect-sui/PrivateKey"
import * as Bip32 from "@unconfirmed/effect-sui/Bip32"
import * as Mnemonic from "@unconfirmed/effect-sui/Mnemonic"
import * as Passkey from "@unconfirmed/effect-sui/Passkey"
import * as PublicIdentifier from "@unconfirmed/effect-sui/zklogin/PublicIdentifier"
import * as Ed25519 from "@unconfirmed/effect-sui/Ed25519"
import * as MlDsa65 from "@unconfirmed/effect-sui/MlDsa65"
import * as MultiSig from "@unconfirmed/effect-sui/MultiSig"
import * as Secp256k1 from "@unconfirmed/effect-sui/Secp256k1"
import { SignatureSchemes } from "./shared.ts"

declare const s: string
declare const json: string
declare const seed32: Uint8Array
declare const sk: Uint8Array
declare const storedPasskeyKey: Uint8Array
declare const addressSeed: bigint
declare const iss: string
declare const message: Uint8Array
declare const signature: Uint8Array

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
  const k1 = yield* Secp256k1.fromSecretKey(yield* Bip32.secp256k1SecretKey(m, { account: 1 }))     // m/54'/784'/1'/0/0
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

export const sync = () => {
  // #region readme
  const ed = Result.getOrThrow(Ed25519.fromSecretKeyResult(sk))             // also Secp256k1/r1.fromSecretKeyResult
  const multi = MultiSig.publicKeyResult({ members: [{ publicKey: ed.publicKey, weight: 1 }], threshold: 1 })
  const zk = Result.map(PublicIdentifier.makeResult(addressSeed, iss), PublicIdentifier.toPublicKey)  // flag 0x05
  const passkey = Passkey.publicKeyResult(storedPasskeyKey)                 // flag 0x06, from the 33-byte compressed key
  const ok = Ed25519.verifyRaw(ed.publicKey.bytes, message, signature)      // over the raw message, as Move's ed25519_verify
  // #endregion
}
