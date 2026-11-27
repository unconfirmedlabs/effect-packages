import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Chain, type ChainInfo } from "../Chain.ts"
import { RpcError } from "../RpcError.ts"
import type { ObjectDigest } from "../TransactionData.ts"
import * as Rpc from "./generated/lean.ts"
import { successFor } from "./cache.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

const missing = (method: string, field: string) =>
  Effect.fail(new RpcError({ method, code: "UNAVAILABLE", message: `incomplete response: no ${field}` }))

/**
 * `Chain` over gRPC: `info` from `GetServiceInfo`, the gas price from
 * `GetEpoch`. Successes are cached for 30 seconds, failures are not, and
 * concurrent readers share one request. A response without a field the caller
 * depends on is a retryable `UNAVAILABLE`, not a guessed value.
 */
export const layer: Layer.Layer<Chain, never, GrpcWeb> = /* @__PURE__ */ Layer.effect(
  Chain,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const getEpoch = Rpc.LedgerService_GetEpoch.path
    const getInfo = Rpc.LedgerService_GetServiceInfo.path
    const referenceGasPrice = grpc
      .unary(Rpc.LedgerService_GetEpoch, { read_mask: { paths: ["reference_gas_price"] } })
      .pipe(
        Effect.flatMap((r) =>
          r.epoch?.reference_gas_price === undefined
            ? missing(getEpoch, "reference_gas_price")
            : Effect.succeed(r.epoch.reference_gas_price)
        ),
        (e) => successFor(e, "30 seconds")
      )
    const info = grpc.unary(Rpc.LedgerService_GetServiceInfo, {}).pipe(
      Effect.flatMap((i) => {
        if (i.chain_id === undefined || i.chain_id === "") return missing(getInfo, "chain_id")
        if (i.epoch === undefined) return missing(getInfo, "epoch")
        if (i.checkpoint_height === undefined) return missing(getInfo, "checkpoint_height")
        return Effect.succeed<ChainInfo>({
          chainId: i.chain_id as ObjectDigest,
          chain: i.chain ?? "unknown",
          epoch: i.epoch,
          checkpointHeight: i.checkpoint_height
        })
      }),
      (e) => successFor(e, "30 seconds")
    )
    return Chain.of({ info, referenceGasPrice })
  })
)
