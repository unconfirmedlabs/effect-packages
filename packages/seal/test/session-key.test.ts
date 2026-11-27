import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { ed25519 } from "@noble/curves/ed25519.js"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as PrivateKey from "@unconfirmed/sui/PrivateKey"
import * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Signer from "@unconfirmed/sui/Signer"
import * as T from "@unconfirmed/sui/TransactionData"
import * as Verify from "@unconfirmed/sui/Verify"
import { Wallet } from "@unconfirmed/sui-wallet"
import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { fakeWallet } from "../../sui-wallet/test/FakeWallet.ts"
import { Entropy, SessionKey } from "../src/index.ts"
import { b64, hex, seeded, toB64, unhex, utf8 } from "./support.ts"

const PKG = "0x" + "ab".repeat(32)
const OTHER_PKG = "0x" + "cd".repeat(32)
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0, 0)
const SEED = new Uint8Array(32).fill(7)
const keySigner = Effect.runSync(Ed25519.fromSecretKey(SEED))
const schemes = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme)

/** Run under a TestClock set to T0 with a seeded Entropy. */
const run = <A, E>(eff: Effect.Effect<A, E, never>, seed = "session") =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(T0), eff).pipe(
      Effect.provideService(Entropy.Entropy, seeded(seed)),
      Effect.provide(TestClock.layer())
    )
  )
const runExit = <A, E>(eff: Effect.Effect<A, E, never>) => run(Effect.exit(eff))

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  const f = Cause.findErrorOption(exit.cause)
  if (Option.isNone(f)) throw new Error(`expected a typed failure, got ${Cause.pretty(exit.cause)}`)
  return f.value
}

/** A personal-message signer that counts prompts, waits `delay` (virtual time), and can fail. */
const counting = (o: { delay?: Duration.Input; fail?: (n: number) => { _tag: string; message?: string } | undefined } = {}) => {
  let prompts = 0
  const signer: SessionKey.PersonalMessageSigner = {
    address: keySigner.address,
    signPersonalMessage: (message) =>
      Effect.gen(function*() {
        const n = ++prompts
        if (o.delay) yield* Effect.sleep(o.delay)
        const e = o.fail?.(n)
        if (e) return yield* Effect.fail(e)
        return yield* Signer.signPersonalMessage(keySigner, message)
      })
  }
  return { signer, prompts: () => prompts }
}

describe("personal message (R1)", () => {
  // crates/seal-sdk/src/lib.rs test_signed_message_regression / _mvr_regression
  const vk = b64("DX2rNYyNrapO+gBJp1sHQ2VVsQo2ghm7aA9wVxNJ13U=")
  test("Rust vector, hex package id", () => {
    const m = SessionKey.personalMessage({
      packageName: "0x0000c457b42d48924087ea3f22d35fd2fe9afdf5bdfe38cc51c0f14f3282f6d5",
      ttlMin: 30,
      creationTime: 1622548800,
      sessionVk: vk
    })
    expect(new TextDecoder().decode(m)).toBe(
      "Accessing keys of package 0x0000c457b42d48924087ea3f22d35fd2fe9afdf5bdfe38cc51c0f14f3282f6d5 for 30 mins from 1970-01-19 18:42:28 UTC, session key DX2rNYyNrapO+gBJp1sHQ2VVsQo2ghm7aA9wVxNJ13U="
    )
  })
  test("Rust vector, MVR name", () => {
    const m = SessionKey.personalMessage({ packageName: "@my/package", ttlMin: 30, creationTime: 1622548800, sessionVk: vk })
    expect(new TextDecoder().decode(m)).toBe(
      "Accessing keys of package @my/package for 30 mins from 1970-01-19 18:42:28 UTC, session key DX2rNYyNrapO+gBJp1sHQ2VVsQo2ghm7aA9wVxNJ13U="
    )
  })
  test("a session's message uses its MVR name, else its canonical package id, and its creation time", async () => {
    const s = await run(SessionKey.make({ packageId: PKG.toUpperCase().replace("0X", "0x"), signer: keySigner, clockSkew: 0 }))
    expect(s.packageId).toBe(PKG as Address.Address)
    expect(new TextDecoder().decode(s.personalMessage)).toBe(
      `Accessing keys of package ${PKG} for 10 mins from 2026-11-27 12:00:00 UTC, session key ${toB64(s.publicKey)}`
    )
    const m = await run(SessionKey.make({ packageId: PKG, signer: keySigner, mvrName: "@my/package", clockSkew: 0 }))
    expect(new TextDecoder().decode(m.personalMessage)).toContain("package @my/package for 10 mins")
  })
})

describe("request signature (R4)", () => {
  // crates/seal-sdk/src/lib.rs test_signed_request_regression
  const expected = unhex(
    "38000100d92bc457b42d48924087ea3f22d35fd2fe9afdf5bdfe38cc51c0f14f3282f6d503626c610e7365616c5f617070726f76655f7800003085946cd4134ecb8f7739bbd3522d1c8fab793c6c431a8b0b77b4f1885d4c096aafab755e7b8bce8688410cee9908fb29608faaf686c0dcbe3f65f1130e8be538d7ea009347d397f517188dfa14417618887a0412e404fff56efbafb63d1fc4970a1187b4ccb6e767a91822312e533fa53dee69f77ef5130be095e147ff3d40e96e8ddc4bf554dae3bcc34048fe9330cccf"
  )
  const ptb = Bcs.encodeSync(T.ProgrammableTransaction)({
    inputs: [],
    commands: [{
      _tag: "MoveCall",
      package: Address.normalize("0xd92bc457b42d48924087ea3f22d35fd2fe9afdf5bdfe38cc51c0f14f3282f6d5"),
      module: "bla",
      function: "seal_approve_x",
      typeArguments: [],
      arguments: []
    }]
  })
  // The ElGamal keys come from Rust's StdRng; take them from the vector: ptb (1 + 56), enc_key (1 + 48), enc_vk (1 + 96).
  const encKey = expected.slice(58, 106)
  const encVk = expected.slice(107)

  test("Rust vector", () => {
    expect(encVk.length).toBe(96)
    expect(hex(SessionKey.requestMessage(ptb, encKey, encVk))).toBe(hex(expected))
  })

  test("signRequest: raw Ed25519 over those bytes with the session key", async () => {
    const s = await run(SessionKey.make({ packageId: PKG, signer: keySigner }))
    const sig = await run(SessionKey.signRequest(s, ptb, encKey, encVk))
    expect(sig.length).toBe(64)
    expect(ed25519.verify(sig, expected, s.publicKey)).toBe(true)
  })
})

describe("SessionKey.make", () => {
  test("package id: validated and normalised strictly (item 14)", async () => {
    const upper = await run(SessionKey.make({ packageId: "0x" + "AB".repeat(32), signer: keySigner }))
    expect(upper.packageId).toBe(PKG as Address.Address)
    for (const bad of ["ab".repeat(32), "0x2", "0x" + "ab".repeat(31), "0x" + "zz".repeat(32), "0x" + "ab".repeat(33)]) {
      const e = failure(await runExit(SessionKey.make({ packageId: bad, signer: keySigner })))
      expect(e._tag).toBe("InvalidSessionKey")
    }
  })

  test("address: the signer's by default, or given; one of the two is required", async () => {
    const a = await run(SessionKey.make({ packageId: PKG, signer: keySigner }))
    expect(a.address).toBe(keySigner.address)
    const alias = "0x" + "11".repeat(32)
    expect((await run(SessionKey.make({ packageId: PKG, signer: keySigner, address: alias }))).address).toBe(alias as Address.Address)
    expect((await run(SessionKey.make({ packageId: PKG, address: alias }))).address).toBe(alias as Address.Address)
    expect(failure(await runExit(SessionKey.make({ packageId: PKG })))._tag).toBe("InvalidSessionKey")
  })

  test("TTL: whole minutes from 1 to 30, default 10", async () => {
    expect((await run(SessionKey.make({ packageId: PKG, signer: keySigner }))).ttlMinutes).toBe(10)
    for (const ttl of ["1 minute", "30 minutes"] as const) {
      const s = await run(SessionKey.make({ packageId: PKG, signer: keySigner, ttl, clockSkew: 0 }))
      expect(s.expiresAt - s.createdAt).toBe(s.ttlMinutes * 60_000)
    }
    for (const ttl of ["0 minutes", "31 minutes", "90 seconds", "1 second"] as const) {
      expect(failure(await runExit(SessionKey.make({ packageId: PKG, signer: keySigner, ttl })))._tag).toBe("InvalidSessionKey")
    }
  })

  test("clockSkew: the certificate is dated 10 s back by default, 0 on request", async () => {
    expect((await run(SessionKey.make({ packageId: PKG, signer: keySigner }))).createdAt).toBe(T0 - 10_000)
    expect((await run(SessionKey.make({ packageId: PKG, signer: keySigner, clockSkew: 0 }))).createdAt).toBe(T0)
    expect((await run(SessionKey.make({ packageId: PKG, signer: keySigner, clockSkew: "1 minute" }))).createdAt).toBe(T0 - 60_000)
    expect(failure(await runExit(SessionKey.make({ packageId: PKG, signer: keySigner, clockSkew: "-1 second" })))._tag)
      .toBe("InvalidSessionKey")
  })

  test("the session key comes from Entropy", async () => {
    const a = await run(SessionKey.make({ packageId: PKG, signer: keySigner }), "x")
    const b = await run(SessionKey.make({ packageId: PKG, signer: keySigner }), "x")
    const c = await run(SessionKey.make({ packageId: PKG, signer: keySigner }), "y")
    expect(a.publicKey).toEqual(b.publicKey)
    expect(a.publicKey).not.toEqual(c.publicKey)
    expect(a.publicKey).toEqual(ed25519.getPublicKey(seeded("x")(32)))
  })

  test("the secret is not reachable from the value", async () => {
    const s = await run(SessionKey.make({ packageId: PKG, signer: keySigner }), "x")
    const secret = hex(seeded("x")(32))
    expect(JSON.stringify(s)).not.toContain(secret)
    expect(Object.values(s).some((v) => v instanceof Uint8Array && hex(v) === secret)).toBe(false)
  })
})

describe("expiry (TestClock)", () => {
  test("isExpired from 10 s before expiresAt; certificate and signRequest then fail", async () => {
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: keySigner, ttl: "1 minute", clockSkew: 0 })
      yield* TestClock.adjust("49999 millis")
      const before = yield* s.isExpired
      const cert = yield* Effect.exit(s.certificate)
      yield* TestClock.adjust("1 millis")
      const after = yield* s.isExpired
      const certAfter = yield* Effect.exit(s.certificate)
      const req = yield* Effect.exit(SessionKey.signRequest(s, new Uint8Array(1), new Uint8Array(48), new Uint8Array(96)))
      return { s, before, cert, after, certAfter, req }
    }))
    expect(r.before).toBe(false)
    expect(Exit.isSuccess(r.cert)).toBe(true)
    expect(r.after).toBe(true)
    const e = failure(r.certAfter)
    expect(e).toMatchObject({ _tag: "SessionKeyExpired", expiresAt: T0 + 60_000, now: T0 + 50_000 })
    expect(failure(r.req)._tag).toBe("SessionKeyExpired")
  })

  test("with the default skew the session is usable for ttl − 20 s", async () => {
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: keySigner, ttl: "1 minute" })
      yield* TestClock.adjust("39999 millis")
      const a = yield* s.isExpired
      yield* TestClock.adjust("1 millis")
      return [a, yield* s.isExpired]
    }))
    expect(r).toEqual([false, true])
  })
})

describe("certificate", () => {
  test("ten concurrent callers share one prompt", async () => {
    const c = counting({ delay: "1 second" })
    const certs = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: c.signer })
      const fibers = yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.forkChild(s.certificate))
      yield* TestClock.adjust("1 second")
      const out = yield* Effect.forEach(fibers, Fiber.join)
      // Later calls reuse it too.
      out.push(yield* s.certificate)
      return out
    }))
    expect(c.prompts()).toBe(1)
    expect(certs.length).toBe(11)
    for (const cert of certs) expect(cert.signature).toEqual(certs[0]!.signature)
  })

  test("a rejected prompt is not remembered; the next call prompts again", async () => {
    const c = counting({ fail: (n) => n === 1 ? new Signer.SigningError({ reason: "rejected", message: "no" }) : undefined })
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: c.signer })
      const first = yield* Effect.exit(s.certificate)
      const second = yield* s.certificate
      const third = yield* s.certificate
      return { first, second, third }
    }))
    expect(failure(r.first)).toMatchObject({ _tag: "SigningError", reason: "rejected" })
    expect(r.second.signature).toEqual(r.third.signature)
    expect(c.prompts()).toBe(2)
  })

  test("a failure that is not a SigningError becomes SigningError \"unavailable\"", async () => {
    const c = counting({ fail: () => ({ _tag: "UnsupportedFeature", message: "no sui:signPersonalMessage" }) })
    const e = failure(await runExit(Effect.flatMap(SessionKey.make({ packageId: PKG, signer: c.signer }), (s) => s.certificate)))
    expect(e).toMatchObject({ _tag: "SigningError", reason: "unavailable" })
    expect((e as Signer.SigningError).message).toContain("UnsupportedFeature")
  })

  test("key signer: the certificate's fields, and the signature verifies (verify)", async () => {
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: keySigner, mvrName: "@my/package" })
      const cert = yield* s.certificate
      const verified = yield* SessionKey.verify(s).pipe(Effect.provide(schemes))
      return { s, cert, verified }
    }))
    expect(r.cert).toEqual({
      user: keySigner.address,
      sessionVk: r.s.publicKey,
      creationTime: r.s.createdAt,
      ttlMin: 10,
      signature: r.cert.signature,
      mvrName: "@my/package"
    })
    expect(r.verified.address).toBe(keySigner.address)
    // The same thing @mysten/sui's verifier accepts.
    const { verifyPersonalMessageSignature } = await import("@mysten/sui/verify")
    const pk = await verifyPersonalMessageSignature(r.s.personalMessage, toB64(r.cert.signature), { offline: true } as never)
    expect(pk.toSuiAddress()).toBe(keySigner.address)
  })

  test("wallet signer (@unconfirmed/sui-wallet over a wallet-standard wallet)", async () => {
    const keypair = Ed25519Keypair.fromSecretKey(SEED)
    const fake = fakeWallet({ keypair, name: "Seal session test wallet" })
    const r = await run(Effect.gen(function*() {
      yield* Wallet.register(fake.wallet)
      const wallet = yield* Wallet.find(fake.wallet.name)
      yield* Wallet.connect(wallet)
      const signer = yield* Wallet.signer(wallet, { chain: "sui:testnet" })
      const s = yield* SessionKey.make({ packageId: PKG, signer })
      const cert = yield* s.certificate
      return yield* SessionKey.verify(s).pipe(Effect.provide(schemes), Effect.as(cert))
    }).pipe(Effect.scoped))
    expect(r.user).toBe(keypair.toSuiAddress() as Address.Address)
  })

  test("no signer: SignatureRequired carries the message; withSignature completes the session", async () => {
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, address: keySigner.address })
      const missing = yield* Effect.exit(s.certificate)
      const { signature } = yield* Signer.signPersonalMessage(keySigner, s.personalMessage)
      const signed = yield* SessionKey.withSignature(s, signature)
      const cert = yield* signed.certificate
      const verified = yield* SessionKey.verify(signed).pipe(Effect.provide(schemes))
      const bad = yield* Effect.exit(SessionKey.withSignature(s, signature.slice(0, 50)))
      const badFlag = yield* Effect.exit(SessionKey.withSignature(s, new Uint8Array([0x09, 1, 2])))
      return { s, missing, signed, signature, cert, verified, bad, badFlag }
    }))
    const e = failure(r.missing)
    expect(e._tag).toBe("SignatureRequired")
    expect(b64((e as { message: string }).message)).toEqual(r.s.personalMessage)
    expect(r.signed.publicKey).toEqual(r.s.publicKey)
    expect(r.cert.signature).toEqual(r.signature)
    expect(r.verified.address).toBe(keySigner.address)
    expect(failure(r.bad)._tag).toBe("InvalidSessionKey")
    expect(failure(r.badFlag)._tag).toBe("InvalidSessionKey")
  })

  test("verify fails for a signer that is not the session's address", async () => {
    const e = failure(await runExit(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: keySigner, address: "0x" + "11".repeat(32) })
      return yield* SessionKey.verify(s).pipe(Effect.provide(schemes))
    })))
    expect(e._tag).toBe("InvalidSignature")
  })
})

describe("export / import", () => {
  test("toExported → JSON → fromExported: same session, signature kept, no new prompt", async () => {
    const c = counting()
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: c.signer, mvrName: "@my/package" })
      const cert = yield* s.certificate
      const exported = yield* SessionKey.toExported(s)
      const json = JSON.stringify(Schema.encodeSync(SessionKey.Exported)(exported))
      const imported = yield* SessionKey.fromExported(JSON.parse(json))
      const again = yield* SessionKey.fromExported(exported)
      const cert2 = yield* imported.certificate
      const sig1 = yield* SessionKey.signRequest(s, utf8("ptb"), new Uint8Array(48), new Uint8Array(96))
      const sig2 = yield* SessionKey.signRequest(imported, utf8("ptb"), new Uint8Array(48), new Uint8Array(96))
      return { s, cert, exported, json, imported, again, cert2, sig1, sig2 }
    }))
    expect(Redacted.isRedacted(r.exported.sessionKey)).toBe(true)
    expect(String(r.exported.sessionKey)).not.toContain("suiprivkey")
    expect(JSON.parse(r.json).sessionKey).toStartWith("suiprivkey1")
    for (const s of [r.imported, r.again]) {
      expect(s.publicKey).toEqual(r.s.publicKey)
      expect(s.createdAt).toBe(r.s.createdAt)
      expect(s.mvrName).toBe("@my/package")
      expect(s.personalMessage).toEqual(r.s.personalMessage)
    }
    expect(r.cert2).toEqual(r.cert)
    expect(r.sig2).toEqual(r.sig1)
    expect(c.prompts()).toBe(1)
  })

  test("an unsigned session exports without a signature", async () => {
    const e = await run(Effect.flatMap(SessionKey.make({ packageId: PKG, address: keySigner.address }), SessionKey.toExported))
    expect("personalMessageSignature" in e).toBe(false)
    expect("mvrName" in e).toBe(false)
  })

  test("importing an expired session is SessionKeyExpired", async () => {
    const exported = await run(Effect.flatMap(SessionKey.make({ packageId: PKG, signer: keySigner, ttl: "1 minute" }), SessionKey.toExported))
    const e = failure(await run(Effect.exit(Effect.andThen(TestClock.adjust("1 minute"), SessionKey.fromExported(exported)))))
    expect(e._tag).toBe("SessionKeyExpired")
  })

  test("malformed exports are InvalidSessionKey", async () => {
    const good = Schema.encodeSync(SessionKey.Exported)(
      await run(Effect.flatMap(SessionKey.make({ packageId: PKG, signer: keySigner }), SessionKey.toExported))
    )
    const secp = Effect.runSync(PrivateKey.encode({ flag: PrivateKey.Scheme.Secp256k1, secretKey: new Uint8Array(32).fill(3) }))
    const bad: Array<unknown> = [
      null,
      "x",
      { ...good, sessionKey: undefined },
      { ...good, sessionKey: "suiprivkey1nope" },
      { ...good, sessionKey: secp },
      { ...good, ttlMin: 31 },
      { ...good, ttlMin: 0 },
      { ...good, ttlMin: 1.5 },
      { ...good, packageId: "ab".repeat(32) },
      { ...good, address: "0x1" },
      { ...good, creationTimeMs: "1" },
      { ...good, personalMessageSignature: "AAAA" },
      { ...good, personalMessageSignature: "%%%" }
    ]
    for (const input of bad) {
      const e = failure(await runExit(SessionKey.fromExported(input)))
      expect(e._tag).toBe("InvalidSessionKey")
    }
  })
})

describe("derived-key cache", () => {
  const fullId = (pkg: string, id: number) => {
    const out = new Uint8Array(33)
    out.set(unhex(pkg), 0)
    out[32] = id
    return out
  }
  const S1 = Address.normalize("0x51")
  const S2 = Address.normalize("0x52")
  const key = (n: number) => new Uint8Array(48).fill(n)

  test("get, lookup, set; a copy in and out", async () => {
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: keySigner })
      const cache = SessionKey.keyCache(s)
      const empty = yield* cache.get(fullId(PKG, 1), S1)
      const k = key(1)
      yield* cache.set(fullId(PKG, 1), S1, k)
      k.fill(9)
      yield* cache.set(fullId(PKG, 1), S2, key(2))
      yield* cache.set(fullId(PKG, 2), S1, key(3))
      const hit = yield* cache.get(fullId(PKG, 1), S1)
      const all = yield* cache.lookup(fullId(PKG, 1))
      return { empty, hit, all, size: yield* cache.size }
    }))
    expect(Option.isNone(r.empty)).toBe(true)
    expect(r.hit).toEqual(Option.some(key(1)))
    expect(r.all.map((e) => [e.server, e.key[0]]).sort()).toEqual([[S1, 1], [S2, 2]])
    expect(r.size).toBe(3)
  })

  test("bounded: the least recently used entry goes first", async () => {
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: keySigner, cacheCapacity: 2 })
      const cache = SessionKey.keyCache(s)
      yield* cache.set(fullId(PKG, 1), S1, key(1))
      yield* cache.set(fullId(PKG, 2), S1, key(2))
      yield* cache.get(fullId(PKG, 1), S1)
      yield* cache.set(fullId(PKG, 3), S1, key(3))
      return {
        one: yield* cache.get(fullId(PKG, 1), S1),
        two: yield* cache.get(fullId(PKG, 2), S1),
        three: yield* cache.get(fullId(PKG, 3), S1)
      }
    }))
    expect(Option.isSome(r.one)).toBe(true)
    expect(Option.isNone(r.two)).toBe(true)
    expect(Option.isSome(r.three)).toBe(true)
  })

  test("the session is checked before anything is returned: expired fails and empties the cache", async () => {
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: keySigner, ttl: "1 minute", clockSkew: 0 })
      const cache = SessionKey.keyCache(s)
      yield* cache.set(fullId(PKG, 1), S1, key(1))
      yield* TestClock.adjust("50 seconds")
      const get = yield* Effect.exit(cache.get(fullId(PKG, 1), S1))
      const lookup = yield* Effect.exit(cache.lookup(fullId(PKG, 1)))
      const set = yield* Effect.exit(cache.set(fullId(PKG, 1), S1, key(1)))
      return { get, lookup, set, size: yield* cache.size }
    }))
    expect(failure(r.get)._tag).toBe("SessionKeyExpired")
    expect(failure(r.lookup)._tag).toBe("SessionKeyExpired")
    expect(failure(r.set)._tag).toBe("SessionKeyExpired")
    expect(r.size).toBe(0)
  })

  test("another package's ids are never found, and storing one is a defect", async () => {
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, signer: keySigner })
      const cache = SessionKey.keyCache(s)
      const get = yield* cache.get(fullId(OTHER_PKG, 1), S1)
      const lookup = yield* cache.lookup(fullId(OTHER_PKG, 1))
      const set = yield* Effect.exit(cache.set(fullId(OTHER_PKG, 1), S1, key(1)))
      return { get, lookup, set }
    }))
    expect(Option.isNone(r.get)).toBe(true)
    expect(r.lookup).toEqual([])
    expect(Exit.isFailure(r.set) && Cause.hasDies(r.set.cause)).toBe(true)
  })

  test("per session: a new or imported session starts empty; withSignature shares it; clear empties it", async () => {
    const r = await run(Effect.gen(function*() {
      const s = yield* SessionKey.make({ packageId: PKG, address: keySigner.address })
      yield* SessionKey.keyCache(s).set(fullId(PKG, 1), S1, key(1))
      const other = yield* SessionKey.make({ packageId: PKG, address: keySigner.address })
      const imported = yield* SessionKey.fromExported(yield* SessionKey.toExported(s))
      const { signature } = yield* Signer.signPersonalMessage(keySigner, s.personalMessage)
      const signed = yield* SessionKey.withSignature(s, signature)
      const sizes = [
        yield* SessionKey.keyCache(other).size,
        yield* SessionKey.keyCache(imported).size,
        yield* SessionKey.keyCache(signed).size
      ]
      yield* SessionKey.keyCache(signed).clear
      sizes.push(yield* SessionKey.keyCache(s).size)
      return sizes
    }))
    expect(r).toEqual([0, 0, 1, 0])
  })

  test("a value not made by SessionKey has no cache (defect)", async () => {
    const s = await run(SessionKey.make({ packageId: PKG, signer: keySigner }))
    const exit = await runExit(SessionKey.keyCache({ ...s }).size)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Type tests: both kinds of signer are MessageSigners.
// -----------------------------------------------------------------------------

type Assert<T extends true> = T
export type _KeySigner = Assert<Signer.Signer extends SessionKey.MessageSigner ? true : false>
export type _WalletSigner = Assert<Wallet.WalletSigner extends SessionKey.MessageSigner ? true : false>
// And Verify is used as documented.
export type _Verified = Assert<Effect.Success<ReturnType<typeof SessionKey.verify>> extends Verify.Verified ? true : false>
