/**
 * Key servers against real full nodes (read-only, no keys, no funds). Opt in
 * with SUI_LIVE=1.
 *
 * - The twelve objects of §0.1 (ten testnet V1 servers, the testnet and
 *   mainnet committees) decode through `KeyServers.layer`.
 * - Our view equals `@mysten/seal`'s `SealClient.getKeyServers()` for all
 *   twelve (name, URL or aggregator, public key, server type).
 * - `layerVerified` passes for Mysten's two servers; the other independent
 *   servers are probed best effort (a warning, not a failure, when one is
 *   down). The `/v1/service` client here is a minimal `fetch` stand-in for
 *   S4's `KeyServerApi.layer`.
 */
import { SealClient } from "@mysten/seal"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { base64 } from "@scure/base"
import type { Address } from "@unconfirmed/sui/Address"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import * as Config from "../src/Config.ts"
import * as KeyServer from "../src/KeyServer.ts"
import { KeyServerApi, KeyServerError } from "../src/KeyServerApi.ts"
import { TESTNET_INDEPENDENT } from "./fixtures.ts"

const live = process.env.SUI_LIVE === "1"
const suite = live ? describe : describe.skip

const NETWORKS = {
  testnet: {
    url: process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443",
    servers: [...TESTNET_INDEPENDENT.map((objectId) => ({ objectId })), Config.testnet.committee]
  },
  mainnet: {
    url: process.env.SUI_MAINNET_URL ?? "https://fullnode.mainnet.sui.io:443",
    servers: [Config.mainnet.committee]
  }
} as const

const chain = (network: keyof typeof NETWORKS) =>
  SuiGrpc.layer({ baseUrl: NETWORKS[network].url }).pipe(Layer.provide(FetchHttpClient.layer))

/** `GET /v1/service` over `fetch`, 10 s timeout; any failure is `Unavailable`. */
const fetchService = Layer.succeed(
  KeyServerApi,
  KeyServerApi.of({
    fetchKey: () => Effect.die("not used"),
    service: (server) =>
      Effect.tryPromise({
        try: async () => {
          const r = await fetch(`${server.url}/v1/service?service_id=${server.objectId}`, {
            headers: { "Client-Sdk-Type": "typescript", "Client-Sdk-Version": "2.0.1", "Request-Id": crypto.randomUUID() },
            signal: AbortSignal.timeout(10_000)
          })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          const json = (await r.json()) as { service_id: string; pop: string }
          return {
            serviceId: json.service_id as Address,
            pop: base64.decode(json.pop),
            version: r.headers.get("x-keyserver-version") ?? undefined
          }
        },
        catch: (e) => new KeyServerError({ server: server.objectId, url: server.url, kind: "Unavailable", message: String(e) })
      })
  })
)

const keyServers = (network: keyof typeof NETWORKS, verified: boolean, servers: ReadonlyArray<Config.ServerInput>) =>
  (verified ? KeyServer.layerVerified() : KeyServer.layer()).pipe(
    Layer.provide(Layer.mergeAll(Config.layer(servers), chain(network), fetchService))
  )

const hex = (b: Uint8Array | ReadonlyArray<number>) => Buffer.from(b).toString("hex")

suite("live key servers", () => {
  for (const network of ["testnet", "mainnet"] as const) {
    test(`${network}: every §0.1 object decodes and equals @mysten/seal's view`, async () => {
      const servers = NETWORKS[network].servers
      const ours = await Effect.runPromise(
        Effect.forEach(servers, (s) => Effect.flatMap(Effect.service(KeyServer.KeyServers), (k) => k.get(s.objectId as Address)), {
          concurrency: "unbounded"
        }).pipe(Effect.provide(keyServers(network, false, servers)))
      )
      const onChain = await Effect.runPromise(
        Effect.forEach(servers, (s) => KeyServer.read(s.objectId as Address), { concurrency: "unbounded" }).pipe(
          Effect.provide(chain(network))
        )
      )
      expect(onChain.filter((s) => s.layout === 1).length).toBe(network === "testnet" ? 10 : 0)
      expect(onChain.filter((s) => s.type._tag === "Committee").length).toBe(1)

      const client = new SealClient({
        suiClient: new SuiGrpcClient({ network, baseUrl: NETWORKS[network].url }) as any,
        serverConfigs: servers.map((s) => ({
          objectId: s.objectId,
          weight: 1,
          ...("aggregatorUrl" in s && { aggregatorUrl: s.aggregatorUrl })
        }))
      })
      const theirs = await client.getKeyServers()
      for (const s of ours) {
        const t = theirs.get(s.objectId)
        expect(t).toBeDefined()
        expect([s.name, s.url, s.type, hex(s.publicKey)]).toEqual([t!.name, t!.url, t!.serverType, hex(t!.pk)])
      }
      expect(ours.length).toBe(servers.length)
    }, 60_000)
  }

  test("testnet: layerVerified passes for Mysten's two servers", async () => {
    const servers = [Config.testnet.mysten1, Config.testnet.mysten2, Config.testnet.committee]
    const out = await Effect.runPromise(
      Effect.forEach(servers, (s) => Effect.flatMap(Effect.service(KeyServer.KeyServers), (k) => k.get(s.objectId as Address))).pipe(
        Effect.provide(keyServers("testnet", true, servers))
      )
    )
    expect(out.map((s) => s.name)).toEqual(["mysten-v1-1", "mysten-v1-2", expect.any(String)])
  }, 60_000)

  test("testnet: other independent servers' proofs (best effort)", async () => {
    const others = TESTNET_INDEPENDENT.slice(2).map((objectId) => ({ objectId }))
    const exits = await Effect.runPromise(
      Effect.forEach(
        others,
        (s) => Effect.exit(Effect.flatMap(Effect.service(KeyServer.KeyServers), (k) => k.get(s.objectId as Address))),
        { concurrency: "unbounded" }
      ).pipe(Effect.provide(keyServers("testnet", true, others)))
    )
    let ok = 0
    exits.forEach((exit, i) => {
      if (Exit.isSuccess(exit)) return void ok++
      const error = exit.cause.reasons.find((r) => r._tag === "Fail") as { error: KeyServer.InvalidKeyServer } | undefined
      const reason = error?.error.reason ?? String(exit.cause)
      // A wrong proof is a failure; an unreachable server only a warning.
      expect(reason).not.toContain("does not verify")
      expect(reason).not.toContain("names another id")
      console.warn(`key server ${others[i]!.objectId} not verified: ${reason.slice(0, 200)}`)
    })
    console.log(`${ok} of ${others.length} other independent servers verified`)
  }, 60_000)
})
