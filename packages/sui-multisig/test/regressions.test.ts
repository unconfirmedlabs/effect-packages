/**
 * Review regressions: zkLogin members are stored with their flag byte (parity
 * with @mysten/sui), `combine` can name members, and verification rejects what
 * validators reject.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import * as Theirs from "@mysten/sui/zklogin"
import { Bcs } from "@unconfirmed/bcs"
import { Address, Ed25519, Hash, SignatureScheme, Signer, Verify } from "@unconfirmed/sui"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as MultiSig from "../src/index.ts"

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"))
const seed = (n: number) => new Uint8Array(32).fill(n)
const msg = new TextEncoder().encode("zkLogin member")

// -----------------------------------------------------------------------------
// A fixed zkLogin signature (made-up JWT and proof that parse but prove nothing),
// after packages/sui-zklogin/test/fixtures.ts.
// -----------------------------------------------------------------------------

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url")
const header = { alg: "RS256", kid: "a50f6e70ef4b548a5fd9142eecd1fb8f54dce9ee", typ: "JWT" }
const claims = { iss: "https://accounts.google.com", aud: "client-id", sub: "110463452167303598383", nonce: "n" }
const jwt = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}.c2ln`
const claimDetails = (token: string, name: string) => {
  const payload = token.split(".")[1]!
  const json = Buffer.from(payload, "base64url").toString("utf8")
  const start = json.indexOf(`"${name}":`)
  let end = json.indexOf(",", start) + 1
  if (end === 0) end = json.indexOf("}", start) + 1
  const startChar = Math.floor((Buffer.byteLength(json.slice(0, start)) * 4) / 3)
  const endChar = Math.ceil((Buffer.byteLength(json.slice(0, end)) * 4) / 3)
  return { value: payload.slice(startChar, endChar), indexMod4: startChar % 4 }
}
const addressSeed = String(Theirs.genAddressSeed(42n, "sub", claims.sub, claims.aud))
const inputs = {
  proofPoints: { a: ["1", "2", "1"], b: [["3", "4"], ["5", "6"], ["1", "0"]], c: ["7", "8", "1"] },
  issBase64Details: claimDetails(jwt, "iss"),
  headerBase64: b64url(JSON.stringify(header)),
  addressSeed
}

const zkFixture = async () => {
  const ephemeral = Ed25519Keypair.fromSecretKey(seed(9))
  const { signature: userSignature } = await ephemeral.signPersonalMessage(msg)
  const zkSignature = fromB64(Theirs.getZkLoginSignature({ inputs, maxEpoch: 954, userSignature }))
  const zkPk = Theirs.toZkLoginPublicIdentifier(BigInt(addressSeed), claims.iss, { legacyAddress: false })
  const other = Ed25519Keypair.fromSecretKey(seed(1))
  const theirs = MultiSigPublicKey.fromPublicKeys({
    threshold: 1,
    publicKeys: [{ publicKey: other.getPublicKey(), weight: 1 }, { publicKey: zkPk, weight: 1 }]
  })
  const zkMember: SignatureScheme.PublicKey = { flag: 0x05, bytes: zkPk.toRawBytes() }
  const ours = await Effect.runPromise(MultiSig.publicKey({
    members: [{ publicKey: { flag: 0x00, bytes: other.getPublicKey().toRawBytes() }, weight: 1 }, { publicKey: zkMember, weight: 1 }],
    threshold: 1
  }))
  return { zkSignature, zkMember, theirs, ours, reference: fromB64(theirs.combinePartialSignatures([b64(zkSignature)])) }
}

describe("zkLogin members (review 11/14)", () => {
  test("MultiSig.signer stores the zkLogin member signature with its flag, byte-for-byte with @mysten", async () => {
    const f = await zkFixture()
    expect(MultiSig.address(f.ours)).toBe(f.theirs.toSuiAddress() as Address.Address)
    const zkSigner: Signer.Signer = {
      address: Address.normalize("0x1"),
      publicKey: f.zkMember,
      sign: () => Effect.succeed(f.zkSignature)
    }
    const signed = await Effect.runPromise(
      Effect.flatMap(MultiSig.signer(f.ours, [zkSigner]), (s) => Signer.signPersonalMessage(s, msg))
    )
    expect(signed.signature.length).toBe(f.reference.length)
    expect(b64(signed.signature)).toBe(b64(f.reference))
  })

  test("combine with a named zkLogin member matches @mysten's combinePartialSignatures", async () => {
    const f = await zkFixture()
    const combined = await Effect.runPromise(MultiSig.combine(f.ours, [{ signature: f.zkSignature, publicKey: f.zkMember }]))
    expect(b64(combined)).toBe(b64(f.reference))
  })

  test("combine refuses an unnamed zkLogin signature, and a name of the wrong scheme", async () => {
    const f = await zkFixture()
    const bare = await Effect.runPromise(MultiSig.combine(f.ours, [f.zkSignature]).pipe(Effect.flip))
    expect(bare.reason).toContain("must name its member")
    const wrong = await Effect.runPromise(
      MultiSig.combine(f.ours, [{ signature: f.zkSignature, publicKey: f.ours.members[0]!.publicKey }]).pipe(Effect.flip)
    )
    expect(wrong._tag).toBe("InvalidMultiSig")
  })

  test("verify hands verifyMember the full 0x05 || body", async () => {
    const f = await zkFixture()
    const seen: Array<Uint8Array> = []
    const zkStub: SignatureScheme.SignatureScheme = {
      name: "ZkLogin",
      flag: 0x05,
      verify: () => Effect.die("unused"),
      verifyMember: (_pk, signature) => Effect.sync(() => void seen.push(signature))
    }
    await Effect.runPromise(
      Verify.personalMessage(msg, f.reference).pipe(Effect.provide(SignatureScheme.SignatureSchemes.layer(Ed25519.scheme, zkStub, MultiSig.scheme)))
    )
    expect(b64(seen[0]!)).toBe(b64(f.zkSignature))
  })
})

describe("verify validates the multisig public key like validators (review 13)", () => {
  const all = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme, MultiSig.scheme)
  const raw = (pkMap: ReadonlyArray<{ pubKey: Uint8Array; weight: number }>, threshold: number, sigs: ReadonlyArray<Uint8Array>, bitmap: number) => {
    const body = Bcs.encodeSync(MultiSig.MultiSigBcs)({
      sigs: sigs.map((value) => ({ _tag: "ED25519", value }) as any),
      bitmap,
      multisigPk: { pkMap: pkMap.map((m) => ({ pubKey: { _tag: "ED25519", value: m.pubKey } as any, weight: m.weight })), threshold }
    })
    return Uint8Array.from([MultiSig.FLAG, ...body])
  }
  const key = (n: number) => Ed25519.fromSecretKey(seed(n)).pipe(Effect.runSync)
  const sign = (n: number) =>
    Effect.runSync(key(n).sign(Hash.personalMessageIntent(msg))).subarray(1, 65)
  const verdict = (sig: Uint8Array) => Effect.runPromise(Verify.personalMessage(msg, sig).pipe(Effect.flip, Effect.provide(all)))

  test("threshold 0 with no signatures is rejected", async () => {
    expect((await verdict(raw([{ pubKey: key(1).publicKey.bytes, weight: 1 }], 0, [], 0)))._tag).toBe("InvalidSignature")
  })

  test("zero weight, duplicate members and more than 10 members are rejected", async () => {
    const k1 = key(1).publicKey.bytes
    const zeroWeight = raw([{ pubKey: k1, weight: 1 }, { pubKey: key(2).publicKey.bytes, weight: 0 }], 1, [sign(1)], 1)
    const duplicate = raw([{ pubKey: k1, weight: 1 }, { pubKey: k1, weight: 1 }], 1, [sign(1)], 1)
    const eleven = raw(Array.from({ length: 11 }, (_, i) => ({ pubKey: key(i + 1).publicKey.bytes, weight: 1 })), 1, [sign(1)], 1)
    for (const sig of [zeroWeight, duplicate, eleven]) {
      const e = await verdict(sig)
      expect(e._tag).toBe("InvalidSignature")
      expect(e._tag === "InvalidSignature" && e.reason).toContain("invalid multisig public key")
    }
  })

  test("a valid 1-of-2 still verifies", async () => {
    const sig = raw([{ pubKey: key(1).publicKey.bytes, weight: 1 }, { pubKey: key(2).publicKey.bytes, weight: 1 }], 1, [sign(1)], 1)
    const v = await Effect.runPromise(Verify.personalMessage(msg, sig).pipe(Effect.provide(all)))
    expect(v.publicKey.flag).toBe(MultiSig.FLAG)
  })
})
