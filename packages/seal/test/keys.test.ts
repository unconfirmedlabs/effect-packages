/**
 * `Keys` (§4.7, §5) against `fakeKeyServers` under `TestClock`: every case
 * runs the fetch in a fiber and asserts the virtual time at which it ended
 * (ms after `T0`). The clock is advanced in 10 ms steps with a real
 * macrotask between steps, so the fake servers' real promise work (response
 * bodies) settles before time moves on.
 *
 * Also the "Requests" parity bullet of §6.2: the body and headers `SealClient`
 * sends for the same session, transaction and ElGamal draw.
 */
import { SealClient, SessionKey as MystenSessionKey } from "@mysten/seal"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import * as Address from "@unconfirmed/sui/Address"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import { RpcError } from "@unconfirmed/sui/RpcError"
import * as Signer from "@unconfirmed/sui/Signer"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import { TestClock } from "effect/testing"
import * as Approval from "../src/Approval.ts"
import * as ElGamal from "../src/ElGamal.ts"
import * as Entropy from "../src/Entropy.ts"
import { SessionKeyExpired, ThresholdNotMet } from "../src/Errors.ts"
import * as Ibe from "../src/Ibe.ts"
import * as Kdf from "../src/Kdf.ts"
import * as KeyServer from "../src/KeyServer.ts"
import type * as KeyServerApi from "../src/KeyServerApi.ts"
import * as Keys from "../src/Keys.ts"
import * as SessionKey from "../src/SessionKey.ts"
import * as Bls from "../src/Bls.ts"
import {
  approvalPtb,
  fakeKeyServers,
  type FakeKeyServerOptions,
  type FakeRequest,
  hex,
  keyServerErrors,
  seeded,
  statusOf,
  toB64,
  unhex,
  b64
} from "./support.ts"

// The harness jumps between scheduled wake-ups, so even the 10 s timeout cases take well under a second.
setDefaultTimeout(30_000)

const T0 = Date.UTC(2026, 10, 27, 12, 0, 0)
const PKG = Address.normalize("0x" + "a1".repeat(32))
const userSecret = unhex("11".repeat(32))
const user = Effect.runSync(Ed25519.fromSecretKey(userSecret))

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

type Services = KeyServer.KeyServers | KeyServerApi.KeyServerApi

interface Run<A, E> {
  readonly exit: Exit.Exit<A, E>
  /** Virtual ms after T0 at which the effect ended. */
  readonly at: number
}

/** Real macrotasks between clock steps: enough for a fake server's response body to be read. */
const TICKS = 4
const realTick = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

/** When the earliest pending sleep wakes, if any (`TestClock` keeps them sorted, latest first). */
const nextWakeUp = TestClock.testClockWith((clock) => {
  const sleeps = (clock as unknown as { readonly sleeps: ReadonlyArray<{ readonly timestamp: number }> }).sleeps
  return Effect.succeed(sleeps.length === 0 ? undefined : sleeps[sleeps.length - 1]!.timestamp)
})

/** Run `effect` at `T0` under `TestClock`, jumping from one wake-up to the next until it ends (at most `limit` ms). */
const timed = async <A, E>(
  layer: Layer.Layer<Services>,
  effect: Effect.Effect<A, E, Services>,
  options: { readonly start?: number; readonly step?: number; readonly limit?: number } = {}
): Promise<Run<A, E>> => {
  const { start = T0, step = 10, limit = 60_000 } = options
  return Effect.runPromise(
    Effect.gen(function*() {
      yield* TestClock.setTime(start)
      const fiber = yield* Effect.forkChild(
        Effect.flatMap(Effect.exit(effect), (exit) => Effect.map(Clock.currentTimeMillis, (now) => ({ exit, at: now - start })))
      )
      for (let elapsed = 0; fiber.pollUnsafe() === undefined && elapsed <= limit;) {
        for (let i = 0; i < TICKS && fiber.pollUnsafe() === undefined; i++) yield* realTick
        if (fiber.pollUnsafe() !== undefined) break
        // Jump straight to the next scheduled wake-up (nothing can happen in virtual time before it);
        // with nothing scheduled, step `step` ms so pending real I/O gets more real ticks.
        const next = yield* nextWakeUp
        const by = next === undefined ? step : Math.max(1, next - (start + elapsed))
        yield* TestClock.adjust(by)
        elapsed += by
      }
      if (fiber.pollUnsafe() === undefined) throw new Error(`still running after ${limit} ms of virtual time`)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())))
  )
}

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected success, got ${String(exit.cause)}`)
}

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isFailure(exit)) {
    const reason = exit.cause.reasons[0]
    if (reason && reason._tag === "Fail") return reason.error
  }
  throw new Error(`expected a typed failure, got ${Exit.isSuccess(exit) ? "success" : String(exit.cause)}`)
}

/** A wallet-shaped signer that counts prompts. */
const countingSigner = () => {
  const state = { prompts: 0 }
  const signer: SessionKey.PersonalMessageSigner = {
    address: user.address,
    signPersonalMessage: (message) =>
      Effect.suspend(() => {
        state.prompts++
        return Signer.signPersonalMessage(user, message)
      })
  }
  return { signer, state }
}

const approvalFor = (ids: ReadonlyArray<Uint8Array>) => Result.getOrThrow(Approval.fromBytes(approvalPtb({ packageId: PKG, ids })))
const ID = unhex("0102")
const approval = approvalFor([ID])

/** A fake world plus everything a fetch needs. */
const world = (options: ReadonlyArray<FakeKeyServerOptions>, keyServers?: (servers: ReadonlyArray<KeyServer.KeyServer>) => Layer.Layer<KeyServer.KeyServers>) => {
  const w = fakeKeyServers(options)
  const prompts = countingSigner()
  const layer = Layer.merge(w.api(), keyServers ? keyServers(w.servers) : KeyServer.layerFromServers(w.servers))
  const ids = w.servers.map((s) => s.objectId)
  const fetchRequests = () => w.requests.filter((r) => r.path === "/v1/fetch_key")
  const to = (i: number) => fetchRequests().filter((r) => r.origin === new URL(w.servers[i]!.url).origin).length
  return { ...w, layer, prompts, ids, fetchRequests, to }
}

const session = (signer: SessionKey.MessageSigner, ttl: Duration.Input = "10 minutes") =>
  Effect.orDie(SessionKey.make({ packageId: PKG, signer, ttl }))

const weighted = (ids: ReadonlyArray<Address.Address>, weights?: ReadonlyArray<number>) =>
  ids.map((objectId, i) => ({ objectId, weight: weights?.[i] ?? 1 }))

const reply = (e: { error: string; message: string }) => ({ status: statusOf(e.error), body: e, contentType: "application/json" })
const deny = () => keyServerErrors.noAccess("MoveAbort(...)")

const serversOf = (keys: ReadonlyArray<Keys.DerivedKey>) => [...new Set(keys.map((k) => k.server))]

// -----------------------------------------------------------------------------
// Cases
// -----------------------------------------------------------------------------

describe("Keys.fetch", () => {
  test("returns at the threshold, keys verified, stragglers interrupted", async () => {
    const w = world([
      { intercept: () => ({ delay: "100 millis" }) },
      { intercept: () => ({ delay: "200 millis" }) },
      { intercept: () => ({ delay: "5 seconds" }) }
    ])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      const keys = yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 2 })
      return { keys, size: yield* SessionKey.keyCache(s).size }
    }))
    expect(r.at).toBe(200)
    const { keys, size } = value(r.exit)
    expect(serversOf(keys)).toEqual([w.ids[0]!, w.ids[1]!])
    const fullId = Kdf.fullId(PKG, ID)
    for (const k of keys) {
      const server = w.servers.find((s) => s.objectId === k.server)!
      expect(k.fullId).toEqual(fullId)
      expect(k.key).toEqual(Bls.g1ToBytes(Ibe.extract(server.masterKey, fullId)))
    }
    expect(size).toBe(2) // the straggler's key never arrived
    expect(w.to(2)).toBe(1)
    expect(w.prompts.state.prompts).toBe(1)
  })

  test("weights: a server weighing the threshold suffices alone", async () => {
    const w = world([
      { intercept: () => ({ delay: "100 millis" }) },
      { intercept: () => ({ delay: "200 millis" }) },
      { intercept: () => ({ delay: "300 millis" }) }
    ])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      return yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids, [3, 1, 1]), threshold: 3 })
    }))
    expect(r.at).toBe(100)
    expect(serversOf(value(r.exit))).toEqual([w.ids[0]!])
  })

  test("cached keys lower the threshold; everything cached sends nothing and prompts nobody", async () => {
    const w = world([
      { intercept: () => ({ delay: "100 millis" }) },
      { intercept: () => ({ delay: "400 millis" }) },
      { intercept: () => ({ delay: "200 millis" }) }
    ])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      const first = yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1 })
      const t1 = yield* Clock.currentTimeMillis
      const second = yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 2 })
      const t2 = yield* Clock.currentTimeMillis
      const requestsBefore = w.fetchRequests().length
      const third = yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 2 })
      const t3 = yield* Clock.currentTimeMillis
      const cachedNow = yield* Keys.cached(s, Kdf.fullId(PKG, ID))
      return { first, second, third, t1, t2, t3, requestsBefore, cachedNow }
    }))
    const v = value(r.exit)
    expect([v.t1 - T0, v.t2 - T0, v.t3 - T0]).toEqual([100, 300, 300])
    expect(r.at).toBe(300)
    expect(serversOf(v.first)).toEqual([w.ids[0]!])
    // the second fetch asked only the two others and returned at the faster one
    expect(serversOf(v.second)).toEqual([w.ids[0]!, w.ids[2]!])
    expect(w.to(0)).toBe(1)
    expect(w.fetchRequests().length).toBe(v.requestsBefore)
    expect(serversOf(v.third)).toEqual([w.ids[0]!, w.ids[2]!])
    expect(v.cachedNow.map((k) => k.server).sort()).toEqual([w.ids[0]!, w.ids[2]!].sort())
    expect(w.prompts.state.prompts).toBe(1)
  })

  test("everything cached: no request and no prompt at all", async () => {
    const w = world([{}, {}])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      const cache = SessionKey.keyCache(s)
      const fullId = Kdf.fullId(PKG, ID)
      for (const server of w.servers) {
        yield* cache.set(fullId, server.objectId, Bls.g1ToBytes(Ibe.extract(server.masterKey, fullId)))
      }
      return yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 2 })
    }))
    expect(r.at).toBe(0)
    expect(value(r.exit)).toHaveLength(2)
    expect(w.requests).toHaveLength(0)
    expect(w.prompts.state.prompts).toBe(0)
  })

  test("an expired session fails even when everything is cached (item 10)", async () => {
    const w = world([{}])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer, "1 minute")
      yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1 })
      yield* Effect.sleep("40 seconds") // createdAt = T0 − 10 s; expired from T0 + 40 s (10 s margin)
      return yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1 })
    }), { step: 1000 })
    expect(r.at).toBe(40_000)
    expect(failure(r.exit)).toBeInstanceOf(SessionKeyExpired)
    expect(w.fetchRequests()).toHaveLength(1)
  })

  for (
    const [name, first] of [
      ["503 Failure", reply(keyServerErrors.failure())],
      ["InvalidParameter", reply(keyServerErrors.invalidParameter("object not found"))],
      ["429", { status: 429, body: "Too Many Requests" }]
    ] as const
  ) {
    test(`transient ${name} then 200: retried on that server after 250 ms`, async () => {
      const w = world([{ intercept: (_r, n) => n === 1 ? first : undefined }, { intercept: () => "hang" }])
      const r = await timed(w.layer, Effect.gen(function*() {
        const s = yield* session(w.prompts.signer)
        return yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1 })
      }))
      expect(r.at).toBe(250)
      expect(serversOf(value(r.exit))).toEqual([w.ids[0]!])
      expect(w.to(0)).toBe(2)
    })
  }

  test("retries follow the schedule: 250, 500, 1000 ms, then the failure is final", async () => {
    const w = world([{ intercept: () => reply(keyServerErrors.failure()) }])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      return yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1 })
    }))
    expect(r.at).toBe(1750)
    const e = failure(r.exit) as ThresholdNotMet
    expect(e.reason).toBe("unreachable")
    expect(e.failures.map((f) => f.error.kind)).toEqual(["Unavailable"])
    expect(w.to(0)).toBe(4)
  })

  test("Timeout and definitive errors are not retried", async () => {
    const w = world([{ intercept: () => "hang" }, { policy: deny }, { intercept: () => ({ delay: "12 seconds" }) }, {}])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      return yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids, [1, 1, 1, 0]), threshold: 2 })
    }))
    // NoAccess at 0 (definitive, weight 1 < 2: no give-up), timeout at 10 s → unreachable
    expect(r.at).toBe(10_000)
    const e = failure(r.exit) as ThresholdNotMet
    expect(e.failures.map((f) => f.error.kind)).toEqual(["NoAccess", "Timeout"])
    expect(e.reason).toBe("unreachable")
    expect(e.unsettled).toEqual([{ server: w.ids[2]!, weight: 1, started: true }])
    expect(w.to(0)).toBe(1)
    expect(w.to(1)).toBe(1)
    expect(w.to(3)).toBe(0) // weight 0: never asked
  })

  test("a key for another id or from another master key is InvalidKey; the others are used (item 9)", async () => {
    const w = world([{ intercept: () => "wrong-id" }, { intercept: () => "wrong-key" }, { intercept: () => ({ delay: "50 millis" }) }])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      const keys = yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1 })
      return { keys, size: yield* SessionKey.keyCache(s).size }
    }))
    expect(r.at).toBe(50)
    expect(serversOf(value(r.exit).keys)).toEqual([w.ids[2]!])
    expect(value(r.exit).size).toBe(1)

    const all = world([{ intercept: () => "wrong-id" }, { intercept: () => "wrong-key" }])
    const r2 = await timed(all.layer, Effect.gen(function*() {
      const s = yield* session(all.prompts.signer)
      return yield* Keys.fetch({ session: s, approval, servers: weighted(all.ids), threshold: 1 })
    }))
    expect(r2.at).toBe(0)
    const e = failure(r2.exit) as ThresholdNotMet
    expect(e.failures.map((f) => [f.error.server, f.error.kind])).toEqual([[all.ids[0]!, "InvalidKey"], [all.ids[1]!, "InvalidKey"]])
    expect(e.reason).toBe("unreachable")
  })

  test("a missing id is MissingKey, never undefined (item 7); duplicate ids are asked once", async () => {
    const ID2 = unhex("0304")
    const two = approvalFor([ID, ID, ID2])
    const w = world([{ intercept: () => "missing-key" }, { intercept: () => ({ delay: "30 millis" }) }])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      return yield* Keys.fetch({ session: s, approval: two, servers: weighted(w.ids), threshold: 1 })
    }))
    expect(r.at).toBe(30)
    const keys = value(r.exit)
    expect(keys.map((k) => hex(k.fullId))).toEqual([hex(Kdf.fullId(PKG, ID)), hex(Kdf.fullId(PKG, ID2))])

    const only = world([{ intercept: () => "missing-key" }])
    const r2 = await timed(only.layer, Effect.gen(function*() {
      const s = yield* session(only.prompts.signer)
      return yield* Keys.fetch({ session: s, approval: approvalFor([ID, ID2]), servers: weighted(only.ids), threshold: 1 })
    }))
    expect(r2.at).toBe(0)
    const e = failure(r2.exit) as ThresholdNotMet
    expect(e).toBeInstanceOf(ThresholdNotMet)
    expect(e.failures[0]!.error.kind).toBe("MissingKey")
  })

  test("ThresholdNotMet lists every server's error, kinds and the reason table (§4.7 step 6)", async () => {
    // 3 of 3, one NoAccess: the quorum stops as unreachable, but the denial explains it.
    const a = world([{ policy: deny }, { intercept: () => ({ delay: "1 second" }) }, { intercept: () => ({ delay: "1 second" }) }])
    const ra = await timed(a.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(a.prompts.signer), approval, servers: weighted(a.ids), threshold: 3 })
    }))
    expect(ra.at).toBe(0)
    const ea = failure(ra.exit) as ThresholdNotMet
    expect(ea.reason).toBe("denied")
    expect(ea.unsettled.map((u) => [u.server, u.started])).toEqual([[a.ids[1]!, true], [a.ids[2]!, true]])
    expect(ea.message).toBe("threshold 3 not met: 0 reached, denied by 1 (NoAccess), 2 unsettled (total 3)")

    // 2 of 3, one NoAccess and two servers down: unreachable.
    const b = world([{ policy: deny }, { intercept: () => "network-error" }, { intercept: () => ({ status: 502, body: "bad gateway" }) }])
    const rb = await timed(b.layer, Effect.gen(function*() {
      return yield* Keys.fetch({
        session: yield* session(b.prompts.signer),
        approval,
        servers: weighted(b.ids),
        threshold: 2,
        retry: Keys.defaultRetry()
      })
    }))
    const eb = failure(rb.exit) as ThresholdNotMet
    expect(eb.reason).toBe("unreachable")
    // the network error is retried 250 + 500 + 1000 ms before it is final
    expect(rb.at).toBe(1750)
    expect(eb.failures.map((f) => f.error.kind)).toEqual(["NoAccess", "Unavailable"])
    expect(eb.kinds).toEqual([["NoAccess", 1], ["Unavailable", 1]])
    expect(eb.weight).toBe(0)
    expect(eb.totalWeight).toBe(3)

    // 2 of 3, two NoAccess: denied, at once (giveUp weight 2 reached and the threshold unreachable).
    const c = world([{ policy: deny }, { policy: deny }, { intercept: () => "hang" }])
    const rc = await timed(c.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(c.prompts.signer), approval, servers: weighted(c.ids), threshold: 2 })
    }))
    expect(rc.at).toBe(0)
    const ec = failure(rc.exit) as ThresholdNotMet
    expect(ec.reason).toBe("denied")
    expect(ec.kinds).toEqual([["NoAccess", 2]])
    expect(ec.failures.every((f) => f.error.message.startsWith("Access denied"))).toBe(true)
  })

  test("insufficientWeight sends nothing and prompts nobody", async () => {
    const w = world([{}, {}])
    const r = await timed(w.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w.prompts.signer), approval, servers: weighted(w.ids), threshold: 3 })
    }))
    expect(r.at).toBe(0)
    const e = failure(r.exit) as ThresholdNotMet
    expect(e.reason).toBe("insufficientWeight")
    expect(e.totalWeight).toBe(2)
    expect(e.unsettled.map((u) => u.started)).toEqual([false, false])
    expect(w.requests).toHaveLength(0)
    expect(w.prompts.state.prompts).toBe(0)
  })

  test("early stop: 1 of 3 with two NoAccess and a hung server fails at the grace, not the timeout", async () => {
    const w = world([{ policy: deny }, { intercept: () => ({ delay: "300 millis", then: reply(deny()) }) }, { intercept: () => "hang" }])
    const r = await timed(w.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w.prompts.signer), approval, servers: weighted(w.ids), threshold: 1 })
    }))
    expect(r.at).toBe(2000) // first denial at 0 + 2 s grace
    const e = failure(r.exit) as ThresholdNotMet
    expect(e.reason).toBe("denied")
    expect(e.failures.map((f) => f.error.kind)).toEqual(["NoAccess", "NoAccess"])
    expect(e.unsettled).toEqual([{ server: w.ids[2]!, weight: 1, started: true }])

    // a custom grace
    const w2 = world([{ policy: deny }, { intercept: () => "hang" }])
    const r2 = await timed(w2.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w2.prompts.signer), approval, servers: weighted(w2.ids), threshold: 1, denialGrace: "500 millis" })
    }))
    expect(r2.at).toBe(500)
    expect((failure(r2.exit) as ThresholdNotMet).reason).toBe("denied")
  })

  test("a lagging denial followed by an approval inside the grace succeeds", async () => {
    const w = world([{ policy: deny }, { intercept: () => ({ delay: "1500 millis" }) }])
    const r = await timed(w.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w.prompts.signer), approval, servers: weighted(w.ids), threshold: 1 })
    }))
    expect(r.at).toBe(1500)
    expect(serversOf(value(r.exit))).toEqual([w.ids[1]!])
  })

  test("2 of 3 is unaffected by the early stop: one denial waits for the slow server", async () => {
    const w = world([{ policy: deny }, {}, { intercept: () => ({ delay: "5 seconds" }) }])
    const r = await timed(w.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w.prompts.signer), approval, servers: weighted(w.ids), threshold: 2 })
    }))
    expect(r.at).toBe(5000)
    expect(serversOf(value(r.exit))).toEqual([w.ids[1]!, w.ids[2]!])
  })

  test("committee server: the aggregator URL and the API key header", async () => {
    const w = world([{ type: "Committee", url: "https://aggregator.test", apiKey: { name: "x-api-key", value: "secret-1" }, intercept: () => ({ delay: "20 millis" }) }])
    const r = await timed(w.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w.prompts.signer), approval, servers: weighted(w.ids), threshold: 1 })
    }))
    expect(r.at).toBe(20)
    expect(value(r.exit)).toHaveLength(1)
    const [req] = w.fetchRequests() as ReadonlyArray<FakeRequest>
    expect(req!.origin).toBe("https://aggregator.test")
    expect(req!.headers["x-api-key"]).toBe("secret-1")
    expect(req!.headers["client-sdk-type"]).toBe("typescript")
  })

  test("an unloadable key server object, or one with no URL, is Unresolved and does not sink the fetch", async () => {
    const missing = Address.normalize("0x" + "ee".repeat(32))
    const w = world([{}, {}, { intercept: () => ({ delay: "40 millis" }) }], (servers) =>
      KeyServer.layerFromServers([servers[0]!, { ...servers[1]!, url: undefined }, servers[2]!]))
    const r = await timed(w.layer, Effect.gen(function*() {
      return yield* Keys.fetch({
        session: yield* session(w.prompts.signer),
        approval,
        servers: [{ objectId: missing, weight: 1 }, { objectId: w.ids[1]!, weight: 1 }, ...weighted([w.ids[0]!, w.ids[2]!])],
        threshold: 2
      })
    }))
    expect(r.at).toBe(40)
    expect(serversOf(value(r.exit))).toEqual([w.ids[0]!, w.ids[2]!])
    expect(w.to(1)).toBe(0)

    const only = world([{}], () => KeyServer.layerFromServers([]))
    const r2 = await timed(only.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(only.prompts.signer), approval, servers: weighted(only.ids), threshold: 1 })
    }))
    expect(r2.at).toBe(0)
    const e = failure(r2.exit) as ThresholdNotMet
    expect(e.failures[0]!.error.kind).toBe("Unresolved")
    expect(e.failures[0]!.error.message).toContain("object not found")
  })

  test("a retryable RpcError while loading the key server is Unavailable and retried", async () => {
    let loads = 0
    const w = world([{}], (servers) => {
      const inner = KeyServer.layerFromServers(servers)
      return Layer.effect(
        KeyServer.KeyServers,
        Effect.gen(function*() {
          const ks = yield* Effect.service(KeyServer.KeyServers)
          const get = (id: Address.Address) =>
            Effect.suspend(() =>
              ++loads === 1 ? Effect.fail(new RpcError({ method: "GetObject", code: "UNAVAILABLE", message: "down" })) : ks.get(id)
            )
          return KeyServer.KeyServers.of({ get, refresh: get })
        })
      ).pipe(Layer.provide(inner))
    })
    const r = await timed(w.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w.prompts.signer), approval, servers: weighted(w.ids), threshold: 1 })
    }))
    expect(r.at).toBe(250)
    expect(value(r.exit)).toHaveLength(1)
    expect(loads).toBe(2)
  })

  test("Keys.forget empties the session's cache; the next fetch asks again", async () => {
    const w = world([{}])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1 })
      yield* Keys.forget(s)
      const after = yield* Keys.cached(s, Kdf.fullId(PKG, ID))
      yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1 })
      return after
    }))
    expect(r.at).toBe(0)
    expect(value(r.exit)).toEqual([])
    expect(w.fetchRequests()).toHaveLength(2)
    expect(w.prompts.state.prompts).toBe(1)
  })

  test("a session without signer fails with SignatureRequired before any request", async () => {
    const w = world([{}])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* Effect.orDie(SessionKey.make({ packageId: PKG, address: user.address }))
      return yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1 })
    }))
    expect(r.at).toBe(0)
    expect((failure(r.exit) as { _tag: string })._tag).toBe("SignatureRequired")
    expect(w.requests).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// Parity: requests (§6.2)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Review fixes (docs/review/seal.md)
// -----------------------------------------------------------------------------

/** One `decryption_keys` entry for `id`, encrypted to the request's ElGamal key with the server's master key. */
const entryFor = (req: FakeRequest, masterKey: Bls.Scalar, id: Uint8Array) => {
  const encKey = b64(JSON.parse(req.body!).enc_key)
  const fullId = Kdf.fullId(PKG, id)
  const ct = Result.getOrThrow(ElGamal.encrypt(encKey, Ibe.extract(masterKey, fullId), 12345n))
  return { id: Array.from(fullId), encrypted_key: [toB64(ct[0]), toB64(ct[1])] }
}
const keysReply = (entries: ReadonlyArray<unknown>) => ({
  status: 200,
  body: { decryption_keys: entries },
  contentType: "application/json",
  headers: { "x-keyserver-version": "0.6.16" }
})

describe("Keys.fetch: review fixes", () => {
  test("SEAL-1: a server repeating one valid entry 1,000 times is Malformed at once, nothing verified", async () => {
    let masterKey!: Bls.Scalar
    const w = world([{
      intercept: (req) => {
        const entry = entryFor(req, masterKey, ID)
        return keysReply(Array.from({ length: 1000 }, () => entry))
      }
    }, {
      intercept: () => ({ delay: "100 millis" })
    }])
    masterKey = w.servers[0]!.masterKey
    const started = performance.now()
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      return yield* Effect.flip(Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 2 }))
    }))
    // Before the fix this verified every copy: about 14 s of blocked event loop.
    expect(performance.now() - started).toBeLessThan(3000)
    const e = value(r.exit) as ThresholdNotMet
    expect(e.failures.map((f) => [f.error.server, f.error.kind])).toEqual([[w.ids[0]!, "Malformed"]])
    expect(e.failures[0]!.error.message).toContain("1000 entries for 1 commands")
  })

  test("SEAL-1: within the command count, the first entry for an id decides and later copies are not decoded", async () => {
    const ID2 = unhex("0304")
    let masterKey!: Bls.Scalar
    const w = world([{
      intercept: (req) =>
        keysReply([
          entryFor(req, masterKey, ID),
          // a copy for the same id that is not even a curve point: skipped, never decoded
          { id: Array.from(Kdf.fullId(PKG, ID)), encrypted_key: [toB64(new Uint8Array(48).fill(7)), toB64(new Uint8Array(48).fill(7))] },
          entryFor(req, masterKey, ID2)
        ])
    }])
    masterKey = w.servers[0]!.masterKey
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      return yield* Keys.fetch({ session: s, approval: approvalFor([ID, ID2, ID]), servers: weighted(w.ids), threshold: 1 })
    }))
    const keys = value(r.exit)
    expect(keys.map((k) => hex(k.fullId))).toEqual([hex(Kdf.fullId(PKG, ID)), hex(Kdf.fullId(PKG, ID2))])
    expect(keys.map((k) => hex(k.key))).toEqual([ID, ID2].map((id) => hex(Bls.g1ToBytes(Ibe.extract(masterKey, Kdf.fullId(PKG, id))))))
  })

  test("SEAL-1/SEAL-9: one wrong key among several of one server is InvalidKey (batched check)", async () => {
    const ids = [unhex("01"), unhex("02"), unhex("03"), unhex("04")]
    let masterKey!: Bls.Scalar
    const other = 777n
    const w = world([{
      intercept: (req) => keysReply(ids.map((id, i) => entryFor(req, i === 2 ? other : masterKey, id)))
    }])
    masterKey = w.servers[0]!.masterKey
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      return yield* Effect.flip(Keys.fetch({ session: s, approval: approvalFor(ids), servers: weighted(w.ids), threshold: 1 }))
    }))
    expect((value(r.exit) as ThresholdNotMet).failures.map((f) => f.error.kind)).toEqual(["InvalidKey"])
  })

  test("SEAL-3: reason is denied when a cached server, a denial and a healthy server make 3 of 3 unreachable", async () => {
    let denyB = false
    const w = world([{}, { intercept: () => denyB ? reply(deny()) : undefined }, {}])
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      yield* Keys.fetch({ session: s, approval, servers: weighted([w.ids[0]!]), threshold: 1 }) // A is now cached
      denyB = true
      return yield* Effect.flip(Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 3, denialGrace: 0 }))
    }))
    const e = value(r.exit) as ThresholdNotMet
    expect(e.reason).toBe("denied")
    expect(e.failures.map((f) => f.error.kind)).toEqual(["NoAccess"])
  })

  test("SEAL-4: no crypto.randomUUID (an insecure context): requests still go out, each with its own Request-Id", async () => {
    const w = world([{}, {}])
    const original = crypto.randomUUID
    ;(crypto as { randomUUID: unknown }).randomUUID = undefined
    try {
      const r = await timed(w.layer, Effect.gen(function*() {
        const s = yield* session(w.prompts.signer)
        return yield* Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 2 })
      }))
      expect(value(r.exit)).toHaveLength(2)
    } finally {
      ;(crypto as { randomUUID: unknown }).randomUUID = original
    }
    const ids = w.fetchRequests().map((q) => q.headers["request-id"])
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test("SEAL-4: a defect inside a member is Unavailable but not retried", async () => {
    const w = world([{}], () =>
      Layer.succeed(
        KeyServer.KeyServers,
        KeyServer.KeyServers.of({ get: () => Effect.die(new Error("boom")), refresh: () => Effect.die(new Error("boom")) })
      ))
    const r = await timed(w.layer, Effect.gen(function*() {
      const s = yield* session(w.prompts.signer)
      return yield* Effect.flip(Keys.fetch({ session: s, approval, servers: weighted(w.ids), threshold: 1, retry: Keys.defaultRetry() }))
    }))
    expect(r.at).toBe(0)
    const e = value(r.exit) as ThresholdNotMet
    expect(e.failures.map((f) => f.error.kind)).toEqual(["Unavailable"])
    expect(e.failures[0]!.error.message).toContain("unexpected defect")
  })

  test("SEAL-6: a transient proof-of-possession failure is retried like an unavailable server", async () => {
    let loads = 0
    const w = world([{}], (servers) =>
      Layer.effect(
        KeyServer.KeyServers,
        Effect.gen(function*() {
          const ks = yield* Effect.service(KeyServer.KeyServers)
          const get = (id: Address.Address) =>
            Effect.suspend(() =>
              ++loads === 1
                ? Effect.fail(new KeyServer.InvalidKeyServer({ objectId: id, reason: "proof of possession unavailable (Unavailable): 503", kind: "Unavailable" }))
                : ks.get(id)
            )
          return KeyServer.KeyServers.of({ get, refresh: get })
        })
      ).pipe(Layer.provide(KeyServer.layerFromServers(servers))))
    const r = await timed(w.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w.prompts.signer), approval, servers: weighted(w.ids), threshold: 1 })
    }))
    expect(r.at).toBe(250)
    expect(value(r.exit)).toHaveLength(1)
    expect(loads).toBe(2)
  })

  test("SEAL-15: a 429 with Retry-After is not asked again sooner", async () => {
    const w = world([{
      intercept: (_req, n) => n === 1 ? { ...reply(keyServerErrors.failure()), status: 429, headers: { "retry-after": "3" } } : undefined
    }])
    const r = await timed(w.layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w.prompts.signer), approval, servers: weighted(w.ids), threshold: 1 })
    }))
    expect(r.at).toBe(3000)
    expect(value(r.exit)).toHaveLength(1)
  })

  test("SEAL-15: no answer at all reloads the server once; a changed URL is asked at once", async () => {
    const w = world([{ url: "https://moved.test" }, { url: "https://old.test", intercept: () => "network-error" }])
    // The cached entry still has the old URL; the chain (refresh) has the new one.
    const stale = { ...w.servers[0]!, url: "https://old.test" }
    let refreshes = 0
    const layer = Layer.merge(
      w.api(),
      Layer.succeed(
        KeyServer.KeyServers,
        KeyServer.KeyServers.of({
          get: () => Effect.succeed(stale),
          refresh: () => Effect.sync(() => (refreshes++, w.servers[0]!))
        })
      )
    )
    const r = await timed(layer, Effect.gen(function*() {
      return yield* Keys.fetch({ session: yield* session(w.prompts.signer), approval, servers: weighted([w.ids[0]!]), threshold: 1 })
    }))
    expect(r.at).toBe(0)
    expect(value(r.exit)).toHaveLength(1)
    expect(refreshes).toBe(1)
  })
})

describe("request parity with @mysten/seal", () => {
  test("SealClient sends the same body and headers (Request-Id aside) for the same session, PTB and ElGamal draw", async () => {
    const keypair = Ed25519Keypair.fromSecretKey(userSecret)
    const w = fakeKeyServers([{ url: "https://key-server-0.test" }])
    const server = w.servers[0]!
    const ptb = approvalPtb({ packageId: PKG, ids: [ID] })
    const kindBytes = new Uint8Array([0, ...ptb])

    // Their session, signed, and the same session imported on our side.
    const Fresh = MystenSessionKey as unknown as new(o: object) => MystenSessionKey
    const fresh = new Fresh({ address: keypair.toSuiAddress(), packageId: PKG, ttlMin: 10, suiClient: {} })
    const { signature } = await keypair.signPersonalMessage(fresh.getPersonalMessage())
    const theirs = MystenSessionKey.import({ ...fresh.export(), personalMessageSignature: signature }, {} as never)

    // A chain with one V1 key server, as `retrieveKeyServers` reads it.
    type Struct = { serialize(v: object): { toBytes(): Uint8Array } }
    const { KeyServerMove, KeyServerMoveV1 } = (await import(`${"../../../node_modules/@mysten/seal/dist"}/bcs.mjs`)) as {
      KeyServerMove: Struct
      KeyServerMoveV1: Struct
    }
    const suiClient = {
      core: {
        getObject: async () => ({ object: { content: KeyServerMove.serialize({ id: server.objectId, firstVersion: 1, lastVersion: 1 }).toBytes() } }),
        getDynamicField: async () => ({
          dynamicField: { value: { bcs: KeyServerMoveV1.serialize({ name: server.name, url: server.url, keyType: 0, pk: server.publicKey }).toBytes() } }
        })
      }
    }
    const captured: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const client = new SealClient({
      suiClient: suiClient as never,
      serverConfigs: [{ objectId: server.objectId, weight: 1 }],
      fetch: (async (url: string, init: RequestInit) => {
        captured.push({ url, headers: init.headers as Record<string, string>, body: init.body as string })
        return new Response(JSON.stringify(keyServerErrors.failure()), { status: 503 })
      }) as never
    })

    // The ElGamal secret both sides draw: 48 bytes mapped to a scalar.
    const draw = seeded("parity-elgamal")(48)
    const blinding = seeded("blinding")
    const original = crypto.getRandomValues
    crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
      if (array === null) return array
      const bytes = array.byteLength === 48 ? draw : blinding(array.byteLength)
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes)
      return array
    }) as typeof crypto.getRandomValues
    try {
      await client.fetchKeys({ ids: [hex(ID)], txBytes: kindBytes, sessionKey: theirs, threshold: 1 }).catch(() => undefined)
    } finally {
      crypto.getRandomValues = original
    }
    expect(captured).toHaveLength(1)

    const layer = Layer.merge(w.api(), KeyServer.layerFromServers(w.servers))
    const r = await timed(layer, Effect.gen(function*() {
      const ours = yield* Effect.orDie(SessionKey.fromExported(theirs.export()))
      return yield* Keys.fetch({ session: ours, approval: approvalFor([ID]), servers: weighted([server.objectId]), threshold: 1 }).pipe(
        Effect.provideService(Entropy.Entropy, () => draw)
      )
    }), { start: Date.now() })
    expect(r.at).toBe(0)
    const sent = w.requests.find((q) => q.path === "/v1/fetch_key")!
    expect(sent.body).toBe(captured[0]!.body)
    expect(captured[0]!.url).toBe(`${server.url}/v1/fetch_key`)
    const lower = (h: Record<string, string>) =>
      Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => k !== "request-id" && k !== "content-length"))
    expect(lower(sent.headers)).toEqual(lower(captured[0]!.headers))
  })
})
