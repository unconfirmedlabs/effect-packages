/**
 * An unresolved transaction as a structured `sui.rpc.v2.Transaction`, for
 * `SimulateTransaction` with gas selection (`Transactions.resolve`). Object
 * inputs the caller left unresolved carry only their id (and a forced
 * mutability); everything already resolved is sent as it is. GraphQL's
 * `simulateTransaction` takes the same message as proto3 JSON.
 */
import * as Option from "effect/Option"
import type { UnresolvedObject } from "../Ptb.ts"
import type * as T from "../TransactionData.ts"
import type { UnresolvedTransaction } from "../Transactions.ts"
import * as TypeTag from "../TypeTag.ts"
import type * as P from "./generated/proto.ts"

// Enum values of sui.rpc.v2 (literals, so no enum table is linked).
const ARG_GAS = 1
const ARG_INPUT = 2
const ARG_RESULT = 3
const INPUT_PURE = 1
const INPUT_OWNED = 2
const INPUT_SHARED = 3
const INPUT_RECEIVING = 4
const INPUT_FUNDS = 5
const MUTABILITY_NON_EXCLUSIVE_WRITE = 3
const SOURCE = { Sender: 1, Sponsor: 2, SenderAllowance: 3 } as const
const EXPIRATION = { None: 1, Epoch: 2, ValidDuring: 3, Validity: 4 } as const

const argument = (a: T.Argument): P.Argument => {
  switch (a._tag) {
    case "GasCoin":
      return { kind: ARG_GAS }
    case "Input":
      return { kind: ARG_INPUT, input: a.value }
    case "Result":
      return { kind: ARG_RESULT, result: a.value }
    case "NestedResult":
      return { kind: ARG_RESULT, result: a.value[0], subresult: a.value[1] }
  }
}

const input = (i: T.CallArg | UnresolvedObject): P.Input => {
  switch (i._tag) {
    case "UnresolvedObject":
      return { object_id: i.objectId, ...(i.mutable !== undefined && { mutable: i.mutable }) }
    case "Pure":
      return { kind: INPUT_PURE, pure: i.bytes }
    case "FundsWithdrawal": {
      const from = i.withdrawFrom
      return {
        kind: INPUT_FUNDS,
        funds_withdrawal: {
          amount: i.reservation.value,
          coin_type: TypeTag.format(i.typeArg.value),
          source: SOURCE[from._tag],
          ...(from._tag === "SenderAllowance" && { funder: from.funder, allowance: from.allowance })
        }
      }
    }
    case "Object": {
      const o = i.value
      switch (o._tag) {
        case "ImmOrOwnedObject":
          return { kind: INPUT_OWNED, object_id: o.objectId, version: o.version, digest: o.digest }
        case "Receiving":
          return { kind: INPUT_RECEIVING, object_id: o.objectId, version: o.version, digest: o.digest }
        case "SharedObject":
          return {
            kind: INPUT_SHARED,
            object_id: o.objectId,
            version: o.initialSharedVersion,
            mutable: o.mutability._tag === "Mutable",
            ...(o.mutability._tag === "NonExclusiveWrite" && { mutability: MUTABILITY_NON_EXCLUSIVE_WRITE })
          }
      }
    }
  }
}

const command = (c: T.Command): P.Command => {
  switch (c._tag) {
    case "MoveCall":
      return {
        command: {
          _tag: "move_call",
          value: {
            package: c.package,
            module: c.module,
            function: c.function,
            type_arguments: c.typeArguments.map(TypeTag.format),
            arguments: c.arguments.map(argument)
          }
        }
      }
    case "TransferObjects":
      return { command: { _tag: "transfer_objects", value: { objects: c.objects.map(argument), address: argument(c.address) } } }
    case "SplitCoins":
      return { command: { _tag: "split_coins", value: { coin: argument(c.coin), amounts: c.amounts.map(argument) } } }
    case "MergeCoins":
      return { command: { _tag: "merge_coins", value: { coin: argument(c.destination), coins_to_merge: c.sources.map(argument) } } }
    case "Publish":
      return { command: { _tag: "publish", value: { modules: c.modules, dependencies: c.dependencies } } }
    case "MakeMoveVec":
      return {
        command: {
          _tag: "make_move_vector",
          value: {
            ...(Option.isSome(c.type) && { element_type: TypeTag.format(c.type.value) }),
            elements: c.elements.map(argument)
          }
        }
      }
    case "Upgrade":
      return {
        command: {
          _tag: "upgrade",
          value: { modules: c.modules, dependencies: c.dependencies, package: c.package, ticket: argument(c.ticket) }
        }
      }
  }
}

const timestamp = (ms: Option.Option<bigint>): P.Timestamp | undefined =>
  Option.isSome(ms) ? { seconds: ms.value / 1000n, nanos: Number(ms.value % 1000n) * 1_000_000 } : undefined

const expiration = (e: T.TransactionExpiration): P.TransactionExpiration => {
  switch (e._tag) {
    case "None":
      return { kind: EXPIRATION.None }
    case "Epoch":
      return { kind: EXPIRATION.Epoch, epoch: e.value }
    case "ValidDuring":
    case "Validity": {
      const v = e
      const proposers = e._tag === "Validity" && Option.isSome(e.allowedProposers) ? e.allowedProposers.value : undefined
      const minTimestamp = timestamp(v.minTimestamp)
      const maxTimestamp = timestamp(v.maxTimestamp)
      return {
        kind: EXPIRATION[e._tag],
        ...(Option.isSome(v.minEpoch) && { min_epoch: v.minEpoch.value }),
        ...(Option.isSome(v.maxEpoch) && { epoch: v.maxEpoch.value }),
        ...(minTimestamp && { min_timestamp: minTimestamp }),
        ...(maxTimestamp && { max_timestamp: maxTimestamp }),
        chain: v.chain,
        nonce: v.nonce,
        ...(proposers && { allowed_proposers: { epoch: proposers.epoch, proposers: proposers.proposers } })
      }
    }
  }
}

/** The unresolved transaction as a `sui.rpc.v2.Transaction` (`version` 1, a programmable kind). */
export const toProto = (tx: UnresolvedTransaction): P.Transaction => ({
  version: 1,
  kind: {
    data: {
      _tag: "programmable_transaction",
      value: { inputs: tx.inputs.map(input), commands: tx.commands.map(command) }
    }
  },
  sender: tx.sender,
  gas_payment: {
    objects: (tx.gasPayment ?? []).map((r) => ({ object_id: r.objectId, version: r.version, digest: r.digest })),
    owner: tx.gasOwner,
    ...(tx.gasPrice !== undefined && { price: tx.gasPrice }),
    ...(tx.gasBudget !== undefined && { budget: tx.gasBudget })
  },
  ...(tx.expiration && { expiration: expiration(tx.expiration) })
})

/** Ask for gas selection unless the caller fixed both the budget and the payment. */
export const needsGasSelection = (tx: UnresolvedTransaction): boolean =>
  tx.gasBudget === undefined || tx.gasPayment === undefined

/** Read-mask paths (from the `SimulateTransactionResponse`) a resolution reads. */
export const RESOLVE_PATHS = [
  "transaction.transaction.bcs",
  "transaction.digest",
  "transaction.effects.status",
  "transaction.effects.gas_used",
  "transaction.effects.changed_objects",
  "transaction.effects.epoch"
]
