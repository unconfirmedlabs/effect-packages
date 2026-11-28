/**
 * Sponsorship and the zkLogin flow against a scripted Enoki.
 */
import { Transaction } from "@mysten/sui/transactions"
import * as TheirZk from "@mysten/sui/zklogin"
import { Bcs } from "@unconfirmed/bcs"
import { Address, Ed25519, Hash, Ptb, SignatureScheme, TransactionData as T, Verify } from "@unconfirmed/sui"
import * as Testing from "@unconfirmed/sui/Testing"
import * as Nonce from "@unconfirmed/sui-zklogin/Nonce"
import * as PublicIdentifier from "@unconfirmed/sui-zklogin/PublicIdentifier"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Schema } from "effect"
import { claims, inputs, makeJwt } from "@unconfirmed/test-support/zklogin"
import * as EnokiHttp from "../src/EnokiHttp.ts"
import * as Sponsor from "../src/Sponsor.ts"
import * as ZkLoginFlow from "../src/ZkLoginFlow.ts"
import { type Recorded, type Reply, scripted } from "./support.ts"

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"))
const seed = (n: number) => new Uint8Array(32).fill(n)
const RECIPIENT = Address.normalize("0x1234")
const SPONSOR = Address.normalize("0x5905")

const recipe = Effect.gen(function*() {
  const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
  yield* Ptb.transferObjects([coin!], yield* Ptb.address(RECIPIENT))
})

/** Pure inputs only, so `Resolve.inputs` never reads the node. */
const noChain = Testing.layer()

/** A fake Enoki: sponsors by wrapping the kind in gas data owned by SPONSOR (optionally tampering). */
const fakeEnoki = (tamper?: (data: T.TransactionData) => T.TransactionData, reportedDigest?: string) =>
  scripted((req: Recorded): Reply => {
    const path = new URL(req.url).pathname
    if (path === "/v1/app") {
      return { body: { data: { allowedOrigins: [], authenticationProviders: [], domains: [], sponsorAddresses: { testnet: SPONSOR } } } }
    }
    if (path === "/v1/transaction-blocks/sponsor") {
      const body = JSON.parse(req.body!)
      const kind = Bcs.decodeSync(T.TransactionKind)(fromB64(body.transactionBlockKindBytes))
      const data: T.TransactionData = {
        _tag: "V1",
        kind,
        sender: Address.normalize(body.sender),
        gasData: { payment: [], owner: SPONSOR, price: 1000n, budget: 5_000_000n },
        expiration: { _tag: "None" }
      }
      const bytes = T.encode(tamper ? tamper(data) : data)
      return { body: { data: { bytes: b64(bytes), digest: reportedDigest ?? Hash.transactionDigest(bytes) } } }
    }
    if (path.startsWith("/v1/transaction-blocks/sponsor/")) return { body: { data: { digest: path.split("/").pop() } } }
    return { status: 404, body: { errors: [{ code: "not_found", message: path }] } }
  })

const enoki = (http: ReturnType<typeof scripted>) =>
  EnokiHttp.layer({ apiKey: "k", url: "https://enoki.test" }).pipe(Layer.provide(http.layer))

describe("Sponsor", () => {
  test("transactionKind matches @mysten/sui's onlyTransactionKind build", async () => {
    const ours = await Effect.runPromise(
      Ptb.build(recipe).pipe(Effect.flatMap(({ draft }) => Sponsor.transactionKind(draft)))
    )
    const tx = new Transaction()
    const [coin] = tx.splitCoins(tx.gas, [1_000n])
    tx.transferObjects([coin!], RECIPIENT)
    expect(b64(ours)).toBe(b64(await tx.build({ onlyTransactionKind: true })))
  })

  test("run: sponsor the kind, sign Enoki's bytes, execute through Enoki", async () => {
    const http = fakeEnoki()
    const { result, signer } = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.fromSecretKey(seed(3))
      const result = yield* Sponsor.run(recipe, { signer, network: "testnet", allowedAddresses: [RECIPIENT] })
      return { result, signer }
    }).pipe(Effect.provide(Layer.merge(enoki(http), noChain))))

    const byPath = (p: string) => http.requests.find((r) => new URL(r.url).pathname.startsWith(p) && (p !== "/v1/transaction-blocks/sponsor" || new URL(r.url).pathname === p))
    const sponsor = byPath("/v1/transaction-blocks/sponsor")
    const execute = byPath("/v1/transaction-blocks/sponsor/")
    expect(http.requests.some((r) => r.url.endsWith("/v1/app"))).toBe(true)
    expect(new URL(sponsor!.url).pathname).toBe("/v1/transaction-blocks/sponsor")
    expect(JSON.parse(sponsor!.body!)).toEqual({
      sender: signer.address,
      network: "testnet",
      transactionBlockKindBytes: expect.any(String),
      allowedAddresses: [RECIPIENT]
    })
    expect(new URL(execute!.url).pathname).toBe(`/v1/transaction-blocks/sponsor/${Hash.transactionDigest(result.bytes)}`)
    expect(JSON.parse(execute!.body!)).toEqual({ signature: b64(result.signature) })
    expect(result.digest).toBe(Hash.transactionDigest(result.bytes))

    // The signature is the sender's over the sponsored bytes (gas owned by the sponsor).
    const v = await Effect.runPromise(
      Verify.transaction(result.bytes, result.signature, { address: signer.address }).pipe(
        Effect.provide(SignatureScheme.SignatureSchemes.layer(Ed25519.scheme))
      )
    )
    expect(v.address).toBe(signer.address)
    const data = Bcs.decodeSync(T.TransactionData)(result.bytes)
    expect(data.gasData.owner).toBe(SPONSOR)
  })

  test("a jwt-identified sender sends the zklogin-jwt header and no sender", async () => {
    const http = scripted(() => ({ status: 403, body: { errors: [{ code: "forbidden", message: "no" }] } }))
    const e = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.fromSecretKey(seed(3))
      return yield* Effect.flip(Sponsor.run(recipe, { signer, jwt: "a.b.c" }))
    }).pipe(Effect.provide(Layer.merge(enoki(http), noChain))))
    expect(e._tag).toBe("EnokiError")
    const sponsorReq = http.requests.find((r) => new URL(r.url).pathname === "/v1/transaction-blocks/sponsor")!
    expect(sponsorReq.headers["zklogin-jwt"]).toBe("a.b.c")
    expect(Object.keys(JSON.parse(sponsorReq.body!))).toEqual(["transactionBlockKindBytes"])
  })

  /** Run with `options` against a fake Enoki; answer the failure and whether anything was executed. */
  const refused = async (
    fake: ReturnType<typeof scripted>,
    options: Partial<Sponsor.SponsorOptions> = {}
  ) => {
    const e = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.fromSecretKey(seed(3))
      return yield* Effect.flip(Sponsor.run(recipe, { signer, ...options }))
    }).pipe(Effect.provide(Layer.merge(enoki(fake), noChain))))
    const executed = fake.requests.some((r) => /\/sponsor\/[^/]+$/.test(new URL(r.url).pathname) && !r.url.endsWith("/execute"))
    return { e, executed }
  }

  test("sponsored bytes that fail a check are refused before signing, and nothing is executed", async () => {
    const other = Address.normalize("0xbad")
    const MAINNET_SPONSOR = Address.normalize("0x3a1")
    const mainnetOnly = () => {
      const base = fakeEnoki()
      return scripted((req) =>
        req.url.endsWith("/v1/app")
          ? { body: { data: { allowedOrigins: [], authenticationProviders: [], domains: [], sponsorAddresses: { mainnet: MAINNET_SPONSOR } } } }
          : base.route(req)
      )
    }
    const cases: Array<[string, () => ReturnType<typeof scripted>, Partial<Sponsor.SponsorOptions>, string]> = [
      ["sender changed", () => fakeEnoki((d) => ({ ...d, sender: RECIPIENT })), {}, "sender"],
      ["kind changed", () => fakeEnoki((d) => ({ ...d, kind: { _tag: "ProgrammableTransaction", inputs: [], commands: [] } })), {}, "kind"],
      // The sender would pay up to the budget.
      ["gas paid by the sender", () => fakeEnoki((d) => ({ ...d, gasData: { ...d.gasData, owner: d.sender, price: 1_000_000n, budget: 50_000_000_000n } })), {}, "paid by the sender"],
      ["gas owner not the app's sponsor", () => fakeEnoki((d) => ({ ...d, gasData: { ...d.gasData, owner: other } })), { network: "testnet" }, "not the sponsor"],
      // An omitted network pins Enoki's default (mainnet) sponsor.
      ["omitted network", mainnetOnly, {}, `not the sponsor ${MAINNET_SPONSOR}`],
      ["digest not the bytes'", () => fakeEnoki(undefined, "11111111111111111111111111111111"), {}, "digest"],
      ["budget cap", () => fakeEnoki(), { maxBudget: 1_000_000n }, "budget"],
      ["price cap", () => fakeEnoki(), { maxGasPrice: 999n }, "price"]
    ]
    for (const [why, http, options, reason] of cases) {
      const { e, executed } = await refused(http(), options)
      expect(e._tag, why).toBe("UnexpectedSponsoredTransaction")
      expect((e as Sponsor.UnexpectedSponsoredTransaction).reason, why).toContain(reason)
      expect(executed, why).toBe(false)
    }
    // An explicit sponsorAddress is enforced without asking getApp.
    const http = fakeEnoki()
    const r = await refused(http, { sponsorAddress: other })
    expect((r.e as Sponsor.UnexpectedSponsoredTransaction).reason).toContain("not the sponsor")
    expect(http.requests.some((q) => q.url.endsWith("/v1/app"))).toBe(false)
  })

  test("a failed execute keeps the signed bytes, signature and digest; re-executing posts the same signature", async () => {
    let failExecute = true
    const base = fakeEnoki()
    const http = scripted((req) => {
      const path = new URL(req.url).pathname
      if (path.startsWith("/v1/transaction-blocks/sponsor/") && failExecute) return { status: 504, body: "gateway timeout" }
      return base.route(req)
    })
    const { e, signer } = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.fromSecretKey(seed(3))
      return { e: yield* Effect.flip(Sponsor.run(recipe, { signer, network: "testnet" })), signer }
    }).pipe(Effect.provide(Layer.merge(enoki(http), noChain))))
    expect(e._tag).toBe("ExecutionUnconfirmed")
    const unconfirmed = e as Sponsor.ExecutionUnconfirmed
    expect(unconfirmed.digest).toBe(Hash.transactionDigest(unconfirmed.bytes))
    expect(unconfirmed.cause).toMatchObject({ _tag: "EnokiError", status: 504 })
    expect(unconfirmed.retryable).toBe(true)
    const v = await Effect.runPromise(
      Verify.transaction(unconfirmed.bytes, unconfirmed.signature, { address: signer.address }).pipe(
        Effect.provide(SignatureScheme.SignatureSchemes.layer(Ed25519.scheme))
      )
    )
    expect(v.address).toBe(signer.address)

    // Retry the execute step alone: the same digest and signature, no new sponsorship.
    failExecute = false
    const sponsorCalls = () => http.requests.filter((r) => new URL(r.url).pathname === "/v1/transaction-blocks/sponsor").length
    const before = sponsorCalls()
    const done = await Effect.runPromise(
      Sponsor.execute({ digest: unconfirmed.digest, bytes: unconfirmed.bytes, signature: unconfirmed.signature }).pipe(
        Effect.provide(enoki(http))
      )
    )
    expect(done.digest).toBe(unconfirmed.digest)
    expect(sponsorCalls()).toBe(before)
    const posts = http.requests.filter((r) => new URL(r.url).pathname === `/v1/transaction-blocks/sponsor/${unconfirmed.digest}`)
    expect(posts.map((r) => JSON.parse(r.body!).signature)).toEqual([b64(unconfirmed.signature), b64(unconfirmed.signature)])
  })

  test("getApp is asked once per layer, not per transaction, and asked again after a stale-sponsor error", async () => {
    let stale = false
    const base = fakeEnoki()
    const http = scripted((req) => {
      if (stale && new URL(req.url).pathname === "/v1/transaction-blocks/sponsor") {
        return { status: 400, body: { errors: [{ code: "invalid_gas_owner", message: "sponsor changed" }] } }
      }
      return base.route(req)
    })
    const apps = () => http.requests.filter((r) => r.url.endsWith("/v1/app")).length
    await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.fromSecretKey(seed(3))
      for (let i = 0; i < 3; i++) yield* Sponsor.run(recipe, { signer, network: "testnet" })
      expect(apps()).toBe(1)
      stale = true
      const e = yield* Effect.flip(Sponsor.run(recipe, { signer, network: "testnet" }))
      expect(e).toMatchObject({ _tag: "EnokiError", code: "invalid_gas_owner" })
      stale = false
      yield* Sponsor.run(recipe, { signer, network: "testnet" })
      expect(apps()).toBe(2)
    }).pipe(Effect.provide(Layer.merge(enoki(http), noChain))))
  })
})

/** A salt whose address seed has a leading zero byte (legacy address differs). */
const legacySalt = (() => {
  for (let s = 1n; s < 5000n; s++) if (TheirZk.genAddressSeed(s, "sub", claims.sub, claims.aud) < 2n ** 248n) return s
  throw new Error("no legacy salt")
})()

describe("ZkLoginFlow", () => {
  const seedOf = String(TheirZk.genAddressSeed(legacySalt, "sub", claims.sub, claims.aud))
  const identifier = Effect.runSync(PublicIdentifier.make(BigInt(seedOf), claims.iss))
  const flow = (address: string, forgeNonce?: string) =>
    scripted((req): Reply => {
      const path = new URL(req.url).pathname
      if (path === "/v1/zklogin/nonce") {
        const pk = fromB64(JSON.parse(req.body!).ephemeralPublicKey)
        const nonce = forgeNonce ?? Effect.runSync(Nonce.generate({ flag: pk[0]!, bytes: pk.subarray(1) }, 12n, "77"))
        return { body: { data: { nonce, randomness: "77", epoch: 10, maxEpoch: 12, estimatedExpiration: 1 } } }
      }
      if (path === "/v1/zklogin") return { body: { data: { address, publicKey: b64(identifier), salt: String(legacySalt) } } }
      if (path === "/v1/zklogin/zkp") return { body: { data: inputs(seedOf) } }
      return { status: 404, body: "" }
    })

  test("start -> (OAuth) -> complete gives a zkLogin signer, for either address derivation", async () => {
    for (const legacyAddress of [false, true]) {
      const address = PublicIdentifier.toAddress(identifier, { legacyAddress })
      const http = flow(address)
      const { session, done, ephemeral } = await Effect.runPromise(Effect.gen(function*() {
        const ephemeral = yield* Ed25519.fromSecretKey(seed(4))
        const session = yield* ZkLoginFlow.start({ ephemeral, network: "testnet" })
        const done = yield* ZkLoginFlow.complete(session, makeJwt({ ...claims, nonce: session.nonce }))
        return { session, done, ephemeral }
      }).pipe(Effect.provide(enoki(http))))
      expect(session).toMatchObject({ randomness: "77", maxEpoch: 12n, network: "testnet" })
      expect(session.nonce).toBe(Effect.runSync(Nonce.generate(ephemeral.publicKey, 12n, "77")))
      expect(done.address).toBe(address)
      expect(done.signer.address).toBe(address)
      expect(done.salt).toBe(String(legacySalt))
      const nonceReq = http.requests.find((r) => r.url.endsWith("/zklogin/nonce"))!
      expect(JSON.parse(nonceReq.body!)).toEqual({ network: "testnet", ephemeralPublicKey: b64(Uint8Array.from([0, ...ephemeral.publicKey.bytes])) })
      const zkpReq = http.requests.find((r) => r.url.endsWith("/zklogin/zkp"))!
      expect(zkpReq.headers["zklogin-jwt"]).toBe(makeJwt({ ...claims, nonce: session.nonce }))
      expect(JSON.parse(zkpReq.body!)).toMatchObject({ maxEpoch: 12, randomness: "77", network: "testnet" })
    }
  })

  test("a nonce that doesn't commit to our ephemeral key is refused", async () => {
    // e.g. a nonce for the right epoch and randomness but someone else's key
    const otherKey = Effect.runSync(Ed25519.fromSecretKey(seed(5))).publicKey
    const http = flow(Address.normalize("0x1"), Effect.runSync(Nonce.generate(otherKey, 12n, "77")))
    const e = await Effect.runPromise(Effect.gen(function*() {
      const ephemeral = yield* Ed25519.fromSecretKey(seed(4))
      return yield* Effect.flip(ZkLoginFlow.start({ ephemeral }))
    }).pipe(Effect.provide(enoki(http))))
    expect(e._tag).toBe("InvalidEnokiNonce")
  })

  test("an address that matches neither derivation is refused", async () => {
    const http = flow(Address.normalize("0xdead"))
    const e = await Effect.runPromise(Effect.gen(function*() {
      const ephemeral = yield* Ed25519.fromSecretKey(seed(4))
      const session = yield* ZkLoginFlow.start({ ephemeral })
      return yield* Effect.flip(ZkLoginFlow.complete(session, makeJwt({ ...claims, nonce: session.nonce })))
    }).pipe(Effect.provide(enoki(http))))
    expect(e._tag).toBe("InvalidKey")
  })

  test("a JWT for another login is refused locally, before any Enoki call", async () => {
    const http = flow(Address.normalize("0x1"))
    const { mismatch, missing, malformed, calls } = await Effect.runPromise(Effect.gen(function*() {
      const ephemeral = yield* Ed25519.fromSecretKey(seed(4))
      const session = yield* ZkLoginFlow.start({ ephemeral })
      const calls = http.requests.length
      return {
        mismatch: yield* Effect.flip(ZkLoginFlow.complete(session, makeJwt({ ...claims, nonce: "someone-elses-nonce" }))),
        missing: yield* Effect.flip(ZkLoginFlow.complete(session, makeJwt({ ...claims, nonce: undefined }))),
        malformed: yield* Effect.flip(ZkLoginFlow.complete(session, "h.p.s")),
        calls: http.requests.length - calls
      }
    }).pipe(Effect.provide(enoki(http))))
    expect(mismatch).toMatchObject({ _tag: "JwtNonceMismatch", received: "someone-elses-nonce" })
    expect(missing).toMatchObject({ _tag: "JwtNonceMismatch" })
    expect(malformed._tag).toBe("InvalidJwt")
    expect(calls).toBe(0)
  })

  test("session data round-trips through JSON; complete takes it back with the ephemeral signer", async () => {
    const identifierAddress = PublicIdentifier.toAddress(identifier)
    const http = flow(identifierAddress)
    const done = await Effect.runPromise(Effect.gen(function*() {
      const ephemeral = yield* Ed25519.fromSecretKey(seed(4))
      const { ephemeral: _, ...data } = yield* ZkLoginFlow.start({ ephemeral, network: "testnet" })
      const saved = JSON.stringify(yield* Schema.encodeEffect(ZkLoginFlow.SessionData)(data))
      // ... the OAuth redirect ...
      const restored = yield* Schema.decodeUnknownEffect(ZkLoginFlow.SessionData)(JSON.parse(saved))
      return yield* ZkLoginFlow.complete({ ...restored, ephemeral }, makeJwt({ ...claims, nonce: restored.nonce }))
    }).pipe(Effect.provide(enoki(http))))
    expect(done.address).toBe(identifierAddress)
  })

  test("authorizationUrl matches EnokiFlow's", () => {
    const url = new URL(ZkLoginFlow.authorizationUrl({ provider: "google", clientId: "cid", redirectUrl: "https://app/cb", nonce: "N" }))
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      nonce: "N",
      client_id: "cid",
      redirect_uri: "https://app/cb",
      response_type: "id_token",
      scope: "openid"
    })
  })
})

describe("Sponsor with address-balance intents", () => {
  test("Ptb.coin({ useGasCoin: false }) is sourced from the sender's address balance before the kind goes to Enoki", async () => {
    const http = fakeEnoki()
    await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      yield* Testing.Node.use((node) => node.setAddressBalance({ owner: signer.address, amount: 5_000n }))
      return yield* Sponsor.run(
        Effect.gen(function*() {
          const coin = yield* Ptb.coin({ amount: 1_000n, useGasCoin: false })
          yield* Ptb.transferObjects([coin], yield* Ptb.address(RECIPIENT))
        }),
        { signer, network: "testnet", allowedAddresses: [RECIPIENT] }
      )
    }).pipe(Effect.provide(Layer.merge(enoki(http), Testing.layer()))))
    const sponsorRequest = http.requests.find((r) => r.url.endsWith("/v1/transaction-blocks/sponsor"))!
    const kind = Bcs.decodeSync(T.TransactionKind)(fromB64(JSON.parse(sponsorRequest.body!).transactionBlockKindBytes))
    expect(kind.inputs.some((i) => i._tag === "FundsWithdrawal")).toBe(true)
    expect(kind.commands.some((c) => c._tag === "MoveCall" && c.function === "redeem_funds")).toBe(true)
    expect(kind.commands.some((c) => argumentsUseGas(c))).toBe(false)
  })
})

const argumentsUseGas = (c: T.Command): boolean =>
  JSON.stringify(c, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? [] : v)).includes('"GasCoin"')
