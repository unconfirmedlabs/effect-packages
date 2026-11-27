/**
 * `Evidence` over gRPC: the node's lowest available checkpoint (an uncached
 * `GetServiceInfo`) and an epoch's first checkpoint. Its own subpath, so
 * nothing else loads the gRPC code.
 *
 *   EvidenceGrpc.layer.pipe(Layer.provide(GrpcWeb.layer({ baseUrl })))
 */
import * as Rpc from "@unconfirmed/sui/grpc/generated/rpc"
import { GrpcWeb } from "@unconfirmed/sui/grpc/GrpcWeb"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Evidence } from "./Evidence.ts"

export const layer: Layer.Layer<never, never, GrpcWeb> = Layer.effect(
  Evidence,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    return {
      lowestAvailableCheckpoint: grpc.unary(Rpc.LedgerService_GetServiceInfo, {}).pipe(
        // Proto3 optional: absent means unreported, which is never "full history".
        Effect.map((r) => Option.fromNullishOr(r.lowest_available_checkpoint)),
        Effect.withSpan("Evidence.lowestAvailableCheckpoint")
      ),
      epochFirstCheckpoint: (epoch) =>
        grpc.unary(Rpc.LedgerService_GetEpoch, { epoch, read_mask: { paths: ["epoch", "first_checkpoint"] } }).pipe(
          Effect.map((r) => r.epoch?.epoch === epoch ? Option.fromNullishOr(r.epoch?.first_checkpoint) : Option.none()),
          Effect.catchIf((e) => e.code === "NOT_FOUND", () => Effect.succeedNone),
          Effect.withSpan("Evidence.epochFirstCheckpoint")
        )
    }
  })
)
