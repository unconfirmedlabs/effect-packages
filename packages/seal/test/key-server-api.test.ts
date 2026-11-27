/**
 * `KeyServerApi` over an in-memory `HttpClient`: request method, path, headers
 * and body for both endpoints; every row of the §4.4 mapping, from bodies
 * recorded on testnet (`fixtures/key-server/recorded.json`) or built from
 * `errors.rs` (`synthesized.json`); timeouts under `TestClock`; server
 * versions; API keys kept out of errors. Then `fakeKeyServers` itself: a
 * hand-built request round-trips with the certificate and both signatures
 * checked (R1–R4), and each of its refusals.
 * Live (SUI_LIVE=1): `/v1/service` of Mysten's first testnet server.
 */
import { describe, expect, test } from "bun:test"
import * as Address from "@unconfirmed/sui/Address"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import { TestClock } from "effect/testing"
import * as Ibe from "../src/Ibe.ts"
import * as KeyServerApi from "../src/KeyServerApi.ts"
import {
  accountBased,
  approvalPtb,
  fakeKeyServers,
  type FakeKeyServerOptions,
  type FixtureResponse,
  hex,
  type Intercept,
  keyServerErrors,
  openKeys,
  recorded,
  statusOf,
  synthesized,
  testRequest,
  toB64,
  unhex
} from "./support.ts"

const R = recorded.responses
const S = synthesized.responses
const live = process.env.SUI_LIVE === "1"

const T0 = Date.UTC(2026, 10, 27, 12, 0, 0)
const PACKAGE = Address.normalize("0x" + "a1".repeat(32))
const userSecret = unhex("11".repeat(32))
const sessionSecret = unhex("22".repeat(32))

type Api = KeyServerApi.KeyServerApiService

/** A request from the fixed test user for `ids` (default: the user's own address, as `account_based` wants). */
const makeRequest = (o: { readonly ids?: (user: string) => ReadonlyArray<Uint8Array>; readonly creationTime?: number; readonly ttlMin?: number; readonly packageId?: string; readonly calledPackage?: string; readonly mvrName?: string; readonly signedName?: string; readonly function?: string } = {}) =>
  Effect.gen(function*() {
    const probe = yield* testRequest({ userSecret, sessionSecret, packageId: PACKAGE, ptb: new Uint8Array(), creationTime: T0 })
    const ids = (o.ids ?? ((u) => [unhex(u)]))(probe.user)
    const ptb = approvalPtb({ packageId: o.calledPackage ?? o.packageId ?? PACKAGE, ids, ...(o.function !== undefined && { function: o.function }) })
    return yield* testRequest({
      userSecret,
      sessionSecret,
      packageId: o.packageId ?? PACKAGE,
      ptb,
      creationTime: o.creationTime ?? T0 - 10_000,
      ...(o.ttlMin !== undefined && { ttlMin: o.ttlMin }),
      ...(o.mvrName !== undefined && { mvrName: o.mvrName }),
      ...(o.signedName !== undefined && { signedName: o.signedName })
    })
  }).pipe(Effect.orDie)

/** Run `f` against one fake server (at `T0` on a `TestClock`). */
const withServer = async <A, E>(
  server: FakeKeyServerOptions,
  f: (api: Api, endpoint: KeyServerApi.Endpoint) => Effect.Effect<A, E>,
  apiOptions?: KeyServerApi.KeyServerApiOptions
) => {
  const world = fakeKeyServers([server])
  const exit = await Effect.runPromiseExit(
    Effect.gen(function*() {
      yield* TestClock.setTime(T0)
      const api = yield* Effect.service(KeyServerApi.KeyServerApi)
      return yield* f(api, world.servers[0]!.endpoint)
    }).pipe(Effect.provide(Layer.merge(world.api(apiOptions), TestClock.layer())))
  )
  return { exit, requests: world.requests, server: world.servers[0]! }
}

/** A server that answers every request with `outcome`. */
const answering = (outcome: Intercept, extra: Partial<FakeKeyServerOptions> = {}): FakeKeyServerOptions => ({ ...extra, intercept: () => outcome })

const replyOf = (r: FixtureResponse): Intercept => ({
  status: r.status,
  body: r.body,
  ...(r.contentType !== null && { contentType: r.contentType }),
  ...(r.keyServerVersion !== null && { headers: { "x-keyserver-version": r.keyServerVersion } })
})

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`)
  return exit.value
}
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const e = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (!e || e._tag !== "Fail") throw new Error(`expected a typed failure, got ${String(exit.cause)}`)
  return e.error
}

const fetchKey = (o?: Parameters<typeof makeRequest>[0]) => (api: Api, endpoint: KeyServerApi.Endpoint) =>
  Effect.flatMap(makeRequest(o), ({ request }) => api.fetchKey(endpoint, request))
const service = (api: Api, endpoint: KeyServerApi.Endpoint) => api.service(endpoint)

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

describe("requests", () => {
  test("requestBody: the exact JSON of H5, @mysten/seal's field order, mvr_name omitted when absent", async () => {
    const { request } = await Effect.runPromise(makeRequest())
    const c = request.certificate
    expect(KeyServerApi.requestBody(request)).toBe(
      `{"ptb":"${toB64(request.ptb)}","enc_key":"${toB64(request.encKey)}","enc_verification_key":"${toB64(request.encVerificationKey)}",` +
        `"request_signature":"${toB64(request.requestSignature)}","certificate":{"user":"${c.user}","session_vk":"${toB64(c.sessionVk)}",` +
        `"creation_time":${c.creationTime},"ttl_min":10,"signature":"${toB64(c.signature)}"}}`
    )
    const withMvr = KeyServerApi.requestBody({ ...request, certificate: { ...c, mvrName: "@org/app" } })
    expect(withMvr.endsWith(`"signature":"${toB64(c.signature)}","mvr_name":"@org/app"}}`)).toBe(true)
  })

  test("fetch_key: POST /v1/fetch_key, exactly the headers of H3, body = requestBody", async () => {
    const { exit, requests } = await withServer({ url: "https://ks.test/" }, (api, endpoint) =>
      Effect.flatMap(makeRequest(), ({ request }) => Effect.map(api.fetchKey(endpoint, request), (keys) => ({ keys, request }))))
    const { request } = value(exit)
    const r = requests[0]!
    expect(r.method).toBe("POST")
    expect(r.url).toBe("https://ks.test/v1/fetch_key")
    const { "content-length": _len, ...headers } = r.headers
    expect(Object.keys(headers).sort()).toEqual(["client-sdk-type", "client-sdk-version", "content-type", "request-id"])
    expect(headers["content-type"]).toBe("application/json")
    expect(headers["client-sdk-type"]).toBe("typescript")
    expect(headers["client-sdk-version"]).toBe("2.0.1")
    expect(headers["request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(r.body).toBe(KeyServerApi.requestBody(request))
  })

  test("service: GET /v1/service?service_id=<object id>, same headers, no body", async () => {
    const { exit, requests, server } = await withServer({}, service)
    value(exit)
    const r = requests[0]!
    expect(r.method).toBe("GET")
    expect(r.path).toBe(`/v1/service?service_id=${server.objectId}`)
    expect(Object.keys(r.headers).sort()).toEqual(["client-sdk-type", "client-sdk-version", "content-type", "request-id"])
    expect(r.body).toBeUndefined()
  })

  test("API key header, SDK identity overrides, no trace headers even with a span", async () => {
    const { exit, requests } = await withServer(
      { apiKey: { name: "x-api-key", value: "secret-123" } },
      (api, endpoint) => Effect.withSpan(service(api, endpoint), "outer"),
      { sdkType: "rust", sdkVersion: "0.6.0" }
    )
    value(exit)
    const h = requests[0]!.headers
    expect(h["x-api-key"]).toBe("secret-123")
    expect(h["client-sdk-type"]).toBe("rust")
    expect(h["client-sdk-version"]).toBe("0.6.0")
    expect(h.traceparent).toBeUndefined()
    expect(h.b3).toBeUndefined()
  })

  test("tracerPropagation: true adds the trace headers", async () => {
    const { requests } = await withServer({}, (api, endpoint) => Effect.withSpan(service(api, endpoint), "outer"), { tracerPropagation: true })
    expect(requests[0]!.headers.traceparent).toBeDefined()
  })
})

// -----------------------------------------------------------------------------
// Successful answers
// -----------------------------------------------------------------------------

describe("answers", () => {
  test("recorded fetch_key answer: one entry per command, full id = package ‖ id, two 48-byte points", async () => {
    const r = R["fetch-key"]!
    const { exit } = await withServer(answering(replyOf(r)), fetchKey())
    const keys = value(exit)
    const body = JSON.parse(r.body) as { decryption_keys: Array<{ id: Array<number> }> }
    expect(keys.length).toBe(1)
    expect(hex(keys[0]!.fullId)).toBe(hex(Uint8Array.from(body.decryption_keys[0]!.id)))
    expect(hex(keys[0]!.fullId.subarray(0, 32))).toBe("58dce5d91278bceb65d44666ffa225ab397fc3ae9d8398c8c779c5530bd978c2")
    expect(keys[0]!.ciphertext[0].length).toBe(48)
    expect(keys[0]!.ciphertext[1].length).toBe(48)
  })

  test("recorded aggregator answer decodes the same way", async () => {
    const keys = value((await withServer(answering(replyOf(R["aggregator-fetch-key"]!)), fetchKey())).exit)
    expect(keys.length).toBe(1)
    expect(keys[0]!.fullId.length).toBe(64)
  })

  test("recorded service answer: id, 48-byte proof, version", async () => {
    const r = R["service"]!
    const info = value((await withServer(answering(replyOf(r)), service)).exit)
    expect(info.serviceId).toBe(Address.normalize("0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75"))
    expect(info.pop.length).toBe(48)
    expect(info.version).toBe("0.6.16")
  })

  test("a missing X-KeyServer-Version is accepted (H4)", async () => {
    const r = R["service"]!
    const info = value((await withServer(answering({ status: 200, body: r.body, contentType: "application/json" }), service)).exit)
    expect(info.version).toBeUndefined()
  })

  test("a version below minServerVersion is UnsupportedServerVersion; at it, accepted; the option moves it", async () => {
    const body = R["service"]!.body
    const at = (v: string, options?: KeyServerApi.KeyServerApiOptions) =>
      withServer(answering({ status: 200, body, headers: { "x-keyserver-version": v } }), service, options)
    const old = failure((await at("0.4.0")).exit)
    expect(old.kind).toBe("UnsupportedServerVersion")
    expect(old.status).toBe(200)
    expect(old.message).toContain("0.4.0")
    expect(value((await at("0.4.1")).exit).version).toBe("0.4.1")
    expect(failure((await at("0.6.15", { minServerVersion: "0.6.16" })).exit).kind).toBe("UnsupportedServerVersion")
    expect(failure((await at("garbage")).exit).kind).toBe("UnsupportedServerVersion")
  })

  test("2xx bodies that do not decode are Malformed", async () => {
    const cases: ReadonlyArray<[unknown, (api: Api, e: KeyServerApi.Endpoint) => Effect.Effect<unknown, KeyServerApi.KeyServerError>]> = [
      ["not json", fetchKey()],
      [{ keys: [] }, fetchKey()],
      [{ decryption_keys: [{ id: [1, 256], encrypted_key: ["AA==", "AA=="] }] }, fetchKey()],
      [{ decryption_keys: [{ id: [1], encrypted_key: ["AA=="] }] }, fetchKey()],
      [{ decryption_keys: [{ id: [1], encrypted_key: ["!!", "AA=="] }] }, fetchKey()],
      [{ service_id: "0x1", pop: toB64(new Uint8Array(48)) }, service],
      [{ service_id: "0x" + "00".repeat(32), pop: toB64(new Uint8Array(47)) }, service]
    ]
    for (const [body, f] of cases) {
      const { exit, requests } = await withServer(answering({ status: 200, body, contentType: "application/json" }), f)
      const e = failure(exit)
      expect(e.kind).toBe("Malformed")
      expect(e.status).toBe(200)
      expect(e.requestId).toBe(requests[0]!.headers["request-id"])
    }
  })
})

// -----------------------------------------------------------------------------
// The mapping (§4.4)
// -----------------------------------------------------------------------------

/** Every recorded and synthesized error, with the kind §4.4 assigns. */
const MAPPING: ReadonlyArray<readonly [string, FixtureResponse, KeyServerApi.KeyServerErrorKind]> = [
  ["service-unknown-id", R["service-unknown-id"]!, "InvalidServiceId"],
  ["aggregator-service (text 400)", R["aggregator-service"]!, "Rejected"],
  ["load-balancer-503 (HTML)", R["load-balancer-503"]!, "Unavailable"],
  ["no-access", R["no-access"]!, "NoAccess"],
  ["aggregator-no-access", R["aggregator-no-access"]!, "NoAccess"],
  ["invalid-ptb-function", R["invalid-ptb-function"]!, "InvalidPtb"],
  ["invalid-ptb-format", R["invalid-ptb-format"]!, "InvalidPtb"],
  ["invalid-package", R["invalid-package"]!, "InvalidPackage"],
  ["invalid-certificate", R["invalid-certificate"]!, "InvalidCertificate"],
  ["invalid-certificate-ttl", R["invalid-certificate-ttl"]!, "InvalidCertificate"],
  ["invalid-signature", R["invalid-signature"]!, "InvalidSignature"],
  ["invalid-session-signature", R["invalid-session-signature"]!, "InvalidSessionSignature"],
  ["invalid-mvr-name", R["invalid-mvr-name"]!, "InvalidMvrName"],
  ["invalid-parameter", R["invalid-parameter"]!, "InvalidParameter"],
  ["missing-required-header", R["missing-required-header"]!, "SdkRejected"],
  ["invalid-sdk-version", R["invalid-sdk-version"]!, "SdkRejected"],
  ["deprecated-sdk-version", R["deprecated-sdk-version"]!, "SdkRejected"],
  ["aggregator-invalid-sdk-type", R["aggregator-invalid-sdk-type"]!, "SdkRejected"],
  ["invalid-json (text 400)", R["invalid-json"]!, "Rejected"],
  ["invalid-body (text 422)", R["invalid-body"]!, "Rejected"],
  ["mainnet-aggregator-401 (gateway)", R["mainnet-aggregator-401"]!, "Unauthorized"],
  ["rate-limited (gateway)", S["rate-limited"]!, "RateLimited"],
  ["rate-limited-empty", S["rate-limited-empty"]!, "RateLimited"],
  ["rate-limited-seal-body", S["rate-limited-seal-body"]!, "RateLimited"],
  ["failure", S["failure"]!, "Unavailable"],
  ["unsupported-package-id", S["unsupported-package-id"]!, "UnsupportedPackage"]
]

const RETRYABLE = new Set(["Unavailable", "RateLimited", "InvalidParameter"])
const DEFINITIVE = new Set(["NoAccess", "InvalidPtb", "InvalidPackage", "InvalidSignature", "InvalidSessionSignature", "InvalidCertificate", "InvalidMvrName"])
const ENDPOINT: KeyServerApi.Endpoint = { objectId: Address.normalize("0x1"), url: "https://ks.test/" }

describe("error mapping", () => {
  test("every fixture is used", () => {
    const used = new Set(MAPPING.map(([, r]) => r))
    const errors = [...Object.values(R), ...Object.values(S)].filter((r) => r.status >= 300)
    expect(errors.filter((r) => !used.has(r))).toEqual([])
  })

  for (const [name, r, kind] of MAPPING) {
    test(`${name}: ${r.status} → ${kind}`, async () => {
      const parsed = (() => {
        try {
          return JSON.parse(r.body) as { error?: string; message?: string }
        } catch {
          return {}
        }
      })()
      // The pure mapping.
      const pure = KeyServerApi.fromResponse(ENDPOINT, r.status, r.body, "req-1")
      expect(pure.kind).toBe(kind)
      expect(pure.status).toBe(r.status)
      expect(pure.server).toBe(ENDPOINT.objectId)
      expect(pure.url).toBe("https://ks.test")
      expect(pure.requestId).toBe("req-1")
      expect(pure.error).toBe(typeof parsed.error === "string" ? parsed.error : undefined)
      expect(pure.message).toBe(typeof parsed.message === "string" ? parsed.message : r.body.trim().slice(0, 500) || `HTTP ${r.status}`)
      expect(pure.retryable).toBe(RETRYABLE.has(kind))
      expect(pure.definitive).toBe(DEFINITIVE.has(kind))
      expect(KeyServerApi.retryable(pure)).toBe(pure.retryable)
      expect(KeyServerApi.definitive(pure)).toBe(pure.definitive)
      // Through the layer, on the endpoint the body came from.
      const f: (api: Api, e: KeyServerApi.Endpoint) => Effect.Effect<unknown, KeyServerApi.KeyServerError> = r.method === "GET" ? service : fetchKey()
      const { exit, requests } = await withServer(answering(replyOf(r)), f)
      const e = failure(exit)
      expect(e._tag).toBe("KeyServerError")
      expect(e.kind).toBe(kind)
      expect(e.status).toBe(r.status)
      expect(e.message).toBe(pure.message)
      expect(e.requestId).toBe(requests[0]!.headers["request-id"])
    })
  }

  test("NoAccess and InvalidParameter keep the server's detail (§1.7)", () => {
    expect(KeyServerApi.fromResponse(ENDPOINT, 403, R["no-access"]!.body).message).toContain("MoveAbort(MoveLocation")
    expect(KeyServerApi.fromResponse(ENDPOINT, 403, R["invalid-parameter"]!.body).message).toMatch(/Object 0x[0-9a-f]{64} not found/)
  })

  test("without a known Seal error name: 401/403 → Unauthorized, 5xx → Unavailable, other → Rejected; unknown names kept", () => {
    const unknown = JSON.stringify({ error: "SomethingNew", message: "a future error" })
    const cases: ReadonlyArray<readonly [number, string, KeyServerApi.KeyServerErrorKind]> = [
      [403, unknown, "Unauthorized"],
      [401, "", "Unauthorized"],
      [400, unknown, "Rejected"],
      [404, "", "Rejected"],
      [418, "<p>teapot</p>", "Rejected"],
      [302, "", "Rejected"],
      [500, "", "Unavailable"],
      [502, "Bad Gateway", "Unavailable"],
      [503, unknown, "Unavailable"],
      [200, '{"error":"NoAccess"}', "NoAccess"]
    ]
    for (const [status, body, kind] of cases) {
      const e = KeyServerApi.fromResponse(ENDPOINT, status, body)
      expect([status, e.kind]).toEqual([status, kind])
    }
    const e = KeyServerApi.fromResponse(ENDPOINT, 403, unknown)
    expect(e.error).toBe("SomethingNew")
    expect(e.message).toBe("a future error")
    expect(KeyServerApi.fromResponse(ENDPOINT, 500, "").message).toBe("HTTP 500")
    expect(KeyServerApi.fromResponse(ENDPOINT, 500, "x".repeat(2000)).message.length).toBe(500)
    expect(KeyServerApi.fromResponse(ENDPOINT, 403, '{"error":"toString"}').kind).toBe("Unauthorized")
  })

  test("transport failure → Unavailable, no status, retryable", async () => {
    const e = failure((await withServer(answering("network-error"), service)).exit)
    expect(e.kind).toBe("Unavailable")
    expect(e.status).toBeUndefined()
    expect(e.retryable).toBe(true)
  })

  test("a defect raised by the HttpClient → Unavailable, never a defect", async () => {
    const dying = Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die(new Error("boom"))))
    const throwing = Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => { throw new Error("thrown") }))
    for (const http of [dying, throwing]) {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(Effect.service(KeyServerApi.KeyServerApi), (api) => api.service(ENDPOINT)).pipe(Effect.provide(KeyServerApi.layer().pipe(Layer.provide(http))))
      )
      const e = failure(exit)
      expect(e.kind).toBe("Unavailable")
      expect(e.message).toContain("transport defect")
    }
  })

  test("timeout → Timeout at exactly 10 s by default, typed, not retryable (TestClock)", async () => {
    const world = fakeKeyServers([answering("hang")])
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const api = yield* Effect.service(KeyServerApi.KeyServerApi)
        const fiber = yield* Effect.forkChild(api.service(world.servers[0]!.endpoint))
        yield* TestClock.adjust("9999 millis")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 millis")
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(Layer.merge(world.api(), TestClock.layer())))
    )
    const e = failure(exit)
    expect(e.kind).toBe("Timeout")
    expect(e.status).toBeUndefined()
    expect(e.message).toContain("10s")
    expect(e.retryable).toBe(false)
    expect(e.definitive).toBe(false)
  })

  test("requestTimeout covers the whole answer: a slow server past it is a Timeout", async () => {
    const world = fakeKeyServers([answering({ delay: "3 seconds" })])
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(T0)
        const api = yield* Effect.service(KeyServerApi.KeyServerApi)
        const fiber = yield* Effect.forkChild(api.service(world.servers[0]!.endpoint))
        yield* TestClock.adjust("2 seconds")
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(Layer.merge(world.api({ requestTimeout: "2 seconds" }), TestClock.layer())))
    )
    expect(failure(exit).kind).toBe("Timeout")
  })

  test("an API key never appears in an error, even when a gateway echoes it", async () => {
    const key = "sk-live-abcdef123456"
    const echo = (api: Api, endpoint: KeyServerApi.Endpoint) => service(api, endpoint)
    const { exit } = await withServer(
      { apiKey: { name: "x-api-key", value: key }, intercept: (req) => ({ status: 403, body: { message: `bad key ${req.headers["x-api-key"]}` }, contentType: "application/json" }) },
      echo
    )
    const e = failure(exit)
    expect(e.kind).toBe("Unauthorized")
    expect(e.message).toBe("bad key <redacted>")
    expect(JSON.stringify(e)).not.toContain(key)
    expect(String(e)).not.toContain(key)
    // A wrong key: the fake gateway's recorded 401.
    const wrong = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const world = fakeKeyServers([{ apiKey: { name: "x-api-key", value: key } }])
        const api = yield* Effect.service(KeyServerApi.KeyServerApi).pipe(Effect.provide(world.api()))
        return yield* api.service({ ...world.servers[0]!.endpoint, apiKey: { name: "x-api-key", value: Redacted.make("other") } })
      })
    )
    const w = failure(wrong)
    expect(w.kind).toBe("Unauthorized")
    expect(w.message).toBe("No API key found in request")
  })
})

// -----------------------------------------------------------------------------
// fakeKeyServers
// -----------------------------------------------------------------------------

describe("fakeKeyServers", () => {
  test("round trip: a hand-built request is accepted (R1–R4 checked) and its keys verify against the server's public key", async () => {
    const world = fakeKeyServers([{ policy: accountBased }])
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(T0)
        const api = yield* Effect.service(KeyServerApi.KeyServerApi)
        const built = yield* makeRequest({ ids: (u) => [unhex(u), unhex(u)] })
        const keys = yield* api.fetchKey(world.servers[0]!.endpoint, built.request)
        return { keys, built }
      }).pipe(Effect.provide(Layer.merge(world.api(), TestClock.layer())))
    )
    const { keys, built } = result
    expect(keys.length).toBe(2)
    for (const k of keys) expect(hex(k.fullId)).toBe(PACKAGE.slice(2) + built.user.slice(2))
    expect(openKeys(keys, built.enc, world.servers[0]!.publicKey).map((k) => k.valid)).toEqual([true, true])
    // The personal message is R1's text.
    expect(new TextDecoder().decode(built.personalMessage)).toBe(
      `Accessing keys of package ${PACKAGE} for 10 mins from 2026-11-27 11:59:50 UTC, session key ${toB64(built.request.certificate.sessionVk)}`
    )
  })

  test("service answers a proof of possession that verifies for the server's object id", async () => {
    const { exit, server } = await withServer({}, service)
    const info = value(exit)
    expect(info.serviceId).toBe(server.objectId)
    expect(info.version).toBe("0.6.16")
    expect(Ibe.verifyProofOfPossession(info.pop, server.publicKey, server.objectId)).toBe(true)
    // Another id is InvalidServiceId.
    const other = await withServer({}, (api, e) => api.service({ ...e, objectId: Address.normalize("0x5") }))
    expect(failure(other.exit).kind).toBe("InvalidServiceId")
  })

  const refusals: ReadonlyArray<readonly [string, FakeKeyServerOptions, Parameters<typeof makeRequest>[0], KeyServerApi.KeyServerErrorKind]> = [
    ["creation time ahead of the server's clock (R2)", {}, { creationTime: T0 + 1 }, "InvalidCertificate"],
    ["expired certificate (R2)", {}, { creationTime: T0 - 10 * 60_000 - 1 }, "InvalidCertificate"],
    ["TTL above 30 minutes (R2)", {}, { ttlMin: 31 }, "InvalidCertificate"],
    ["personal message naming another package (R1)", {}, { signedName: Address.normalize("0x2") }, "InvalidSignature"],
    ["the policy denies (account_based, another id)", { policy: accountBased }, { ids: () => [new Uint8Array(32)] }, "NoAccess"],
    ["a function without the seal_approve prefix (P1)", {}, { function: "approve" }, "InvalidPtb"],
    ["permissioned server, other package", { packages: ["0x" + "bb".repeat(32)] }, {}, "UnsupportedPackage"],
    ["unknown MVR name", {}, { mvrName: "@org/unknown" }, "InvalidMvrName"]
  ]
  for (const [name, server, request, kind] of refusals) {
    test(`refuses: ${name} → ${kind}`, async () => {
      const e = failure((await withServer(server, fetchKey(request))).exit)
      expect(e.kind).toBe(kind)
      expect(e.status).toBe(statusOf(e.error!))
    })
  }

  test("refuses a tampered request signature (R4) and a certificate signed by someone else (R3)", async () => {
    const tampered = await withServer({}, (api, endpoint) =>
      Effect.flatMap(makeRequest(), ({ request }) => {
        const sig = request.requestSignature.slice()
        sig[5] = sig[5]! ^ 1
        return api.fetchKey(endpoint, { ...request, requestSignature: sig })
      }))
    expect(failure(tampered.exit).kind).toBe("InvalidSessionSignature")
    const impostor = await withServer({}, (api, endpoint) =>
      Effect.flatMap(makeRequest(), ({ request }) =>
        api.fetchKey(endpoint, { ...request, certificate: { ...request.certificate, user: Address.normalize("0x77") } })))
    expect(failure(impostor.exit).kind).toBe("InvalidSignature")
  })

  test("the certificate is valid until creation + ttl inclusive, by the server's Clock", async () => {
    const ok = await withServer({}, fetchKey({ creationTime: T0 - 10 * 60_000 }))
    expect(value(ok.exit).length).toBe(1)
  })

  test("I1: a request through an upgraded package gets keys for the first version; unknown packages are InvalidPackage", async () => {
    const V1 = PACKAGE
    const V2 = Address.normalize("0x" + "a2".repeat(32))
    const world = fakeKeyServers([{}], { packages: { [V2]: V1 } })
    const run = (o: Parameters<typeof makeRequest>[0]) =>
      Effect.runPromiseExit(
        Effect.gen(function*() {
          yield* TestClock.setTime(T0)
          const api = yield* Effect.service(KeyServerApi.KeyServerApi)
          const built = yield* makeRequest(o)
          return { keys: yield* api.fetchKey(world.servers[0]!.endpoint, built.request), built }
        }).pipe(Effect.provide(Layer.merge(world.api(), TestClock.layer())))
      )
    const upgraded = value(await run({ packageId: V1, calledPackage: V2 }))
    expect(hex(upgraded.keys[0]!.fullId.subarray(0, 32))).toBe(V1.slice(2))
    expect(openKeys(upgraded.keys, upgraded.built.enc, world.servers[0]!.publicKey)[0]!.valid).toBe(true)
    // The certificate must name the first version, not the called one.
    expect(failure(await run({ packageId: V2 })).kind).toBe("InvalidSignature")
    expect(failure(await run({ packageId: "0x" + "cc".repeat(32) })).kind).toBe("InvalidPackage")
  })

  test("a known MVR name pointing at the first version is accepted and signed instead of the id", async () => {
    const world = fakeKeyServers([{}], { mvr: { "@org/app": PACKAGE } })
    const keys = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(T0)
        const api = yield* Effect.service(KeyServerApi.KeyServerApi)
        const { request } = yield* makeRequest({ mvrName: "@org/app" })
        return yield* api.fetchKey(world.servers[0]!.endpoint, request)
      }).pipe(Effect.provide(Layer.merge(world.api(), TestClock.layer())))
    )
    expect(keys.length).toBe(1)
  })

  test("headers (H2): SDK version required and checked; a committee refuses unknown SDK types and has no /v1/service", async () => {
    expect(failure((await withServer({}, service, { sdkVersion: "nope" })).exit).kind).toBe("SdkRejected")
    expect(failure((await withServer({}, service, { sdkVersion: "0.4.4" })).exit).error).toBe("DeprecatedSDKVersion")
    expect(value((await withServer({}, service, { sdkType: "effect", sdkVersion: "0.0.1" })).exit).version).toBe("0.6.16")
    expect(failure((await withServer({ type: "Committee" }, fetchKey(), { sdkType: "effect" })).exit).error).toBe("InvalidSDKType")
    expect(failure((await withServer({ type: "Committee" }, fetchKey(), { sdkVersion: "0.9.0" })).exit).error).toBe("DeprecatedSDKVersion")
    const committeeService = failure((await withServer({ type: "Committee" }, service)).exit)
    expect([committeeService.kind, committeeService.status, committeeService.message]).toEqual(["Rejected", 400, "Unsupported"])
    expect(value((await withServer({ type: "Committee" }, fetchKey())).exit).length).toBe(1)
  })

  test("its error bodies are the recorded ones, word for word", () => {
    const pairs: ReadonlyArray<readonly [string, { error: string; message: string }]> = [
      ["service-unknown-id", keyServerErrors.invalidServiceId()],
      ["invalid-ptb-format", keyServerErrors.invalidPtb("Invalid function or package id")],
      ["invalid-package", keyServerErrors.invalidPackage()],
      ["invalid-certificate", keyServerErrors.invalidCertificate()],
      ["invalid-signature", keyServerErrors.invalidSignature()],
      ["invalid-session-signature", keyServerErrors.invalidSessionSignature()],
      ["invalid-mvr-name", keyServerErrors.invalidMvrName()],
      ["missing-required-header", keyServerErrors.missingRequiredHeader("Client-Sdk-Version")],
      ["invalid-sdk-version", keyServerErrors.invalidSdkVersion()],
      ["deprecated-sdk-version", keyServerErrors.deprecatedSdkVersion()],
      ["aggregator-invalid-sdk-type", keyServerErrors.invalidSdkType()]
    ]
    for (const [key, body] of pairs) {
      expect(JSON.stringify(body)).toBe(R[key]!.body)
      expect(statusOf(body.error)).toBe(R[key]!.status)
    }
    expect(JSON.stringify(keyServerErrors.failure())).toBe(S["failure"]!.body)
    expect(JSON.stringify(keyServerErrors.unsupportedPackageId())).toBe(S["unsupported-package-id"]!.body)
  })

  test("intercepts: wrong key, wrong id, missing key, delay, then normal processing", async () => {
    const at = (intercept: Intercept) => {
      const world = fakeKeyServers([{ intercept: () => intercept }])
      return Effect.runPromise(
        Effect.gen(function*() {
          yield* TestClock.setTime(T0)
          const api = yield* Effect.service(KeyServerApi.KeyServerApi)
          const built = yield* makeRequest({ ids: (u) => [unhex(u), new Uint8Array([7])] })
          const fiber = yield* Effect.forkChild(api.fetchKey(world.servers[0]!.endpoint, built.request))
          yield* TestClock.adjust("5 seconds")
          const keys = yield* Fiber.join(fiber)
          return openKeys(keys, built.enc, world.servers[0]!.publicKey).map((k) => k.valid)
        }).pipe(Effect.provide(Layer.merge(world.api(), TestClock.layer())))
      )
    }
    expect(await at("wrong-key")).toEqual([false, false])
    expect(await at("wrong-id")).toEqual([false, false])
    expect(await at("missing-key")).toEqual([true])
    expect(await at({ delay: "4 seconds" })).toEqual([true, true])
    expect(await at({ delay: "1 second", then: "missing-key" })).toEqual([true])
  })

  test("intercept sees the request count; an unknown origin is a network error", async () => {
    const world = fakeKeyServers([{ intercept: (_req, n) => (n === 1 ? keyServerReply503 : undefined) }])
    const results = await Effect.runPromise(
      Effect.gen(function*() {
        const api = yield* Effect.service(KeyServerApi.KeyServerApi)
        const first = yield* Effect.flip(api.service(world.servers[0]!.endpoint))
        const second = yield* api.service(world.servers[0]!.endpoint)
        const unknown = yield* Effect.flip(api.service({ objectId: Address.normalize("0x9"), url: "https://nowhere.test" }))
        return { first, second, unknown }
      }).pipe(Effect.provide(world.api()))
    )
    expect(results.first.kind).toBe("Unavailable")
    expect(results.second.serviceId).toBe(world.servers[0]!.objectId)
    expect(results.unknown.kind).toBe("Unavailable")
    expect(results.unknown.status).toBeUndefined()
  })
})

const keyServerReply503: Intercept = { status: 503, body: keyServerErrors.failure(), contentType: "application/json" }

// -----------------------------------------------------------------------------
// Live
// -----------------------------------------------------------------------------

describe.skipIf(!live)("live (SUI_LIVE=1)", () => {
  test("/v1/service of Mysten's first testnet server", async () => {
    const objectId = Address.normalize("0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75")
    const info = await Effect.runPromise(
      Effect.flatMap(Effect.service(KeyServerApi.KeyServerApi), (api) => api.service({ objectId, url: "https://seal-key-server-testnet-1.mystenlabs.com" })).pipe(
        Effect.provide(KeyServerApi.layer().pipe(Layer.provide(FetchHttpClient.layer)))
      )
    )
    expect(info.serviceId).toBe(objectId)
    expect(info.pop.length).toBe(48)
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
  }, 30_000)
})
