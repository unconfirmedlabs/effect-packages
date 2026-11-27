/**
 * Recorded chain state (written by `scripts/record-chain.ts`) served as an
 * `Objects` layer, so key server code runs offline against real testnet and
 * mainnet bytes; and the recorded `/v1/service` answers served as a stub
 * `KeyServerApi` (only `service`; `fetchKey` dies).
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { base64 } from "@scure/base"
import type { Address } from "@unconfirmed/sui/Address"
import * as Objects from "@unconfirmed/sui/Objects"
import type { ObjectDigest } from "@unconfirmed/sui/TransactionData"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { KeyServerApi, KeyServerError } from "../src/KeyServerApi.ts"

export interface RecordedObject {
  readonly objectId: string
  readonly version: string
  readonly digest: string
  readonly owner: Record<string, unknown> & { readonly _tag: string }
  readonly type: string
  readonly contents: string // base64
  readonly previousTransaction?: string
}

/** One `GET /v1/service?service_id=<id>` as it went. */
export interface RecordedService {
  readonly url: string
  /** Absent when no HTTP answer arrived. */
  readonly status?: number
  /** `X-KeyServer-Version`. */
  readonly version?: string
  /** The body, verbatim (truncated to 2 KiB). */
  readonly body?: string
  /** Transport failure or timeout. */
  readonly error?: string
}

export interface Fixture {
  readonly network: "testnet" | "mainnet"
  readonly recordedAt: string
  /** The key servers of §0.1 on this network, with what the recorder decoded. */
  readonly keyServers: ReadonlyArray<{ readonly objectId: string; readonly name: string; readonly layout: 1 | 2; readonly type: string }>
  readonly objects: ReadonlyArray<RecordedObject>
  /** By object id: each independent server's answer, and each committee's aggregator's. */
  readonly services: Readonly<Record<string, RecordedService>>
}

/** §0.1: ten independent testnet servers and the two committees. */
export const TESTNET_INDEPENDENT = [
  "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75", // mysten-v1-1
  "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8", // mysten-v1-2
  "0x6068c0acb197dddbacd4746a9de7f025b2ed5a5b6c1b1ab44dade4426d141da2", // ruby-nodes-free-testnet
  "0x5466b7df5c15b508678d51496ada8afab0d6f70a01c10613123382b1b8131007", // Testnet-Nodeinfra-open
  "0x164ac3d2b3b8694b8181c13f671950004765c23f270321a45fdd04d40cccf0f2", // studio-mirai-open
  "0x9c949e53c36ab7a9c484ed9e8b43267a77d4b8d70e79aa6b39042e3d4c434105", // overclock-open
  "0x39cef09b24b667bc6ed54f7159d82352fe2d5dd97ca9a5beaa1d21aa774f25a2", // H2O Nodes
  "0x4cded1abeb52a22b6becb42a91d3686a4c901cf52eee16234214d0b5b2da4c46", // triton-testnet-seal-1
  "0x3c93ec1474454e1b47cf485a4e5361a5878d722b9492daf10ef626a76adc3dad", // natsai-open-test
  "0x6a0726a1ea3d62ba2f2ae51104f2c3633c003fb75621d06fde47f04dc930ba06" // Suiftly|Mhax.io
] as const

export const fixturesDir = join(dirname(new URL(import.meta.url).pathname), "fixtures")

export const loadFixture = (network: "testnet" | "mainnet"): Fixture =>
  JSON.parse(readFileSync(join(fixturesDir, `${network}.json`), "utf-8"))

// -----------------------------------------------------------------------------
// Serialization
// -----------------------------------------------------------------------------

const BIGINT_OWNER_FIELDS = ["initialSharedVersion", "startVersion"] as const

export const recordObject = (o: Objects.SuiObject): RecordedObject => {
  const owner: Record<string, unknown> = { ...o.owner }
  for (const k of BIGINT_OWNER_FIELDS) if (typeof owner[k] === "bigint") owner[k] = (owner[k] as bigint).toString()
  return {
    objectId: o.objectId,
    version: o.version.toString(),
    digest: o.digest,
    owner: owner as RecordedObject["owner"],
    type: o.type,
    contents: base64.encode(o.contents),
    ...(o.previousTransaction !== undefined && { previousTransaction: o.previousTransaction })
  }
}

export const restoreObject = (r: RecordedObject): Objects.SuiObject => {
  const owner: Record<string, unknown> = { ...r.owner }
  for (const k of BIGINT_OWNER_FIELDS) if (typeof owner[k] === "string") owner[k] = BigInt(owner[k] as string)
  return {
    objectId: r.objectId as Address,
    version: BigInt(r.version),
    digest: r.digest as ObjectDigest,
    owner: owner as unknown as Objects.Owner,
    type: r.type,
    contents: base64.decode(r.contents),
    previousTransaction: r.previousTransaction
  }
}

// -----------------------------------------------------------------------------
// Layers
// -----------------------------------------------------------------------------

/** `Objects` over fixtures and extra objects; `gets` counts reads by id (to test caching). */
export const objectsLayer = (
  fixtures: ReadonlyArray<Fixture>,
  overrides: ReadonlyArray<Objects.SuiObject> = []
) => {
  const byId = new Map<string, Objects.SuiObject>()
  for (const f of fixtures) for (const r of f.objects) byId.set(r.objectId, restoreObject(r))
  for (const o of overrides) byId.set(o.objectId, o)
  const gets = new Map<string, number>()
  const layer = Layer.succeed(
    Objects.Objects,
    Objects.Objects.of({
      get: (objectId) =>
        Effect.suspend(() => {
          gets.set(objectId, (gets.get(objectId) ?? 0) + 1)
          const o = byId.get(objectId)
          return o === undefined ? Effect.fail(new Objects.ObjectNotFound({ objectId })) : Effect.succeed(o)
        }),
      listOwned: () => Stream.empty
    })
  )
  return { layer, gets, byId }
}

/**
 * A stub `KeyServerApi` answering `service` from recorded answers (by object
 * id). A recorded `200` decodes as S4's layer would; anything else is a
 * `KeyServerError` (`Unavailable`, or `Rejected` with the status). `calls`
 * counts requests by object id. `fetchKey` dies: S4 owns it.
 */
export const serviceStub = (services: Readonly<Record<string, RecordedService>>) => {
  const calls = new Map<string, number>()
  const layer = Layer.succeed(
    KeyServerApi,
    KeyServerApi.of({
      fetchKey: () => Effect.die("fetchKey is not stubbed"),
      service: (server) =>
        Effect.suspend(() => {
          calls.set(server.objectId, (calls.get(server.objectId) ?? 0) + 1)
          const r = services[server.objectId]
          const fail = (kind: KeyServerError["kind"], message: string, status?: number) =>
            Effect.fail(
              new KeyServerError({
                server: server.objectId,
                url: server.url,
                kind,
                message,
                ...(status !== undefined && { status })
              })
            )
          if (r === undefined || r.status === undefined) return fail("Unavailable", r?.error ?? "no recorded answer")
          if (r.status !== 200) return fail(r.status >= 500 ? "Unavailable" : "Rejected", r.body ?? "", r.status)
          const json = JSON.parse(r.body ?? "{}") as { service_id: string; pop: string }
          return Effect.succeed({ serviceId: json.service_id as Address, pop: base64.decode(json.pop), version: r.version })
        })
    })
  )
  return { layer, calls }
}
