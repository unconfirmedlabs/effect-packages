/**
 * Recorded chain objects: a JSON form of `Objects.SuiObject` (bigints as
 * strings, contents as base64) and an `Objects` layer over a set of them, so
 * chain-state code runs offline against real testnet and mainnet bytes.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import type { Address } from "@unconfirmed/sui/Address"
import * as Objects from "@unconfirmed/sui/Objects"
import type { ObjectDigest } from "@unconfirmed/sui/TransactionData"

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

/** `Objects` over recorded objects plus live overrides (later wins); `gets` counts reads by id (to test caching). */
export const objectsLayer = (recorded: Iterable<RecordedObject>, overrides: ReadonlyArray<Objects.SuiObject> = []) => {
  const byId = new Map<string, Objects.SuiObject>()
  for (const r of recorded) byId.set(r.objectId, restoreObject(r))
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
