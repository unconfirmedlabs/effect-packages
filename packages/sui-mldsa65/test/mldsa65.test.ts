import { MLDSA65Keypair, MLDSA65PublicKey } from "@mysten/sui/keypairs/mldsa65"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { verifyPersonalMessageSignature, verifyTransactionSignature } from "@mysten/sui/verify"
import { Ed25519, PrivateKey, SignatureScheme, Signer, Verify } from "@unconfirmed/sui"
import * as MultiSig from "@unconfirmed/sui-multisig"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as MlDsa65 from "../src/index.ts"

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"))
const seed = (n: number) => new Uint8Array(32).map((_, i) => (i * 13 + n) & 0xff)
const msg = new TextEncoder().encode("post-quantum hello")
const txBytes = new Uint8Array(200).map((_, i) => i) // verification doesn't parse the transaction
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

const schemes = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme, MlDsa65.scheme, MultiSig.scheme)
const verified = <A, E>(e: Effect.Effect<A, E, SignatureScheme.SignatureSchemes>) => run(Effect.provide(e, schemes))

describe("ML-DSA-65", () => {
  test("same key and address as @mysten/sui, which verifies our (hedged) signatures", async () => {
    const kp = MLDSA65Keypair.fromSecretKey(seed(2))
    const signer = await run(MlDsa65.fromSecretKey(seed(2)))
    expect(signer.publicKey.bytes).toEqual(kp.getPublicKey().toRawBytes())
    expect(signer.address).toBe(kp.toSuiAddress() as typeof signer.address)
    const personal = await run(Signer.signPersonalMessage(signer, msg))
    expect((await verifyPersonalMessageSignature(msg, b64(personal.signature), { offline: true })).toSuiAddress()).toBe(signer.address)
    const tx = await run(Signer.signTransaction(signer, txBytes))
    expect((await verifyTransactionSignature(txBytes, b64(tx.signature), { offline: true })).toSuiAddress()).toBe(signer.address)
    // Hedged: a second signature differs and also verifies.
    const again = await run(Signer.signPersonalMessage(signer, msg))
    expect(b64(again.signature)).not.toBe(b64(personal.signature))
    expect(await new MLDSA65PublicKey(signer.publicKey.bytes).verifyPersonalMessage(msg, b64(again.signature))).toBe(true)
  })

  test("we verify @mysten/sui's signatures, and reject tampering", async () => {
    const kp = MLDSA65Keypair.fromSecretKey(seed(3))
    const personal = fromB64((await kp.signPersonalMessage(msg)).signature)
    const ok = await verified(Verify.personalMessage(msg, personal, { address: kp.toSuiAddress() as any }))
    expect(ok.publicKey.flag).toBe(MlDsa65.FLAG)

    const tampered = personal.slice()
    tampered[10]! ^= 1
    expect((await verified(Effect.flip(Verify.personalMessage(msg, tampered))))._tag).toBe("InvalidSignature")
    expect((await verified(Effect.flip(Verify.personalMessage(msg, personal.subarray(0, 100)))))._tag).toBe("InvalidSignature")
  })

  test("secret keys are 32-byte seeds, interchangeable with @mysten/sui's suiprivkey", async () => {
    const sk = await run(MlDsa65.generateSecretKey)
    const signer = await run(MlDsa65.fromSecretKey(sk))
    const exported = await run(PrivateKey.encode({ flag: MlDsa65.FLAG, secretKey: sk }))
    expect(MLDSA65Keypair.fromSecretKey(exported).toSuiAddress()).toBe(signer.address)
    const kp = MLDSA65Keypair.generate()
    const imported = await run(Effect.flatMap(PrivateKey.decode(kp.getSecretKey(), MlDsa65.FLAG), (k) => MlDsa65.fromSecretKey(k.secretKey)))
    expect(imported.address).toBe(kp.toSuiAddress() as any)
    expect((await run(Effect.flip(MlDsa65.fromSecretKey(new Uint8Array(31)))))._tag).toBe("InvalidKey")
  })

  test("as a multisig member: same address as @mysten/sui, each side verifies the other", async () => {
    const [kpA, kpB] = [Ed25519Keypair.fromSecretKey(seed(4)), MLDSA65Keypair.fromSecretKey(seed(5))]
    const theirPk = MultiSigPublicKey.fromPublicKeys({
      threshold: 2,
      publicKeys: [{ publicKey: kpA.getPublicKey(), weight: 1 }, { publicKey: kpB.getPublicKey(), weight: 2 }]
    })
    const { pk, signer } = await run(Effect.gen(function*() {
      const a = yield* Ed25519.fromSecretKey(seed(4))
      const b = yield* MlDsa65.fromSecretKey(seed(5))
      const pk = yield* MultiSig.publicKey({ members: [{ publicKey: a.publicKey, weight: 1 }, { publicKey: b.publicKey, weight: 2 }], threshold: 2 })
      return { pk, signer: yield* MultiSig.signer(pk, [b]) }
    }))
    expect(MultiSig.address(pk)).toBe(theirPk.toSuiAddress() as any)

    // Ours -> theirs
    const ours = await run(Signer.signPersonalMessage(signer, msg))
    expect(await theirPk.verifyPersonalMessage(msg, b64(ours.signature))).toBe(true)

    // Theirs -> ours
    const theirs = theirPk.combinePartialSignatures([(await kpB.signPersonalMessage(msg)).signature])
    const ok = await verified(Verify.personalMessage(msg, fromB64(theirs), { address: signer.address }))
    expect(ok.publicKey.flag).toBe(MultiSig.FLAG)

    // An ML-DSA signature that doesn't verify fails the multisig.
    const bad = fromB64(theirs)
    bad[20]! ^= 1
    expect((await verified(Effect.flip(Verify.personalMessage(msg, bad))))._tag).toBe("InvalidSignature")
  })
})
