/** Proto values -> domain values, shared by the gRPC implementations. */
import * as Address from "../Address.ts"
import type { Checkpoint, CheckpointTransaction } from "../CheckpointData.ts"
import type { Event } from "../Events.ts"
import type { Owner, SuiObject } from "../Objects.ts"
import type { ObjectDigest } from "../TransactionData.ts"
import type { ChangedObject, Effects, GasUsed, Status } from "../Transactions.ts"
import type * as P from "./generated/proto.ts"

export const OBJECT_MASK = { paths: ["object_id", "version", "digest", "owner", "object_type", "contents", "previous_transaction"] }

export const owner = (o: P.Owner | undefined): Owner => {
  switch (o?.kind) {
    case 1:
      return { _tag: "AddressOwner", address: Address.normalize(o.address!) }
    case 2:
      return { _tag: "ObjectOwner", address: Address.normalize(o.address!) }
    case 3:
      return { _tag: "Shared", initialSharedVersion: o.version ?? 0n }
    case 4:
      return { _tag: "Immutable" }
    case 5:
      return { _tag: "ConsensusAddressOwner", startVersion: o.version ?? 0n, address: Address.normalize(o.address!) }
    default:
      throw new Error(`unknown owner kind ${o?.kind}`)
  }
}

export const object = (o: P.ObjectMessage): SuiObject => ({
  objectId: Address.normalize(o.object_id!),
  version: o.version!,
  digest: o.digest! as ObjectDigest,
  owner: owner(o.owner),
  type: o.object_type!,
  contents: o.contents?.value ?? new Uint8Array(),
  previousTransaction: o.previous_transaction
})

const gas = (g: P.GasCostSummary | undefined): GasUsed => ({
  computationCost: g?.computation_cost ?? 0n,
  storageCost: g?.storage_cost ?? 0n,
  storageRebate: g?.storage_rebate ?? 0n,
  nonRefundableStorageFee: g?.non_refundable_storage_fee ?? 0n
})

const status = (s: P.ExecutionStatus | undefined): Status => {
  if (s?.success) return { _tag: "Success" }
  const e = s?.error
  return {
    _tag: "Failure",
    description: e?.description ?? "unknown execution failure",
    command: e?.command === undefined ? undefined : Number(e.command),
    abortCode: e?.error_details?._tag === "abort" ? e.error_details.value.abort_code : undefined
  }
}

const OPS = { 1: "None", 2: "Created", 3: "Deleted" } as const

const changed = (c: P.ChangedObject): ChangedObject => ({
  objectId: Address.normalize(c.object_id!),
  type: c.object_type,
  operation: OPS[(c.id_operation ?? 1) as 1 | 2 | 3] ?? "None",
  version: c.output_version,
  digest: c.output_digest as ObjectDigest | undefined,
  // A package write has no owner on the wire; packages are immutable.
  owner: c.output_owner?.kind ? owner(c.output_owner) : c.output_state === 3 ? { _tag: "Immutable" } : undefined,
  inputVersion: c.input_version,
  inputDigest: c.input_digest as ObjectDigest | undefined,
  inputOwner: c.input_owner?.kind ? owner(c.input_owner) : undefined
})

export const EFFECTS_PATHS = ["digest", "effects.status", "effects.gas_used", "effects.changed_objects"]

export const effects = (t: P.ExecutedTransaction | undefined): Effects => ({
  digest: t?.digest ?? "",
  status: status(t?.effects?.status),
  gasUsed: gas(t?.effects?.gas_used),
  changedObjects: (t?.effects?.changed_objects ?? []).map(changed)
})

export const EVENT_PATHS = [
  "package_id",
  "module",
  "sender",
  "event_type",
  "contents",
  "checkpoint",
  "transaction_digest",
  "transaction_index",
  "event_index"
]

/** Position fields missing from `e` (events nested in a transaction carry none) come from `at`. */
export const event = (
  e: P.Event,
  at?: { readonly checkpoint: bigint; readonly transactionDigest: string; readonly transactionIndex: bigint; readonly eventIndex: number }
): Event => ({
  type: e.event_type ?? e.contents?.name ?? "",
  sender: Address.normalize(e.sender ?? "0x0"),
  packageId: Address.normalize(e.package_id ?? "0x0"),
  module: e.module ?? "",
  contents: e.contents?.value ?? new Uint8Array(),
  transactionDigest: e.transaction_digest ?? at?.transactionDigest ?? "",
  checkpoint: e.checkpoint ?? at?.checkpoint ?? 0n,
  transactionIndex: e.transaction_index ?? at?.transactionIndex ?? 0n,
  eventIndex: e.event_index ?? at?.eventIndex ?? 0
})

export const CHECKPOINT_PATHS = [
  "sequence_number",
  "digest",
  "summary.epoch",
  "summary.timestamp",
  "transactions.digest",
  "transactions.transaction_index",
  ...EFFECTS_PATHS.filter((p) => p !== "digest").map((p) => `transactions.${p}`),
  ...["package_id", "module", "sender", "event_type", "contents"].map((p) => `transactions.events.events.${p}`)
]

const millis = (t: P.Timestamp | undefined) => (t?.seconds ?? 0n) * 1000n + BigInt(Math.floor((t?.nanos ?? 0) / 1e6))

export const checkpoint = (c: P.Checkpoint | undefined): Checkpoint => {
  const sequenceNumber = c?.sequence_number ?? 0n
  return {
    sequenceNumber,
    digest: c?.digest ?? "",
    epoch: c?.summary?.epoch ?? 0n,
    timestampMs: millis(c?.summary?.timestamp),
    transactions: (c?.transactions ?? []).map((t, i): CheckpointTransaction => {
      const fx = effects(t)
      const index = t.transaction_index ?? BigInt(i)
      return {
        digest: fx.digest,
        index,
        status: fx.status,
        gasUsed: fx.gasUsed,
        changedObjects: fx.changedObjects,
        events: (t.events?.events ?? []).map((e, eventIndex) =>
          event(e, { checkpoint: sequenceNumber, transactionDigest: fx.digest, transactionIndex: index, eventIndex })
        )
      }
    })
  }
}
