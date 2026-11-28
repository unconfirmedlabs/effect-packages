import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { Hash, SignatureScheme, Signer, Verify } from "@unconfirmed/effect-sui"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Secp256k1 from "../../src/Secp256k1.ts"

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const secret = new Uint8Array(32).map((_, i) => i + 7)
const msg = new TextEncoder().encode("hello")

describe("Secp256k1", () => {
  test("address and signatures match @mysten/sui", async () => {
    const signer = await Effect.runPromise(Secp256k1.fromSecretKey(secret))
    const kp = Secp256k1Keypair.fromSecretKey(secret)
    expect(signer.address).toBe(kp.toSuiAddress() as typeof signer.address)
    const ours = await Effect.runPromise(Signer.signPersonalMessage(signer, msg))
    expect(b64(ours.signature)).toBe((await kp.signPersonalMessage(msg)).signature)
    expect((await verifyPersonalMessageSignature(msg, b64(ours.signature), { offline: true })).toSuiAddress()).toBe(signer.address)
  })

  test("refuses a high-S signature (malleability), which a lax verifier would accept", async () => {
    const signer = await Effect.runPromise(Secp256k1.fromSecretKey(secret))
    const { signature } = await Effect.runPromise(Signer.signPersonalMessage(signer, msg))
    const n = secp256k1.Point.CURVE().n
    const s = BigInt("0x" + Buffer.from(signature.subarray(33, 65)).toString("hex"))
    const highS = signature.slice()
    highS.set(Buffer.from((n - s).toString(16).padStart(64, "0"), "hex"), 33)
    const layer = SignatureScheme.SignatureSchemes.layer(Secp256k1.scheme)
    const ok = await Effect.runPromise(Verify.personalMessage(msg, signature).pipe(Effect.provide(layer)))
    expect(ok.address).toBe(signer.address)
    const err = await Effect.runPromise(Verify.personalMessage(msg, highS).pipe(Effect.flip, Effect.provide(layer)))
    expect(err._tag).toBe("InvalidSignature")
    // The same bytes verify when low-S is not enforced: the refusal above is ours, not an accident.
    const intent = Uint8Array.from([3, 0, 0, msg.length, ...msg])
    expect(secp256k1.verify(highS.subarray(1, 65), Hash.blake2b256(intent), signer.publicKey.bytes, { lowS: false })).toBe(true)
  })

  test("a malformed secret key is a typed InvalidKey with a fixed reason", async () => {
    const err = await Effect.runPromise(Secp256k1.fromSecretKey(new Uint8Array(31)).pipe(Effect.flip))
    expect(err._tag).toBe("InvalidKey")
    expect(err.reason).not.toContain("0000")
  })
})
