import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { CheckpointData, CheckpointNotFound } from "../CheckpointData.ts"
import { checkpoint, CHECKPOINT_PATHS } from "./convert.ts"
import type * as P from "./generated/proto.ts"
import * as Rpc from "./generated/rpc.ts"
import { GrpcWeb } from "./GrpcWeb.ts"
import { CHECKPOINT_LIMIT, checkpointBounds, convert, pinned, resumable } from "./scan.ts"

const MASK = { paths: CHECKPOINT_PATHS }

/** `CheckpointData` over gRPC: checkpoints read with their transactions, effects and events. */
export const layer: Layer.Layer<CheckpointData, never, GrpcWeb> = Layer.effect(
  CheckpointData,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    return CheckpointData.of({
      get: (sequenceNumber) =>
        grpc
          .unary(Rpc.LedgerService_GetCheckpoint, { read_mask: MASK, checkpoint_id: { _tag: "sequence_number", value: sequenceNumber } })
          .pipe(
            Effect.flatMap((r) => convert(Rpc.LedgerService_GetCheckpoint.path, () => checkpoint(r.checkpoint))),
            Effect.catchIf((e) => e.code === "NOT_FOUND", () => Effect.fail(new CheckpointNotFound({ sequenceNumber }))),
            Effect.withSpan("CheckpointData.get", { attributes: { sequenceNumber: String(sequenceNumber) } })
          ),
      list: (options) =>
        pinned(grpc, { start: options?.start, end: options?.end }, false, (range) =>
          resumable(
            Rpc.LedgerService_ListCheckpoints.path,
            (w) =>
              grpc.serverStream(Rpc.LedgerService_ListCheckpoints, {
                read_mask: MASK,
                ...checkpointBounds(w, range),
                options: { limit: CHECKPOINT_LIMIT, ...(w?.cursor && { after: w.cursor }) }
              }),
            (r) => ({ item: r.checkpoint && checkpoint(r.checkpoint), watermark: r.watermark, end: r.end })
          )),
      subscribe: grpc
        .serverStream(Rpc.SubscriptionService_SubscribeCheckpoints, { read_mask: MASK })
        .pipe(
          Stream.filter((r): r is P.SubscribeCheckpointsResponse & { checkpoint: P.Checkpoint } => r.checkpoint !== undefined),
          Stream.mapEffect((r) => convert(Rpc.SubscriptionService_SubscribeCheckpoints.path, () => checkpoint(r.checkpoint)))
        )
    })
  })
)
