/**
 * Record real key server answers (§6.1, `key-server-api.test.ts`) into
 * `test/fixtures/key-server/recorded.json`: one `/v1/service` and one
 * `fetch_key` success, and every error a client can provoke on testnet.
 *
 *   bun packages/seal/scripts/record-key-server.ts
 *
 * Every user and session key is a fresh in-memory Ed25519 key; nothing is
 * signed with a wallet and nothing costs funds. Requests go to Mysten's first
 * testnet server, the testnet and mainnet aggregators and one server that was
 * answering `503` (§0.1), spaced to stay under the 10 per second limit (H11).
 */
import * as Address from "@unconfirmed/sui/Address"
import * as Effect from "effect/Effect"
import { writeFileSync } from "node:fs"
import * as KeyServerApi from "../src/KeyServerApi.ts"
import { type FixtureResponse, approvalPtb, testRequest } from "../test/support.ts"

const MYSTEN_1 = {
  objectId: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
  url: "https://seal-key-server-testnet-1.mystenlabs.com"
}
const AGGREGATOR_TESTNET = "https://seal-aggregator-testnet.mystenlabs.com"
const COMMITTEE_TESTNET = "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98"
const AGGREGATOR_MAINNET = "https://seal-aggregator-mainnet.mystenlabs.com"
const SUIFTLY = { objectId: "0x6a0726a1ea3d62ba2f2ae51104f2c3633c003fb75621d06fde47f04dc930ba06", url: "https://seal-testnet-open.suiftly.io" }
/** Mysten's canary package on testnet (§0.1): `account_based`, `whitelist`, … */
const CANARY = "0x58dce5d91278bceb65d44666ffa225ab397fc3ae9d8398c8c779c5530bd978c2"

const random32 = () => crypto.getRandomValues(new Uint8Array(32))
const addressBytes = (a: string) => Uint8Array.from(Buffer.from(a.slice(2), "hex"))

const HEADERS = {
  "Content-Type": "application/json",
  "Client-Sdk-Type": KeyServerApi.DEFAULT_SDK_TYPE,
  "Client-Sdk-Version": KeyServerApi.DEFAULT_SDK_VERSION
}

const responses: Record<string, FixtureResponse> = {}
const reached = new Set<string>()

const record = async (
  key: string,
  o: { readonly server: string; readonly method: "GET" | "POST"; readonly path: string; readonly headers?: Record<string, string | undefined>; readonly body?: string; readonly note?: string }
) => {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...HEADERS, "Request-Id": crypto.randomUUID(), ...o.headers })) if (v !== undefined) headers[k] = v
  try {
    const res = await fetch(o.server + o.path, { method: o.method, headers, ...(o.body !== undefined && { body: o.body }), signal: AbortSignal.timeout(20_000) })
    const body = await res.text()
    reached.add(o.server)
    responses[key] = {
      server: o.server,
      method: o.method,
      path: o.path,
      ...(o.note !== undefined && { note: o.note }),
      status: res.status,
      contentType: res.headers.get("content-type"),
      keyServerVersion: res.headers.get("x-keyserver-version"),
      body
    }
    console.log(`${key}: ${res.status} ${body.slice(0, 120).replace(/\s+/g, " ")}`)
  } catch (e) {
    console.log(`${key}: no answer (${String(e)})`)
  }
  await Bun.sleep(300)
}

/** A request from a fresh user for `ids` under `account_based` (or the given PTB), dated `skewMs` in the past. */
const request = async (o: {
  readonly ids?: (user: string) => ReadonlyArray<Uint8Array>
  readonly ptb?: Uint8Array
  readonly creationOffsetMs?: number
  readonly mvrName?: string
  readonly signedName?: string
  readonly ttlMin?: number
  /** The package the certificate names (default: the canary). */
  readonly packageId?: string
}) => {
  const userSecret = random32()
  // The address is needed before the PTB: derive it with a throwaway build first.
  const probe = await Effect.runPromise(
    testRequest({ userSecret, sessionSecret: random32(), packageId: CANARY, ptb: new Uint8Array(), creationTime: Date.now() })
  )
  const ptb = o.ptb ?? approvalPtb({ packageId: CANARY, ids: (o.ids ?? ((u) => [addressBytes(u)]))(probe.user) })
  const { request } = await Effect.runPromise(
    testRequest({
      userSecret,
      sessionSecret: random32(),
      packageId: o.packageId ?? CANARY,
      ptb,
      creationTime: Date.now() + (o.creationOffsetMs ?? -10_000),
      ...(o.ttlMin !== undefined && { ttlMin: o.ttlMin }),
      ...(o.mvrName !== undefined && { mvrName: o.mvrName }),
      ...(o.signedName !== undefined && { signedName: o.signedName })
    })
  )
  return request
}

const post = (server: string, body: string, extra: { readonly headers?: Record<string, string | undefined>; readonly note?: string } = {}) => ({
  server,
  method: "POST" as const,
  path: "/v1/fetch_key",
  body,
  ...extra
})

// --- /v1/service -------------------------------------------------------------

await record("service", { server: MYSTEN_1.url, method: "GET", path: `/v1/service?service_id=${MYSTEN_1.objectId}` })
await record("service-unknown-id", {
  server: MYSTEN_1.url,
  method: "GET",
  path: `/v1/service?service_id=${Address.normalize("0x1")}`,
  note: "an id the server does not hold"
})
await record("aggregator-service", { server: AGGREGATOR_TESTNET, method: "GET", path: `/v1/service?service_id=${COMMITTEE_TESTNET}` })
await record("load-balancer-503", { server: SUIFTLY.url, method: "GET", path: `/v1/service?service_id=${SUIFTLY.objectId}`, note: "a server that was down behind its load balancer" })

// --- fetch_key: success and verdicts -----------------------------------------

const ok = KeyServerApi.requestBody(await request({}))
await record("fetch-key", post(MYSTEN_1.url, ok, { note: "account_based::seal_approve with id = bcs(user)" }))
await record("aggregator-fetch-key", post(AGGREGATOR_TESTNET, KeyServerApi.requestBody(await request({})), { note: "account_based, committee" }))

const denied = KeyServerApi.requestBody(await request({ ids: () => [random32()] }))
await record("no-access", post(MYSTEN_1.url, denied, { note: "account_based with another address's id" }))
await record("aggregator-no-access", post(AGGREGATOR_TESTNET, denied, { note: "the same request, committee" }))

await record(
  "invalid-ptb-function",
  post(
    MYSTEN_1.url,
    KeyServerApi.requestBody(await request({ packageId: "0x2", ptb: approvalPtb({ packageId: "0x2", module: "coin", ids: [random32()] }) })),
    { note: "0x2::coin::seal_approve (open mode: passes the package check, fails in the dry run, H9)" }
  )
)
await record(
  "invalid-ptb-format",
  post(
    MYSTEN_1.url,
    KeyServerApi.requestBody(await request({ ptb: approvalPtb({ packageId: CANARY, function: "approve", ids: [random32()] }) })),
    { note: "a function name without the seal_approve prefix (P1)" }
  )
)
await record(
  "invalid-package",
  post(
    MYSTEN_1.url,
    KeyServerApi.requestBody(await request({ packageId: "0x" + "de".repeat(32), ptb: approvalPtb({ packageId: "0x" + "de".repeat(32), ids: [random32()] }) })),
    { note: "a package that does not exist" }
  )
)
await record("invalid-certificate", post(MYSTEN_1.url, KeyServerApi.requestBody(await request({ creationOffsetMs: 60_000 })), { note: "creation_time 60 s ahead of the server (R2)" }))
await record("invalid-certificate-ttl", post(MYSTEN_1.url, KeyServerApi.requestBody(await request({ ttlMin: 31 })), { note: "ttl_min 31 (R2)" }))
await record(
  "invalid-signature",
  post(MYSTEN_1.url, KeyServerApi.requestBody(await request({ signedName: Address.normalize("0x2") })), { note: "the personal message names another package (R1)" })
)
{
  const r = await request({})
  const tampered = r.requestSignature.slice()
  tampered[0] = tampered[0]! ^ 1
  await record(
    "invalid-session-signature",
    post(MYSTEN_1.url, KeyServerApi.requestBody({ ...r, requestSignature: tampered }), { note: "a request signature with one bit flipped (R4)" })
  )
}
await record(
  "invalid-mvr-name",
  post(MYSTEN_1.url, KeyServerApi.requestBody(await request({ mvrName: "@nonexistent-seal-test/nothing" })), { note: "an MVR name that resolves to nothing" })
)
await record(
  "invalid-parameter",
  post(
    MYSTEN_1.url,
    KeyServerApi.requestBody(
      await request({
        ptb: approvalPtb({
          packageId: CANARY,
          module: "whitelist",
          ids: [random32()],
          objects: [{ _tag: "Object", value: { _tag: "SharedObject", objectId: Address.fromBytes(random32()), initialSharedVersion: 1n, mutability: { _tag: "Immutable" } } } as never]
        })
      })
    ),
    { note: "whitelist::seal_approve with a shared object that does not exist" }
  )
)

// --- fetch_key: headers (H2) and transport-level refusals --------------------

await record("missing-required-header", post(MYSTEN_1.url, ok, { headers: { "Client-Sdk-Version": undefined } }))
await record("invalid-sdk-version", post(MYSTEN_1.url, ok, { headers: { "Client-Sdk-Version": "not-a-version" } }))
await record("deprecated-sdk-version", post(MYSTEN_1.url, ok, { headers: { "Client-Sdk-Version": "0.1.0" } }))
await record("aggregator-invalid-sdk-type", post(AGGREGATOR_TESTNET, ok, { headers: { "Client-Sdk-Type": "effect" } }))
await record("invalid-json", post(MYSTEN_1.url, "{\"ptb\":", { note: "a truncated JSON body (axum's extractor)" }))
await record("invalid-body", post(MYSTEN_1.url, JSON.stringify({ ...JSON.parse(ok), enc_key: "AAAA" }), { note: "an enc_key that is not a G1 point (axum's extractor)" }))
await record("mainnet-aggregator-401", post(AGGREGATOR_MAINNET, ok, { note: "no API key: the gateway's body, not Seal's" }))

const out = {
  source:
    "Recorded by packages/seal/scripts/record-key-server.ts with fresh in-memory Ed25519 keys (no wallet, no funds). Servers: " +
    [...reached].join(", ") +
    ".",
  recordedAt: new Date().toISOString(),
  responses
}
const file = new URL("../test/fixtures/key-server/recorded.json", import.meta.url)
writeFileSync(file, JSON.stringify(out, null, 2) + "\n")
console.log(`wrote ${Object.keys(responses).length} responses to ${file.pathname}`)
