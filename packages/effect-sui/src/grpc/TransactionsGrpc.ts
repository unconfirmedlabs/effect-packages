import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { transactionDigest } from "../Hash.ts"
import { ExecutedEffectsIncomplete, TransactionNotFound, Transactions } from "../Transactions.ts"
import { convert, EFFECTS_PATHS, effects, LANDED_PATHS, landed, maskWith } from "./convert.ts"
import * as Rpc from "./generated/lean.ts"
import { GrpcWeb } from "./GrpcWeb.ts"
import { needsGasSelection, RESOLVE_PATHS, toProto } from "./transaction.ts"

const GET_PATHS = [...EFFECTS_PATHS, ...LANDED_PATHS]

const prefixed = (prefix: string) => EFFECTS_PATHS.map((p) => (p === "digest" ? `${prefix}digest` : `${prefix}${p}`))

/** `Transactions` over gRPC. A response that can't be converted is `DATA_LOSS`, never a defect. */
export const layer: Layer.Layer<Transactions, never, GrpcWeb> = /* @__PURE__ */ Layer.effect(
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
                effects: effects(r.transaction, transactionDigest(txBytes)),
                returnValues: (r.command_outputs ?? []).map((o) =>
                  (o.return_values ?? []).map((v) => v.value?.value ?? new Uint8Array())
                )
              }))
            ),
            Effect.withSpan("Transactions.simulate")
          ),
      execute: (txBytes, signatures, options) =>
        grpc
          .unary(Rpc.TransactionExecutionService_ExecuteTransaction, {
            transaction: { bcs: { value: txBytes } },
            signatures: signatures.map((s) => ({ bcs: { value: s } })),
            read_mask: { paths: maskWith(EFFECTS_PATHS, options?.include) }
          })
          .pipe(
            // The node accepted the transaction: a response we can't read is
            // "executed, reconcile by digest", not a Move failure or a transport error.
            Effect.flatMap((r) =>
              convert(executePath, () => effects(r.transaction, undefined, options?.include)).pipe(
                Effect.mapError((e) => new ExecutedEffectsIncomplete({ digest: transactionDigest(txBytes), message: e.message }))
              )
            ),
            Effect.withSpan("Transactions.execute")
          ),
      resolve: (transaction) =>
        grpc
          .unary(Rpc.TransactionExecutionService_SimulateTransaction, {
            transaction: toProto(transaction),
            read_mask: { paths: RESOLVE_PATHS },
            checks: 0,
            do_gas_selection: needsGasSelection(transaction)
          })
          .pipe(
            Effect.flatMap((r) =>
              convert(simulatePath, () => {
                const bytes = r.transaction?.transaction?.bcs?.value
                if (bytes === undefined) throw new Error("no resolved transaction (transaction.transaction.bcs)")
                return { transaction: bytes, effects: effects(r.transaction, transactionDigest(bytes)), epoch: r.transaction?.effects?.epoch }
              })
            ),
            Effect.withSpan("Transactions.resolve")
          ),
      get: (digest, options) =>
        grpc.unary(Rpc.LedgerService_GetTransaction, { digest, read_mask: { paths: maskWith(GET_PATHS, options?.include) } }).pipe(
          Effect.flatMap((r) =>
            convert(Rpc.LedgerService_GetTransaction.path, () => ({
              ...effects(r.transaction, undefined, options?.include),
              ...landed(r.transaction)
            }))
          ),
          Effect.catchIf((e) => e.code === "NOT_FOUND", () => Effect.fail(new TransactionNotFound({ digest }))),
          Effect.withSpan("Transactions.get", { attributes: { digest } })
        )
    })
  })
)
