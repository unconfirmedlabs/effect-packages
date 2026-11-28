/**
 * Dynamic fields: reading a field of a parent by name, the child object of a
 * dynamic object field, and listing a parent's fields as a `Stream`.
 *
 * A name is its Move type plus its BCS bytes. `deriveId` computes a field's
 * object id offline, which is how `get` reads through the batched `Objects.get`.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { type Address, fromBytes, normalize, SUI_FRAMEWORK } from "./Address.ts"
import { blake2b256 } from "./Hash.ts"
import type { SuiObject } from "./Objects.ts"
import type { RpcError } from "./RpcError.ts"
import * as TypeTag from "./TypeTag.ts"

export interface Name {
  /** The name's Move type, e.g. `u64`, `0x1::string::String`. */
  readonly type: string
  /** The name's BCS bytes. */
  readonly bcs: Uint8Array
}

/** A dynamic field read by name. */
export interface DynamicField {
  readonly parent: Address
  readonly fieldId: Address
  readonly name: Name
  /** The value's Move type. */
  readonly valueType: string
  /** The value's BCS bytes. */
  readonly value: Uint8Array
  /** The `0x2::dynamic_field::Field<Name, Value>` object itself. */
  readonly field: SuiObject
}

/** One entry of a parent's listing. */
export interface FieldInfo {
  /** `Field` for `0x2::dynamic_field`, `Object` for `0x2::dynamic_object_field`. */
  readonly kind: "Field" | "Object"
  readonly parent: Address
  readonly fieldId: Address
  /** For an object field, the name as added (not its `Wrapper`). */
  readonly name: Name
  /** For an object field, the child object's type. */
  readonly valueType: string
  /** The value's BCS bytes; for an object field, the child's id. */
  readonly value: Uint8Array
  /** The child object's id, for an object field. */
  readonly childId: Address | undefined
}

export class DynamicFieldNotFound extends /* @__PURE__ */ Schema.TaggedError<DynamicFieldNotFound>()("DynamicFieldNotFound", {
  parent: Schema.String,
  nameType: Schema.String,
  fieldId: Schema.String
}) {
  override get message(): string {
    return `dynamic field ${this.fieldId} (${this.nameType}) of ${this.parent} not found`
  }
}

/** The name's type doesn't parse, or its value doesn't encode with the given schema. */
export class InvalidDynamicFieldName extends /* @__PURE__ */ Schema.TaggedError<InvalidDynamicFieldName>()("InvalidDynamicFieldName", {
  nameType: Schema.String,
  issue: Schema.String
}) {
  override get message(): string {
    return `invalid dynamic field name of type ${this.nameType}: ${this.issue}`
  }
}

export class DynamicFieldDecodeError extends /* @__PURE__ */ Schema.TaggedError<DynamicFieldDecodeError>()("DynamicFieldDecodeError", {
  fieldId: Schema.String,
  valueType: Schema.String,
  issue: Schema.String
}) {
  override get message(): string {
    return `cannot decode dynamic field ${this.fieldId} as ${this.valueType}: ${this.issue}`
  }
}

// -----------------------------------------------------------------------------
// Pure
// -----------------------------------------------------------------------------

const encodeTypeTag = /* @__PURE__ */ Bcs.encodeSync(TypeTag.TypeTag)
const encodeU64 = /* @__PURE__ */ Bcs.encodeSync(Bcs.u64)

/**
 * A dynamic field's object id:
 * `blake2b256(0xf0 || parent || u64(len(name)) || name || bcs(TypeTag))`.
 * Throws on a malformed type string, like `TypeTag.parse`.
 */
export const deriveId = (parent: string, nameType: string | TypeTag.TypeTag, nameBcs: Uint8Array): Address => {
  const tag = encodeTypeTag(typeof nameType === "string" ? TypeTag.parse(nameType) : nameType)
  const parentBytes = Bcs.encodeSync(Bcs.Address)(normalize(parent))
  const len = encodeU64(BigInt(nameBcs.length))
  const input = new Uint8Array(1 + 32 + 8 + nameBcs.length + tag.length)
  let o = 0
  input[o++] = 0xf0
  for (const part of [parentBytes, len, nameBcs, tag]) {
    input.set(part, o)
    o += part.length
  }
  return fromBytes(blake2b256(input))
}

/**
 * The id of an object created with `0x2::derived_object::claim(parent, key)`:
 * the dynamic field id of `DerivedObjectKey<K>(key)` under `parent`, as
 * `@mysten/sui`'s `deriveObjectID`. `keyBcs` is the key's BCS bytes (the
 * wrapper adds none). Throws on a malformed key type, like `deriveId`.
 */
export const deriveObjectId = (parent: string, keyType: string | TypeTag.TypeTag, keyBcs: Uint8Array): Address =>
  deriveId(parent, {
    _tag: "struct",
    address: SUI_FRAMEWORK,
    module: "derived_object",
    name: "DerivedObjectKey",
    typeParams: [typeof keyType === "string" ? TypeTag.parse(keyType) : keyType]
  }, keyBcs)

/** The name type a dynamic object field is stored under: `0x2::dynamic_object_field::Wrapper<T>`. */
export const objectFieldNameType = (nameType: string): string =>
  `0x2::dynamic_object_field::Wrapper<${nameType}>`

/** Encode a name with its BCS schema. */
export const name = <T, E>(type: string, schema: Schema.Codec<T, E>, value: T): Result.Result<Name, InvalidDynamicFieldName> =>
  Result.match(Bcs.encode(schema)(value), {
    onSuccess: (bcs) => Result.succeed({ type, bcs }),
    onFailure: (e) => Result.fail(new InvalidDynamicFieldName({ nameType: type, issue: e.message }))
  })

/** Decode a field's value with a BCS schema. */
export const decodeValue = <T, E>(schema: Schema.Codec<T, E>) => {
  const run = Bcs.decode(schema)
  return (f: { readonly fieldId: Address; readonly valueType: string; readonly value: Uint8Array }): Effect.Effect<T, DynamicFieldDecodeError> =>
    Result.match(run(f.value), {
      onSuccess: Effect.succeed,
      onFailure: (e) => Effect.fail(new DynamicFieldDecodeError({ fieldId: f.fieldId, valueType: f.valueType, issue: e.message }))
    })
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface ListOptions {
  /** Only fields whose name type matches (`0xaddr[::module[::Name[<T>]]]`, or an exact non-struct type). */
  readonly nameType?: string
  readonly pageSize?: number
}

export class DynamicFields extends /* @__PURE__ */ Context.Service<DynamicFields, {
  readonly get: (parent: Address, name: Name) => Effect.Effect<DynamicField, DynamicFieldNotFound | InvalidDynamicFieldName | RpcError>
  /** The child object of a dynamic object field. */
  readonly getObject: (parent: Address, name: Name) => Effect.Effect<SuiObject, DynamicFieldNotFound | InvalidDynamicFieldName | RpcError>
  readonly list: (parent: Address, options?: ListOptions) => Stream.Stream<FieldInfo, RpcError>
}>()("@unconfirmed/sui/DynamicFields") {}

const withName = <T, E, A, Err, R>(
  type: string,
  schema: Schema.Codec<T, E>,
  value: T,
  f: (n: Name) => Effect.Effect<A, Err, R>
): Effect.Effect<A, Err | InvalidDynamicFieldName, R> =>
  Result.match(name(type, schema, value), { onSuccess: f, onFailure: Effect.fail })

/** `get` with the name given as a BCS schema and value: `getWith(parent, "u64", Bcs.u64, 7n)`. */
export const getWith = <T, E>(parent: Address, type: string, schema: Schema.Codec<T, E>, value: T) =>
  Effect.flatMap(Effect.service(DynamicFields), (d) => withName(type, schema, value, (n) => d.get(parent, n)))

/** `getObject` with the name given as a BCS schema and value. */
export const getObjectWith = <T, E>(parent: Address, type: string, schema: Schema.Codec<T, E>, value: T) =>
  Effect.flatMap(Effect.service(DynamicFields), (d) => withName(type, schema, value, (n) => d.getObject(parent, n)))
