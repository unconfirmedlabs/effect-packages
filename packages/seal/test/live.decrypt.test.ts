/**
 * Live decryption on testnet (§6.3), without funds: opt in with SUI_LIVE=1.
 * Users are fresh in-memory Ed25519 keys, nothing is signed by the wallet and
 * no transaction is submitted. Policies are Mysten's canary package (§0.1,
 * version 1, the whole `move/patterns` set). Servers: Mysten's two testnet
 * servers and the testnet committee (aggregator), unless a case says
 * otherwise.
 *
 * Budget: about 30 `fetch_key` requests per run, sequential, well under
 * Mysten's 10 per second (H11).
 */
import { SealClient, SessionKey as MystenSessionKey } from "@mysten/seal"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import type { Address } from "@unconfirmed/sui/Address"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as Ptb from "@unconfirmed/sui/Ptb"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import { Wallet } from "@unconfirmed/sui-wallet"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import { fakeWallet } from "@unconfirmed/test-support/wallet"
import * as Approval from "../src/Approval.ts"
import * as Config from "../src/Config.ts"
import type { ThresholdNotMet } from "../src/Errors.ts"
import * as KeyServer from "../src/KeyServer.ts"
import * as KeyServerApi from "../src/KeyServerApi.ts"
import * as Keys from "../src/Keys.ts"
import * as Seal from "../src/Seal.ts"
import * as SessionKey from "../src/SessionKey.ts"
import { TESTNET_INDEPENDENT } from "./fixtures.ts"

const live = process.env.SUI_LIVE === "1"
const suite = live ? describe : describe.skip
const FULLNODE = process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443"
const CANARY = "0x58dce5d91278bceb65d44666ffa225ab397fc3ae9d8398c8c779c5530bd978c2"
const TIMEOUT = 60_000

const SERVERS = [Config.testnet.mysten1, Config.testnet.mysten2, Config.testnet.committee]
/** ruby-nodes (§0.1): a real public key, given an unroutable URL for case 8. */
const RUBY = TESTNET_INDEPENDENT[2]
const UNROUTABLE = "https://192.0.2.1" // TEST-NET-1: connections hang until our 10 s timeout

/** Counts `fetch_key` requests at the `HttpClient`. */
const counter = { fetches: 0 }
const http = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(Effect.service(HttpClient.HttpClient), (client) =>
    HttpClient.tapRequest(client, (request) =>
      Effect.sync(() => {
        if (request.url.endsWith("/v1/fetch_key")) counter.fetches++
      })))
).pipe(Layer.provide(FetchHttpClient.layer))

const chain = SuiGrpc.layer({ url: FULLNODE })
const layer = Seal.layer({ servers: SERVERS }).pipe(Layer.provideMerge(chain), Layer.provideMerge(http))
type Services = Layer.Success<typeof layer>
const runLive = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runPromise(Effect.provide(effect, layer))
const exitLive = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runPromiseExit(Effect.provide(effect, layer))

const utf8 = (s: string) => new TextEncoder().encode(s)
const addressBytes = (address: string) => Uint8Array.from(Buffer.from(address.slice(2), "hex"))

/** A fresh user: our signer and the same key as `@mysten/sui` keypair. */
const freshUser = () => {
  const secret = crypto.getRandomValues(new Uint8Array(32))
  return { signer: Effect.runSync(Ed25519.fromSecretKey(secret)), keypair: Ed25519Keypair.fromSecretKey(secret) }
}

const accountBased = (id: Uint8Array) =>
  Approval.fromRecipeOffline(Approval.call({ target: `${CANARY}::account_based::seal_approve`, id }))
const tleId = (ms: number) => Bcs.encodeSync(Bcs.u64)(BigInt(ms))
const tle = (ids: ReadonlyArray<Uint8Array>) =>
  Approval.fromRecipeOffline(Effect.forEach(ids, (id) => Approval.call({ target: `${CANARY}::tle::seal_approve`, id, arguments: [Ptb.clock] })))

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isFailure(exit)) {
    const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
    if (reason && reason._tag === "Fail") return reason.error
  }
  throw new Error(`expected a typed failure, got ${Exit.isSuccess(exit) ? "success" : String(exit.cause)}`)
}

const asThresholdNotMet = (e: { readonly _tag: string }): ThresholdNotMet => {
  if (e._tag !== "ThresholdNotMet") throw new Error(`expected ThresholdNotMet, got ${e._tag}: ${String((e as { message?: string }).message)}`)
  return e as ThresholdNotMet
}

suite("live decryption (testnet, no funds)", () => {
  test("1, 4. account_based 2 of 3: AES, HMAC-CTR, share consistency; later decrypts send nothing", async () => {
    const { signer } = freshUser()
    const id = addressBytes(signer.address)
    const data = utf8("live account_based")
    const r = await runLive(Effect.gen(function*() {
      const aes = yield* Seal.encrypt({ packageId: CANARY, id, data, threshold: 2 })
      const hmac = yield* Seal.encrypt({ packageId: CANARY, id, data, threshold: 2, dem: "Hmac256Ctr" })
      const session = yield* Seal.session({ packageId: CANARY, signer })
      const approval = yield* accountBased(id)
      const before = counter.fetches
      const a = yield* Seal.decrypt({ data: aes.encryptedObject, session, approval })
      const first = counter.fetches - before
      const h = yield* Seal.decrypt({ data: hmac.encryptedObject, session, approval })
      const c = yield* Seal.decrypt({ data: aes.encryptedObject, session, approval, checkShareConsistency: true })
      return { a, h, c, first, total: counter.fetches - before }
    }))
    expect([r.a, r.h, r.c]).toEqual([data, data, data])
    expect(r.first).toBe(3) // all three asked at once; two answers suffice
    expect(r.total).toBe(3) // the second and third decrypts came from the session's cache
  }, TIMEOUT)

  test("2. @mysten/seal decrypts our object, and we decrypt theirs", async () => {
    const { signer, keypair } = freshUser()
    const id = addressBytes(signer.address)
    const suiClient = new SuiGrpcClient({ network: "testnet", baseUrl: FULLNODE })
    const client = new SealClient({
      suiClient: suiClient as never,
      serverConfigs: SERVERS.map((s) => ({ objectId: s.objectId, weight: 1, ...(s.aggregatorUrl !== undefined && { aggregatorUrl: s.aggregatorUrl }) }))
    })
    const ours = await runLive(Seal.encrypt({ packageId: CANARY, id, data: utf8("ours"), threshold: 2 }))
    const approval = await runLive(accountBased(id))
    const sessionKey = await MystenSessionKey.create({ address: keypair.toSuiAddress(), packageId: CANARY, ttlMin: 10, signer: keypair, suiClient: suiClient as never })
    const txBytes = new Uint8Array([0, ...approval.bytes])
    expect(await client.decrypt({ data: ours.encryptedObject, sessionKey, txBytes })).toEqual(utf8("ours"))

    const theirs = await client.encrypt({ threshold: 2, packageId: CANARY, id: Buffer.from(id).toString("hex"), data: utf8("theirs") })
    const plain = await runLive(Effect.gen(function*() {
      const session = yield* Seal.session({ packageId: CANARY, signer })
      return yield* Seal.decrypt({ data: theirs.encryptedObject, session, approval })
    }))
    expect(plain).toEqual(utf8("theirs"))
  }, TIMEOUT)

  test("3. another address's id: denied, every failure NoAccess with the Move abort", async () => {
    const { signer } = freshUser()
    const otherId = addressBytes(freshUser().signer.address)
    const exit = await exitLive(Effect.gen(function*() {
      const { encryptedObject } = yield* Seal.encrypt({ packageId: CANARY, id: otherId, data: utf8("not yours"), threshold: 2 })
      const session = yield* Seal.session({ packageId: CANARY, signer })
      return yield* Seal.decrypt({ data: encryptedObject, session, approval: yield* accountBased(otherId) })
    }))
    const e = asThresholdNotMet(failureOf(exit))
    expect(e.reason).toBe("denied")
    expect(e.failures.length).toBeGreaterThanOrEqual(2)
    for (const f of e.failures) {
      expect(f.error.kind).toBe("NoAccess")
      expect(f.error.message).toContain("account_based")
    }
  }, TIMEOUT)

  test("5. tle: a time in the past decrypts (a shared Clock input); a time in the future is denied", async () => {
    const { signer } = freshUser()
    const past = tleId(Date.now() - 60_000)
    const future = tleId(Date.now() + 3_600_000)
    const r = await runLive(Effect.gen(function*() {
      const a = yield* Seal.encrypt({ packageId: CANARY, id: past, data: utf8("past"), threshold: 2 })
      const b = yield* Seal.encrypt({ packageId: CANARY, id: future, data: utf8("future"), threshold: 2 })
      const session = yield* Seal.session({ packageId: CANARY, signer })
      const ok = yield* Seal.decrypt({ data: a.encryptedObject, session, approval: yield* tle([past]) })
      const denied = yield* Effect.exit(Seal.decrypt({ data: b.encryptedObject, session, approval: yield* tle([future]) }))
      return { ok, denied }
    }))
    expect(r.ok).toEqual(utf8("past"))
    const e = asThresholdNotMet(failureOf(r.denied))
    expect(e.reason).toBe("denied")
    expect(e.failures.every((f) => f.error.kind === "NoAccess")).toBe(true)
  }, TIMEOUT)

  test("6. two ids in one approval: fetchKeys, then both objects decrypt with no further request", async () => {
    const { signer } = freshUser()
    const ids = [tleId(Date.now() - 120_000), tleId(Date.now() - 60_000)]
    const r = await runLive(Effect.gen(function*() {
      const objects = yield* Effect.forEach(ids, (id, i) => Seal.encrypt({ packageId: CANARY, id, data: utf8(`tle ${i}`), threshold: 2 }))
      const session = yield* Seal.session({ packageId: CANARY, signer })
      const approval = yield* tle(ids)
      yield* Seal.fetchKeys({ objects: objects.map((o) => o.encryptedObject), session, approval })
      const before = counter.fetches
      const plain = yield* Effect.forEach(objects, (o) => Seal.decrypt({ data: o.encryptedObject, session, approval }))
      return { plain, after: counter.fetches - before }
    }))
    expect(r.plain).toEqual([utf8("tle 0"), utf8("tle 1")])
    expect(r.after).toBe(0)
  }, TIMEOUT)

  test("7. a wallet-shaped signer (wallet-standard FakeWallet) as the session's signer", async () => {
    const { keypair } = freshUser()
    const fake = fakeWallet({ keypair, name: "Seal live test wallet" })
    const id = addressBytes(keypair.toSuiAddress())
    const plain = await runLive(Effect.gen(function*() {
      yield* Wallet.register(fake.wallet)
      const wallet = yield* Wallet.find(fake.wallet.name)
      yield* Wallet.connect(wallet)
      const signer = yield* Wallet.signer(wallet, { chain: "sui:testnet" })
      const { encryptedObject } = yield* Seal.encrypt({ packageId: CANARY, id, data: utf8("wallet"), threshold: 2 })
      const session = yield* Seal.session({ packageId: CANARY, signer })
      return yield* Seal.decrypt({ data: encryptedObject, session, approval: yield* accountBased(id) })
    }).pipe(Effect.scoped))
    expect(plain).toEqual(utf8("wallet"))
  }, TIMEOUT)

  test("8. availability: an unreachable server; 2 of 4 decrypts, a 1-of-3 denial ends at the grace, not the timeout", async () => {
    // The real servers as read from chain, plus ruby-nodes' key with an unroutable URL.
    const loaded = await runLive(Effect.gen(function*() {
      const keyServers = yield* Effect.service(KeyServer.KeyServers)
      const real = yield* Effect.forEach(SERVERS, (s) => keyServers.get(s.objectId as Address))
      const ruby = yield* KeyServer.read(RUBY as Address)
      return { real, ruby }
    }))
    const unreachable: KeyServer.KeyServer = {
      objectId: loaded.ruby.objectId,
      name: loaded.ruby.name,
      publicKey: loaded.ruby.publicKey,
      type: "Independent",
      url: UNROUTABLE,
      apiKey: undefined
    }
    const servers = [...SERVERS, { objectId: RUBY }]
    const availability = Layer.mergeAll(
      Config.layer(servers),
      KeyServer.layerFromServers([...loaded.real, unreachable]),
      KeyServerApi.layer()
    ).pipe(Layer.provideMerge(chain), Layer.provideMerge(http))
    const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof availability>>) =>
      Effect.runPromiseExit(Effect.provide(effect, availability))

    const { signer } = freshUser()
    const id = addressBytes(signer.address)
    const ok = await run(Effect.gen(function*() {
      const { encryptedObject } = yield* Seal.encrypt({ packageId: CANARY, id, data: utf8("2 of 4"), threshold: 2 })
      const session = yield* Seal.session({ packageId: CANARY, signer })
      return yield* Seal.decrypt({ data: encryptedObject, session, approval: yield* accountBased(id) })
    }))
    expect(Exit.isSuccess(ok) && ok.value).toEqual(utf8("2 of 4"))

    const otherId = addressBytes(freshUser().signer.address)
    const three = [Config.testnet.mysten1, Config.testnet.mysten2, { objectId: RUBY }].map((s) => ({ objectId: s.objectId, weight: 1 }))
    let elapsed = 0
    const denied = await run(Effect.gen(function*() {
      const { encryptedObject } = yield* Seal.encrypt({ packageId: CANARY, id: otherId, data: utf8("1 of 3"), threshold: 1, servers: three })
      const session = yield* Seal.session({ packageId: CANARY, signer })
      const approval = yield* accountBased(otherId)
      yield* session.certificate // sign first: time only the requests
      const start = Date.now()
      return yield* Seal.decrypt({ data: encryptedObject, session, approval }).pipe(Effect.ensuring(Effect.sync(() => (elapsed = Date.now() - start))))
    }))
    const e = asThresholdNotMet(failureOf(denied))
    expect(e.reason).toBe("denied")
    expect(e.failures.map((f) => f.error.kind)).toEqual(["NoAccess", "NoAccess"])
    expect(e.unsettled.map((u) => u.server)).toEqual([RUBY])
    // About 2 s (the default denialGrace) after the first NoAccess; the unroutable server would take 10 s.
    expect(elapsed).toBeGreaterThan(1_900)
    expect(elapsed).toBeLessThan(6_000)
    console.log(`[live.decrypt] 1-of-3 denial ended after ${elapsed} ms`)
  }, TIMEOUT)

  test("9. open mode: 0x2::coin::seal_approve is InvalidPtb from an independent server and from the aggregator (H9)", async () => {
    const { signer } = freshUser()
    const exit = await exitLive(Effect.gen(function*() {
      const session = yield* SessionKey.make({ packageId: "0x" + "0".repeat(63) + "2", signer })
      const approval = yield* Approval.fromRecipeOffline(Approval.call({ target: "0x2::coin::seal_approve", id: new Uint8Array([1]) }))
      return yield* Keys.fetch({
        session,
        approval,
        servers: [Config.testnet.mysten1, Config.testnet.committee].map((s) => ({ objectId: s.objectId as Address, weight: 1 })),
        threshold: 1
      })
    }))
    const e = asThresholdNotMet(failureOf(exit))
    expect(e.reason).toBe("denied")
    expect(e.failures.map((f) => f.error.kind)).toEqual(["InvalidPtb", "InvalidPtb"])
  }, TIMEOUT)
})
