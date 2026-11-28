import * as Cache from "effect/Cache"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Address from "../Address.ts"
import * as Packages from "../Packages.ts"
import { RpcError } from "../RpcError.ts"
import { Bytes, call } from "./convert.ts"

/**
 * The parts of an `OpenMoveTypeSignature` (a JSON scalar) that `Parameter`
 * needs: the reference and, for a datatype, its name. Everything else in the
 * body (primitives, vectors, type parameters) has no `typeName`, as over gRPC.
 */
const Signature = Schema.Struct({
  ref: Schema.optionalKey(Schema.NullOr(Schema.Literals(["&", "&mut"]))),
  body: Schema.Unknown
})

const Datatype = Schema.Struct({
  datatype: Schema.Struct({ package: Schema.String, module: Schema.String, type: Schema.String })
})
const isDatatype = Schema.is(Datatype)

export const GetMoveFunction = GraphQL.query("GetMoveFunction", {
  document: "query GetMoveFunction($package:SuiAddress!,$module:String!,$function:String!){" +
    "package(address:$package){module(name:$module){function(name:$function){isEntry parameters{signature}}}}}",
  variables: { package: Schema.String, module: Schema.String, function: Schema.String },
  result: Schema.Struct({
    package: Schema.NullOr(Schema.Struct({
      module: Schema.NullOr(Schema.Struct({
        function: Schema.NullOr(Schema.Struct({
          isEntry: Schema.NullOr(Schema.Boolean),
          parameters: Schema.NullOr(Schema.Array(Schema.Struct({ signature: Signature })))
        }))
      }))
    }))
  })
})

/** Asked only when there is no package: tells "no such package" (NOT_FOUND) from "an object, not a package" (INVALID_ARGUMENT). */
export const ObjectExists = GraphQL.query("ObjectExists", {
  document: "query ObjectExists($address:SuiAddress!){object(address:$address){address}}",
  variables: { address: Schema.String },
  result: Schema.Struct({ object: Schema.NullOr(Schema.Struct({ address: Schema.String })) })
})

/** `moduleBcs`: the modules as BCS `(name, bytes)` pairs, in one field instead of a paged `modules` connection. */
export const GetPackageModules = GraphQL.query("GetPackageModules", {
  document: "query GetPackageModules($package:SuiAddress!){package(address:$package){moduleBcs}}",
  variables: { package: Schema.String },
  result: Schema.Struct({ package: Schema.NullOr(Schema.Struct({ moduleBcs: Schema.NullOr(Bytes) })) })
})

const decodeModules = /* @__PURE__ */ Bcs.decode(/* @__PURE__ */ Bcs.vector(/* @__PURE__ */ Bcs.tuple([Bcs.string, Bcs.byteVector])))

export const group = GraphQLGroup.make(GetMoveFunction, ObjectExists, GetPackageModules)

const PRIMITIVES = new Set(["address", "bool", "u8", "u16", "u32", "u64", "u128", "u256"])

/** A closed signature body as a type string; `undefined` if it mentions a type parameter (or is not understood). */
const typeString = (body: unknown): string | undefined => {
  if (typeof body === "string") return PRIMITIVES.has(body) ? body : undefined
  if (typeof body !== "object" || body === null) return undefined
  if ("vector" in body) {
    const item = typeString((body as { vector: unknown }).vector)
    return item === undefined ? undefined : `vector<${item}>`
  }
  if (!isDatatype(body)) return undefined
  const d = body.datatype
  const name = `${Address.normalize(d.package)}::${d.module}::${d.type}`
  const args = typeArgumentsOf(body)
  return args === undefined ? undefined : args.length === 0 ? name : `${name}<${args.join(", ")}>`
}

const typeArgumentsOf = (body: typeof Datatype.Type): ReadonlyArray<string> | undefined => {
  const raw = (body.datatype as { typeParameters?: unknown }).typeParameters
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return undefined
  const args = raw.map(typeString)
  return args.every((a) => a !== undefined) ? args as Array<string> : undefined
}

const parameter = (s: typeof Signature.Type): Packages.Parameter => {
  const out: Packages.Parameter = {
    reference: s.ref === "&" ? "Immutable" : s.ref === "&mut" ? "Mutable" : "Value",
    typeName: isDatatype(s.body)
      ? `${Address.normalize(s.body.datatype.package)}::${s.body.datatype.module}::${s.body.datatype.type}`
      : undefined
  }
  const typeArguments = isDatatype(s.body) ? typeArgumentsOf(s.body) : undefined
  return typeArguments === undefined || typeArguments.length === 0 ? out : { ...out, typeArguments }
}

/**
 * `Packages` over GraphQL. Function signatures are immutable, so successful
 * lookups are cached for the layer's lifetime (up to 4096); failures are not
 * cached. Concurrent lookups of the same function share one request.
 *
 * Errors match gRPC: a missing package, module or function is NOT_FOUND, an
 * address that holds an object but not a package is INVALID_ARGUMENT.
 */
export const layer: Layer.Layer<Packages.Packages, never, GraphQLProtocol.GraphQLProtocol> = Layer.effect(
  Packages.Packages,
  Effect.gen(function*() {
    const client = yield* GraphQLClient.make(group)
    const fail = (code: "NOT_FOUND" | "INVALID_ARGUMENT", message: string) =>
      Effect.fail(new RpcError({ method: "GetMoveFunction", code, message }))

    const lookup = (key: string): Effect.Effect<Packages.MoveFunction, RpcError> => {
      const [pkg, module, fn] = key.split("::") as [string, string, string]
      return client.GetMoveFunction({ package: pkg, module, function: fn }).pipe(
        call,
        Effect.flatMap((r): Effect.Effect<Packages.MoveFunction, RpcError> => {
          if (r.package === null) {
            return client.ObjectExists({ address: pkg }).pipe(
              call,
              Effect.flatMap((o) =>
                o.object === null ? fail("NOT_FOUND", `package ${pkg} not found`) : fail("INVALID_ARGUMENT", "object is not a package")
              )
            )
          }
          if (r.package.module === null) return fail("NOT_FOUND", `Module not found: ${pkg}::${module}`)
          const f = r.package.module.function
          if (f === null) return fail("NOT_FOUND", `Function not found: ${fn}`)
          return Effect.succeed({
            isEntry: f.isEntry ?? false,
            parameters: (f.parameters ?? []).map((p) => parameter(p.signature))
          })
        })
      )
    }
    const cache = yield* Cache.makeWith(lookup, {
      capacity: 4096,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
    })

    return Packages.Packages.of({
      getFunction: (target) => Cache.get(cache, `${target.package}::${target.module}::${target.function}`),
      getModules: (packageId) =>
        client.GetPackageModules({ package: packageId }).pipe(
          call,
          Effect.flatMap((r): Effect.Effect<ReadonlyMap<string, Uint8Array>, Packages.PackageNotFound | RpcError> => {
            const method = "GetPackageModules"
            if (r.package === null) {
              return client.ObjectExists({ address: packageId }).pipe(
                call,
                Effect.flatMap((o): Effect.Effect<never, Packages.PackageNotFound | RpcError> =>
                  o.object === null
                    ? Effect.fail(new Packages.PackageNotFound({ packageId }))
                    : Effect.fail(new RpcError({ method, code: "INVALID_ARGUMENT", message: `${packageId} is not a package` }))
                )
              )
            }
            if (r.package.moduleBcs === null) return Effect.fail(new RpcError({ method, code: "DATA_LOSS", message: "no moduleBcs" }))
            return Result.match(decodeModules(r.package.moduleBcs), {
              onSuccess: (pairs) => Effect.succeed(new Map(pairs)),
              onFailure: (e) => Effect.fail(new RpcError({ method, code: "DATA_LOSS", message: `malformed moduleBcs: ${e.message}` }))
            })
          }),
          Effect.withSpan("Packages.getModules", { attributes: { packageId } })
        )
    })
  })
)
