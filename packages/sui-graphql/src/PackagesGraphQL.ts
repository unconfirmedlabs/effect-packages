import * as Cache from "effect/Cache"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Address from "@unconfirmed/sui/Address"
import * as Packages from "@unconfirmed/sui/Packages"
import { RpcError } from "@unconfirmed/sui/RpcError"
import { call } from "./convert.ts"

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
    "package(address:$package){module(name:$module){function(name:$function){isEntry parameters{signature}}}} " +
    // Tells "no such package" (NOT_FOUND) from "an object, not a package" (INVALID_ARGUMENT).
    "object(address:$package){address}}",
  variables: { package: Schema.String, module: Schema.String, function: Schema.String },
  result: Schema.Struct({
    package: Schema.NullOr(Schema.Struct({
      module: Schema.NullOr(Schema.Struct({
        function: Schema.NullOr(Schema.Struct({
          isEntry: Schema.NullOr(Schema.Boolean),
          parameters: Schema.NullOr(Schema.Array(Schema.Struct({ signature: Signature })))
        }))
      }))
    })),
    object: Schema.NullOr(Schema.Struct({ address: Schema.String }))
  })
})

export const group = GraphQLGroup.make(GetMoveFunction)

const parameter = (s: typeof Signature.Type): Packages.Parameter => ({
  reference: s.ref === "&" ? "Immutable" : s.ref === "&mut" ? "Mutable" : "Value",
  typeName: isDatatype(s.body)
    ? `${Address.normalize(s.body.datatype.package)}::${s.body.datatype.module}::${s.body.datatype.type}`
    : undefined
})

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
            return r.object === null ? fail("NOT_FOUND", `package ${pkg} not found`) : fail("INVALID_ARGUMENT", "object is not a package")
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
      getFunction: (target) => Cache.get(cache, `${target.package}::${target.module}::${target.function}`)
    })
  })
)
