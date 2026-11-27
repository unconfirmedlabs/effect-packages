import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Chain, type ChainInfo } from "../Chain.ts"
import type { ObjectDigest } from "../TransactionData.ts"
import * as Rpc from "./generated/lean.ts"
import { successFor } from "./cache.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

/** `Chain` over gRPC. Successful chain info is cached for 30 seconds, the gas price for a minute; failures are not cached. */
export const layer: Layer.Layer<Chain, never, GrpcWeb> = Layer.effect(
  Chain,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const info = Effect.all([
      grpc.unary(Rpc.LedgerService_GetServiceInfo, {}),
      grpc.unary(Rpc.LedgerService_GetEpoch, { read_mask: { paths: ["epoch", "first_checkpoint"] } })
    ], { concurrency: "unbounded" }).pipe(
      Effect.map(([i, e]): ChainInfo => ({
        chainId: i.chain_id as ObjectDigest,
        chain: i.chain ?? "unknown",
        epoch: i.epoch ?? 0n,
        checkpointHeight: i.checkpoint_height ?? 0n,
        lowestAvailableCheckpoint: i.lowest_available_checkpoint,
        // Only when both calls saw the same epoch (one may straddle a boundary).
        epochFirstCheckpoint: e.epoch?.epoch === i.epoch ? e.epoch?.first_checkpoint : undefined
      })),
      (e) => successFor(e, "30 seconds")
    )
    const referenceGasPrice = grpc
      .unary(Rpc.LedgerService_GetEpoch, { read_mask: { paths: ["epoch", "reference_gas_price"] } })
      .pipe(Effect.map((r) => r.epoch?.reference_gas_price ?? 1000n), (e) => successFor(e, "1 minute"))
    return Chain.of({ info, referenceGasPrice })
  })
)
