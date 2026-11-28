/**
 * The Sui transaction data model as BCS Schemas: what the builder produces,
 * the resolver completes, and a signer hashes. One shape, no converters.
 */
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import { Address } from "./Address.ts"
import { TypeTag } from "./TypeTag.ts"

export const ObjectDigest = Bcs.Digest
export type ObjectDigest = Bcs.Digest

export const ObjectRef = /* @__PURE__ */ Bcs.struct({ objectId: Address, version: Bcs.u64, digest: ObjectDigest })
export type ObjectRef = typeof ObjectRef.Type

export const SharedObjectMutability = /* @__PURE__ */ Bcs.enum({ Immutable: null, Mutable: null, NonExclusiveWrite: null })

export const SharedObjectRef = /* @__PURE__ */ Bcs.struct({
  objectId: Address,
  initialSharedVersion: Bcs.u64,
  mutability: SharedObjectMutability
})
export type SharedObjectRef = typeof SharedObjectRef.Type

export const ObjectArg = /* @__PURE__ */ Bcs.enum({
  ImmOrOwnedObject: ObjectRef,
  SharedObject: SharedObjectRef,
  Receiving: ObjectRef
})
export type ObjectArg = typeof ObjectArg.Type

export const FundsWithdrawal = /* @__PURE__ */ Bcs.struct({
  reservation: Bcs.enum({ MaxAmountU64: Bcs.u64 }),
  typeArg: Bcs.enum({ Balance: TypeTag }),
  withdrawFrom: Bcs.enum({
    Sender: null,
    Sponsor: null,
    SenderAllowance: Bcs.struct({ funder: Address, allowance: Address })
  })
})
export type FundsWithdrawal = typeof FundsWithdrawal.Type

export const CallArg = /* @__PURE__ */ Bcs.enum({
  Pure: Bcs.struct({ bytes: Bcs.byteVector }),
  Object: ObjectArg,
  FundsWithdrawal
})
export type CallArg = typeof CallArg.Type

export const Argument = /* @__PURE__ */ Bcs.enum({
  GasCoin: null,
  Input: Bcs.u16,
  Result: Bcs.u16,
  NestedResult: Bcs.tuple([Bcs.u16, Bcs.u16])
})
export type Argument = typeof Argument.Type

export const Command = /* @__PURE__ */ Bcs.enum({
  MoveCall: Bcs.struct({
    package: Address,
    module: Bcs.string,
    function: Bcs.string,
    typeArguments: Bcs.vector(TypeTag),
    arguments: Bcs.vector(Argument)
  }),
  TransferObjects: Bcs.struct({ objects: Bcs.vector(Argument), address: Argument }),
  SplitCoins: Bcs.struct({ coin: Argument, amounts: Bcs.vector(Argument) }),
  MergeCoins: Bcs.struct({ destination: Argument, sources: Bcs.vector(Argument) }),
  Publish: Bcs.struct({ modules: Bcs.vector(Bcs.byteVector), dependencies: Bcs.vector(Address) }),
  MakeMoveVec: Bcs.struct({ type: Bcs.option(TypeTag), elements: Bcs.vector(Argument) }),
  Upgrade: Bcs.struct({
    modules: Bcs.vector(Bcs.byteVector),
    dependencies: Bcs.vector(Address),
    package: Address,
    ticket: Argument
  })
})
export type Command = typeof Command.Type

export const ProgrammableTransaction = /* @__PURE__ */ Bcs.struct({
  inputs: Bcs.vector(CallArg),
  commands: Bcs.vector(Command)
})
export type ProgrammableTransaction = typeof ProgrammableTransaction.Type

/**
 * The user-facing kind. System kinds (ChangeEpoch, Genesis, ...) follow in
 * Rust order and would be added as variants; decoding one today is a typed
 * `BcsDecodeError`, never a guess.
 */
export const TransactionKind = /* @__PURE__ */ Bcs.enum({ ProgrammableTransaction })
export type TransactionKind = typeof TransactionKind.Type

export const GasData = /* @__PURE__ */ Bcs.struct({
  payment: Bcs.vector(ObjectRef),
  owner: Address,
  price: Bcs.u64,
  budget: Bcs.u64
})
export type GasData = typeof GasData.Type

const ValidDuringFields = {
  minEpoch: Bcs.option(Bcs.u64),
  maxEpoch: Bcs.option(Bcs.u64),
  minTimestamp: Bcs.option(Bcs.u64),
  maxTimestamp: Bcs.option(Bcs.u64),
  chain: ObjectDigest,
  nonce: Bcs.u32
}

export const TransactionExpiration = /* @__PURE__ */ Bcs.enum({
  None: null,
  Epoch: Bcs.u64,
  ValidDuring: Bcs.struct(ValidDuringFields),
  Validity: Bcs.struct({
    ...ValidDuringFields,
    allowedProposers: Bcs.option(Bcs.struct({ epoch: Bcs.u64, proposers: Bcs.vector(Bcs.u32) }))
  })
})
export type TransactionExpiration = typeof TransactionExpiration.Type

export const TransactionDataV1 = /* @__PURE__ */ Bcs.struct({
  kind: TransactionKind,
  sender: Address,
  gasData: GasData,
  expiration: TransactionExpiration
})

export const TransactionData = /* @__PURE__ */ Bcs.enum({ V1: TransactionDataV1 })
export type TransactionData = typeof TransactionData.Type

export const encode = /* @__PURE__ */ Bcs.encodeSync(TransactionData)
/** Alias of `encode`, for call sites that read better as "serialize". */
export const serialize = encode
export const decode = /* @__PURE__ */ Bcs.decode(TransactionData)
