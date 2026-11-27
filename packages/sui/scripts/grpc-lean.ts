/**
 * What the SDK's own gRPC services read, per method. `codegen-grpc.ts` emits
 * `src/grpc/generated/lean.ts` from this: a handle per method whose
 * descriptors carry only these fields, so a program ships the descriptors of
 * what it reads instead of each response's full message graph.
 *
 * - `mask`: the read-mask paths the service may send, relative to the message
 *   at `root` (the path from the response to the masked entity; "" for the
 *   response itself). Each path keeps its field's whole subtree. Every other
 *   field of the messages along `root` is kept whole.
 * - `keep`: further response paths kept whole (fields a mask does not govern).
 * - `request`: the request fields the service sets; omitted keeps the request whole.
 * - A method with no `mask` keeps its whole response.
 *
 * Fields outside the descriptor decode as unknown fields and are skipped.
 * Lean handles check every request at encode time: a read-mask path outside
 * `mask`, a missing read mask, or a request field outside `request` is a
 * defect naming the method, so this table cannot silently fall behind the
 * services. The full handles (`generated/rpc.ts`, exported as `SuiGrpc.Rpc`)
 * are unaffected.
 */
import { CHECKPOINT_PATHS, EFFECTS_PATHS, EVENT_PATHS, OBJECT_MASK } from "../src/grpc/convert.ts"

export interface LeanMethod {
  readonly root?: string
  readonly mask?: ReadonlyArray<string>
  readonly keep?: ReadonlyArray<string>
  readonly request?: ReadonlyArray<string>
}

/** `ChainGrpc`: `referenceGasPrice`. */
const EPOCH = ["reference_gas_price"]
/** `CheckpointsGrpc` (the bare listing). */
const CHECKPOINT_IDS = ["sequence_number", "digest"]
/** `DynamicFieldsGrpc` (`LIST_MASK`). */
const DYNAMIC_FIELD = ["kind", "parent", "field_id", "name", "value", "value_type", "child_id"]

const union = (...lists: Array<ReadonlyArray<string>>) => [...new Set(lists.flat())]

export const LEAN: Record<string, LeanMethod> = {
  LedgerService_GetServiceInfo: {},
  LedgerService_GetEpoch: { root: "epoch", mask: EPOCH },
  LedgerService_BatchGetObjects: { root: "objects.object", mask: OBJECT_MASK.paths },
  StateService_ListOwnedObjects: { root: "objects", mask: OBJECT_MASK.paths },
  StateService_GetBalance: {},
  MovePackageService_GetFunction: {},
  TransactionExecutionService_SimulateTransaction: {
    root: "",
    mask: union(EFFECTS_PATHS.map((p) => `transaction.${p}`), ["command_outputs"]),
    keep: ["suggested_gas_price"],
    request: ["transaction.bcs", "read_mask", "checks", "do_gas_selection"]
  },
  TransactionExecutionService_ExecuteTransaction: {
    root: "transaction",
    mask: EFFECTS_PATHS,
    request: ["transaction.bcs", "signatures.bcs", "read_mask"]
  },
  LedgerService_GetTransaction: { root: "transaction", mask: EFFECTS_PATHS },
  LedgerService_GetCheckpoint: { root: "checkpoint", mask: CHECKPOINT_PATHS },
  LedgerService_ListCheckpoints: { root: "checkpoint", mask: union(CHECKPOINT_PATHS, CHECKPOINT_IDS) },
  SubscriptionService_SubscribeCheckpoints: { root: "checkpoint", mask: union(CHECKPOINT_PATHS, CHECKPOINT_IDS) },
  LedgerService_ListEvents: { root: "event", mask: EVENT_PATHS },
  SubscriptionService_SubscribeEvents: { root: "event", mask: EVENT_PATHS },
  StateService_ListDynamicFields: { root: "dynamic_fields", mask: DYNAMIC_FIELD }
}
