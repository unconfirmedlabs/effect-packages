/**
 * `EnokiHttp` sends exactly what `@mysten/enoki`'s `EnokiClient` sends, and
 * decodes responses and errors into typed results.
 */
import { EnokiClient as TheirClient } from "@mysten/enoki"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Ed25519 } from "@unconfirmed/sui"
import { describe, expect, test } from "bun:test"
import { Effect, Tracer } from "effect"
import { HttpClient } from "effect/http"
import { inputs } from "@unconfirmed/test-support/zklogin"
import { EnokiClient, type EnokiError } from "../src/EnokiClient.ts"
import * as EnokiHttp from "../src/EnokiHttp.ts"
import { captureFetch, type Recorded, type Reply, scripted } from "./support.ts"

const API_KEY = "enoki_public_test"
const API_URL = "https://enoki.test"
const seed = new Uint8Array(32).fill(5)
const theirKey = Ed25519Keypair.fromSecretKey(seed).getPublicKey()
const ourKey = Effect.runSync(Ed25519.fromSecretKey(seed)).publicKey
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const theirClient = (additionalEpochs?: number) =>
  new TheirClient({ apiKey: API_KEY, apiUrl: API_URL, ...(additionalEpochs !== undefined && { additionalEpochs }) })

/** Call ours through a scripted HttpClient answering `reply`; answer the request and the result. */
const ours = async <A>(
  reply: Reply,
  f: (c: EnokiClient["Service"]) => Effect.Effect<A, EnokiError>,
  additionalEpochs?: number
) => {
  const http = scripted(() => reply)
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(Effect.service(EnokiClient), f).pipe(
      Effect.provide(EnokiHttp.layer({ apiKey: API_KEY, url: API_URL, ...(additionalEpochs !== undefined && { additionalEpochs }) })),
      Effect.provide(http.layer)
    )
  )
  return { exit, request: http.requests[0]! }
}

const sameRequest = (a: Recorded, b: Recorded) => {
  expect(a.method).toBe(b.method)
  expect(a.url).toBe(b.url)
  expect(a.body).toBe(b.body) // byte-identical JSON, key order included
  const strip = (h: Record<string, string>) => {
    const out = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
    expect(out["request-id"]).toMatch(UUID)
    delete out["request-id"]
    delete out["content-length"] // set by the transport from the body (fetch does the same)
    return out
  }
  expect(strip(a.headers)).toEqual(strip(b.headers))
}

const data = (d: unknown): Reply => ({ body: { data: d } })

const zkp = inputs("12345678901234567890")
const txBytes = new Uint8Array([0, 1, 2, 3, 250])

const CASES: Array<{
  name: string
  reply: Reply
  theirs: (c: TheirClient) => Promise<unknown>
  ours: (c: EnokiClient["Service"]) => Effect.Effect<unknown, EnokiError>
  additionalEpochs?: number
  expected?: unknown
}> = [
  {
    name: "getApp",
    reply: data({ allowedOrigins: ["https://a.b"], authenticationProviders: [{ providerType: "google", clientId: "cid" }], domains: [], sponsorAddresses: { testnet: "0x1" } }),
    theirs: (c) => c.getApp(),
    ours: (c) => c.getApp
  },
  {
    name: "getZkLogin",
    reply: data({ address: "0xabc", publicKey: "AAE=", salt: "123" }),
    theirs: (c) => c.getZkLogin({ jwt: JWT }),
    ours: (c) => c.getZkLogin({ jwt: JWT })
  },
  {
    name: "getZkLoginAddresses",
    reply: data({ addresses: [{ clientId: "c", salt: "1", address: "0x1", publicKey: "AA==", legacy: true }] }),
    theirs: (c) => c.getZkLoginAddresses({ jwt: JWT }),
    ours: (c) => c.getZkLoginAddresses({ jwt: JWT })
  },
  {
    name: "createZkLoginNonce (network, explicit epochs)",
    reply: data({ nonce: "n", randomness: "42", epoch: 10, maxEpoch: 12, estimatedExpiration: 1700000000000 }),
    theirs: (c) => c.createZkLoginNonce({ network: "testnet", ephemeralPublicKey: theirKey, additionalEpochs: 2 }),
    ours: (c) => c.createZkLoginNonce({ network: "testnet", ephemeralPublicKey: ourKey, additionalEpochs: 2 }),
    // Epochs are u64s: ours decodes them to bigint (theirs keeps the JSON numbers).
    expected: { nonce: "n", randomness: "42", epoch: 10n, maxEpoch: 12n, estimatedExpiration: 1700000000000 }
  },
  {
    name: "createZkLoginNonce (configured default epochs, no network)",
    reply: data({ nonce: "n", randomness: "42", epoch: 10, maxEpoch: 13, estimatedExpiration: 1 }),
    theirs: (c) => c.createZkLoginNonce({ ephemeralPublicKey: theirKey }),
    ours: (c) => c.createZkLoginNonce({ ephemeralPublicKey: ourKey }),
    additionalEpochs: 3,
    expected: { nonce: "n", randomness: "42", epoch: 10n, maxEpoch: 13n, estimatedExpiration: 1 }
  },
  {
    name: "createZkLoginZkp",
    reply: data(zkp),
    theirs: (c) => c.createZkLoginZkp({ network: "devnet", jwt: JWT, ephemeralPublicKey: theirKey, randomness: "42", maxEpoch: 12 }),
    ours: (c) => c.createZkLoginZkp({ network: "devnet", jwt: JWT, ephemeralPublicKey: ourKey, randomness: "42", maxEpoch: 12n })
  },
  {
    name: "createSponsoredTransaction (sender)",
    reply: data({ bytes: Buffer.from(txBytes).toString("base64"), digest: "D1" }),
    theirs: (c) =>
      c.createSponsoredTransaction({
        network: "testnet",
        transactionKindBytes: Buffer.from(txBytes).toString("base64"),
        sender: "0x2",
        allowedAddresses: ["0x3"],
        allowedMoveCallTargets: ["0x2::coin::split"]
      }),
    ours: (c) =>
      c.createSponsoredTransaction({
        network: "testnet",
        transactionKindBytes: txBytes,
        sender: "0x2",
        allowedAddresses: ["0x3"],
        allowedMoveCallTargets: ["0x2::coin::split"]
      }),
    expected: { bytes: txBytes, digest: "D1" }
  },
  {
    name: "createSponsoredTransaction (jwt)",
    reply: data({ bytes: Buffer.from(txBytes).toString("base64"), digest: "D2" }),
    theirs: (c) => c.createSponsoredTransaction({ transactionKindBytes: Buffer.from(txBytes).toString("base64"), jwt: JWT }),
    ours: (c) => c.createSponsoredTransaction({ transactionKindBytes: txBytes, jwt: JWT }),
    expected: { bytes: txBytes, digest: "D2" }
  },
  {
    name: "executeSponsoredTransaction",
    reply: data({ digest: "D1" }),
    theirs: (c) => c.executeSponsoredTransaction({ digest: "D1", signature: Buffer.from(txBytes).toString("base64") }),
    ours: (c) => c.executeSponsoredTransaction({ digest: "D1", signature: txBytes })
  },
  {
    name: "sponsorAndExecuteTransaction",
    reply: data({ digest: "D3" }),
    theirs: (c) =>
      c.sponsorAndExecuteTransaction({
        network: "mainnet",
        transactionBytes: Buffer.from(txBytes).toString("base64"),
        signature: "c2ln",
        allowedMoveCallTargets: ["0x2::a::b"]
      }),
    ours: (c) =>
      c.sponsorAndExecuteTransaction({
        network: "mainnet",
        transactionBytes: txBytes,
        signature: Uint8Array.from(Buffer.from("c2ln", "base64")),
        allowedMoveCallTargets: ["0x2::a::b"]
      })
  }
]

describe("EnokiHttp matches @mysten/enoki", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const theirs = await captureFetch(c.reply, () => c.theirs(theirClient(c.additionalEpochs)))
      const mine = await ours(c.reply, c.ours, c.additionalEpochs)
      sameRequest(mine.request, theirs.request)
      expect(mine.exit._tag).toBe("Success")
      const value = (mine.exit as any).value
      expect(value).toEqual(c.expected ?? (theirs as any).value)
    })
  }
})

describe("EnokiHttp options", () => {
  test("url: trailing slashes are stripped; extra headers are sent, but never replace the API key", async () => {
    const http = scripted(() => data({ address: "0xabc", publicKey: "AAE=", salt: "123" }))
    await Effect.runPromise(
      Effect.flatMap(Effect.service(EnokiClient), (c) => c.getZkLogin({ jwt: JWT })).pipe(
        Effect.provide(EnokiHttp.layer({ apiKey: API_KEY, url: `${API_URL}/`, headers: { "x-route": "eu", authorization: "Bearer other" } })),
        Effect.provide(http.layer)
      )
    )
    const request = http.requests[0]!
    const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]))
    expect(request.url).toBe(`${API_URL}/v1/zklogin`)
    expect(headers["x-route"]).toBe("eu")
    expect(headers["authorization"]).toBe(`Bearer ${API_KEY}`)
  })
})

describe("EnokiHttp errors", () => {
  const failure = async (reply: Reply | "network-error") => {
    const http = scripted(() => reply)
    return Effect.runPromise(
      Effect.flatMap(Effect.service(EnokiClient), (c) => c.getZkLogin({ jwt: JWT })).pipe(
        Effect.flip,
        Effect.provide(EnokiHttp.layer({ apiKey: API_KEY, url: API_URL })),
        Effect.provide(http.layer)
      )
    )
  }

  test("an Enoki error body decodes into status, code and message, like EnokiClientError", async () => {
    const reply = { status: 400, body: { errors: [{ code: "invalid_gas_price", message: "gas price changed", data: { referenceGasPrice: "750" } }] } }
    const e = await failure(reply)
    const theirs = (await captureFetch(reply, () => theirClient().getZkLogin({ jwt: JWT }))) as any
    expect(e._tag).toBe("EnokiError")
    expect(e.status).toBe(theirs.error.status)
    expect(e.code).toBe(theirs.error.code)
    expect(e.message).toBe(theirs.error.cause.message)
    expect(e.errors).toEqual(theirs.error.errors)
    expect(e.requiresRebuild).toBe(true)
  })

  test("error entries decode leniently, one at a time, like @mysten/enoki", async () => {
    const reply = { status: 400, body: { errors: [{ code: "rate_limited" }, "junk", { code: 7, message: "m2" }] } }
    const e = await failure(reply)
    const theirs = (await captureFetch(reply, () => theirClient().getZkLogin({ jwt: JWT }))) as any
    expect(e.code).toBe(theirs.error.code)
    expect(e.code).toBe("rate_limited")
    expect(e.message).toBe("Request to Enoki API failed (status: 400)")
    expect(e.errors).toEqual([{ code: "rate_limited" }, { message: "m2" }])
  })

  test("a non-JSON error body is unknown_error with the status", async () => {
    const e = await failure({ status: 502, body: "<html>bad gateway</html>" })
    expect({ status: e.status, code: e.code }).toEqual({ status: 502, code: "unknown_error" })
    expect(e.message).toBe("Request to Enoki API failed (status: 502)")
  })

  test("a response that doesn't match the schema is invalid_response", async () => {
    const e = await failure(data({ address: 1 }))
    expect({ status: e.status, code: e.code }).toEqual({ status: 200, code: "invalid_response" })
  })

  test("a transport failure is request_failed", async () => {
    const e = await failure("network-error")
    expect({ status: e.status, code: e.code }).toEqual({ status: 0, code: "request_failed" })
  })

  test("retryable: no response, 429 and 5xx; cause kept without the request's credentials", async () => {
    const transport = await failure("network-error")
    expect(transport.retryable).toBe(true)
    expect(transport.cause).toBeInstanceOf(Error)
    expect((transport.cause as Error).message).toContain("connection refused")
    // The request (Authorization: Bearer <key>, zklogin-jwt) is not reachable from the error.
    const seen = new Set<unknown>()
    const reachable = (v: unknown): boolean => {
      if (typeof v === "string") return v.includes(API_KEY) || v.includes(JWT)
      if (typeof v !== "object" || v === null || seen.has(v)) return false
      seen.add(v)
      return Object.values(v).some(reachable) || reachable((v as { cause?: unknown }).cause)
    }
    expect(reachable(transport)).toBe(false)
    expect((await failure({ status: 429, body: "" })).retryable).toBe(true)
    expect((await failure({ status: 503, body: "" })).retryable).toBe(true)
    expect((await failure({ status: 400, body: { errors: [{ code: "invalid_jwt" }] } })).retryable).toBe(false)
    const invalid = await failure(data({ address: 1 }))
    expect(invalid.retryable).toBe(false)
    expect(invalid.cause).toBeDefined()
  })
})

describe("EnokiHttp tracing", () => {
  test("the zklogin-jwt header is redacted and span names carry no digest", async () => {
    const spans: Array<{ name: string; span: Tracer.Span }> = []
    const tracer = Tracer.make({
      span(options) {
        const span = Tracer.nativeTracer.span(options)
        spans.push({ name: options.name, span })
        return span
      }
    })
    const http = scripted(() => ({ body: { data: { digest: "SECRETDIGEST" } } }))
    await Effect.runPromise(
      Effect.flatMap(Effect.service(EnokiClient), (c) =>
        Effect.andThen(
          c.getZkLogin({ jwt: JWT }).pipe(Effect.ignore),
          c.executeSponsoredTransaction({ digest: "SECRETDIGEST", signature: txBytes })
        )).pipe(
          Effect.provide(EnokiHttp.layer({ apiKey: API_KEY, url: API_URL })),
          Effect.provide(http.layer),
          Effect.withTracer(tracer),
          // Record every header on the client span, so redaction is what's left to keep the JWT out.
          Effect.provideService(HttpClient.TracerHeaderFilter, () => true)
        )
    )
    expect(spans.some((s) => s.name === "EnokiClient.executeSponsoredTransaction")).toBe(true)
    expect(spans.every((s) => !s.name.includes("SECRETDIGEST"))).toBe(true)
    const attrs = spans.map((s) => Object.fromEntries(s.span.attributes))
    const jwtAttr = attrs.find((a) => "http.request.header.zklogin-jwt" in a)
    expect(jwtAttr).toBeDefined()
    expect(jwtAttr!["http.request.header.zklogin-jwt"]).toBe("<redacted>")
    expect(jwtAttr!["http.request.header.authorization"]).toBe("<redacted>")
  })
})
