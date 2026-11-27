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
 *   down). Proofs come through `KeyServerApi.layer` over `FetchHttpClient`.
 * - The aggregators do not implement `/v1/service`: testnet's answers `400
 *   Unsupported` (`Rejected`), mainnet's gateway `401` without an API key
 *   (`Unauthorized`).
 */
import { SealClient } from "@mysten/seal"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import type { Address } from "@unconfirmed/sui/Address"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import * as Config from "../src/Config.ts"
import * as KeyServer from "../src/KeyServer.ts"
import * as KeyServerApi from "../src/KeyServerApi.ts"
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

/** The real key server client (S4) over `fetch`. */
const api = KeyServerApi.layer().pipe(Layer.provide(FetchHttpClient.layer))

const keyServers = (network: keyof typeof NETWORKS, verified: boolean, servers: ReadonlyArray<Config.ServerInput>) =>
  (verified ? KeyServer.layerVerified() : KeyServer.layer()).pipe(
    Layer.provide(Layer.mergeAll(Config.layer(servers), chain(network), api))
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

  for (const [network, committee, kind] of [
    ["testnet", Config.testnet.committee, "Rejected"],
    ["mainnet", Config.mainnet.committee, "Unauthorized"]
  ] as const) {
    test(`${network}: the aggregator's /v1/service is ${kind}`, async () => {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(Effect.service(KeyServerApi.KeyServerApi), (k) =>
          k.service({ objectId: committee.objectId as Address, url: committee.aggregatorUrl! })).pipe(Effect.provide(api))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: KeyServerApi.KeyServerError } | undefined)?.error : undefined
      expect(error?.kind).toBe(kind)
      expect(error?.status).toBe(network === "testnet" ? 400 : 401)
    }, 30_000)
  }
})
