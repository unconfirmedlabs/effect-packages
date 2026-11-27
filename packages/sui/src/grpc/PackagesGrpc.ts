import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Request from "effect/Request"
import * as RequestResolver from "effect/RequestResolver"
import { type FunctionTarget, type MoveFunction, Packages, type Reference } from "../Packages.ts"
import type { RpcError } from "../RpcError.ts"
import * as Rpc from "./generated/rpc.ts"
import { successByKey } from "./cache.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

class GetFunction extends Request.Class<FunctionTarget, MoveFunction, RpcError> {}

const REFERENCE: Record<number, Reference> = { 1: "Immutable", 2: "Mutable" }

/** `Packages` over gRPC. Function signatures are immutable; successful reads are cached for the layer's lifetime. */
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
          Effect.map((r): MoveFunction => ({
            isEntry: r.function?.is_entry ?? false,
            parameters: (r.function?.parameters ?? []).map((p) => ({
              reference: REFERENCE[p.reference ?? 0] ?? "Value",
              typeName: p.body?.type_name
            }))
          }))
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
