import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Chain, type ChainInfo } from "../Chain.ts"
import { RpcError } from "../RpcError.ts"
import type { ObjectDigest } from "../TransactionData.ts"
import * as Rpc from "./generated/lean.ts"
import { successFor } from "./cache.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

const missing = (method: string, field: string) =>
  Effect.fail(new RpcError({ method, code: "DATA_LOSS", message: `malformed response: no ${field}` }))

/**
 * `Chain` over gRPC. One `GetEpoch` serves both the gas price and chain info;
 * successes are cached for 30 seconds, failures are not, and concurrent
 * readers share one request. A response without a field the caller depends on
 * is `DATA_LOSS`, not a guessed value.
 */
export const layer: Layer.Layer<Chain, never, GrpcWeb> = Layer.effect(
  Chain,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const getEpoch = Rpc.LedgerService_GetEpoch.path
    const getInfo = Rpc.LedgerService_GetServiceInfo.path
    const epoch = grpc
      .unary(Rpc.LedgerService_GetEpoch, { read_mask: { paths: ["epoch", "first_checkpoint", "reference_gas_price"] } })
      .pipe(
        Effect.flatMap((r) =>
          r.epoch?.epoch === undefined
            ? missing(getEpoch, "epoch")
            : r.epoch.reference_gas_price === undefined
            ? missing(getEpoch, "reference_gas_price")
            : Effect.succeed({ epoch: r.epoch.epoch, firstCheckpoint: r.epoch.first_checkpoint, referenceGasPrice: r.epoch.reference_gas_price })
        ),
        (e) => successFor(e, "30 seconds")
      )
    const info = Effect.all([grpc.unary(Rpc.LedgerService_GetServiceInfo, {}), epoch], { concurrency: "unbounded" }).pipe(
      Effect.flatMap(([i, e]) => {
        if (i.chain_id === undefined || i.chain_id === "") return missing(getInfo, "chain_id")
        if (i.epoch === undefined) return missing(getInfo, "epoch")
        if (i.checkpoint_height === undefined) return missing(getInfo, "checkpoint_height")
        return Effect.succeed<ChainInfo>({
          chainId: i.chain_id as ObjectDigest,
          chain: i.chain ?? "unknown",
          epoch: i.epoch,
          checkpointHeight: i.checkpoint_height,
          lowestAvailableCheckpoint: i.lowest_available_checkpoint,
          // Only when both calls saw the same epoch (one may straddle a boundary).
          epochFirstCheckpoint: e.epoch === i.epoch ? e.firstCheckpoint : undefined
        })
      }),
      (e) => successFor(e, "30 seconds")
    )
    return Chain.of({ info, referenceGasPrice: Effect.map(epoch, (e) => e.referenceGasPrice) })
  })
)
