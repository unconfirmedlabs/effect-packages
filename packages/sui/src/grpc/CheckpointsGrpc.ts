import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { Checkpoints } from "../Checkpoints.ts"
import type * as P from "./generated/proto.ts"
import * as Rpc from "./generated/lean.ts"
import { GrpcWeb } from "./GrpcWeb.ts"
import { CHECKPOINT_LIMIT, checkpointBounds, pinned, resumable } from "./scan.ts"

const summary = (c: P.Checkpoint | undefined) => ({ sequenceNumber: c?.sequence_number ?? 0n, digest: c?.digest ?? "" })
const MASK = { paths: ["sequence_number", "digest"] }

/** `Checkpoints` over gRPC server streams. */
export const layer: Layer.Layer<Checkpoints, never, GrpcWeb> = /* @__PURE__ */ Layer.effect(
  Checkpoints,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    return Checkpoints.of({
      // The node stops each `ListCheckpoints` call at an item budget; resume until the real end.
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
            (r) => ({ item: r.checkpoint && summary(r.checkpoint), watermark: r.watermark, end: r.end })
          )),
      subscribe: grpc
        .serverStream(Rpc.SubscriptionService_SubscribeCheckpoints, { read_mask: MASK })
        .pipe(Stream.map((r) => summary(r.checkpoint)))
    })
  })
)
