/**
 * `Seal` (§4.8) through `Seal.layer` against `fakeKeyServers`: key server
 * objects synthesized for the fake servers and served by an `Objects` stub,
 * so the layer reads them from "chain" exactly as it would from a full node.
 * Real clock (the fake servers answer at once).
 */
import * as Address from "@unconfirmed/sui/Address"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as Signer from "@unconfirmed/sui/Signer"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Approval from "../src/Approval.ts"
import * as Bls from "../src/Bls.ts"
import type * as Config from "../src/Config.ts"
import * as EncryptedObject from "../src/EncryptedObject.ts"
import * as Ibe from "../src/Ibe.ts"
import * as Kdf from "../src/Kdf.ts"
import type * as KeyServer from "../src/KeyServer.ts"
import * as Seal from "../src/Seal.ts"
import type * as SessionKey from "../src/SessionKey.ts"
import { keyServerObjects, objectsLayer, packageObject } from "./fixtures.ts"
import {
  accountBased,
  approvalPtb,
  fakeKeyServers,
  type FakeKeyServer,
  type FakeKeyServerOptions,
  keyServerErrors,
  unhex,
  utf8
} from "./support.ts"

const PKG = "0x" + "a1".repeat(32)
const PKG_V2 = "0x" + "a2".repeat(32)
const OTHER_PKG = "0x" + "a3".repeat(32)
const MISSING_PKG = "0x" + "a4".repeat(32)

const user = Effect.runSync(Ed25519.fromSecretKey(unhex("11".repeat(32))))
const other = Effect.runSync(Ed25519.fromSecretKey(unhex("22".repeat(32))))
/** `account_based`: the id is the BCS of the user's address. */
const ID = unhex(user.address.slice(2))
const OTHER_ID = unhex(other.address.slice(2))

const approvalFor = (ids: ReadonlyArray<Uint8Array>, packageId = PKG) =>
  Result.getOrThrow(Approval.fromBytes(approvalPtb({ packageId, ids })))

/** A wallet-shaped signer that counts prompts. */
const countingSigner = (key = user) => {
  const state = { prompts: 0 }
  const signer: SessionKey.PersonalMessageSigner = {
    address: key.address,
    signPersonalMessage: (message) =>
      Effect.suspend(() => {
        state.prompts++
        return Signer.signPersonalMessage(key, message)
      })
  }
  return { signer, state }
}

/**
 * Fake servers, their synthesized objects, packages (PKG and OTHER_PKG first
 * versions, PKG_V2 at version 2), and `Seal.layer` over them. `configure`
 * picks the configured servers (default: all, weight 1).
 */
const world = (
  options: ReadonlyArray<FakeKeyServerOptions>,
  configure: (servers: ReadonlyArray<FakeKeyServer>) => ReadonlyArray<Config.ServerInput> = (servers) =>
    servers.map((s) => ({ objectId: s.objectId })),
  extra: { readonly verifyKeyServers?: boolean } = {}
) => {
  const w = fakeKeyServers(options.map((o) => ({ policy: accountBased, ...o })))
  const objects = objectsLayer([], [
    ...keyServerObjects(w.servers),
    packageObject(PKG),
    packageObject(PKG_V2, 2n),
    packageObject(OTHER_PKG)
  ])
  const layer = Seal.layer({ servers: configure(w.servers), ...extra }).pipe(Layer.provideMerge(Layer.merge(objects.layer, w.layer)))
  const fetches = () => w.requests.filter((r) => r.path === "/v1/fetch_key")
  const to = (i: number) => fetches().filter((r) => r.origin === new URL(w.servers[i]!.url).origin).length
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    Effect.runPromiseExit(Effect.provide(effect, layer))
  return { ...w, objects, layer, fetches, to, run, ids: w.servers.map((s) => s.objectId) }
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

const data = utf8("My super secret message")

describe("Seal.encrypt / decrypt", () => {
  test("round trip through the layer, both DEMs; one prompt, keys from the threshold", async () => {
    const w = world([{}, {}, {}])
    const prompts = countingSigner()
    const r = value(await w.run(Effect.gen(function*() {
      const aes = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 2, aad: utf8("aad") })
      const hmac = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 2, dem: "Hmac256Ctr" })
      const session = yield* Seal.session({ packageId: PKG, signer: prompts.signer })
      const approval = approvalFor([ID])
      const a = yield* Seal.decrypt({ data: aes.encryptedObject, session, approval })
      const h = yield* Seal.decrypt({ data: hmac.encryptedObject, session, approval })
      return { aes, hmac, a, h }
    })))
    expect(r.a).toEqual(data)
    expect(r.h).toEqual(data)
    const aes = Result.getOrThrow(EncryptedObject.parse(r.aes.encryptedObject))
    expect(aes.ciphertext._tag).toBe("Aes256Gcm")
    expect(Result.getOrThrow(EncryptedObject.parse(r.hmac.encryptedObject)).ciphertext._tag).toBe("Hmac256Ctr")
    expect(Redacted.value(r.aes.key)).toHaveLength(32)
    expect(String(r.aes.key)).not.toContain(Array.from(Redacted.value(r.aes.key)).join(","))
    expect(prompts.state.prompts).toBe(1)
    expect(w.fetches().length).toBeGreaterThanOrEqual(2) // the second decrypt hit the cache for the servers that answered first
  })

  test("share order and multiplicity follow configuration, or the `servers` option", async () => {
    const w = world([{}, {}, {}], (servers) => servers.map((s, i) => ({ objectId: s.objectId, weight: [2, 1, 1][i]! })))
    const r = value(await w.run(Effect.gen(function*() {
      const configured = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 3 })
      const chosen = yield* Seal.encrypt({
        packageId: PKG,
        id: ID,
        data,
        threshold: 1,
        servers: [{ objectId: w.ids[2]!, weight: 1 }, { objectId: w.ids[0]!.toUpperCase().replace("0X", "0x"), weight: 3 }]
      })
      return { configured, chosen }
    })))
    const services = (bytes: Uint8Array) => Result.getOrThrow(EncryptedObject.parse(bytes)).services
    const [a, b, c] = w.ids
    expect(services(r.configured.encryptedObject)).toEqual([[a!, 1], [a!, 2], [b!, 3], [c!, 4]])
    expect(services(r.chosen.encryptedObject)).toEqual([[c!, 1], [a!, 2], [a!, 3], [a!, 4]])
  })

  test("weights come from the object: a server holding two shares meets threshold 2 alone", async () => {
    const w = world([{}, { intercept: () => "hang" }, { intercept: () => "hang" }])
    const r = value(await w.run(Effect.gen(function*() {
      const { encryptedObject } = yield* Seal.encrypt({
        packageId: PKG,
        id: ID,
        data,
        threshold: 2,
        servers: [{ objectId: w.ids[0]!, weight: 2 }, { objectId: w.ids[1]!, weight: 1 }, { objectId: w.ids[2]!, weight: 1 }]
      })
      const session = yield* Seal.session({ packageId: PKG, signer: user })
      return yield* Seal.decrypt({ data: encryptedObject, session, approval: approvalFor([ID]) })
    })))
    expect(r).toEqual(data)
  })

  test("invalid parameters are InvalidEncryption, before any chain read", async () => {
    const w = world([{}, {}])
    const cases: ReadonlyArray<Partial<Seal.EncryptOptions>> = [
      { packageId: "0x2" },
      { packageId: PKG.slice(2) },
      { threshold: 0 },
      { threshold: 3 },
      { threshold: 1.5 },
      { servers: [{ objectId: "0x1", weight: 1 }] },
      { servers: [{ objectId: PKG, weight: 0 }] },
      { servers: [{ objectId: PKG, weight: 1 }, { objectId: PKG, weight: 1 }] },
      { servers: [{ objectId: PKG, weight: 256 }], threshold: 1 }
    ]
    for (const c of cases) {
      const e = failure(await w.run(Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 2, ...c })))
      expect(e._tag).toBe("InvalidEncryption")
    }
    expect(w.objects.gets.size).toBe(0)
  })

  test("NotFirstVersion for an upgraded package (encrypt and session); checkPackage: false skips; reads are cached", async () => {
    const w = world([{}, {}])
    const r = await w.run(Effect.gen(function*() {
      const encrypt = yield* Effect.exit(Seal.encrypt({ packageId: PKG_V2, id: ID, data, threshold: 1 }))
      const session = yield* Effect.exit(Seal.session({ packageId: PKG_V2, signer: user }))
      const missing = yield* Effect.exit(Seal.session({ packageId: MISSING_PKG, signer: user }))
      const notAPackage = yield* Effect.exit(Seal.checkFirstVersion(w.ids[0]!))
      const malformed = yield* Effect.exit(Seal.session({ packageId: "0x2", signer: user }))
      const unchecked = yield* Seal.encrypt({ packageId: PKG_V2, id: ID, data, threshold: 1, checkPackage: false })
      yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 1 })
      yield* Seal.session({ packageId: PKG.toUpperCase().replace("0X", "0x"), signer: user })
      return { encrypt, session, missing, notAPackage, malformed, unchecked }
    }))
    const { encrypt, session, missing, notAPackage, malformed, unchecked } = value(r)
    expect(failure(encrypt)).toMatchObject({ _tag: "NotFirstVersion", packageId: PKG_V2, version: 2n })
    expect(failure(session)._tag).toBe("NotFirstVersion")
    expect(failure(missing)._tag).toBe("ObjectNotFound")
    expect(failure(notAPackage)._tag).toBe("ObjectNotFound")
    expect(failure(malformed)._tag).toBe("InvalidSessionKey")
    expect(Result.getOrThrow(EncryptedObject.parse(unchecked.encryptedObject)).packageId as string).toBe(PKG_V2)
    expect(w.objects.gets.get(PKG_V2)).toBe(1)
    expect(w.objects.gets.get(PKG)).toBe(1)
  })

  test("ApprovalMismatch for another package and for an id the approval lacks; nothing is sent", async () => {
    const w = world([{}, {}])
    const r = value(await w.run(Effect.gen(function*() {
      const mine = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 1 })
      const theirs = yield* Seal.encrypt({ packageId: OTHER_PKG, id: ID, data, threshold: 1 })
      const session = yield* Seal.session({ packageId: PKG, signer: user })
      const otherPackage = yield* Effect.exit(Seal.decrypt({ data: theirs.encryptedObject, session, approval: approvalFor([ID], OTHER_PKG) }))
      const otherId = yield* Effect.exit(Seal.decrypt({ data: mine.encryptedObject, session, approval: approvalFor([OTHER_ID]) }))
      const keys = yield* Effect.exit(Seal.derivedKeys({ data: mine.encryptedObject, session, approval: approvalFor([OTHER_ID]) }))
      const fetch = yield* Effect.exit(Seal.fetchKeys({ objects: [mine.encryptedObject, theirs.encryptedObject], session, approval: approvalFor([ID]) }))
      const garbage = yield* Effect.exit(Seal.decrypt({ data: new Uint8Array([1, 2, 3]), session, approval: approvalFor([ID]) }))
      return { otherPackage, otherId, keys, fetch, garbage }
    })))
    expect(failure(r.otherPackage)._tag).toBe("ApprovalMismatch")
    expect(failure(r.otherId)._tag).toBe("ApprovalMismatch")
    expect(failure(r.keys)._tag).toBe("ApprovalMismatch")
    expect(failure(r.fetch)._tag).toBe("ApprovalMismatch")
    expect(failure(r.garbage)._tag).toBe("InvalidCiphertext")
    expect(w.fetches()).toHaveLength(0)
  })

  test("a second decrypt in the same session makes no request and no prompt", async () => {
    const w = world([{}, {}, {}])
    const prompts = countingSigner()
    const r = value(await w.run(Effect.gen(function*() {
      const { encryptedObject } = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 3 })
      const session = yield* Seal.session({ packageId: PKG, signer: prompts.signer })
      const approval = approvalFor([ID])
      const first = yield* Seal.decrypt({ data: encryptedObject, session, approval })
      const sent = w.fetches().length
      const second = yield* Seal.decrypt({ data: Result.getOrThrow(EncryptedObject.parse(encryptedObject)), session, approval })
      return { first, second, sent }
    })))
    expect(r.first).toEqual(data)
    expect(r.second).toEqual(data)
    expect(r.sent).toBe(3)
    expect(w.fetches()).toHaveLength(3)
    expect(prompts.state.prompts).toBe(1)
  })

  test("denied: ThresholdNotMet with the servers' NoAccess", async () => {
    const w = world([{}, {}, {}])
    const e = failure(await w.run(Effect.gen(function*() {
      const { encryptedObject } = yield* Seal.encrypt({ packageId: PKG, id: OTHER_ID, data, threshold: 2 })
      const session = yield* Seal.session({ packageId: PKG, signer: user })
      return yield* Seal.decrypt({ data: encryptedObject, session, approval: approvalFor([OTHER_ID]) })
    })))
    expect(e._tag).toBe("ThresholdNotMet")
    if (e._tag !== "ThresholdNotMet") return
    expect(e.reason).toBe("denied")
    // 2 of 3: the second denial leaves too little weight, the third request is interrupted.
    expect(e.failures.length).toBeGreaterThanOrEqual(2)
    expect(e.failures.every((f) => f.error.kind === "NoAccess")).toBe(true)
    expect(e.failures[0]!.error.message).toContain("account_based")
  })

  test("servers the object names but the configuration lacks are never asked; too little weight is insufficientWeight", async () => {
    const w = world([{}, {}, {}], (servers) => [{ objectId: servers[0]!.objectId }])
    const r = value(await w.run(Effect.gen(function*() {
      const all = w.ids.map((objectId) => ({ objectId, weight: 1 }))
      const one = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 1, servers: all })
      const two = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 2, servers: all })
      const session = yield* Seal.session({ packageId: PKG, signer: user })
      const approval = approvalFor([ID])
      const ok = yield* Seal.decrypt({ data: one.encryptedObject, session, approval })
      const short = yield* Effect.exit(Seal.decrypt({ data: two.encryptedObject, session, approval }))
      return { ok, short }
    })))
    expect(r.ok).toEqual(data)
    expect(w.to(0)).toBe(1)
    expect(w.to(1) + w.to(2)).toBe(0)
    expect(failure(r.short)).toMatchObject({ _tag: "ThresholdNotMet", reason: "insufficientWeight", weight: 1, totalWeight: 1 })
  })
})

describe("review fixes", () => {
  test("SEAL-10: a hand-built object with a non-integer threshold is InvalidCiphertext, not a defect", async () => {
    const w = world([{}, {}])
    const e = failure(await w.run(Effect.gen(function*() {
      const enc = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 1 })
      const object = Result.getOrThrow(EncryptedObject.parse(enc.encryptedObject))
      const session = yield* Seal.session({ packageId: PKG, signer: user })
      return yield* Seal.decrypt({ data: { ...object, threshold: 1.5 }, session, approval: approvalFor([ID]) })
    })))
    expect(e._tag).toBe("InvalidCiphertext")
  })

  test("SEAL-6: with verifyKeyServers, a transient proof failure is retryable, retried by decrypt, and a proof is asked once", async () => {
    let failService = true
    const flaky = {
      intercept: (req: { readonly path: string }) => {
        if (!req.path.startsWith("/v1/service") || !failService) return undefined
        failService = false
        return { status: 503, body: keyServerErrors.failure(), contentType: "application/json" }
      }
    }
    const w = world([flaky, {}], undefined, { verifyKeyServers: true })
    const services = (i: number) =>
      w.requests.filter((r) => r.path.startsWith("/v1/service") && r.origin === new URL(w.servers[i]!.url).origin).length
    // encrypt needs every server: the transient failure surfaces, typed and retryable.
    const first = failure(await w.run(Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 2 })))
    expect(first._tag).toBe("InvalidKeyServer")
    expect((first as KeyServer.InvalidKeyServer).kind).toBe("Unavailable")
    expect((first as KeyServer.InvalidKeyServer).retryable).toBe(true)
    // In one layer: encrypt, then decrypt: each server proves once.
    const before = [services(0), services(1)]
    const enc = value(await w.run(Effect.gen(function*() {
      const e = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 2 })
      const session = yield* Seal.session({ packageId: PKG, signer: user })
      yield* Seal.decrypt({ data: e.encryptedObject, session, approval: approvalFor([ID]) })
      return e
    })))
    expect([services(0) - before[0]!, services(1) - before[1]!]).toEqual([1, 1])
    // A fresh layer whose first proof request fails: decrypt retries the server and succeeds.
    failService = true
    const plain = value(await w.run(Effect.gen(function*() {
      const session = yield* Seal.session({ packageId: PKG, signer: user })
      return yield* Seal.decrypt({ data: enc.encryptedObject, session, approval: approvalFor([ID]) })
    })))
    expect(plain).toEqual(data)
  })
})

describe("Seal.fetchKeys / derivedKeys", () => {
  test("fetchKeys over objects with two different server sets (account_based: one id): afterwards every decrypt is free", async () => {
    const w = world([{}, {}, {}])
    const prompts = countingSigner()
    const r = value(await w.run(Effect.gen(function*() {
      const a = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 2, servers: [{ objectId: w.ids[0]!, weight: 1 }, { objectId: w.ids[1]!, weight: 1 }] })
      const b = yield* Seal.encrypt({ packageId: PKG, id: ID, data: utf8("second"), threshold: 2, servers: [{ objectId: w.ids[1]!, weight: 1 }, { objectId: w.ids[2]!, weight: 1 }] })
      const session = yield* Seal.session({ packageId: PKG, signer: prompts.signer })
      const approval = approvalFor([ID])
      yield* Seal.fetchKeys({ objects: [a.encryptedObject, b.encryptedObject, a.encryptedObject], session, approval })
      const sent = w.fetches().length
      const da = yield* Seal.decrypt({ data: a.encryptedObject, session, approval })
      const db = yield* Seal.decrypt({ data: b.encryptedObject, session, approval })
      return { sent, da, db }
    })))
    // Two groups: {0, 1} then {1, 2}; server 1 is already complete for the second.
    expect(r.sent).toBe(3)
    expect([w.to(0), w.to(1), w.to(2)]).toEqual([1, 1, 1])
    expect(w.fetches()).toHaveLength(3)
    expect(r.da).toEqual(data)
    expect(r.db).toEqual(utf8("second"))
    expect(prompts.state.prompts).toBe(1)
  })

  test("derivedKeys: verified keys for the object's full id, weighing its threshold", async () => {
    const allow = { policy: () => true as const }
    const w = world([allow, allow, allow])
    const r = value(await w.run(Effect.gen(function*() {
      const { encryptedObject } = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 3 })
      const session = yield* Seal.session({ packageId: PKG, signer: user })
      // The approval covers another id too: only the object's keys come back.
      return yield* Seal.derivedKeys({ data: encryptedObject, session, approval: approvalFor([OTHER_ID, ID]) })
    })))
    const fullId = Kdf.fullId(Address.normalize(PKG), ID)
    expect(r).toHaveLength(3)
    for (const k of r) {
      const server = w.servers.find((s) => s.objectId === k.server)!
      expect(k.fullId).toEqual(fullId)
      expect(k.key).toEqual(Bls.g1ToBytes(Ibe.extract(server.masterKey, fullId)))
    }
  })
})

describe("Seal.decrypt: share consistency (C10)", () => {
  test("an unconfigured committee named by the object: its public key is read from chain, it is never asked (item 12)", async () => {
    const w = world([{}, {}, { type: "Committee", url: "https://aggregator.test" }], (servers) => servers.slice(0, 2).map((s) => ({ objectId: s.objectId })))
    const r = value(await w.run(Effect.gen(function*() {
      const servers = w.ids.map((objectId) => ({ objectId, weight: 1 }))
      const { encryptedObject } = yield* Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 2, servers })
      const session = yield* Seal.session({ packageId: PKG, signer: user })
      return yield* Seal.decrypt({ data: encryptedObject, session, approval: approvalFor([ID]), checkShareConsistency: true })
    })))
    expect(r).toEqual(data)
    expect(w.to(2)).toBe(0)
    expect(w.objects.gets.get(w.ids[2]!)).toBe(1)
  })

})
