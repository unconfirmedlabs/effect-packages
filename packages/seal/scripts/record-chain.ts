/**
 * Record the key server objects of §0.1 (each object and the versioned field
 * `KeyServer.read` reads) and each server's `GET /v1/service` answer (the
 * on-chain URL for independent servers, the aggregator for committees) into
 * `test/fixtures/<network>.json`. Read-only: no keys, no funds.
 *
 *   bun packages/seal/scripts/record-chain.ts
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import type { Address } from "@unconfirmed/sui/Address"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import * as Objects from "@unconfirmed/sui/Objects"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Config from "../src/Config.ts"
import * as KeyServer from "../src/KeyServer.ts"
import {
  type Fixture,
  fixturesDir,
  type RecordedObject,
  type RecordedService,
  recordObject,
  TESTNET_INDEPENDENT
} from "../test/fixtures.ts"

const networks = {
  testnet: {
    url: "https://fullnode.testnet.sui.io:443",
    servers: [...TESTNET_INDEPENDENT, Config.testnet.committee.objectId],
    aggregators: { [Config.testnet.committee.objectId]: Config.testnet.committee.aggregatorUrl! }
  },
  mainnet: {
    url: "https://fullnode.mainnet.sui.io:443",
    servers: [Config.mainnet.committee.objectId],
    aggregators: { [Config.mainnet.committee.objectId]: Config.mainnet.committee.aggregatorUrl! }
  }
} as const

const MAX_BODY = 2048

/** The request `@mysten/seal` sends for `verifyKeyServers` (H3), with a 10 s timeout. */
const recordService = async (url: string, objectId: string): Promise<RecordedService> => {
  try {
    const response = await fetch(`${url}/v1/service?service_id=${objectId}`, {
      headers: {
        "Content-Type": "application/json",
        "Request-Id": crypto.randomUUID(),
        "Client-Sdk-Type": "typescript",
        "Client-Sdk-Version": "2.0.1"
      },
      signal: AbortSignal.timeout(10_000)
    })
    const body = await response.text()
    const version = response.headers.get("x-keyserver-version")
    return {
      url,
      status: response.status,
      ...(version !== null && { version }),
      body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body
    }
  } catch (e) {
    return { url, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

for (const [network, { aggregators, servers, url }] of Object.entries(networks)) {
  const objects = new Map<string, RecordedObject>()
  const recording = Layer.effect(
    Objects.Objects,
    Effect.map(Effect.service(Objects.Objects), (o) =>
      Objects.Objects.of({
        get: (id) => Effect.tap(o.get(id), (obj) => Effect.sync(() => objects.set(obj.objectId, recordObject(obj)))),
        listOwned: o.listOwned
      }))
  )
  const chain = SuiGrpc.layer({ baseUrl: url }).pipe(Layer.provide(FetchHttpClient.layer))
  const onChain = await Effect.runPromise(
    Effect.forEach(servers, (id) => KeyServer.read(id as Address), { concurrency: "unbounded" }).pipe(
      Effect.provide(recording.pipe(Layer.provide(chain)))
    )
  )
  const services: Record<string, RecordedService> = {}
  await Promise.all(onChain.map(async (s) => {
    const target = s.type._tag === "Independent" ? s.type.url : (aggregators as Record<string, string>)[s.objectId]!
    services[s.objectId] = await recordService(target, s.objectId)
  }))
  const fixture: Fixture = {
    network: network as Fixture["network"],
    recordedAt: new Date().toISOString(),
    keyServers: onChain.map((s) => ({ objectId: s.objectId, name: s.name, layout: s.layout, type: s.type._tag })),
    objects: [...objects.values()].sort((a, b) => a.objectId.localeCompare(b.objectId)),
    services: Object.fromEntries(Object.entries(services).sort(([a], [b]) => a.localeCompare(b)))
  }
  writeFileSync(join(fixturesDir, `${network}.json`), JSON.stringify(fixture, null, 1) + "\n")
  console.log(`${network}: ${onChain.length} key servers, ${objects.size} objects`)
  for (const s of onChain) {
    const r = services[s.objectId]!
    console.log(`  ${s.name.padEnd(26)} v${s.layout} ${s.type._tag.padEnd(11)} ${r.status ?? r.error} ${r.version ?? ""}`)
  }
}
