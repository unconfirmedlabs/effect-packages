import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Address from "../Address.ts"
import {
  deriveId,
  DynamicFieldNotFound,
  DynamicFields,
  type FieldInfo,
  InvalidDynamicFieldName,
  type Name,
  objectFieldNameType
} from "../DynamicFields.ts"
import { Objects } from "../Objects.ts"
import * as TypeTag from "../TypeTag.ts"
import type * as P from "./generated/proto.ts"
import * as Rpc from "./generated/lean.ts"
import { GrpcWeb } from "./GrpcWeb.ts"
import { convert } from "./scan.ts"

const LIST_MASK = { paths: ["kind", "parent", "field_id", "name", "value", "value_type", "child_id"] }
const KINDS = { 1: "Field", 2: "Object" } as const

const required = <A>(a: A | undefined, name: string): A => {
  if (a === undefined) throw new Error(`dynamic field without ${name}`)
  return a
}

const info = (f: P.DynamicField): FieldInfo | undefined => {
  const kind = KINDS[f.kind as 1 | 2]
  if (!kind) return undefined
  return {
    kind,
    parent: Address.normalize(required(f.parent, "parent")),
    fieldId: Address.normalize(required(f.field_id, "field_id")),
    name: { type: f.name?.name ?? "", bcs: f.name?.value ?? new Uint8Array() },
    valueType: f.value_type ?? f.value?.name ?? "",
    value: f.value?.value ?? new Uint8Array(),
    childId: f.child_id ? Address.normalize(f.child_id) : undefined
  }
}

const fieldIdOf = (parent: Address.Address, type: string, name: Name) =>
  Effect.try({
    try: () => deriveId(parent, type, name.bcs),
    catch: (e) => new InvalidDynamicFieldName({ nameType: type, issue: e instanceof Error ? e.message : String(e) })
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
 * `DynamicFields` over gRPC. `get` and `getObject` derive the field id and read
 * through `Objects.get`, so concurrent reads batch with every other object read;
 * `list` pages `StateService.ListDynamicFields`.
 */
export const layer: Layer.Layer<DynamicFields, never, GrpcWeb | Objects> = Layer.effect(
  DynamicFields,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const objects = yield* Objects

    const readField = (parent: Address.Address, type: string, name: Name) =>
      Effect.flatMap(fieldIdOf(parent, type, name), (fieldId) =>
        objects.get(fieldId).pipe(
          Effect.catchTag("ObjectNotFound", () => Effect.fail(new DynamicFieldNotFound({ parent, nameType: name.type, fieldId }))),
          // Field<N, V> = { id: UID, name: N, value: V }; the name's bytes are the ones hashed into the id.
          Effect.map((field) => ({
            parent,
            fieldId,
            name,
            valueType: valueTypeOf(field.type),
            value: field.contents.subarray(32 + name.bcs.length),
            field
          }))
        ))

    return DynamicFields.of({
      get: (parent, name) =>
        readField(parent, name.type, name).pipe(
          Effect.withSpan("DynamicFields.get", { attributes: { parent, nameType: name.type } })
        ),
      getObject: (parent, name) =>
        readField(parent, objectFieldNameType(name.type), name).pipe(
          Effect.flatMap((f) => {
            const childId = Address.fromBytes(f.value.subarray(0, 32))
            return objects.get(childId).pipe(
              Effect.catchTag("ObjectNotFound", () =>
                Effect.fail(new DynamicFieldNotFound({ parent, nameType: name.type, fieldId: f.fieldId })))
            )
          }),
          Effect.withSpan("DynamicFields.getObject", { attributes: { parent, nameType: name.type } })
        ),
      list: (parent, options) =>
        Stream.paginate(undefined as Uint8Array | undefined, (page_token) =>
          grpc
            .unary(Rpc.StateService_ListDynamicFields, {
              parent,
              read_mask: LIST_MASK,
              page_size: options?.pageSize ?? 100,
              ...(page_token && { page_token }),
              ...(options?.nameType && {
                filter: { terms: [{ literals: [{ predicate: { _tag: "name_type", value: { name_type: TypeTag.normalizePath(options.nameType) } } }] }] }
              })
            })
            .pipe(
              Effect.flatMap((r) => convert(Rpc.StateService_ListDynamicFields.path, () =>
                [
                  (r.dynamic_fields ?? []).flatMap((f) => {
                    const i = info(f)
                    // Nodes that predate the filter ignore it.
                    return i && (!options?.nameType || TypeTag.matchesPath(options.nameType, i.name.type)) ? [i] : []
                  }),
                  Option.fromNullishOr(r.next_page_token?.length ? r.next_page_token : undefined)
                ] as const
              ))
            ))
    })
  })
)
