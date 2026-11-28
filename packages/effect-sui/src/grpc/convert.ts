/** Proto values -> domain values, shared by the gRPC implementations. */
import * as Effect from "effect/Effect"
import * as Address from "../Address.ts"
import { RpcError } from "../RpcError.ts"
import type { Checkpoint, CheckpointTransaction } from "../CheckpointData.ts"
import type { Event, TransactionEvent } from "../Events.ts"
import type { Owner, SuiObject } from "../Objects.ts"
import type { ObjectDigest } from "../TransactionData.ts"
import type { BalanceChange, ChangedObject, Effects, GasUsed, Include, Status } from "../Transactions.ts"
import type * as P from "./generated/proto.ts"

/** Run a conversion that may throw on a malformed message; a throw is `DATA_LOSS`, not a defect. */
export const convert = <A>(method: string, f: () => A): Effect.Effect<A, RpcError> =>
  Effect.try({
    try: f,
    catch: (e) => new RpcError({ method, code: "DATA_LOSS", message: `malformed response: ${e instanceof Error ? e.message : String(e)}` })
  })

/** `Packages.getModules` (`GetObject`). */
export const MODULES_PATHS = ["package.modules.name", "package.modules.contents"]

export const OBJECT_MASK = { paths: ["object_id", "version", "digest", "owner", "object_type", "contents", "previous_transaction"] }

/** A field the conversion depends on; its absence is a malformed response (callers turn the throw into `DATA_LOSS`). */
const required = <A>(value: A | undefined, field: string): A => {
  if (value === undefined) throw new Error(`no ${field}`)
  return value
}

/** An owner kind this SDK doesn't know yet is `Unknown`, not a throw: the effects of a submitted transaction must still convert. */
export const owner = (o: P.Owner | undefined): Owner => {
  switch (o?.kind) {
    case 1:
      return { _tag: "AddressOwner", address: Address.normalize(required(o.address, "owner.address")) }
    case 2:
      return { _tag: "ObjectOwner", address: Address.normalize(required(o.address, "owner.address")) }
    case 3:
      return { _tag: "Shared", initialSharedVersion: required(o.version, "owner.version") }
    case 4:
      return { _tag: "Immutable" }
    case 5:
      return {
        _tag: "ConsensusAddressOwner",
        startVersion: required(o.version, "owner.version"),
        address: Address.normalize(required(o.address, "owner.address"))
      }
    default:
      return { _tag: "Unknown", kind: o?.kind ?? 0 }
  }
}

export const object = (o: P.ObjectMessage): SuiObject => ({
  objectId: Address.normalize(required(o.object_id, "object_id")),
  version: required(o.version, "version"),
  digest: required(o.digest, "digest") as ObjectDigest,
  owner: owner(o.owner),
  type: required(o.object_type, "object_type"),
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
  if (s === undefined) throw new Error("no effects.status")
  if (s.success === true) return { _tag: "Success" }
  const e = s.error
  if (s.success === undefined && e === undefined) throw new Error("effects.status has neither success nor error")
  const abort = e?.error_details?._tag === "abort" ? e.error_details.value : undefined
  const loc = abort?.location
  const clever = abort?.clever_error
  return {
    _tag: "Failure",
    description: e?.description ?? "unknown execution failure",
    command: e?.command === undefined ? undefined : Number(e.command),
    abortCode: abort?.abort_code,
    ...(loc?.package !== undefined && loc.module !== undefined && {
      location: { package: Address.normalize(loc.package), module: loc.module, function: loc.function_name, instruction: loc.instruction }
    }),
    ...(clever !== undefined && {
      cleverError: {
        errorCode: clever.error_code,
        lineNumber: clever.line_number,
        constantName: clever.constant_name,
        constantType: clever.constant_type,
        rendered: clever.value?._tag === "rendered" ? clever.value.value : undefined
      }
    })
  }
}

const OPS = { 1: "None", 2: "Created", 3: "Deleted" } as const

const changed = (c: P.ChangedObject): ChangedObject => ({
  objectId: Address.normalize(required(c.object_id, "changed_objects.object_id")),
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

/** An event's own fields, as a transaction's events carry them (no position). */
const EVENT_CONTENT_PATHS = ["package_id", "module", "sender", "event_type", "contents"]

/** What `include` adds to a transaction's read mask. */
export const INCLUDE_PATHS: Record<Include, ReadonlyArray<string>> = {
  events: EVENT_CONTENT_PATHS.map((p) => `events.events.${p}`),
  balanceChanges: ["balance_changes"]
}

/** `Transactions.get` reads where the transaction landed as well: two scalars. */
export const LANDED_PATHS = ["checkpoint", "timestamp"]

/** The fields `LANDED_PATHS` read, those the node set. */
export const landed = (t: P.ExecutedTransaction | undefined): Pick<Effects, "checkpoint" | "timestampMs"> => ({
  ...(t?.checkpoint !== undefined && { checkpoint: t.checkpoint }),
  ...(t?.timestamp !== undefined && { timestampMs: millis(t.timestamp) })
})

export const maskWith = (paths: ReadonlyArray<string>, include: ReadonlyArray<Include> | undefined) =>
  include?.length ? [...paths, ...new Set(include.flatMap((i) => INCLUDE_PATHS[i]))] : paths

const millis = (t: P.Timestamp | undefined) => (t?.seconds ?? 0n) * 1000n + BigInt(Math.floor((t?.nanos ?? 0) / 1e6))

const balanceChange = (b: P.BalanceChange): BalanceChange => ({
  address: Address.normalize(required(b.address, "balance_changes.address")),
  coinType: required(b.coin_type, "balance_changes.coin_type"),
  amount: BigInt(required(b.amount, "balance_changes.amount"))
})

/**
 * Throws on a response without the transaction, its status or (unless the
 * caller knows it: a simulation carries none) its digest; run it under `convert`.
 * `include` lists what the read mask asked for, so it is present even when empty.
 */
export const effects = (t: P.ExecutedTransaction | undefined, knownDigest?: string, include?: ReadonlyArray<Include>): Effects => {
  if (t === undefined) throw new Error("no transaction")
  const digest = t.digest || knownDigest
  if (!digest) throw new Error("no transaction digest")
  return {
    digest,
    status: status(t.effects?.status),
    gasUsed: gas(t.effects?.gas_used),
    changedObjects: (t.effects?.changed_objects ?? []).map(changed),
    ...(include?.includes("events") && {
      events: (t.events?.events ?? []).map((e, i) => transactionEvent(e, digest, i))
    }),
    ...(include?.includes("balanceChanges") && { balanceChanges: (t.balance_changes ?? []).map(balanceChange) })
  }
}

export const EVENT_PATHS = [
  ...EVENT_CONTENT_PATHS,
  "checkpoint",
  "transaction_digest",
  "transaction_index",
  "event_index"
]

/** Fields missing from `e` (events nested in a transaction carry no position) come from the transaction. */
const transactionEvent = (e: P.Event, transactionDigest: string, eventIndex: number): TransactionEvent => ({
  type: e.event_type ?? e.contents?.name ?? "",
  sender: Address.normalize(e.sender ?? "0x0"),
  packageId: Address.normalize(e.package_id ?? "0x0"),
  module: e.module ?? "",
  contents: e.contents?.value ?? new Uint8Array(),
  transactionDigest: e.transaction_digest ?? transactionDigest,
  eventIndex: e.event_index ?? eventIndex
})

/** Position fields missing from `e` (events nested in a transaction carry none) come from `at`. */
export const event = (
  e: P.Event,
  at?: { readonly checkpoint: bigint; readonly transactionDigest: string; readonly transactionIndex: bigint; readonly eventIndex: number }
): Event => ({
  ...transactionEvent(e, at?.transactionDigest ?? "", at?.eventIndex ?? 0),
  checkpoint: e.checkpoint ?? at?.checkpoint ?? 0n,
  transactionIndex: e.transaction_index ?? at?.transactionIndex ?? 0n
})

export const CHECKPOINT_PATHS = [
  "sequence_number",
  "digest",
  "summary.epoch",
  "summary.timestamp",
  "transactions.digest",
  "transactions.transaction_index",
  ...EFFECTS_PATHS.filter((p) => p !== "digest").map((p) => `transactions.${p}`),
  ...INCLUDE_PATHS.events.map((p) => `transactions.${p}`)
]

export const checkpoint = (c: P.Checkpoint | undefined): Checkpoint => {
  if (c === undefined) throw new Error("no checkpoint")
  const sequenceNumber = required(c.sequence_number, "checkpoint.sequence_number")
  return {
    sequenceNumber,
    digest: required(c.digest, "checkpoint.digest"),
    epoch: c.summary?.epoch ?? 0n,
    timestampMs: millis(c.summary?.timestamp),
    transactions: (c.transactions ?? []).map((t, i): CheckpointTransaction => {
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
