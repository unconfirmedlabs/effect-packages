/**
 * Recorded chain objects: a JSON form of `Objects.SuiObject` (bigints as
 * strings, contents as base64) and an in-memory node holding a set of them, so
 * chain-state code runs offline against real testnet and mainnet bytes.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Testing from "@unconfirmed/effect-sui/Testing"
import type { Address } from "@unconfirmed/effect-sui/Address"
import * as Objects from "@unconfirmed/effect-sui/Objects"
import type { ObjectDigest } from "@unconfirmed/effect-sui/TransactionData"

export interface RecordedObject {
  readonly objectId: string
  readonly version: string
  readonly digest: string
  readonly owner: Record<string, unknown> & { readonly _tag: string }
  readonly type: string
  readonly contents: string // base64
  readonly previousTransaction?: string
}

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

/**
 * An in-memory node (`@unconfirmed/effect-sui/Testing`) holding recorded objects plus
 * overrides (later wins), shared by every run of `layer`. `gets()` counts
 * `Objects.get` calls by id so far (to test caching), `requests()` is the log.
 */
export const objectsLayer = (recorded: Iterable<RecordedObject>, overrides: ReadonlyArray<Objects.SuiObject> = [], seed: Testing.Seed = {}) => {
  const context = Effect.runSync(Testing.make({ ...seed, objects: [...[...recorded].map(restoreObject), ...overrides] }))
  const requests = () => Effect.runSync(Context.get(context, Testing.Node).requests)
  const gets = () => {
    const counts = new Map<string, number>()
    for (const r of requests()) if (r.method === "Objects.get") for (const id of r.args as ReadonlyArray<string>) counts.set(id, (counts.get(id) ?? 0) + 1)
    return counts
  }
  return { layer: Layer.succeedContext(context), gets, requests }
}
