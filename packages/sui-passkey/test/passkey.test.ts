import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { BrowserPasskeyProvider, findCommonPublicKey, PasskeyKeypair, PasskeyPublicKey } from "@mysten/sui/keypairs/passkey"
import type { PasskeyProvider as MystenProvider } from "@mysten/sui/keypairs/passkey"
import { verifyPersonalMessageSignature, verifyTransactionSignature } from "@mysten/sui/verify"
import { Bcs } from "@unconfirmed/bcs"
import { Ed25519, Hash, SignatureScheme, Signer, Verify } from "@unconfirmed/sui"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Passkey from "../src/index.ts"

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"))
const utf8 = (s: string) => new TextEncoder().encode(s)
const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e)
const secret = new Uint8Array(32).map((_, i) => i + 1)
const credentialId = new Uint8Array(16).fill(9)
const msg = utf8("hello passkey")
const txBytes = new Uint8Array(120).map((_, i) => (i * 7) % 256)

const schemes = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme, Passkey.scheme)
const verifyOurs = <A, E>(e: Effect.Effect<A, E, SignatureScheme.SignatureSchemes>) => run(Effect.provide(e, schemes))

/** Our provider behind @mysten/sui's `PasskeyProvider` interface: both SDKs drive the same authenticator. */
const asMysten = (p: Passkey.Provider): MystenProvider => ({
  create: async () => {
    const c = await run(p.create())
    return { rawId: c.id, response: { getPublicKey: () => c.publicKey } } as any
  },
  get: async (challenge, id) => {
    const a = await run(p.get(challenge, id))
    return {
      rawId: a.credentialId,
      response: { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature }
    } as any
  }
})

const setup = async () => {
  const provider = await run(Passkey.softwareProvider({ secretKey: secret, credentialId }))
  const ours = await run(Passkey.create(provider))
  const theirs = await PasskeyKeypair.getPasskeyInstance(asMysten(provider))
  return { provider, ours, theirs }
}

const mystenAcceptsMessage = (message: Uint8Array, sig: Uint8Array) =>
  verifyPersonalMessageSignature(message, b64(sig), { offline: true }).then(() => true, () => false)

const ourError = (message: Uint8Array, sig: Uint8Array) =>
  verifyOurs(Effect.flip(Verify.personalMessage(message, sig)))

/** Sign arbitrary authenticator output with the software key: validly signed, semantically whatever we like. */
const forge = (sk: Uint8Array, pk: Uint8Array, authenticatorData: Uint8Array, clientDataJson: string) => {
  const sig = p256.sign(new Uint8Array([...authenticatorData, ...sha256(utf8(clientDataJson))]), sk) // low-S compact
  const body = Bcs.encodeSync(Passkey.PasskeyAuthenticatorBcs)({
    authenticatorData,
    clientDataJson,
    userSignature: new Uint8Array([0x02, ...sig, ...pk])
  })
  return new Uint8Array([Passkey.FLAG, ...body])
}

const decode = (sig: Uint8Array) => Bcs.decodeSync(Passkey.PasskeyAuthenticatorBcs)(sig.subarray(1))
const reencode = (fields: typeof Passkey.PasskeyAuthenticatorBcs.Type) =>
  new Uint8Array([Passkey.FLAG, ...Bcs.encodeSync(Passkey.PasskeyAuthenticatorBcs)(fields)])

describe("Passkey parity with @mysten/sui", () => {
  test("same public key, address and credential id", async () => {
    const { provider, ours, theirs } = await setup()
    expect(ours.publicKey.bytes).toEqual(theirs.getPublicKey().toRawBytes())
    expect(ours.publicKey.bytes).toEqual(provider.publicKey)
    expect(ours.address).toBe(theirs.toSuiAddress() as typeof ours.address)
    expect(ours.address).toBe(new PasskeyPublicKey(provider.publicKey).toSuiAddress() as typeof ours.address)
    expect(ours.credentialId).toEqual(theirs.getCredentialId()!)
  })

  test("personal message: identical bytes, each verifies the other's", async () => {
    const { ours, theirs } = await setup()
    const mine = await run(Signer.signPersonalMessage(ours, msg))
    const ref = await theirs.signPersonalMessage(msg)
    expect(b64(mine.signature)).toBe(ref.signature)
    expect((await verifyPersonalMessageSignature(msg, b64(mine.signature), { offline: true })).toSuiAddress()).toBe(ours.address)
    const v = await verifyOurs(Verify.personalMessage(msg, fromB64(ref.signature), { address: ours.address }))
    expect(v.publicKey).toEqual({ flag: Passkey.FLAG, bytes: ours.publicKey.bytes })
  })

  test("transaction: identical bytes, each verifies the other's", async () => {
    const { ours, theirs } = await setup()
    const mine = await run(Signer.signTransaction(ours, txBytes))
    const ref = await theirs.signTransaction(txBytes)
    expect(b64(mine.signature)).toBe(ref.signature)
    expect((await verifyTransactionSignature(txBytes, b64(mine.signature), { offline: true })).toSuiAddress()).toBe(ours.address)
    await verifyOurs(Verify.transaction(txBytes, fromB64(ref.signature), { address: ours.address }))
  })

  test("high-S assertions are normalized like @mysten/sui (which verifies low-S only)", async () => {
    const { provider, ours, theirs } = await setup()
    let highS = 0
    for (let i = 0; i < 12; i++) {
      const m = utf8(`message ${i}`)
      const raw = await run(provider.get(Hash.blake2b256(Hash.personalMessageIntent(m))))
      if (p256.Signature.fromBytes(raw.signature, "der").hasHighS()) highS++
      const mine = await run(Signer.signPersonalMessage(ours, m))
      expect(b64(mine.signature)).toBe((await theirs.signPersonalMessage(m)).signature)
      expect(await mystenAcceptsMessage(m, mine.signature)).toBe(true)
    }
    expect(highS).toBeGreaterThan(0)
  })

  test("recovery finds the same public key as Mysten's signAndRecover + findCommonPublicKey", async () => {
    const { provider, ours } = await setup()
    const [m1, m2] = [utf8("recover 1"), utf8("recover 2")]
    const t1 = await PasskeyKeypair.signAndRecover(asMysten(provider), m1)
    const t2 = await PasskeyKeypair.signAndRecover(asMysten(provider), m2)
    const o1 = await run(Passkey.recoverPublicKeys(provider, m1))
    const o2 = await run(Passkey.recoverPublicKeys(provider, m2))
    expect(o1.publicKeys).toEqual(t1.map((k) => k.toRawBytes()))
    expect(o2.publicKeys).toEqual(t2.map((k) => k.toRawBytes()))
    expect(o1.credentialId).toEqual(credentialId)
    const common = await run(Passkey.findCommonPublicKey(o1.publicKeys, o2.publicKeys))
    expect(common).toEqual(findCommonPublicKey(t1, t2).toRawBytes())
    expect(common).toEqual(ours.publicKey.bytes)

    const recovered = await run(Passkey.recover(provider))
    expect(recovered.address).toBe(ours.address)
    expect(recovered.credentialId).toEqual(credentialId)
    const sig = await run(Signer.signPersonalMessage(recovered, msg))
    expect(await mystenAcceptsMessage(msg, sig.signature)).toBe(true)
  })
})

describe("Passkey recovery errors", () => {
  test("no common key, or several, is NoUniquePublicKey", async () => {
    const a = [new Uint8Array(33).fill(1), new Uint8Array(33).fill(2)]
    const none = await run(Effect.flip(Passkey.findCommonPublicKey(a, [new Uint8Array(33).fill(3)])))
    expect(none).toMatchObject({ _tag: "NoUniquePublicKey", matches: 0 })
    const two = await run(Effect.flip(Passkey.findCommonPublicKey(a, a)))
    expect(two.matches).toBe(2)
  })

  test("two different passkeys answering the two prompts is NoUniquePublicKey", async () => {
    const [p1, p2] = await Promise.all([run(Passkey.softwareProvider()), run(Passkey.softwareProvider())])
    let n = 0
    const alternating: Passkey.Provider = { create: p1.create, get: (c) => (n++ % 2 === 0 ? p1 : p2).get(c) }
    const err = await run(Effect.flip(Passkey.recover(alternating)))
    expect(err._tag).toBe("NoUniquePublicKey")
  })

  test("a malformed assertion signature is a SigningError", async () => {
    const p = await run(Passkey.softwareProvider())
    const broken: Passkey.Provider = { ...p, get: (c, id) => Effect.map(p.get(c, id), (a) => ({ ...a, signature: new Uint8Array(8) })) }
    const err = await run(Effect.flip(Passkey.recoverPublicKeys(broken, msg)))
    expect(err).toMatchObject({ _tag: "SigningError", reason: "failed" })
  })
})

describe("Passkey verification rejects tampering", () => {
  test("a UTF-8 BOM before clientDataJSON (re-encoding a valid signature) is refused", async () => {
    const { ours } = await setup()
    const { signature } = await run(Signer.signPersonalMessage(ours, msg))
    const fields = decode(signature)
    const bom = reencode({ ...fields, clientDataJson: "\uFEFF" + fields.clientDataJson })
    expect(bom).not.toEqual(signature)
    expect((await ourError(msg, bom))._tag).toBe("InvalidSignature")
  })

  test("a non-canonical ULEB128 length (re-encoding a valid signature) is refused", async () => {
    const { ours } = await setup()
    const { signature } = await run(Signer.signPersonalMessage(ours, msg))
    // authenticatorData's length is the first byte after the flag (< 128): spell it `len|0x80, 0x00`.
    const len = signature[1]!
    expect(len).toBeLessThan(0x80)
    const padded = new Uint8Array([signature[0]!, len | 0x80, 0x00, ...signature.subarray(2)])
    expect((await ourError(msg, padded))._tag).toBe("InvalidSignature")
  })

  test("a signed clientDataJSON whose crossOrigin isn't a boolean is refused", async () => {
    const { ours } = await setup()
    const { signature } = await run(Signer.signPersonalMessage(ours, msg))
    const fields = decode(signature)
    const data = { ...JSON.parse(fields.clientDataJson), crossOrigin: "yes" }
    const forged = forge(secret, ours.publicKey.bytes, fields.authenticatorData, JSON.stringify(data))
    expect(((await ourError(msg, forged)) as SignatureScheme.InvalidSignature).reason).toContain("crossOrigin")
  })

  test("a signature over another message (challenge mismatch)", async () => {
    const { ours } = await setup()
    const { signature } = await run(Signer.signPersonalMessage(ours, utf8("other")))
    expect(await mystenAcceptsMessage(msg, signature)).toBe(false)
    const err = await ourError(msg, signature)
    expect(err).toMatchObject({ _tag: "InvalidSignature", scheme: "Passkey" })
    expect((err as SignatureScheme.InvalidSignature).reason).toContain("challenge")
  })

  test("clientDataJSON edited after signing (challenge swapped, origin changed)", async () => {
    const { ours } = await setup()
    const { signature } = await run(Signer.signPersonalMessage(ours, utf8("other")))
    const fields = decode(signature)
    const swapped = JSON.parse(fields.clientDataJson)
    swapped.challenge = Buffer.from(Hash.blake2b256(Hash.personalMessageIntent(msg))).toString("base64url")
    const challengeSwapped = reencode({ ...fields, clientDataJson: JSON.stringify(swapped) })
    expect(await mystenAcceptsMessage(msg, challengeSwapped)).toBe(false)
    expect((await ourError(msg, challengeSwapped) as SignatureScheme.InvalidSignature).reason).toBe("signature does not verify")

    const good = (await run(Signer.signPersonalMessage(ours, msg))).signature
    const g = decode(good)
    const origin = reencode({ ...g, clientDataJson: g.clientDataJson.replace("https://localhost", "https://evil.example") })
    expect(await mystenAcceptsMessage(msg, origin)).toBe(false)
    expect((await ourError(msg, origin) as SignatureScheme.InvalidSignature).reason).toBe("signature does not verify")
  })

  test("authenticatorData edited after signing", async () => {
    const { ours } = await setup()
    const good = (await run(Signer.signPersonalMessage(ours, msg))).signature
    const fields = decode(good)
    const authenticatorData = fields.authenticatorData.slice()
    authenticatorData[32] = authenticatorData[32]! ^ 0x04 // clear UV
    const tampered = reencode({ ...fields, authenticatorData })
    expect(await mystenAcceptsMessage(msg, tampered)).toBe(false)
    expect((await ourError(msg, tampered) as SignatureScheme.InvalidSignature).reason).toBe("signature does not verify")
  })

  test("validly signed but wrong clientDataJSON: type, challenge encoding, missing fields", async () => {
    const { provider, ours } = await setup()
    const good = decode((await run(Signer.signPersonalMessage(ours, msg))).signature)
    const digest = Hash.blake2b256(Hash.personalMessageIntent(msg))
    const cd = (o: object) => forge(provider.secretKey, provider.publicKey, good.authenticatorData, JSON.stringify(o))
    const challenge = Buffer.from(digest).toString("base64url")

    // Sanity: the forger itself produces accepted signatures.
    const ok = cd({ type: "webauthn.get", challenge, origin: "https://localhost" })
    expect(await mystenAcceptsMessage(msg, ok)).toBe(true)
    await verifyOurs(Verify.personalMessage(msg, ok, { address: ours.address }))

    const cases: Array<[string, Uint8Array, boolean]> = [
      // [why, signature, does @mysten/sui also reject it?]
      ["webauthn.create", cd({ type: "webauthn.create", challenge, origin: "https://localhost" }), true],
      ["challenge of other bytes", cd({ type: "webauthn.get", challenge: Buffer.from(sha256(digest)).toString("base64url"), origin: "x" }), true],
      // Sui decodes the challenge as unpadded base64url and parses CollectedClientData (origin required); Mysten is laxer.
      ["padded base64", cd({ type: "webauthn.get", challenge: Buffer.from(digest).toString("base64"), origin: "x" }), false],
      ["no origin", cd({ type: "webauthn.get", challenge }), false],
      ["not JSON", forge(provider.secretKey, provider.publicKey, good.authenticatorData, "{oops"), true],
      // serde_json refuses what JSON.parse takes: a number out of f64 range, and nesting at its recursion limit (128).
      ["number out of range", forge(provider.secretKey, provider.publicKey, good.authenticatorData, `{"type":"webauthn.get","challenge":"${challenge}","origin":"x","extra":1e999}`), false],
      ["nested 128 deep", forge(provider.secretKey, provider.publicKey, good.authenticatorData, `{"type":"webauthn.get","challenge":"${challenge}","origin":"x","extra":${"[".repeat(127)}${"]".repeat(127)}}`), false]
    ]
    for (const [why, sig, mystenRejects] of cases) {
      const err = await ourError(msg, sig)
      expect(err._tag, why).toBe("InvalidSignature")
      if (mystenRejects) expect(await mystenAcceptsMessage(msg, sig), why).toBe(false)
    }
    // Just under the limit still verifies.
    const deep = forge(provider.secretKey, provider.publicKey, good.authenticatorData, `{"type":"webauthn.get","challenge":"${challenge}","origin":"x","extra":${"[".repeat(126)}${"]".repeat(126)},"n":1e308}`)
    await verifyOurs(Verify.personalMessage(msg, deep, { address: ours.address }))
  })

  test("malformed bodies are InvalidSignature, never a defect", async () => {
    const { ours } = await setup()
    const good = (await run(Signer.signPersonalMessage(ours, msg))).signature
    const f = decode(good)
    const wrongFlag = f.userSignature.slice()
    wrongFlag[0] = 0x00
    const highS = (() => {
      const sig = p256.Signature.fromBytes(f.userSignature.subarray(1, 65), "compact")
      const flipped = new p256.Signature(sig.r, p256.Point.Fn.neg(sig.s)).toBytes("compact")
      return new Uint8Array([0x02, ...flipped, ...f.userSignature.subarray(65)])
    })()
    const badPoint = new Uint8Array([...f.userSignature.subarray(0, 65), 0x05, ...new Uint8Array(32)])
    const cases: Array<[string, Uint8Array, boolean]> = [
      // [why, signature, does @mysten/sui also reject it?]
      ["empty body", new Uint8Array([Passkey.FLAG]), true],
      // Validators' BCS refuses trailing bytes; @mysten/bcs ignores them.
      ["trailing bytes", new Uint8Array([...good, 0]), false],
      ["short userSignature", reencode({ ...f, userSignature: f.userSignature.subarray(0, 97) }), true],
      // Sui requires the inner signature to be Secp256r1; Mysten doesn't look at its flag.
      ["not secp256r1", reencode({ ...f, userSignature: wrongFlag }), false],
      ["high-S", reencode({ ...f, userSignature: highS }), true],
      ["invalid point", reencode({ ...f, userSignature: badPoint }), true]
    ]
    for (const [why, sig, mystenRejects] of cases) {
      const err = await ourError(msg, sig)
      expect(err._tag, why).toBe("InvalidSignature")
      if (mystenRejects) expect(await mystenAcceptsMessage(msg, sig), why).toBe(false)
    }
  })

  test("verifies only when installed, and checks the address", async () => {
    const { ours } = await setup()
    const { signature } = await run(Signer.signPersonalMessage(ours, msg))
    const missing = await run(Effect.flip(Effect.provide(Verify.personalMessage(msg, signature), SignatureScheme.SignatureSchemes.layer(Ed25519.scheme))))
    expect(missing._tag).toBe("UnsupportedScheme")
    const other = await run(Ed25519.generate)
    const wrong = await verifyOurs(Effect.flip(Verify.personalMessage(msg, signature, { address: other.address })))
    expect(wrong._tag).toBe("InvalidSignature")
  })
})

describe("Passkey signer", () => {
  test("refuses to return a signature made by a different passkey", async () => {
    const { ours } = await setup()
    const other = await run(Passkey.softwareProvider())
    const impostor = await run(Passkey.fromPublicKey(other, ours.publicKey.bytes))
    const err = await run(Effect.flip(Signer.signPersonalMessage(impostor, msg)))
    expect(err).toMatchObject({ _tag: "SigningError", reason: "failed" })
  })

  test("passes the credential id to the authenticator", async () => {
    const { provider, ours } = await setup()
    const elsewhere = await run(Passkey.fromPublicKey(provider, ours.publicKey.bytes, { credentialId: new Uint8Array(16) }))
    const err = await run(Effect.flip(Signer.signPersonalMessage(elsewhere, msg)))
    expect(err.message).toContain("credential id")
  })

  test("invalid keys and SPKI are InvalidKey", async () => {
    const p = await run(Passkey.softwareProvider())
    for (const pk of [new Uint8Array(32), new Uint8Array(33).fill(5)]) {
      expect((await run(Effect.flip(Passkey.fromPublicKey(p, pk))))._tag).toBe("InvalidKey")
    }
    const spki = await run(Passkey.spkiFromPublicKey(p.publicKey))
    for (const pk of [new Uint8Array(33), new Uint8Array(32), new Uint8Array(33).fill(5)]) {
      expect((await run(Effect.flip(Passkey.spkiFromPublicKey(pk))))._tag).toBe("InvalidKey")
    }
    expect(await run(Passkey.publicKeyFromSpki(spki))).toEqual(p.publicKey)
    const otherCurve = spki.slice()
    otherCurve[20] = otherCurve[20]! ^ 1
    for (const der of [spki.subarray(1), otherCurve]) {
      expect((await run(Effect.flip(Passkey.publicKeyFromSpki(der))))._tag).toBe("InvalidKey")
    }
    const bad: Passkey.Provider = { ...p, create: () => Effect.succeed({ id: new Uint8Array(1), publicKey: otherCurve }) }
    expect((await run(Effect.flip(Passkey.create(bad))))._tag).toBe("InvalidKey")
  })
})

describe("BrowserProvider", () => {
  const nav = globalThis.navigator as any
  const hadPkc = "PublicKeyCredential" in globalThis
  afterEach(() => {
    delete nav.credentials
    if (!hadPkc) delete (globalThis as any).PublicKeyCredential
  })

  /** A fake `navigator.credentials` backed by a software authenticator, recording the options it's called with. */
  const install = (soft: Passkey.SoftwareProvider, fail?: () => Error) => {
    const calls: Array<{ kind: "create" | "get"; options: any }> = []
    ;(globalThis as any).PublicKeyCredential ??= class {}
    Object.defineProperty(nav, "credentials", {
      configurable: true,
      value: {
        create: async (options: any) => {
          calls.push({ kind: "create", options })
          if (fail) throw fail()
          const c = await run(soft.create())
          return { rawId: c.id.buffer, response: { getPublicKey: () => c.publicKey.buffer } }
        },
        get: async (options: any) => {
          calls.push({ kind: "get", options })
          if (fail) throw fail()
          const id = options.publicKey.allowCredentials?.[0]?.id
          const a = await run(soft.get(new Uint8Array(options.publicKey.challenge), id && new Uint8Array(id)))
          return {
            rawId: a.credentialId.buffer,
            response: { authenticatorData: a.authenticatorData.buffer, clientDataJSON: a.clientDataJSON.buffer, signature: a.signature.buffer }
          }
        }
      }
    })
    return calls
  }

  test("no WebAuthn is 'unavailable'", async () => {
    const provider = Passkey.browserProvider("Test")
    expect(await run(Effect.flip(provider.create()))).toMatchObject({ _tag: "SigningError", reason: "unavailable" })
    expect(await run(Effect.flip(provider.get(new Uint8Array(32))))).toMatchObject({ reason: "unavailable" })
  })

  test("a cancelled prompt is 'rejected'", async () => {
    install(await run(Passkey.softwareProvider()), () => new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"))
    const err = await run(Effect.flip(Passkey.create(Passkey.browserProvider("Test"))))
    expect(err).toMatchObject({ _tag: "SigningError", reason: "rejected" })
  })

  test("same WebAuthn options as Mysten's BrowserPasskeyProvider; signs end to end", async () => {
    const soft = await run(Passkey.softwareProvider({ secretKey: secret, credentialId }))
    const options = { rp: { name: "Example" }, user: { name: "alice" }, timeout: 30_000 }
    const ourCalls = install(soft)
    const ours = await run(Passkey.create(Passkey.browserProvider("Sui Test", options)))
    const { signature } = await run(Signer.signPersonalMessage(ours, msg))
    const theirCalls = install(soft)
    const theirs = await PasskeyKeypair.getPasskeyInstance(new BrowserPasskeyProvider("Sui Test", options))
    const ref = await theirs.signPersonalMessage(msg)

    expect(b64(signature)).toBe(ref.signature)
    expect(ourCalls.map((c) => c.kind)).toEqual(["create", "get"])
    const strip = (o: any) => {
      const { signal: _s, ...rest } = o
      return { ...rest, publicKey: { ...rest.publicKey, ...(rest.publicKey.user && { user: { ...rest.publicKey.user, id: "<random>" } }) } }
    }
    for (const i of [0, 1]) {
      expect(ourCalls[i]!.options.signal).toBeInstanceOf(AbortSignal)
      expect(strip(ourCalls[i]!.options)).toEqual(strip(theirCalls[i]!.options))
    }
    expect(ourCalls[0]!.options.publicKey.user.id.length).toBe(10)
    expect(ourCalls[0]!.options.publicKey.pubKeyCredParams).toEqual([{ alg: -7, type: "public-key" }])
  })

  test("one prompt at a time: concurrent requests through one provider are serialised", async () => {
    const soft = await run(Passkey.softwareProvider())
    let pending = 0
    let maxPending = 0
    ;(globalThis as any).PublicKeyCredential ??= class {}
    Object.defineProperty(nav, "credentials", {
      configurable: true,
      value: {
        get: async (options: any) => {
          pending++
          maxPending = Math.max(maxPending, pending)
          try {
            // WebAuthn refuses a second pending request.
            if (pending > 1) throw new DOMException("A request is already pending.", "NotAllowedError")
            await new Promise((r) => setTimeout(r, 5))
            const a = await run(soft.get(new Uint8Array(options.publicKey.challenge)))
            return {
              rawId: a.credentialId.buffer,
              response: { authenticatorData: a.authenticatorData.buffer, clientDataJSON: a.clientDataJSON.buffer, signature: a.signature.buffer }
            }
          } finally {
            pending--
          }
        }
      }
    })
    const provider = Passkey.browserProvider("Test")
    await run(Effect.all([provider.get(new Uint8Array(32)), provider.get(new Uint8Array(32).fill(1))], { concurrency: "unbounded" }))
    expect(maxPending).toBe(1)
  })

  test("an explicit rp id is passed on assertions", async () => {
    const calls = install(await run(Passkey.softwareProvider()))
    await run(Passkey.browserProvider("Test", { rp: { id: "example.com" } }).get(new Uint8Array(32)))
    expect(calls[0]!.options.publicKey.rpId).toBe("example.com")
  })
})
