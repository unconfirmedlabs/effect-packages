import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { Ed25519, SignatureScheme, Signer, Verify } from "@unconfirmed/sui"
import * as Secp256k1 from "@unconfirmed/sui-secp256k1"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as MultiSig from "../src/index.ts"

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"))
const seed = (n: number) => new Uint8Array(32).fill(n)
const msg = new TextEncoder().encode("multisig")

const setup = Effect.gen(function*() {
  const a = yield* Ed25519.fromSecretKey(seed(1))
  const b = yield* Ed25519.fromSecretKey(seed(2))
  const c = yield* Secp256k1.fromSecretKey(seed(3))
  const pk = yield* MultiSig.publicKey({
    members: [
      { publicKey: a.publicKey, weight: 1 },
      { publicKey: b.publicKey, weight: 1 },
      { publicKey: c.publicKey, weight: 2 }
    ],
    threshold: 2
  })
  return { a, b, c, pk }
})

const theirs = () => {
  const [ka, kb, kc] = [Ed25519Keypair.fromSecretKey(seed(1)), Ed25519Keypair.fromSecretKey(seed(2)), Secp256k1Keypair.fromSecretKey(seed(3))]
  const pk = MultiSigPublicKey.fromPublicKeys({
    threshold: 2,
    publicKeys: [
      { publicKey: ka.getPublicKey(), weight: 1 },
      { publicKey: kb.getPublicKey(), weight: 1 },
      { publicKey: kc.getPublicKey(), weight: 2 }
    ]
  })
  return { ka, kb, kc, pk }
}

const all = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme, Secp256k1.scheme, MultiSig.scheme)

describe("MultiSig", () => {
  test("address matches @mysten/sui", async () => {
    const { pk } = await Effect.runPromise(setup)
    expect(MultiSig.address(pk)).toBe(theirs().pk.toSuiAddress() as ReturnType<typeof MultiSig.address>)
  })

  test("a multisig Signer from member Signers produces the reference bytes", async () => {
    const t = theirs()
    const ours = await Effect.runPromise(Effect.gen(function*() {
      const { a, b, pk } = yield* setup
      const signer = yield* MultiSig.signer(pk, [b, a]) // order of signers doesn't matter
      return yield* Signer.signPersonalMessage(signer, msg)
    }))
    const ref = t.pk.combinePartialSignatures([
      (await t.ka.signPersonalMessage(msg)).signature,
      (await t.kb.signPersonalMessage(msg)).signature
    ])
    expect(b64(ours.signature)).toBe(ref)
    const verified = await verifyPersonalMessageSignature(msg, b64(ours.signature), { offline: true })
    expect(verified.toSuiAddress()).toBe(t.pk.toSuiAddress())
  })

  test("verifies @mysten/sui multisig signatures through the registry", async () => {
    const t = theirs()
    const sig = t.pk.combinePartialSignatures([(await t.kc.signPersonalMessage(msg)).signature])
    const v = await Effect.runPromise(Verify.personalMessage(msg, fromB64(sig)).pipe(Effect.provide(all)))
    expect(v.address).toBe(t.pk.toSuiAddress() as typeof v.address)
  })

  test("a member scheme that isn't installed is UnsupportedScheme", async () => {
    const t = theirs()
    const sig = t.pk.combinePartialSignatures([(await t.kc.signPersonalMessage(msg)).signature])
    const noSecp = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme, MultiSig.scheme)
    const err = await Effect.runPromise(Verify.personalMessage(msg, fromB64(sig)).pipe(Effect.flip, Effect.provide(noSecp)))
    expect(err._tag).toBe("UnsupportedScheme")
  })

  test("below threshold is refused at signer construction and at verification", async () => {
    const t = theirs()
    const err = await Effect.runPromise(Effect.flatMap(setup, ({ a, pk }) => MultiSig.signer(pk, [a])).pipe(Effect.flip))
    expect(err._tag).toBe("InvalidMultiSig")
    const weak = t.pk.combinePartialSignatures([(await t.ka.signPersonalMessage(msg)).signature])
    const verr = await Effect.runPromise(Verify.personalMessage(msg, fromB64(weak)).pipe(Effect.flip, Effect.provide(all)))
    expect(verr._tag).toBe("InvalidSignature")
  })

  test("combine assembles separately collected signatures", async () => {
    const t = theirs()
    const ours = await Effect.runPromise(Effect.gen(function*() {
      const { a, b, pk } = yield* setup
      const sa = yield* Signer.signPersonalMessage(a, msg)
      const sb = yield* Signer.signPersonalMessage(b, msg)
      return yield* MultiSig.combine(pk, [sb.signature, sa.signature])
    }))
    const v = await Effect.runPromise(Verify.personalMessage(msg, ours).pipe(Effect.provide(all)))
    expect(v.address).toBe(t.pk.toSuiAddress() as typeof v.address)
  })
  test("combine below the threshold is refused (the result could never verify)", async () => {
    const err = await Effect.runPromise(Effect.gen(function*() {
      const { a, pk } = yield* setup
      const sa = yield* Signer.signPersonalMessage(a, msg)
      return yield* Effect.flip(MultiSig.combine(pk, [sa.signature]))
    }))
    expect(err).toMatchObject({ _tag: "InvalidMultiSig" })
    expect(err.reason).toContain("below threshold")
  })

  test("member keys of the wrong length are refused, so no unreachable address is derived", async () => {
    const a = await Effect.runPromise(Ed25519.fromSecretKey(seed(1)))
    const zk = (issLength: number, rest: number) => new Uint8Array([issLength, ...new Uint8Array(issLength + rest).fill(0x61)])
    const bad: Array<[string, SignatureScheme.PublicKey]> = [
      ["31-byte Ed25519", { flag: 0x00, bytes: new Uint8Array(31) }],
      ["65-byte (uncompressed) secp256k1", { flag: 0x01, bytes: new Uint8Array(65).fill(4) }],
      ["32-byte key under the secp256r1 flag", { flag: 0x02, bytes: new Uint8Array(32) }],
      ["short passkey", { flag: 0x06, bytes: new Uint8Array(32) }],
      ["short ML-DSA-65", { flag: 0x07, bytes: new Uint8Array(1951) }],
      ["zkLogin without a seed", { flag: 0x05, bytes: zk(3, 0) }],
      ["zkLogin with a 33-byte seed", { flag: 0x05, bytes: zk(3, 33) }],
      ["zkLogin without an issuer", { flag: 0x05, bytes: new Uint8Array([0, 1, 2]) }]
    ]
    for (const [why, publicKey] of bad) {
      const err = await Effect.runPromise(
        MultiSig.publicKey({ members: [{ publicKey: a.publicKey, weight: 1 }, { publicKey, weight: 1 }], threshold: 1 }).pipe(Effect.flip)
      )
      expect(err._tag, why).toBe("InvalidMultiSig")
      expect(err.reason, why).toContain("member 1")
    }
    // A padded (32-byte seed) and a legacy (shorter seed) zkLogin identifier are both fine.
    for (const bytes of [zk(3, 32), zk(3, 31)]) {
      await Effect.runPromise(MultiSig.publicKey({ members: [{ publicKey: { flag: 0x05, bytes }, weight: 1 }], threshold: 1 }))
    }
  })

  test("signer fails, never throws, on a bad member set", async () => {
    const a = await Effect.runPromise(Ed25519.fromSecretKey(seed(1)))
    const pk = await Effect.runPromise(MultiSig.publicKey({ members: [{ publicKey: a.publicKey, weight: 1 }], threshold: 1 }))
    // A hand-built key that skipped `publicKey` (the brand is only a type): a 31-byte member, a weight of 300.
    for (const member of [{ publicKey: { flag: 0x00, bytes: new Uint8Array(31) }, weight: 1 }, { publicKey: { flag: 0x00, bytes: seed(5) }, weight: 300 }]) {
      const forged = { ...pk, members: [...pk.members, member] } as MultiSig.MultiSigPublicKey
      const run = MultiSig.signer(forged, [a]) // building the effect doesn't throw
      expect((await Effect.runPromise(Effect.flip(run)))._tag).toBe("InvalidMultiSig")
      const sa = await Effect.runPromise(Signer.signPersonalMessage(a, msg))
      expect((await Effect.runPromise(Effect.flip(MultiSig.combine(forged, [sa.signature]))))._tag).toBe("InvalidMultiSig")
    }
  })
})
