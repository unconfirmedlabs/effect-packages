/**
 * `KeyServerApi` over an in-memory `HttpClient`: headers; recorded answers;
 * every row of the §4.4 mapping, from bodies recorded on testnet
 * (`fixtures/key-server/recorded.json`) or built from `errors.rs`
 * (`synthesized.json`); timeouts under `TestClock`; server versions; API keys
 * kept out of errors and spans; size limits and request ids.
 */
import { describe, expect, test } from "bun:test"
import * as Address from "@unconfirmed/sui/Address"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Tracer from "effect/Tracer"
import * as HttpClient from "effect/http/HttpClient"
import * as Entropy from "../src/Entropy.ts"
import { TestClock } from "effect/testing"
import * as KeyServerApi from "../src/KeyServerApi.ts"
import {
  approvalPtb,
  fakeKeyServers,
  type FakeKeyServerOptions,
  type FixtureResponse,
  hex,
  type Intercept,
  recorded,
  synthesized,
  testRequest,
  toB64,
  unhex
} from "./support.ts"

const R = recorded.responses
const S = synthesized.responses

const T0 = Date.UTC(2026, 10, 27, 12, 0, 0)
const PACKAGE = Address.normalize("0x" + "a1".repeat(32))
const userSecret = unhex("11".repeat(32))
const sessionSecret = unhex("22".repeat(32))

type Api = KeyServerApi.KeyServerApiService

/** A request from the fixed test user for its own address, as `account_based` wants. */
const makeRequest = Effect.gen(function*() {
  const probe = yield* testRequest({ userSecret, sessionSecret, packageId: PACKAGE, ptb: new Uint8Array(), creationTime: T0 })
  const ptb = approvalPtb({ packageId: PACKAGE, ids: [unhex(probe.user)] })
  return yield* testRequest({ userSecret, sessionSecret, packageId: PACKAGE, ptb, creationTime: T0 - 10_000 })
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

const fetchKey = () => (api: Api, endpoint: KeyServerApi.Endpoint) =>
  Effect.flatMap(makeRequest, ({ request }) => api.fetchKey(endpoint, request))
const service = (api: Api, endpoint: KeyServerApi.Endpoint) => api.service(endpoint)

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

describe("requests", () => {
  test("API key header and SDK identity overrides; trace headers only with tracerPropagation", async () => {
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
    const traced = await withServer({}, (api, endpoint) => Effect.withSpan(service(api, endpoint), "outer"), { tracerPropagation: true })
    expect(traced.requests[0]!.headers.traceparent).toBeDefined()
  })
})

// -----------------------------------------------------------------------------
// Successful answers
// -----------------------------------------------------------------------------

describe("answers", () => {
  test("recorded 200 answers decode: key server and aggregator fetch_key, service", async () => {
    const r = R["fetch-key"]!
    const keys = value((await withServer(answering(replyOf(r)), fetchKey())).exit)
    const body = JSON.parse(r.body) as { decryption_keys: Array<{ id: Array<number> }> }
    expect(keys.length).toBe(1)
    expect(hex(keys[0]!.fullId)).toBe(hex(Uint8Array.from(body.decryption_keys[0]!.id)))
    expect(keys[0]!.ciphertext.map((c) => c.length)).toEqual([48, 48])
    expect(value((await withServer(answering(replyOf(R["aggregator-fetch-key"]!)), fetchKey())).exit)[0]!.fullId.length).toBe(64)
    const info = value((await withServer(answering(replyOf(R["service"]!)), service)).exit)
    expect(info.serviceId).toBe(Address.normalize("0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75"))
    expect(info.pop.length).toBe(48)
    expect(info.version).toBe("0.6.16")
  })

  test("server version (H4): missing is accepted; below minServerVersion or garbage is UnsupportedServerVersion", async () => {
    const body = R["service"]!.body
    expect(value((await withServer(answering({ status: 200, body, contentType: "application/json" }), service)).exit).version).toBeUndefined()
    const at = (v: string, options?: KeyServerApi.KeyServerApiOptions) =>
      withServer(answering({ status: 200, body, headers: { "x-keyserver-version": v } }), service, options)
    expect(failure((await at("0.4.0")).exit).kind).toBe("UnsupportedServerVersion")
    expect(value((await at("0.4.1")).exit).version).toBe("0.4.1")
    expect(failure((await at("0.6.15", { minServerVersion: "0.6.16" })).exit).kind).toBe("UnsupportedServerVersion")
    expect(failure((await at("garbage")).exit).kind).toBe("UnsupportedServerVersion")
  })

  test("2xx bodies that do not decode are Malformed", async () => {
    const cases: ReadonlyArray<[unknown, (api: Api, e: KeyServerApi.Endpoint) => Effect.Effect<unknown, KeyServerApi.KeyServerError>]> = [
      ["not json", fetchKey()],
      [{ decryption_keys: [{ id: [1, 256], encrypted_key: ["AA==", "AA=="] }] }, fetchKey()],
      [{ decryption_keys: [{ id: [1], encrypted_key: ["AA=="] }] }, fetchKey()],
      [{ decryption_keys: [{ id: [1], encrypted_key: ["!!", "AA=="] }] }, fetchKey()],
      [{ service_id: "0x" + "00".repeat(32), pop: toB64(new Uint8Array(47)) }, service]
    ]
    for (const [body, f] of cases) {
      const { exit, requests } = await withServer(answering({ status: 200, body, contentType: "application/json" }), f)
      const e = failure(exit)
      expect(e.kind).toBe("Malformed")
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
  test("every recorded and synthesized error maps to its kind, and the kind decides retryable / definitive", async () => {
    const used = new Set(MAPPING.map(([, r]) => r))
    const errors = [...Object.values(R), ...Object.values(S)].filter((r) => r.status >= 300)
    expect(errors.filter((r) => !used.has(r))).toEqual([])
    const got = MAPPING.map(([name, r]) => {
      const e = KeyServerApi.fromResponse(ENDPOINT, r.status, r.body, "req-1")
      return [name, e.kind, e.retryable, e.definitive]
    })
    expect(got).toEqual(MAPPING.map(([name, , kind]) => [name, kind, RETRYABLE.has(kind), DEFINITIVE.has(kind)]))
    // Through the layer, on the endpoint each body came from.
    for (const name of ["no-access", "service-unknown-id"]) {
      const r = R[name]!
      const f: (api: Api, e: KeyServerApi.Endpoint) => Effect.Effect<unknown, KeyServerApi.KeyServerError> = r.method === "GET" ? service : fetchKey()
      const { exit, requests } = await withServer(answering(replyOf(r)), f)
      const e = failure(exit)
      expect([e._tag, e.kind, e.status]).toEqual(["KeyServerError", MAPPING.find(([, x]) => x === r)![2], r.status])
      expect(e.requestId).toBe(requests[0]!.headers["request-id"])
    }
  })

  test("without a known Seal error name: 401/403 → Unauthorized, 5xx → Unavailable, other → Rejected; unknown names kept", () => {
    const unknown = JSON.stringify({ error: "SomethingNew", message: "a future error" })
    const cases: ReadonlyArray<readonly [number, string, KeyServerApi.KeyServerErrorKind]> = [
      [403, unknown, "Unauthorized"],
      [400, unknown, "Rejected"],
      [302, "", "Rejected"],
      [502, "Bad Gateway", "Unavailable"],
      [200, '{"error":"NoAccess"}', "NoAccess"]
    ]
    for (const [status, body, kind] of cases) {
      const e = KeyServerApi.fromResponse(ENDPOINT, status, body)
      expect([status, e.kind]).toEqual([status, kind])
    }
    const e = KeyServerApi.fromResponse(ENDPOINT, 403, unknown)
    expect(e.error).toBe("SomethingNew")
    expect(e.message).toBe("a future error")
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

  test("SEAL-7: the body's error name is scrubbed too, before it is cut; messages are bounded", () => {
    const key = "SECRET-KEY-123"
    const endpoint = { ...ENDPOINT, apiKey: { name: "X-Key", value: Redacted.make(key) } }
    const e = KeyServerApi.fromResponse(endpoint, 401, JSON.stringify({ error: `invalid key ${key}`, message: `key ${key} rejected` }))
    expect(e.error).toBe("invalid key <redacted>")
    expect(e.message).toBe("key <redacted> rejected")
    expect(JSON.stringify(e)).not.toContain(key)
    // A key straddling a cut is scrubbed whole, not half.
    const straddle = KeyServerApi.fromResponse(endpoint, 403, JSON.stringify({ error: "x".repeat(95) + key, message: "m" }))
    expect(straddle.error).toBe("x".repeat(95) + "<reda")
    const text = KeyServerApi.fromResponse(endpoint, 502, "y".repeat(495) + key)
    expect(text.message).not.toContain("SECRET")
    expect(text.message).toHaveLength(500)
    // A 2 MB message is kept to 2000 characters.
    expect(KeyServerApi.fromResponse(ENDPOINT, 403, JSON.stringify({ error: "NoAccess", message: "x".repeat(2_000_000) })).message)
      .toHaveLength(2000)
  })

  test("SEAL-7: a tracer that records request headers records the API key as <redacted>, whatever its name", async () => {
    const key = "sk-header-999"
    const spans: Array<Tracer.Span> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = Tracer.nativeTracer.span(options)
        spans.push(span)
        return span
      }
    })
    const { exit } = await withServer(
      { apiKey: { name: "x-seal-key", value: key } },
      (api, endpoint) =>
        service(api, endpoint).pipe(
          Effect.provideService(HttpClient.TracerHeaderFilter, () => true),
          Effect.provideService(Tracer.Tracer, tracer)
        )
    )
    value(exit)
    const attributes = spans.flatMap((s) => Array.from((s as Tracer.NativeSpan).attributes))
    const header = attributes.find(([k]) => k.includes("x-seal-key"))
    expect(JSON.stringify(header?.[1])).toContain("<redacted>")
    expect(JSON.stringify(attributes)).not.toContain(key)
  })

  test("SEAL-15: Retry-After on a 429 or 503 is kept as retryAfter (ms)", async () => {
    const { exit } = await withServer(
      answering({ status: 429, body: "slow down", headers: { "retry-after": "7" } }),
      service
    )
    expect(failure(exit).retryAfter).toBe(7000)
    expect(KeyServerApi.parseRetryAfter(undefined, 0)).toBeUndefined()
    expect(KeyServerApi.parseRetryAfter("soon", 0)).toBeUndefined()
    expect(KeyServerApi.parseRetryAfter(" 2 ", 0)).toBe(2000)
    expect(KeyServerApi.parseRetryAfter(new Date(T0 + 5000).toUTCString(), T0)).toBe(5000)
    expect(KeyServerApi.parseRetryAfter(new Date(T0 - 5000).toUTCString(), T0)).toBe(0)
    expect(KeyServerApi.parseRetryAfter("999999", 0)).toBe(3_600_000)
  })
})

describe("SEAL-1, SEAL-4: limits and request ids", () => {
  test("a 2xx body above maxResponseBytes is Malformed without being parsed", async () => {
    const big = { status: 200, body: { decryption_keys: [], pad: "x".repeat(5000) }, contentType: "application/json" }
    const { exit } = await withServer(answering(big), fetchKey(), { maxResponseBytes: 4096 })
    const e = failure(exit)
    expect(e.kind).toBe("Malformed")
    expect(e.message).toContain("exceeds 4096")
  })

  test("the Request-Id is drawn when the effect runs, from Entropy: running one effect twice sends two ids", async () => {
    const world = fakeKeyServers([{}])
    let calls = 0
    await Effect.runPromise(
      Effect.gen(function*() {
        const api = yield* Effect.service(KeyServerApi.KeyServerApi)
        const once = api.service(world.servers[0]!.endpoint)
        yield* once
        yield* once
      }).pipe(
        Effect.provideService(Entropy.Entropy, (n: number) => new Uint8Array(n).fill(++calls)),
        Effect.provide(world.api())
      )
    )
    const ids = world.requests.map((r) => r.headers["request-id"])
    expect(ids).toEqual(["01010101-0101-4101-8101-010101010101", "02020202-0202-4202-8202-020202020202"])
  })

  test("no random source at all is a typed KeyServerError, not a defect", async () => {
    const world = fakeKeyServers([{}])
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const api = yield* Effect.service(KeyServerApi.KeyServerApi)
        return yield* api.service(world.servers[0]!.endpoint)
      }).pipe(
        Effect.provideService(Entropy.Entropy, () => {
          throw new TypeError("crypto.getRandomValues is not a function")
        }),
        Effect.provide(world.api())
      )
    )
    const e = failure(exit)
    expect(e._tag).toBe("KeyServerError")
    expect(e.message).toContain("no random source")
    expect(world.requests).toHaveLength(0)
  })
})
