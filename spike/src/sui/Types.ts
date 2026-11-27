/**
 * The Sui transaction data model, declared once as BCS Schemas.
 *
 * These are the *protocol* types (what gets hashed and signed). They are the
 * same values the builder produces, the resolver fills in, and the signer
 * hashes; nothing converts between a "builder JSON" shape and a "BCS" shape.
 */
import { Schema } from "effect"
import * as Bcs from "../bcs/Bcs.ts"

export const Address = Bcs.Address
export type Address = Bcs.Address
export const ObjectDigest = Bcs.Digest
export type ObjectDigest = Bcs.Digest

/** Normalize `0x2` / `0X02` / unprefixed hex to a branded `Address`. */
export const address = (s: string): Address => {
  const h = s.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{1,64}$/.test(h)) throw new Error(`invalid address ${s}`)
  return ("0x" + h.padStart(64, "0")) as Address
}

// --- TypeTag (recursive) -----------------------------------------------------

export interface StructTag {
  readonly address: Address
  readonly module: string
  readonly name: string
  readonly typeParams: ReadonlyArray<TypeTag>
}
export type TypeTag =
  | { readonly _tag: "bool" | "u8" | "u16" | "u32" | "u64" | "u128" | "u256" | "address" | "signer" }
  | { readonly _tag: "vector"; readonly value: TypeTag }
  | ({ readonly _tag: "struct" } & StructTag)

export const StructTag: Bcs.BcsSchema<StructTag, any> = Bcs.struct({
  address: Address,
  module: Bcs.string,
  name: Bcs.string,
  typeParams: Bcs.vector(Bcs.lazy((): Bcs.BcsSchema<TypeTag, any> => TypeTag))
}) as any

export const TypeTag: Bcs.BcsSchema<TypeTag, any> = Bcs.enum({
  bool: null,
  u8: null,
  u64: null,
  u128: null,
  address: null,
  signer: null,
  vector: Bcs.lazy((): Bcs.BcsSchema<TypeTag, any> => TypeTag),
  struct: StructTag as any,
  u16: null,
  u32: null,
  u256: null
}) as any

const PRIMS = new Set(["bool", "u8", "u16", "u32", "u64", "u128", "u256", "address", "signer"])

/** Parse `"vector<0x2::coin::Coin<0x2::sui::SUI>>"`. */
export const parseTypeTag = (input: string): TypeTag => {
  let i = 0
  const s = input.replace(/\s+/g, "")
  const ident = () => {
    const m = /^[A-Za-z0-9_]+/.exec(s.slice(i))
    if (!m) throw new Error(`bad type tag at ${i}: ${input}`)
    i += m[0].length
    return m[0]
  }
  const parse = (): TypeTag => {
    const head = ident()
    if (PRIMS.has(head)) return { _tag: head as any }
    if (head === "vector") {
      i++ // <
      const inner = parse()
      i++ // >
      return { _tag: "vector", value: inner }
    }
    i += 2 // ::
    const module = ident()
    i += 2
    const name = ident()
    const typeParams: Array<TypeTag> = []
    if (s[i] === "<") {
      i++
      for (;;) {
        typeParams.push(parse())
        if (s[i] === ",") i++
        else break
      }
      i++ // >
    }
    return { _tag: "struct", address: address(head), module, name, typeParams }
  }
  return parse()
}

export const formatTypeTag = (t: TypeTag): string =>
  t._tag === "vector"
    ? `vector<${formatTypeTag(t.value)}>`
    : t._tag === "struct"
    ? `${t.address}::${t.module}::${t.name}${t.typeParams.length ? `<${t.typeParams.map(formatTypeTag).join(", ")}>` : ""}`
    : t._tag

// --- Objects -----------------------------------------------------------------

export const ObjectRef = Bcs.struct({ objectId: Address, version: Bcs.u64, digest: ObjectDigest })
export type ObjectRef = typeof ObjectRef.Type

export const SharedObjectMutability = Bcs.enum({ Immutable: null, Mutable: null, NonExclusiveWrite: null })

export const SharedObjectRef = Bcs.struct({
  objectId: Address,
  initialSharedVersion: Bcs.u64,
  mutability: SharedObjectMutability
})
export type SharedObjectRef = typeof SharedObjectRef.Type

export const ObjectArg = Bcs.enum({
  ImmOrOwnedObject: ObjectRef,
  SharedObject: SharedObjectRef,
  Receiving: ObjectRef
})
export type ObjectArg = typeof ObjectArg.Type

export const FundsWithdrawal = Bcs.struct({
  reservation: Bcs.enum({ MaxAmountU64: Bcs.u64 }),
  typeArg: Bcs.enum({ Balance: TypeTag }),
  withdrawFrom: Bcs.enum({
    Sender: null,
    Sponsor: null,
    SenderAllowance: Bcs.struct({ funder: Address, allowance: Address })
  })
})

export const CallArg = Bcs.enum({
  Pure: Bcs.struct({ bytes: Bcs.byteVector }),
  Object: ObjectArg,
  FundsWithdrawal
})
export type CallArg = typeof CallArg.Type

// --- Commands ----------------------------------------------------------------

export const Argument = Bcs.enum({
  GasCoin: null,
  Input: Bcs.u16,
  Result: Bcs.u16,
  NestedResult: Bcs.tuple([Bcs.u16, Bcs.u16])
})
export type Argument = typeof Argument.Type

export const Command = Bcs.enum({
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

export const ProgrammableTransaction = Bcs.struct({
  inputs: Bcs.vector(CallArg),
  commands: Bcs.vector(Command)
})
export type ProgrammableTransaction = typeof ProgrammableTransaction.Type

/**
 * Only the user-facing kind is modelled; system kinds would be added as
 * variants in Rust order (ChangeEpoch, Genesis, ...). Decoding one fails with a
 * typed error instead of guessing.
 */
export const TransactionKind = Bcs.enum({ ProgrammableTransaction })
export type TransactionKind = typeof TransactionKind.Type

// --- Transaction data ----------------------------------------------------------

export const GasData = Bcs.struct({
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

export const TransactionExpiration = Bcs.enum({
  None: null,
  Epoch: Bcs.u64,
  ValidDuring: Bcs.struct(ValidDuringFields),
  Validity: Bcs.struct({
    ...ValidDuringFields,
    allowedProposers: Bcs.option(Bcs.struct({ epoch: Bcs.u64, proposers: Bcs.vector(Bcs.u32) }))
  })
})
export type TransactionExpiration = typeof TransactionExpiration.Type

export const TransactionDataV1 = Bcs.struct({
  kind: TransactionKind,
  sender: Address,
  gasData: GasData,
  expiration: TransactionExpiration
})

export const TransactionData = Bcs.enum({ V1: TransactionDataV1 })
export type TransactionData = typeof TransactionData.Type

export const IntentScope = { TransactionData: 0, PersonalMessage: 3 } as const

/** Plain values decoded from Move: `Schema.Codec`s you hand to `Bcs.decode`. */
export const Move = { ...Bcs, String: Bcs.string } satisfies Record<string, unknown>
export type MoveSchema<T> = Schema.Codec<T, any>
