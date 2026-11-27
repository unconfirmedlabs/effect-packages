import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Request from "effect/Request"
import * as RequestResolver from "effect/RequestResolver"
import { type FunctionTarget, type MoveFunction, Packages, type Parameter, type Reference } from "../Packages.ts"
import type { RpcError } from "../RpcError.ts"
import type * as P from "./generated/proto.ts"
import { convert } from "./convert.ts"
import * as Rpc from "./generated/rpc.ts"
import { successByKey } from "./cache.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

class GetFunction extends Request.Class<FunctionTarget, MoveFunction, RpcError> {}

const REFERENCE: Record<number, Reference> = { 1: "Immutable", 2: "Mutable" }

const PRIMITIVE: Record<number, string> = { 1: "address", 2: "bool", 3: "u8", 4: "u16", 5: "u32", 6: "u64", 7: "u128", 8: "u256" }

/** A closed signature body as a type string; `undefined` if it mentions a type parameter. */
const typeString = (b: P.OpenSignatureBody | undefined): string | undefined => {
  if (b === undefined) return undefined
  const prim = PRIMITIVE[b.type ?? 0]
  if (prim !== undefined) return prim
  if (b.type === 9) {
    const item = typeString(b.type_parameter_instantiation?.[0])
    return item === undefined ? undefined : `vector<${item}>`
  }
  if (b.type === 10 && b.type_name !== undefined) {
    const args = (b.type_parameter_instantiation ?? []).map(typeString)
    if (args.some((a) => a === undefined)) return undefined
    return args.length === 0 ? b.type_name : `${b.type_name}<${args.join(", ")}>`
  }
  return undefined
}

const parameter = (p: P.OpenSignature): Parameter => {
  const type = typeString(p.body)
  const out = { reference: REFERENCE[p.reference ?? 0] ?? "Value", typeName: p.body?.type_name, ...(type !== undefined && { type }) } as const
  const inst = p.body?.type === 10 ? p.body.type_parameter_instantiation ?? [] : []
  if (inst.length === 0) return out
  const typeArguments = inst.map(typeString)
  return typeArguments.every((a) => a !== undefined) ? { ...out, typeArguments: typeArguments as Array<string> } : out
}

/**
 * `Packages` over gRPC. Function signatures are immutable; successful reads are
 * cached for the layer's lifetime, and concurrent reads of one target share a request.
 */
export const layer: Layer.Layer<Packages, never, GrpcWeb> = Layer.effect(
  Packages,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const resolver = RequestResolver.fromEffect(({ request }: Request.Entry<GetFunction>) =>
      grpc
        .unary(Rpc.MovePackageService_GetFunction, {
          package_id: request.package,
          module_name: request.module,
          name: request.function
        })
        .pipe(
          Effect.flatMap((r) =>
            convert(Rpc.MovePackageService_GetFunction.path, (): MoveFunction => {
              if (r.function === undefined) throw new Error("no function")
              return { isEntry: r.function.is_entry ?? false, parameters: (r.function.parameters ?? []).map(parameter) }
            })
          )
        )
    )
    // Successes only: a transient failure must not poison the target for the layer's lifetime.
    const cache = successByKey<string, MoveFunction>(4096)

    return Packages.of({
      getFunction: (target) =>
        cache(
          `${target.package}::${target.module}::${target.function}`,
          Effect.request(new GetFunction({ package: target.package, module: target.module, function: target.function }), resolver)
        )
    })
  })
)
