import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { PasskeyKeypair, PasskeyPublicKey } from "@mysten/sui/keypairs/passkey"
import type { PasskeyProvider as MystenProvider } from "@mysten/sui/keypairs/passkey"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { Bcs } from "@unconfirmed/effect-bcs"
import { Ed25519, SignatureScheme, Signer, Verify } from "@unconfirmed/effect-sui"
import * as MultiSig from "@unconfirmed/effect-sui/MultiSig"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Passkey from "../../src/Passkey.ts"

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"))
const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e)
const msg = new TextEncoder().encode("multisig with a passkey")
const edSeed = new Uint8Array(32).fill(4)
const pkSecret = new Uint8Array(32).fill(5)

const asMysten = (p: Passkey.Provider): MystenProvider => ({
  create: async () => {
    const c = await run(p.create())
    return { rawId: c.id, response: { getPublicKey: () => c.publicKey } } as any
  },
  get: async (challenge, id) => {
    const a = await run(p.get(challenge, id))
    return { rawId: a.credentialId, response: { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature } } as any
  }
})

const all = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme, Passkey.scheme, MultiSig.scheme)

/** 2-of-2 of Ed25519 (weight 1) and a passkey (weight 1), ours and Mysten's over the same keys. */
const setup = async () => {
  const provider = await run(Passkey.softwareProvider({ secretKey: pkSecret }))
  const passkey = await run(Passkey.create(provider))
  const ed = await run(Ed25519.fromSecretKey(edSeed))
  const pk = await run(MultiSig.publicKey({
    members: [{ publicKey: ed.publicKey, weight: 1 }, { publicKey: passkey.publicKey, weight: 1 }],
    threshold: 2
  }))
  const signer = await run(MultiSig.signer(pk, [passkey, ed]))
  const kEd = Ed25519Keypair.fromSecretKey(edSeed)
  const kPasskey = new PasskeyKeypair(passkey.publicKey.bytes, asMysten(provider))
  const theirPk = MultiSigPublicKey.fromPublicKeys({
    threshold: 2,
    publicKeys: [{ publicKey: kEd.getPublicKey(), weight: 1 }, { publicKey: new PasskeyPublicKey(passkey.publicKey.bytes), weight: 1 }]
  })
  return { provider, passkey, ed, pk, signer, kEd, kPasskey, theirPk }
}

describe("MultiSig with a passkey member", () => {
  test("same address; identical bytes; verifies through our Verify and Mysten's", async () => {
    const t = await setup()
    expect(t.signer.address).toBe(t.theirPk.toSuiAddress() as typeof t.signer.address)

    const ours = await run(Signer.signPersonalMessage(t.signer, msg))
    const ref = t.theirPk.combinePartialSignatures([
      (await t.kEd.signPersonalMessage(msg)).signature,
      (await t.kPasskey.signPersonalMessage(msg)).signature
    ])
    expect(b64(ours.signature)).toBe(ref)

    const v = await run(Effect.provide(Verify.personalMessage(msg, fromB64(ref), { address: t.signer.address }), all))
    expect(v.publicKey.flag).toBe(MultiSig.FLAG)
    expect((await verifyPersonalMessageSignature(msg, b64(ours.signature), { offline: true })).toSuiAddress()).toBe(t.signer.address)
    expect(await t.theirPk.verifyPersonalMessage(msg, b64(ours.signature))).toBe(true)

    // combine takes a separately made passkey signature naming its member.
    const sigs = await run(Effect.all([Signer.signPersonalMessage(t.ed, msg), Signer.signPersonalMessage(t.passkey, msg)]))
    const combined = await run(MultiSig.combine(t.pk, [sigs[0].signature, { signature: sigs[1].signature, publicKey: t.passkey.publicKey }]))
    expect(combined as Uint8Array).toEqual(ours.signature)
  })

  test("a different passkey's signature spliced into the member slot is refused", async () => {
    const t = await setup()
    const { signature } = await run(Signer.signPersonalMessage(t.signer, msg))
    // The other passkey's signature is valid on its own, but not from this member.
    const intruder = await run(Effect.flatMap(Passkey.softwareProvider(), Passkey.create))
    const forged = await run(Effect.gen(function*() {
      const edSig = (yield* Signer.signPersonalMessage(t.ed, msg)).signature
      const otherPk = yield* MultiSig.publicKey({
        members: [{ publicKey: t.ed.publicKey, weight: 1 }, { publicKey: intruder.publicKey, weight: 1 }],
        threshold: 2
      })
      const intruderSig = (yield* Signer.signPersonalMessage(intruder, msg)).signature
      return yield* MultiSig.combine(otherPk, [edSig, { signature: intruderSig, publicKey: intruder.publicKey }])
    }))
    // Splice the honest member set back in: same signatures, original multisig public key.
    const parsed = Bcs.decodeSync(MultiSig.MultiSigBcs)(forged.subarray(1))
    const honest = Bcs.decodeSync(MultiSig.MultiSigBcs)(signature.subarray(1))
    const spliced = new Uint8Array([MultiSig.FLAG, ...Bcs.encodeSync(MultiSig.MultiSigBcs)({ ...parsed, multisigPk: honest.multisigPk })])
    const err = await run(Effect.flip(Effect.provide(Verify.personalMessage(msg, spliced), all)))
    expect(err).toMatchObject({ _tag: "InvalidSignature", scheme: "Passkey", reason: "signature is not from this member's passkey" })
    expect(await t.theirPk.verifyPersonalMessage(msg, b64(spliced))).toBe(false)
  })
})
