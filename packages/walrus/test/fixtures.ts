/**
 * Recorded chain objects (written by `scripts/record-fixtures.ts`) served as
 * `Objects` and `Packages` layers, so chain-state code runs offline against
 * real testnet and mainnet bytes.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import type { Address } from "@unconfirmed/sui/Address"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Packages from "@unconfirmed/sui/Packages"
import { RpcError } from "@unconfirmed/sui/RpcError"
import type { ObjectDigest } from "@unconfirmed/sui/TransactionData"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { WalrusConfigService } from "../src/Config.ts"

export interface RecordedObject {
  readonly objectId: string
  readonly version: string
  readonly digest: string
  readonly owner: Record<string, unknown> & { readonly _tag: string }
  readonly type: string
  readonly contents: string // base64
  readonly previousTransaction?: string
}

export interface Fixture {
  readonly network: "testnet" | "mainnet"
  readonly recordedAt: string
  readonly config: WalrusConfigService
  readonly objects: ReadonlyArray<RecordedObject>
  /** `${package}::${module}::${function}` -> signature. */
  readonly functions: Readonly<Record<string, Packages.MoveFunction>>
}

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
    contents: Buffer.from(o.contents).toString("base64"),
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
    contents: new Uint8Array(Buffer.from(r.contents, "base64")),
    previousTransaction: r.previousTransaction
  }
}

// -----------------------------------------------------------------------------
// Layers
// -----------------------------------------------------------------------------

/** `Objects` over a fixture; `gets` counts reads by id (to test caching). */
export const objectsLayer = (fixture: Fixture, overrides: ReadonlyArray<Objects.SuiObject> = []) => {
  const byId = new Map<string, Objects.SuiObject>(fixture.objects.map((r) => [r.objectId, restoreObject(r)]))
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

export const packagesLayer = (fixture: Fixture) =>
  Layer.succeed(
    Packages.Packages,
    Packages.Packages.of({
      getFunction: (t) => {
        const f = fixture.functions[`${t.package}::${t.module}::${t.function}`]
        return f === undefined
          ? Effect.fail(new RpcError({ method: "GetFunction", code: "NOT_FOUND", message: `${t.module}::${t.function}` }))
          : Effect.succeed(f)
      }
    })
  )
