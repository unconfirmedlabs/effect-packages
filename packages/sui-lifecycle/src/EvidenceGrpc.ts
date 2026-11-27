/**
 * `Evidence` over gRPC, from one node: `GetServiceInfo` (its epoch), then
 * `GetTransaction` (does it serve the digest), then `GetServiceInfo` again (its
 * lowest available checkpoint, after the miss) and, if it has pruned,
 * `GetEpoch` for where the window starts. Nothing is cached. Its own subpath,
 * so nothing else loads the gRPC code.
 *
 *   EvidenceGrpc.layer.pipe(Layer.provide(GrpcWeb.layer({ baseUrl })))
 *
 * Point it at the same endpoint as `Transactions`. Behind a load balancer the
 * calls may reach different nodes; use `SubmitConfig` `expiryEvidence: "never"`
 * there.
 */
import * as Rpc from "@unconfirmed/sui/grpc/generated/rpc"
import { GrpcWeb } from "@unconfirmed/sui/grpc/GrpcWeb"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Evidence, historyGap } from "./Evidence.ts"

export const layer: Layer.Layer<never, never, GrpcWeb> = Layer.effect(
  Evidence,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const serviceInfo = grpc.unary(Rpc.LedgerService_GetServiceInfo, {})
    const epochFirstCheckpoint = (epoch: bigint) =>
      grpc.unary(Rpc.LedgerService_GetEpoch, { epoch, read_mask: { paths: ["epoch", "first_checkpoint"] } }).pipe(
        Effect.map((r) => r.epoch?.epoch === epoch ? Option.fromNullishOr(r.epoch?.first_checkpoint) : Option.none<bigint>()),
        Effect.catchIf((e) => e.code === "NOT_FOUND", () => Effect.succeedNone)
      )
    return {
      observe: (digest, fromEpoch) =>
        Effect.gen(function*() {
          const before = yield* serviceInfo
          if (before.epoch === undefined) return Option.none()
          const found = yield* grpc.unary(Rpc.LedgerService_GetTransaction, { digest, read_mask: { paths: ["digest"] } }).pipe(
            Effect.map((r) => r.transaction?.digest === digest),
            Effect.catchIf((e) => e.code === "NOT_FOUND", () => Effect.succeed(false))
          )
          const after = yield* serviceInfo
          // Proto3 optional: absent means unreported, which is never "full history".
          const gap = yield* historyGap(Option.fromNullishOr(after.lowest_available_checkpoint), fromEpoch, epochFirstCheckpoint)
          return Option.some({ epoch: before.epoch, found, gap })
        }).pipe(Effect.withSpan("Evidence.observe", { attributes: { digest } }))
    }
  })
)
