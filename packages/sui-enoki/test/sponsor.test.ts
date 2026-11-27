/**
 * Sponsorship and the zkLogin flow against a scripted Enoki.
 */
import { Transaction } from "@mysten/sui/transactions"
import * as TheirZk from "@mysten/sui/zklogin"
import { Bcs } from "@unconfirmed/bcs"
import { Address, Coins, Ed25519, Hash, Objects, Packages, Ptb, SignatureScheme, TransactionData as T, Verify } from "@unconfirmed/sui"
import * as Stream from "effect/Stream"
import * as Nonce from "@unconfirmed/sui-zklogin/Nonce"
import * as PublicIdentifier from "@unconfirmed/sui-zklogin/PublicIdentifier"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { claims, inputs } from "../../sui-zklogin/test/fixtures.ts"
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

/** Pure inputs only, so `Resolve.inputs` never touches these. */
const noChain = Layer.mergeAll(
  Layer.succeed(Objects.Objects, {} as Objects.Objects["Service"]),
  Layer.succeed(Packages.Packages, {} as Packages.Packages["Service"]),
  Layer.succeed(Coins.Coins, {} as Coins.Coins["Service"])
)

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
  EnokiHttp.layer({ apiKey: "k", apiUrl: "https://enoki.test" }).pipe(Layer.provide(http.layer))

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
    expect(http.requests[0]!.headers["zklogin-jwt"]).toBe("a.b.c")
    expect(Object.keys(JSON.parse(http.requests[0]!.body!))).toEqual(["transactionBlockKindBytes"])
  })

  test("bytes that change the kind or sender are refused before signing", async () => {
    for (const tamper of [
      (d: T.TransactionData): T.TransactionData => ({ ...d, sender: RECIPIENT }),
      (d: T.TransactionData): T.TransactionData => ({ ...d, kind: { _tag: "ProgrammableTransaction", inputs: [], commands: [] } })
    ]) {
      const http = fakeEnoki(tamper)
      const e = await Effect.runPromise(Effect.gen(function*() {
        const signer = yield* Ed25519.fromSecretKey(seed(3))
        return yield* Effect.flip(Sponsor.run(recipe, { signer }))
      }).pipe(Effect.provide(Layer.merge(enoki(http), noChain))))
      expect(e._tag).toBe("UnexpectedSponsoredTransaction")
      expect(http.requests.length).toBe(1) // never executed
    }
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

  test("gas paid by the sender is refused (sender would pay up to the budget)", async () => {
    const http = fakeEnoki((d) => ({ ...d, gasData: { ...d.gasData, owner: d.sender, price: 1_000_000n, budget: 50_000_000_000n } }))
    const { e, executed } = await refused(http)
    expect(e._tag).toBe("UnexpectedSponsoredTransaction")
    expect((e as Sponsor.UnexpectedSponsoredTransaction).reason).toContain("paid by the sender")
    expect(executed).toBe(false)
  })

  test("a gas owner other than the app's sponsor address is refused", async () => {
    const other = Address.normalize("0xbad")
    const { e, executed } = await refused(fakeEnoki((d) => ({ ...d, gasData: { ...d.gasData, owner: other } })), {
      network: "testnet"
    })
    expect((e as Sponsor.UnexpectedSponsoredTransaction).reason).toContain("not the sponsor")
    expect(executed).toBe(false)
    // An explicit sponsorAddress is enforced without asking getApp.
    const http = fakeEnoki()
    const r = await refused(http, { sponsorAddress: other })
    expect((r.e as Sponsor.UnexpectedSponsoredTransaction).reason).toContain("not the sponsor")
    expect(http.requests.some((q) => q.url.endsWith("/v1/app"))).toBe(false)
  })

  test("a digest that doesn't match the bytes is refused", async () => {
    const { e, executed } = await refused(fakeEnoki(undefined, "11111111111111111111111111111111"))
    expect((e as Sponsor.UnexpectedSponsoredTransaction).reason).toContain("digest")
    expect(executed).toBe(false)
  })

  test("budget and price caps", async () => {
    const budget = await refused(fakeEnoki(), { maxBudget: 1_000_000n })
    expect((budget.e as Sponsor.UnexpectedSponsoredTransaction).reason).toContain("budget")
    const price = await refused(fakeEnoki(), { maxGasPrice: 999n })
    expect((price.e as Sponsor.UnexpectedSponsoredTransaction).reason).toContain("price")
    expect(budget.executed || price.executed).toBe(false)
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
        const nonce = forgeNonce ?? Effect.runSync(Nonce.generate({ flag: pk[0]!, bytes: pk.subarray(1) }, 12, "77"))
        return { body: { data: { nonce, randomness: "77", epoch: 10, maxEpoch: 12, estimatedExpiration: 1 } } }
      }
      if (path === "/v1/zklogin") return { body: { data: { address, publicKey: b64(identifier), salt: String(legacySalt) } } }
      if (path === "/v1/zklogin/zkp") return { body: { data: inputs(seedOf) } }
      return { status: 404, body: "" }
    })

  for (const legacyAddress of [false, true]) {
    test(`start -> (OAuth) -> complete gives a zkLogin signer (legacy: ${legacyAddress})`, async () => {
      const address = PublicIdentifier.toAddress(identifier, { legacyAddress })
      const http = flow(address)
      const { session, done, ephemeral } = await Effect.runPromise(Effect.gen(function*() {
        const ephemeral = yield* Ed25519.fromSecretKey(seed(4))
        const session = yield* ZkLoginFlow.start({ ephemeral, network: "testnet" })
        const done = yield* ZkLoginFlow.complete(session, "header.payload.sig")
        return { session, done, ephemeral }
      }).pipe(Effect.provide(enoki(http))))
      expect(session).toMatchObject({ randomness: "77", maxEpoch: 12, network: "testnet" })
      expect(session.nonce).toBe(Effect.runSync(Nonce.generate(ephemeral.publicKey, 12, "77")))
      expect(done.address).toBe(address)
      expect(done.signer.address).toBe(address)
      expect(done.salt).toBe(String(legacySalt))
      const nonceReq = http.requests.find((r) => r.url.endsWith("/zklogin/nonce"))!
      expect(JSON.parse(nonceReq.body!)).toEqual({ network: "testnet", ephemeralPublicKey: b64(Uint8Array.from([0, ...ephemeral.publicKey.bytes])) })
      const zkpReq = http.requests.find((r) => r.url.endsWith("/zklogin/zkp"))!
      expect(zkpReq.headers["zklogin-jwt"]).toBe("header.payload.sig")
      expect(JSON.parse(zkpReq.body!)).toMatchObject({ maxEpoch: 12, randomness: "77", network: "testnet" })
    })
  }

  test("a nonce that doesn't commit to our ephemeral key is refused", async () => {
    // e.g. a nonce for the right epoch and randomness but someone else's key
    const otherKey = Effect.runSync(Ed25519.fromSecretKey(seed(5))).publicKey
    const http = flow(Address.normalize("0x1"), Effect.runSync(Nonce.generate(otherKey, 12, "77")))
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
      return yield* Effect.flip(ZkLoginFlow.complete(session, "h.p.s"))
    }).pipe(Effect.provide(enoki(http))))
    expect(e._tag).toBe("InvalidKey")
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
    const coins = Layer.succeed(Coins.Coins, {
      getBalance: (_owner, coinType = "0x2::sui::SUI") =>
        Effect.succeed({ coinType, total: 5_000n, addressBalance: 5_000n, coinBalance: 0n }),
      list: () => Stream.empty
    })
    const noObjects = Layer.mergeAll(
      Layer.succeed(Objects.Objects, {} as Objects.Objects["Service"]),
      Layer.succeed(Packages.Packages, {} as Packages.Packages["Service"]),
      coins
    )
    await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Sponsor.run(
        Effect.gen(function*() {
          const coin = yield* Ptb.coin({ amount: 1_000n, useGasCoin: false })
          yield* Ptb.transferObjects([coin], yield* Ptb.address(RECIPIENT))
        }),
        { signer, network: "testnet", allowedAddresses: [RECIPIENT] }
      )
    }).pipe(Effect.provide(Layer.merge(enoki(http), noObjects))))
    const sponsorRequest = http.requests.find((r) => r.url.endsWith("/v1/transaction-blocks/sponsor"))!
    const kind = Bcs.decodeSync(T.TransactionKind)(fromB64(JSON.parse(sponsorRequest.body!).transactionBlockKindBytes))
    expect(kind.inputs.some((i) => i._tag === "FundsWithdrawal")).toBe(true)
    expect(kind.commands.some((c) => c._tag === "MoveCall" && c.function === "redeem_funds")).toBe(true)
    expect(kind.commands.some((c) => argumentsUseGas(c))).toBe(false)
  })
})

const argumentsUseGas = (c: T.Command): boolean =>
  JSON.stringify(c, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? [] : v)).includes('"GasCoin"')
