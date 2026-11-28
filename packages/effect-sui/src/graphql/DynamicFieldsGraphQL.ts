import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as DynamicFields from "@unconfirmed/sui/DynamicFields"
import * as Objects from "@unconfirmed/sui/Objects"
import { RpcError } from "@unconfirmed/sui/RpcError"
import * as TypeTag from "@unconfirmed/sui/TypeTag"
import { Bytes, call } from "./convert.ts"

/** The largest page the server allows for `dynamicFields`. */
const MAX_PAGE = 50

const Repr = Schema.Struct({ repr: Schema.String })

const FieldNode = Schema.Struct({
  address: Schema.String,
  name: Schema.Struct({ type: Repr, bcs: Bytes }),
  value: Schema.Union([
    Schema.Struct({ __typename: Schema.Literal("MoveValue"), type: Repr, bcs: Bytes }),
    Schema.Struct({ __typename: Schema.Literal("MoveObject"), address: Schema.String, contents: Schema.Struct({ type: Repr }) })
  ])
})

export const ListDynamicFields = GraphQL.query("ListDynamicFields", {
  document: "query ListDynamicFields($parent:SuiAddress!,$first:Int,$after:String){address(address:$parent){" +
    "dynamicFields(first:$first,after:$after){pageInfo{hasNextPage endCursor}nodes{address name{type{repr} bcs} " +
    "value{__typename ...on MoveValue{type{repr} bcs} ...on MoveObject{address contents{type{repr}}}}}}}}",
  variables: { parent: Schema.String, first: Schema.Number, after: Schema.NullOr(Schema.String) },
  result: Schema.Struct({
    address: Schema.NullOr(Schema.Struct({
      dynamicFields: Schema.NullOr(Schema.Struct({
        pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
        nodes: Schema.Array(FieldNode)
      }))
    }))
  })
})

export const group = GraphQLGroup.make(ListDynamicFields)

const addressBytes = (a: string): Uint8Array => Bcs.encodeSync(Bcs.Address)(Address.normalize(a))

const canonical = (type: string) => {
  try {
    return TypeTag.normalizeString(type)
  } catch {
    return type
  }
}

const info = (parent: Address.Address, f: typeof FieldNode.Type): DynamicFields.FieldInfo =>
  f.value.__typename === "MoveObject"
    ? {
      kind: "Object",
      parent,
      fieldId: Address.normalize(f.address),
      name: { type: canonical(f.name.type.repr), bcs: f.name.bcs },
      valueType: canonical(f.value.contents.type.repr),
      value: addressBytes(f.value.address),
      childId: Address.normalize(f.value.address)
    }
    : {
      kind: "Field",
      parent,
      fieldId: Address.normalize(f.address),
      name: { type: canonical(f.name.type.repr), bcs: f.name.bcs },
      valueType: canonical(f.value.type.repr),
      value: f.value.bcs,
      childId: undefined
    }

const fieldIdOf = (parent: Address.Address, type: string, name: DynamicFields.Name) =>
  Effect.try({
    try: () => DynamicFields.deriveId(parent, type, name.bcs),
    catch: (e) => new DynamicFields.InvalidDynamicFieldName({ nameType: type, issue: e instanceof Error ? e.message : String(e) })
  })

/** `Field<N, V>` -> `V`, canonical. */
const valueTypeOf = (fieldType: string) => {
  try {
    const t = TypeTag.parse(fieldType)
    return t._tag === "struct" && t.typeParams[1] ? TypeTag.format(t.typeParams[1]) : fieldType
  } catch {
    return fieldType
  }
}

/**
 * `DynamicFields` over GraphQL. `get` and `getObject` derive the field id and
 * read through `Objects.get`, so concurrent reads batch with every other object
 * read into `multiGetObjects`; `list` pages `Address.dynamicFields`.
 *
 * GraphQL's `dynamicFields` has no name-type filter, so `nameType` is applied
 * client-side (same matching as the gRPC layer); a sparse match still pages
 * through every field.
 */
export const layer: Layer.Layer<DynamicFields.DynamicFields, never, GraphQLProtocol.GraphQLProtocol | Objects.Objects> =
  Layer.effect(
    DynamicFields.DynamicFields,
    Effect.gen(function*() {
      const client = yield* GraphQLClient.make(group)
      const objects = yield* Objects.Objects

      const readField = (parent: Address.Address, type: string, name: DynamicFields.Name) =>
        Effect.flatMap(fieldIdOf(parent, type, name), (fieldId) =>
          objects.get(fieldId).pipe(
            Effect.catchTag("ObjectNotFound", () =>
              Effect.fail(new DynamicFields.DynamicFieldNotFound({ parent, nameType: name.type, fieldId }))),
            // Field<N, V> = { id: UID, name: N, value: V }; the name's bytes are the ones hashed into the id.
            Effect.map((field): DynamicFields.DynamicField => ({
              parent,
              fieldId,
              name,
              valueType: valueTypeOf(field.type),
              value: field.contents.subarray(32 + name.bcs.length),
              field
            }))
          ))

      return DynamicFields.DynamicFields.of({
        get: (parent, name) =>
          readField(parent, name.type, name).pipe(
            Effect.withSpan("DynamicFields.get", { attributes: { parent, nameType: name.type } })
          ),
        getObject: (parent, name) =>
          readField(parent, DynamicFields.objectFieldNameType(name.type), name).pipe(
            Effect.flatMap((f) =>
              f.value.length < 32
                ? Effect.fail(
                  new RpcError({
                    method: "GetObject",
                    code: "DATA_LOSS",
                    message: `dynamic object field ${f.fieldId} holds ${f.value.length} bytes, not an object id`
                  })
                )
                : objects.get(Address.fromBytes(f.value.subarray(0, 32))).pipe(
                Effect.catchTag("ObjectNotFound", () =>
                  Effect.fail(new DynamicFields.DynamicFieldNotFound({ parent, nameType: name.type, fieldId: f.fieldId })))
              )
            ),
            Effect.withSpan("DynamicFields.getObject", { attributes: { parent, nameType: name.type } })
          ),
        list: (parent, options) =>
          Stream.paginate(null as string | null, (after) =>
            client
              .ListDynamicFields({ parent, first: Math.min(options?.pageSize ?? MAX_PAGE, MAX_PAGE), after })
              .pipe(
                call,
                Effect.map((r) => {
                  const page = r.address?.dynamicFields
                  const fields = (page?.nodes ?? [])
                    .map((f) => info(parent, f))
                    .filter((i) => !options?.nameType || TypeTag.matchesPath(options.nameType, i.name.type))
                  return [fields, Option.fromNullishOr(page?.pageInfo.hasNextPage ? page.pageInfo.endCursor : null)] as const
                })
              ))
      })
    })
  )
