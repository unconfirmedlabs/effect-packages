import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { RpcError } from "../RpcError.ts"
import { TransactionNotFound, Transactions } from "../Transactions.ts"
import { convert, EFFECTS_PATHS, effects } from "./convert.ts"
import * as Rpc from "./generated/rpc.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

const prefixed = (prefix: string) => EFFECTS_PATHS.map((p) => (p === "digest" ? `${prefix}digest` : `${prefix}${p}`))

/** `Transactions` over gRPC. A response that can't be converted is `DATA_LOSS`, never a defect. */
export const layer: Layer.Layer<Transactions, never, GrpcWeb> = Layer.effect(
  Transactions,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb
    const simulatePath = Rpc.TransactionExecutionService_SimulateTransaction.path
    const executePath = Rpc.TransactionExecutionService_ExecuteTransaction.path
    return Transactions.of({
      simulate: (txBytes, options) =>
        grpc
          .unary(Rpc.TransactionExecutionService_SimulateTransaction, {
            transaction: { bcs: { value: txBytes } },
            read_mask: { paths: [...prefixed("transaction."), "command_outputs"] },
            checks: options?.checks === false ? 1 : 0
          })
          .pipe(
            Effect.flatMap((r) =>
              convert(simulatePath, () => ({
                effects: effects(r.transaction),
                returnValues: (r.command_outputs ?? []).map((o) =>
                  (o.return_values ?? []).map((v) => v.value?.value ?? new Uint8Array())
                )
              }))
            ),
            Effect.withSpan("Transactions.simulate")
          ),
      execute: (txBytes, signatures) =>
        grpc
          .unary(Rpc.TransactionExecutionService_ExecuteTransaction, {
            transaction: { bcs: { value: txBytes } },
            signatures: signatures.map((s) => ({ bcs: { value: s } })),
            read_mask: { paths: EFFECTS_PATHS }
          })
          .pipe(
            // The node accepted the transaction: a response we can't read must
            // say so, not pose as a Move failure.
            Effect.flatMap((r) =>
              convert(executePath, () => effects(r.transaction)).pipe(
                Effect.mapError((e) =>
                  new RpcError({
                    method: e.method,
                    code: e.code,
                    message: `${e.message} (the node accepted the transaction, so it may have executed)`
                  })
                )
              )
            ),
            Effect.withSpan("Transactions.execute")
          ),
      get: (digest) =>
        grpc.unary(Rpc.LedgerService_GetTransaction, { digest, read_mask: { paths: EFFECTS_PATHS } }).pipe(
          Effect.flatMap((r) => convert(Rpc.LedgerService_GetTransaction.path, () => effects(r.transaction))),
          Effect.catchIf((e) => e.code === "NOT_FOUND", () => Effect.fail(new TransactionNotFound({ digest }))),
          Effect.withSpan("Transactions.get", { attributes: { digest } })
        )
    })
  })
)
