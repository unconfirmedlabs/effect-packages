/**
 * Reading objects. `get` is batched and deduplicated by every implementation,
 * so call it freely and concurrently.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import type { Address } from "./Address.ts"
import type { RpcError } from "./RpcError.ts"
import type { ObjectDigest, ObjectRef } from "./TransactionData.ts"
import * as TypeTag from "./TypeTag.ts"

export type Owner =
  | { readonly _tag: "AddressOwner"; readonly address: Address }
  | { readonly _tag: "ObjectOwner"; readonly address: Address }
  | { readonly _tag: "Shared"; readonly initialSharedVersion: bigint }
  | { readonly _tag: "Immutable" }
  | { readonly _tag: "ConsensusAddressOwner"; readonly startVersion: bigint; readonly address: Address }
  /** An owner kind newer than this SDK (the transport's raw kind number). */
  | { readonly _tag: "Unknown"; readonly kind: number }

export interface SuiObject {
  readonly objectId: Address
  readonly version: bigint
  readonly digest: ObjectDigest
  readonly owner: Owner
  /** The full type, `0x2::coin::Coin<0x2::sui::SUI>` (or `package`). */
  readonly type: string
  /** The Move struct's BCS bytes. Empty for packages. */
  readonly contents: Uint8Array
  /** The digest of the transaction that last wrote this version; `undefined` when the transport doesn't report it. */
  readonly previousTransaction: string | undefined
}

export const refOf = (o: SuiObject): ObjectRef => ({ objectId: o.objectId, version: o.version, digest: o.digest })

export class ObjectNotFound extends /* @__PURE__ */ Schema.TaggedError<ObjectNotFound>()("ObjectNotFound", {
  objectId: Schema.String
}) {
  override get message(): string {
    return `object ${this.objectId} not found`
  }
}

export class ObjectDecodeError extends /* @__PURE__ */ Schema.TaggedError<ObjectDecodeError>()("ObjectDecodeError", {
  objectId: Schema.String,
  type: Schema.String,
  issue: Schema.String
}) {
  override get message(): string {
    return `cannot decode object ${this.objectId} as ${this.type}: ${this.issue}`
  }
}

/** Decode an object's contents with a BCS schema. */
export const decode = <T, E>(schema: Schema.Codec<T, E>) => {
  const run = Bcs.decode(schema)
  return (o: SuiObject): Effect.Effect<T, ObjectDecodeError> =>
    Result.match(run(o.contents), {
      onSuccess: Effect.succeed,
      onFailure: (e) => Effect.fail(new ObjectDecodeError({ objectId: o.objectId, type: o.type, issue: e.message }))
    })
}

export interface ListOwnedOptions {
  /** A struct type filter; a type without type arguments matches every instantiation. */
  readonly type?: string
  readonly pageSize?: number
}

export class Objects extends /* @__PURE__ */ Context.Service<Objects, {
  readonly get: (objectId: Address) => Effect.Effect<SuiObject, ObjectNotFound | RpcError>
  readonly listOwned: (owner: Address, options?: ListOwnedOptions) => Stream.Stream<SuiObject, RpcError>
}>()("@unconfirmed/effect-sui/Objects") {}

/** The object's type is not the one asked for. */
export class ObjectTypeMismatch extends /* @__PURE__ */ Schema.TaggedError<ObjectTypeMismatch>()("ObjectTypeMismatch", {
  objectId: Schema.String,
  expected: Schema.String,
  actual: Schema.String
}) {
  override get message(): string {
    return `object ${this.objectId} is a ${this.actual}, not a ${this.expected}`
  }
}

export interface GetAsOptions {
  /**
   * The object's expected type, checked before decoding. A struct type without
   * type arguments (`0x2::coin::Coin`) matches every instantiation; with them,
   * only that one. Addresses may be short (`0x2`). Without it, the contents are
   * decoded whatever the type: a schema that happens to parse other bytes
   * decodes them, so give it unless the object id is trusted.
   */
  readonly type?: string
}

/** Fetch, check the type (`options.type`) and decode in one step. */
export const getAs = <T, E>(objectId: Address, schema: Schema.Codec<T, E>, options?: GetAsOptions) => {
  const d = decode(schema)
  const expected = options?.type
  return Effect.flatMap(Effect.service(Objects), (o) =>
    Effect.flatMap(o.get(objectId), (object): Effect.Effect<T, ObjectDecodeError | ObjectTypeMismatch> =>
      expected === undefined || TypeTag.matchesPath(expected, object.type)
        ? d(object)
        : Effect.fail(
          new ObjectTypeMismatch({ objectId: object.objectId, expected: TypeTag.normalizePath(expected), actual: object.type })
        )))
}
