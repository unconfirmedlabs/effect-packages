/**
 * Interop with `@mysten/sui`'s transaction JSON: the v2 serialized
 * `TransactionData` that `Transaction.toJSON()` writes and
 * `Transaction.from(json)` reads (what wallets receive through
 * `sui:signTransaction`).
 *
 *   const json = yield* TransactionJson.encode(data)                 // resolved TransactionData
 *   const json = yield* TransactionJson.encode({ sender, draft })    // a Draft, intents included
 *   const tx = yield* TransactionJson.decode(json)                   // -> Unresolved (a Draft + gas fields)
 *   const data = yield* TransactionJson.resolve(tx)                  // the default Resolve pipeline
 *
 * Mapping:
 * - `Ptb.BalanceIntent` <-> the `CoinWithBalance` `$Intent` (`tx.coin` / `tx.balance`):
 *   `type: "gas"` is SUI that may use the gas coin.
 * - `Ptb.AllowanceIntent` <-> the `AllowanceBalance` `$Intent` (`tx.coin({ allowance })`),
 *   with its `allowance`, `clock` and optional `permit` inputs.
 * - `Ptb.UnresolvedObject` <-> `UnresolvedObject`. Mysten treats `mutable` as
 *   "at least mutable"; so does the decoder (`mutable: true` forces it,
 *   anything else is inferred from usage).
 * - `UnresolvedPure` decodes only where Mysten itself knows the type without a
 *   Move signature (`SplitCoins` amounts: u64, `TransferObjects` address).
 *
 * Anything else that can't be represented faithfully (another intent, an
 * `UnresolvedPure` elsewhere, a pinned `UnresolvedObject` passed to a Move
 * call, a command kind this module doesn't know) is `UnsupportedTransactionJson`,
 * never a silent drop. JSON that doesn't match the schema is `InvalidTransactionJson`.
 */
import { base58, base64 } from "@scure/base"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "./Address.ts"
import * as Hash from "./Hash.ts"
import * as Allowances from "./internal/allowances.ts"
import type * as Ptb from "./Ptb.ts"
import * as Resolve from "./Resolve.ts"
import * as T from "./TransactionData.ts"
import * as Tx from "./Tx.ts"
import * as TypeTag from "./TypeTag.ts"

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Not v2 transaction JSON: wrong shape, a bad u64, address, digest, type tag or base64. */
export class InvalidTransactionJson extends /* @__PURE__ */ Schema.TaggedError<InvalidTransactionJson>()("InvalidTransactionJson", {
  issue: Schema.String
}) {
  override get message(): string {
    return this.issue
  }
}

/** Well-formed, but uses something this SDK can't represent faithfully. */
export class UnsupportedTransactionJson extends /* @__PURE__ */ Schema.TaggedError<UnsupportedTransactionJson>()(
  "UnsupportedTransactionJson",
  { construct: Schema.String, reason: Schema.String }
) {
  override get message(): string {
    return `unsupported ${this.construct}: ${this.reason}`
  }
}

// -----------------------------------------------------------------------------
// The JSON shape (mirrors `SerializedTransactionDataV2Schema`)
// -----------------------------------------------------------------------------

const U64_MAX = (1n << 64n) - 1n

/** A u64 as Mysten writes it: a decimal string or a safe integer. */
export const JsonU64 = /* @__PURE__ */ Schema.Union([
  Schema.Int.check(Schema.makeFilter((n) => (n >= 0 && Number.isSafeInteger(n)) || "expected a non-negative safe integer")),
  Schema.String.check(Schema.makeFilter((s) => (/^\d+$/.test(s) && BigInt(s) <= U64_MAX) || "expected a u64 decimal string"))
])

/** Any hex address; normalized on decode, like Mysten's `SuiAddress`. */
export const JsonAddress = /* @__PURE__ */ Schema.String.check(Schema.isPattern(/^(0x)?[0-9a-fA-F]{1,64}$/))

const U32 = /* @__PURE__ */ Schema.Int.check(Schema.makeFilter((n) => (n >= 0 && n < 2 ** 32) || "expected a u32"))
const Index = /* @__PURE__ */ Schema.Int.check(Schema.makeFilter((n) => (n >= 0 && n < 65536) || "expected a u16 index"))
const Base64 = Schema.String

/** `{ [key]: value, $kind?: key }`, Mysten's enum encoding. */
const variant = <K extends string, S extends Schema.Top>(key: K, value: S) =>
  Schema.Struct({ [key]: value, $kind: Schema.optionalKey(Schema.Literal(key)) } as
    & { readonly [P in K]: S }
    & { readonly $kind: Schema.optionalKey<Schema.Literal<K>> })

export const Argument = /* @__PURE__ */ Schema.Union([
  variant("GasCoin", Schema.Literal(true)),
  Schema.Struct({
    Input: Index,
    type: Schema.optionalKey(Schema.Literals(["pure", "object", "withdrawal"])),
    $kind: Schema.optionalKey(Schema.Literal("Input"))
  }),
  variant("Result", Index),
  variant("NestedResult", Schema.Tuple([Index, Index]))
])
export type Argument = typeof Argument.Type

export const ObjectRef = /* @__PURE__ */ Schema.Struct({ objectId: JsonAddress, version: JsonU64, digest: Bcs.Digest })

export const ObjectArg = /* @__PURE__ */ Schema.Union([
  variant("ImmOrOwnedObject", ObjectRef),
  variant(
    "SharedObject",
    Schema.Struct({
      objectId: JsonAddress,
      initialSharedVersion: JsonU64,
      mutable: Schema.Boolean,
      mutability: Schema.optionalKey(Schema.Literal("NonExclusiveWrite"))
    })
  ),
  variant("Receiving", ObjectRef)
])

export const FundsWithdrawal = /* @__PURE__ */ Schema.Struct({
  reservation: variant("MaxAmountU64", JsonU64),
  typeArg: variant("Balance", Schema.String),
  withdrawFrom: Schema.Union([
    variant("Sender", Schema.Literal(true)),
    variant("Sponsor", Schema.Literal(true)),
    variant("SenderAllowance", Schema.Struct({ funder: JsonAddress, allowance: JsonAddress }))
  ])
})

export const CallArg = /* @__PURE__ */ Schema.Union([
  variant("Object", ObjectArg),
  variant("Pure", Schema.Struct({ bytes: Base64 })),
  variant("UnresolvedPure", Schema.Struct({ value: Schema.Unknown })),
  variant(
    "UnresolvedObject",
    Schema.Struct({
      objectId: JsonAddress,
      version: Schema.optionalKey(Schema.NullOr(JsonU64)),
      digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
      initialSharedVersion: Schema.optionalKey(Schema.NullOr(JsonU64)),
      mutable: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
    })
  ),
  variant("FundsWithdrawal", FundsWithdrawal)
])
export type CallArg = typeof CallArg.Type

export const Intent = /* @__PURE__ */ Schema.Struct({
  name: Schema.String,
  inputs: Schema.Record(Schema.String, Schema.Union([Argument, Schema.Array(Argument)])),
  data: Schema.Record(Schema.String, Schema.Unknown)
})

export const Command = /* @__PURE__ */ Schema.Union([
  variant(
    "MoveCall",
    Schema.Struct({
      package: JsonAddress,
      module: Schema.String,
      function: Schema.String,
      typeArguments: Schema.Array(Schema.String),
      arguments: Schema.Array(Argument)
    })
  ),
  variant("TransferObjects", Schema.Struct({ objects: Schema.Array(Argument), address: Argument })),
  variant("SplitCoins", Schema.Struct({ coin: Argument, amounts: Schema.Array(Argument) })),
  variant("MergeCoins", Schema.Struct({ destination: Argument, sources: Schema.Array(Argument) })),
  variant("Publish", Schema.Struct({ modules: Schema.Array(Base64), dependencies: Schema.Array(JsonAddress) })),
  variant("MakeMoveVec", Schema.Struct({ type: Schema.NullOr(Schema.String), elements: Schema.Array(Argument) })),
  variant(
    "Upgrade",
    Schema.Struct({
      modules: Schema.Array(Base64),
      dependencies: Schema.Array(JsonAddress),
      package: JsonAddress,
      ticket: Argument
    })
  ),
  variant("$Intent", Intent)
])
export type Command = typeof Command.Type

const ValidDuringFields = {
  minEpoch: Schema.NullOr(JsonU64),
  maxEpoch: Schema.NullOr(JsonU64),
  minTimestamp: Schema.NullOr(JsonU64),
  maxTimestamp: Schema.NullOr(JsonU64),
  chain: Bcs.Digest,
  nonce: U32
}

export const Expiration = /* @__PURE__ */ Schema.Union([
  variant("None", Schema.Literal(true)),
  variant("Epoch", JsonU64),
  variant("ValidDuring", Schema.Struct(ValidDuringFields)),
  variant(
    "Validity",
    Schema.Struct({
      ...ValidDuringFields,
      allowedProposers: Schema.NullOr(Schema.Struct({ epoch: JsonU64, proposers: Schema.Array(U32) }))
    })
  )
])

export const GasData = /* @__PURE__ */ Schema.Struct({
  budget: Schema.NullOr(JsonU64),
  price: Schema.NullOr(JsonU64),
  owner: Schema.NullOr(JsonAddress),
  payment: Schema.NullOr(Schema.Array(ObjectRef))
})

/** `SerializedTransactionDataV2`: what `Transaction.toJSON()` produces. */
export const TransactionJson = /* @__PURE__ */ Schema.Struct({
  version: Schema.Literal(2),
  sender: Schema.optionalKey(Schema.NullOr(JsonAddress)),
  expiration: Schema.optionalKey(Schema.NullOr(Expiration)),
  gasData: GasData,
  inputs: Schema.Array(CallArg),
  commands: Schema.Array(Command),
  digest: Schema.optionalKey(Schema.NullOr(Schema.String))
})
export type TransactionJson = typeof TransactionJson.Type

/** The same, as a JSON string. */
export const TransactionJsonString = /* @__PURE__ */ Schema.fromJsonString(TransactionJson)

/** `CoinWithBalance` intent data. */
const CoinWithBalanceData = /* @__PURE__ */ Schema.Struct({
  type: Schema.String,
  balance: JsonU64,
  outputKind: Schema.optionalKey(Schema.Literals(["coin", "balance"]))
})

export const COIN_WITH_BALANCE = "CoinWithBalance"

/** `AllowanceBalance` intent data. */
const AllowanceBalanceData = /* @__PURE__ */ Schema.Struct({
  objectId: Schema.String,
  funder: Schema.optionalKey(Schema.String),
  appType: Schema.optionalKey(Schema.String),
  type: Schema.String,
  amount: JsonU64,
  outputKind: Schema.Literals(["coin", "balance"])
})

export const ALLOWANCE_BALANCE = "AllowanceBalance"

// -----------------------------------------------------------------------------
// The unresolved transaction
// -----------------------------------------------------------------------------

/**
 * What the JSON describes before resolution: a `Draft` plus whichever of
 * sender, gas and expiration are set. A `Resolve.Plan` whose sender may be missing.
 */
export type Unresolved = Omit<Resolve.Plan, "sender"> & { readonly sender?: Address.Address }

// -----------------------------------------------------------------------------
// Encoding (ours -> JSON)
// -----------------------------------------------------------------------------

const u64 = (v: bigint) => v.toString()
const b64 = (bytes: Uint8Array) => base64.encode(bytes)

const argumentJson = (a: T.Argument): Argument => {
  switch (a._tag) {
    case "GasCoin":
      return { GasCoin: true, $kind: "GasCoin" }
    case "Input":
      return { Input: a.value, $kind: "Input" }
    case "Result":
      return { Result: a.value, $kind: "Result" }
    case "NestedResult":
      return { NestedResult: [a.value[0], a.value[1]], $kind: "NestedResult" }
  }
}

const refJson = (r: T.ObjectRef) => ({ objectId: r.objectId, version: u64(r.version), digest: r.digest })

const objectArgJson = (o: T.ObjectArg): typeof ObjectArg.Type => {
  switch (o._tag) {
    case "ImmOrOwnedObject":
      return { ImmOrOwnedObject: refJson(o), $kind: "ImmOrOwnedObject" }
    case "Receiving":
      return { Receiving: refJson(o), $kind: "Receiving" }
    case "SharedObject":
      return {
        SharedObject: {
          objectId: o.objectId,
          initialSharedVersion: u64(o.initialSharedVersion),
          mutable: o.mutability._tag === "Mutable",
          ...(o.mutability._tag === "NonExclusiveWrite" && { mutability: "NonExclusiveWrite" as const })
        },
        $kind: "SharedObject"
      }
  }
}

const withdrawalJson = (w: T.FundsWithdrawal): typeof FundsWithdrawal.Type => ({
  reservation: { MaxAmountU64: u64(w.reservation.value), $kind: "MaxAmountU64" },
  typeArg: { Balance: TypeTag.format(w.typeArg.value), $kind: "Balance" },
  withdrawFrom: w.withdrawFrom._tag === "SenderAllowance"
    ? {
      SenderAllowance: { funder: w.withdrawFrom.funder, allowance: w.withdrawFrom.allowance },
      $kind: "SenderAllowance"
    }
    : w.withdrawFrom._tag === "Sponsor"
    ? { Sponsor: true, $kind: "Sponsor" }
    : { Sender: true, $kind: "Sender" }
})

const inputJson = (i: Ptb.Input): CallArg => {
  switch (i._tag) {
    case "Pure":
      return { Pure: { bytes: b64(i.bytes) }, $kind: "Pure" }
    case "Object":
      return { Object: objectArgJson(i.value), $kind: "Object" }
    case "FundsWithdrawal":
      return { FundsWithdrawal: withdrawalJson(i), $kind: "FundsWithdrawal" }
    case "UnresolvedObject":
      return {
        UnresolvedObject: { objectId: i.objectId, ...(i.mutable !== undefined && { mutable: i.mutable }) },
        $kind: "UnresolvedObject"
      }
  }
}

const commandJson = (c: Ptb.Command): Result.Result<Command, UnsupportedTransactionJson> => {
  const args = (as: ReadonlyArray<T.Argument>) => as.map(argumentJson)
  switch (c._tag) {
    case "MoveCall":
      return Result.succeed({
        MoveCall: {
          package: c.package,
          module: c.module,
          function: c.function,
          typeArguments: c.typeArguments.map(TypeTag.format),
          arguments: args(c.arguments)
        },
        $kind: "MoveCall"
      })
    case "TransferObjects":
      return Result.succeed({
        TransferObjects: { objects: args(c.objects), address: argumentJson(c.address) },
        $kind: "TransferObjects"
      })
    case "SplitCoins":
      return Result.succeed({ SplitCoins: { coin: argumentJson(c.coin), amounts: args(c.amounts) }, $kind: "SplitCoins" })
    case "MergeCoins":
      return Result.succeed({
        MergeCoins: { destination: argumentJson(c.destination), sources: args(c.sources) },
        $kind: "MergeCoins"
      })
    case "Publish":
      return Result.succeed({ Publish: { modules: c.modules.map(b64), dependencies: [...c.dependencies] }, $kind: "Publish" })
    case "MakeMoveVec":
      return Result.succeed({
        MakeMoveVec: { type: Option.match(c.type, { onNone: () => null, onSome: TypeTag.format }), elements: args(c.elements) },
        $kind: "MakeMoveVec"
      })
    case "Upgrade":
      return Result.succeed({
        Upgrade: {
          modules: c.modules.map(b64),
          dependencies: [...c.dependencies],
          package: c.package,
          ticket: argumentJson(c.ticket)
        },
        $kind: "Upgrade"
      })
    case "BalanceIntent":
      return Result.succeed({
        $Intent: {
          name: COIN_WITH_BALANCE,
          inputs: {},
          data: {
            type: c.coinType === TypeTag.SUI && c.useGasCoin ? "gas" : c.coinType,
            balance: u64(c.amount),
            outputKind: c.output
          }
        },
        $kind: "$Intent"
      })
    case "AllowanceIntent":
      return Result.succeed({
        $Intent: {
          name: ALLOWANCE_BALANCE,
          inputs: {
            allowance: argumentJson(c.allowance),
            clock: argumentJson(c.clock),
            ...(c.permit !== undefined && { permit: argumentJson(c.permit) })
          },
          data: {
            objectId: c.allowanceId,
            ...(c.funder !== undefined && { funder: c.funder }),
            ...(c.appType !== undefined && { appType: c.appType }),
            type: c.coinType,
            amount: u64(c.amount),
            outputKind: c.output
          }
        },
        $kind: "$Intent"
      })
    default:
      return Result.fail(
        new UnsupportedTransactionJson({
          construct: `command ${(c as { readonly _tag: string })._tag}`,
          reason: "no transaction JSON mapping for this command"
        })
      )
  }
}

const optionU64 = (o: Option.Option<bigint>) => Option.match(o, { onNone: () => null, onSome: u64 })

const expirationJson = (e: T.TransactionExpiration): typeof Expiration.Type => {
  switch (e._tag) {
    case "None":
      return { None: true, $kind: "None" }
    case "Epoch":
      return { Epoch: u64(e.value), $kind: "Epoch" }
    case "ValidDuring":
    case "Validity": {
      const fields = {
        minEpoch: optionU64(e.minEpoch),
        maxEpoch: optionU64(e.maxEpoch),
        minTimestamp: optionU64(e.minTimestamp),
        maxTimestamp: optionU64(e.maxTimestamp),
        chain: e.chain,
        nonce: e.nonce
      }
      return e._tag === "ValidDuring"
        ? { ValidDuring: fields, $kind: "ValidDuring" }
        : {
          Validity: {
            ...fields,
            allowedProposers: Option.match(e.allowedProposers, {
              onNone: () => null,
              onSome: (p) => ({ epoch: u64(p.epoch), proposers: [...p.proposers] })
            })
          },
          $kind: "Validity"
        }
    }
  }
}

/** Resolved `TransactionData` as transaction JSON (with its digest, as Mysten writes fully resolved transactions). */
export const fromTransactionData = (data: T.TransactionData): TransactionJson => ({
  version: 2,
  sender: data.sender,
  expiration: expirationJson(data.expiration),
  gasData: {
    budget: u64(data.gasData.budget),
    price: u64(data.gasData.price),
    owner: data.gasData.owner,
    payment: data.gasData.payment.map(refJson)
  },
  inputs: data.kind.inputs.map(inputJson),
  // The resolved command set has no intents, so this can't fail.
  commands: data.kind.commands.map((c) => Result.getOrThrow(commandJson(c))),
  digest: Hash.transactionDigest(T.encode(data))
})

/** An unresolved transaction (a `Draft`, intents included) as transaction JSON. */
export const fromUnresolved = (tx: Unresolved): Effect.Effect<TransactionJson, UnsupportedTransactionJson> =>
  Effect.suspend(() => {
    const commands: Array<Command> = []
    for (const c of tx.draft.commands) {
      const r = commandJson(c)
      if (Result.isFailure(r)) return Effect.fail(r.failure)
      commands.push(r.success)
    }
    return Effect.succeed<TransactionJson>({
      version: 2,
      sender: tx.sender ?? null,
      expiration: tx.expiration ? expirationJson(tx.expiration) : null,
      gasData: {
        budget: tx.gasBudget === undefined ? null : u64(tx.gasBudget),
        price: tx.gasPrice === undefined ? null : u64(tx.gasPrice),
        owner: tx.gasOwner ?? null,
        payment: tx.gasPayment ? tx.gasPayment.map(refJson) : null
      },
      inputs: tx.draft.inputs.map(inputJson),
      commands
    })
  })

const isTransactionData = (tx: Unresolved | T.TransactionData): tx is T.TransactionData =>
  (tx as T.TransactionData)._tag === "V1"

/** Either form as transaction JSON. */
export const toJson = (tx: Unresolved | T.TransactionData): Effect.Effect<TransactionJson, UnsupportedTransactionJson> =>
  isTransactionData(tx) ? Effect.succeed(fromTransactionData(tx)) : fromUnresolved(tx)

/** Either form as a JSON string that `Transaction.from` accepts. */
export const encode = (tx: Unresolved | T.TransactionData): Effect.Effect<string, UnsupportedTransactionJson> =>
  Effect.map(toJson(tx), (json) => JSON.stringify(json, null, 2))

// -----------------------------------------------------------------------------
// Decoding (JSON -> ours)
// -----------------------------------------------------------------------------

const KNOWN_INPUTS = new Set(["Object", "Pure", "UnresolvedPure", "UnresolvedObject", "FundsWithdrawal"])
const KNOWN_COMMANDS = new Set([
  "MoveCall",
  "TransferObjects",
  "SplitCoins",
  "MergeCoins",
  "Publish",
  "MakeMoveVec",
  "Upgrade",
  "$Intent"
])

/**
 * Every enum variant key in the v2 schema, derived from the schema itself (a
 * variant is a struct with an optional `$kind`), so a new variant can't be
 * missed by the ambiguity guard. Computed on first use.
 */
let variantKeys: Set<string> | undefined
const VARIANT_KEYS = (): Set<string> => {
  if (variantKeys) return variantKeys
  const keys = new Set<string>()
  const seen = new Set<SchemaAST.AST>()
  const visit = (n: SchemaAST.AST): void => {
    if (seen.has(n)) return
    seen.add(n)
    if (SchemaAST.isObjects(n)) {
      const names = n.propertySignatures.map((p) => String(p.name))
      if (names.includes("$kind")) names.filter((k) => k !== "$kind" && /^[$A-Z]/.test(k)).forEach((k) => keys.add(k))
      n.propertySignatures.forEach((p) => visit(p.type))
      n.indexSignatures.forEach((i) => visit(i.type))
    } else if (SchemaAST.isUnion(n)) n.types.forEach(visit)
    else if (SchemaAST.isArrays(n)) {
      n.elements.forEach(visit)
      n.rest.forEach(visit)
    } else if (SchemaAST.isSuspend(n)) visit(n.thunk())
    n.encoding?.forEach((link) => visit(link.to))
  }
  visit(TransactionJson.ast)
  return variantKeys = keys
}

/**
 * An object carrying two enum variants (`{ "Pure": …, "Object": … }`) reads as
 * different transactions depending on the parser (Mysten takes `$kind` or the
 * first key; a schema union takes its first matching member), so it is refused.
 */
const ambiguousVariant = (v: unknown, path: string): InvalidTransactionJson | undefined => {
  if (typeof v !== "object" || v === null) return undefined
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) {
      const e = ambiguousVariant(x, `${path}[${i}]`)
      if (e) return e
    }
    return undefined
  }
  const variants = Object.keys(v).filter((k) => VARIANT_KEYS().has(k))
  if (variants.length > 1) {
    return new InvalidTransactionJson({ issue: `${path || "transaction"} has more than one enum variant: ${variants.join(", ")}` })
  }
  for (const [k, x] of Object.entries(v)) {
    const e = ambiguousVariant(x, path ? `${path}.${k}` : k)
    if (e) return e
  }
  return undefined
}

const kindOf = (v: unknown): string | undefined => {
  if (typeof v !== "object" || v === null) return undefined
  const k = (v as { $kind?: unknown }).$kind
  return typeof k === "string" ? k : Object.keys(v).find((key) => key !== "$kind")
}

/** Name an enum variant this module doesn't know, so it's reported as unsupported rather than malformed. */
const unknownVariant = (input: unknown): UnsupportedTransactionJson | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const { inputs, commands } = input as { inputs?: unknown; commands?: unknown }
  if (Array.isArray(inputs)) {
    for (const i of inputs) {
      const k = kindOf(i)
      if (k !== undefined && !KNOWN_INPUTS.has(k)) {
        return new UnsupportedTransactionJson({ construct: `input ${k}`, reason: "unknown input kind" })
      }
    }
  }
  if (Array.isArray(commands)) {
    for (const c of commands) {
      const k = kindOf(c)
      if (k !== undefined && !KNOWN_COMMANDS.has(k)) {
        return new UnsupportedTransactionJson({ construct: `command ${k}`, reason: "unknown command kind" })
      }
    }
  }
  return undefined
}

const decodeJsonObject = /* @__PURE__ */ Schema.decodeUnknownResult(TransactionJson)
const decodeCoinWithBalance = /* @__PURE__ */ Schema.decodeUnknownResult(CoinWithBalanceData)
const decodeAllowanceBalance = /* @__PURE__ */ Schema.decodeUnknownResult(AllowanceBalanceData)

/** Validate a parsed JSON value (or a JSON string) against the v2 schema. */
export const parse = (input: unknown): Effect.Effect<TransactionJson, InvalidTransactionJson | UnsupportedTransactionJson> =>
  Effect.suspend(() => {
    let value = input
    if (typeof input === "string") {
      try {
        value = JSON.parse(input)
      } catch (e) {
        return Effect.fail(new InvalidTransactionJson({ issue: `not JSON: ${(e as Error).message}` }))
      }
    }
    const ambiguous = ambiguousVariant(value, "")
    if (ambiguous) return Effect.fail(ambiguous)
    const r = decodeJsonObject(value)
    if (Result.isSuccess(r)) return Effect.succeed(r.success)
    return Effect.fail(unknownVariant(value) ?? new InvalidTransactionJson({ issue: r.failure.message }))
  })

class Fail {
  constructor(readonly error: InvalidTransactionJson | UnsupportedTransactionJson) {}
}
const invalid = (issue: string): never => {
  throw new Fail(new InvalidTransactionJson({ issue }))
}
const unsupported = (construct: string, reason: string): never => {
  throw new Fail(new UnsupportedTransactionJson({ construct, reason }))
}

const toU64 = (v: string | number): bigint => BigInt(v)
const toAddress = (s: string): Address.Address => {
  try {
    return Address.normalize(s)
  } catch {
    return invalid(`${JSON.stringify(s)} is not an address`)
  }
}
const toTypeTag = (s: string): TypeTag.TypeTag => {
  try {
    return TypeTag.parse(s)
  } catch (e) {
    return s.includes("@") || s.includes("/")
      ? unsupported(`type ${s}`, "named (MVR) types must be resolved before they reach this SDK")
      : invalid((e as Error).message)
  }
}
const toBytes = (s: string): Uint8Array => {
  try {
    return base64.decode(s)
  } catch {
    return invalid(`invalid base64: ${s.slice(0, 32)}`)
  }
}
const toDigest = (s: string): T.ObjectDigest => {
  try {
    if (base58.decode(s).length === 32) return s as T.ObjectDigest
  } catch {
    // fall through
  }
  return invalid(`invalid object digest: ${s}`)
}
const toRef = (r: typeof ObjectRef.Type): T.ObjectRef => ({
  objectId: toAddress(r.objectId),
  version: toU64(r.version),
  digest: r.digest
})
const toOptionU64 = (v: string | number | null) => (v === null ? Option.none() : Option.some(toU64(v)))

const toObjectArg = (o: typeof ObjectArg.Type): T.ObjectArg => {
  if ("ImmOrOwnedObject" in o) return { _tag: "ImmOrOwnedObject", ...toRef(o.ImmOrOwnedObject) }
  if ("Receiving" in o) return { _tag: "Receiving", ...toRef(o.Receiving) }
  const s = o.SharedObject
  return {
    _tag: "SharedObject",
    objectId: toAddress(s.objectId),
    initialSharedVersion: toU64(s.initialSharedVersion),
    mutability: { _tag: s.mutability === "NonExclusiveWrite" ? "NonExclusiveWrite" : s.mutable ? "Mutable" : "Immutable" }
  }
}

const toWithdrawal = (w: typeof FundsWithdrawal.Type): T.CallArg => {
  const from = w.withdrawFrom
  return {
    _tag: "FundsWithdrawal",
    reservation: { _tag: "MaxAmountU64", value: toU64(w.reservation.MaxAmountU64) },
    typeArg: { _tag: "Balance", value: toTypeTag(w.typeArg.Balance) },
    withdrawFrom: "SenderAllowance" in from
      ? {
        _tag: "SenderAllowance",
        funder: toAddress(from.SenderAllowance.funder),
        allowance: toAddress(from.SenderAllowance.allowance)
      }
      : "Sponsor" in from
      ? { _tag: "Sponsor" }
      : { _tag: "Sender" }
  }
}

const toExpiration = (e: typeof Expiration.Type): T.TransactionExpiration => {
  if ("None" in e) return { _tag: "None" }
  if ("Epoch" in e) return { _tag: "Epoch", value: toU64(e.Epoch) }
  const v = "ValidDuring" in e ? e.ValidDuring : e.Validity
  const fields = {
    minEpoch: toOptionU64(v.minEpoch),
    maxEpoch: toOptionU64(v.maxEpoch),
    minTimestamp: toOptionU64(v.minTimestamp),
    maxTimestamp: toOptionU64(v.maxTimestamp),
    chain: toDigest(v.chain),
    nonce: v.nonce
  }
  if ("ValidDuring" in e) return { _tag: "ValidDuring", ...fields }
  const p = e.Validity.allowedProposers
  if (p !== null && p.proposers.length === 0) invalid("allowedProposers must not be empty")
  return {
    _tag: "Validity",
    ...fields,
    allowedProposers: p === null ? Option.none() : Option.some({ epoch: toU64(p.epoch), proposers: [...p.proposers] })
  }
}

const encodeU64 = /* @__PURE__ */ Bcs.encodeSync(Bcs.u64)
const encodeAddress = /* @__PURE__ */ Bcs.encodeSync(Bcs.Address)

/** What an `UnresolvedPure` input must be, from where it's used (as Mysten's `normalizeRawArguments`). */
type PureUse = "u64" | "address" | "other"

const toUnresolvedSync = (json: TransactionJson): Unresolved => {
  const nInputs = json.inputs.length

  // Where each input is used, to type `UnresolvedPure` values and to tell
  // whether a pinned `UnresolvedObject` could be a `Receiving`.
  const pureUses = new Map<number, Set<PureUse>>()
  const inMoveCall = new Set<number>()
  const use = (a: Argument, kind: PureUse) => {
    if (!("Input" in a)) return
    const s = pureUses.get(a.Input) ?? new Set<PureUse>()
    s.add(kind)
    pureUses.set(a.Input, s)
  }

  const toArgument = (a: Argument, at: number): T.Argument => {
    if ("GasCoin" in a) return { _tag: "GasCoin" }
    if ("Input" in a) {
      if (a.Input >= nInputs) invalid(`command ${at} refers to input ${a.Input}; there are ${nInputs}`)
      return { _tag: "Input", value: a.Input }
    }
    if ("Result" in a) {
      if (a.Result >= at) invalid(`command ${at} refers to the result of command ${a.Result}`)
      return { _tag: "Result", value: a.Result }
    }
    if (a.NestedResult[0] >= at) invalid(`command ${at} refers to the result of command ${a.NestedResult[0]}`)
    // An intent yields one value: only its first nested result exists.
    if (a.NestedResult[1] > 0 && "$Intent" in json.commands[a.NestedResult[0]]!) {
      invalid(`command ${at} refers to result ${a.NestedResult[1]} of intent command ${a.NestedResult[0]}, which has one`)
    }
    return { _tag: "NestedResult", value: [a.NestedResult[0], a.NestedResult[1]] }
  }

  const commands: Array<Ptb.Command> = json.commands.map((c, at): Ptb.Command => {
    const args = (as: ReadonlyArray<Argument>, kind: PureUse = "other") =>
      as.map((a) => {
        use(a, kind)
        return toArgument(a, at)
      })
    const arg = (a: Argument, kind: PureUse = "other") => args([a], kind)[0]!
    if ("MoveCall" in c) {
      const m = c.MoveCall
      for (const a of m.arguments) if ("Input" in a) inMoveCall.add(a.Input)
      return {
        _tag: "MoveCall",
        package: toAddress(m.package),
        module: m.module,
        function: m.function,
        typeArguments: m.typeArguments.map(toTypeTag),
        arguments: args(m.arguments)
      }
    }
    if ("TransferObjects" in c) {
      return {
        _tag: "TransferObjects",
        objects: args(c.TransferObjects.objects),
        address: arg(c.TransferObjects.address, "address")
      }
    }
    if ("SplitCoins" in c) {
      return { _tag: "SplitCoins", coin: arg(c.SplitCoins.coin), amounts: args(c.SplitCoins.amounts, "u64") }
    }
    if ("MergeCoins" in c) {
      return { _tag: "MergeCoins", destination: arg(c.MergeCoins.destination), sources: args(c.MergeCoins.sources) }
    }
    if ("Publish" in c) {
      return {
        _tag: "Publish",
        modules: c.Publish.modules.map(toBytes),
        dependencies: c.Publish.dependencies.map(toAddress)
      }
    }
    if ("MakeMoveVec" in c) {
      return {
        _tag: "MakeMoveVec",
        type: c.MakeMoveVec.type === null ? Option.none() : Option.some(toTypeTag(c.MakeMoveVec.type)),
        elements: args(c.MakeMoveVec.elements)
      }
    }
    if ("Upgrade" in c) {
      const u = c.Upgrade
      return {
        _tag: "Upgrade",
        modules: u.modules.map(toBytes),
        dependencies: u.dependencies.map(toAddress),
        package: toAddress(u.package),
        ticket: arg(u.ticket)
      }
    }
    const intent = c.$Intent
    if (intent.name === ALLOWANCE_BALANCE) {
      const input = (name: string): T.Argument | undefined => {
        const a = intent.inputs[name]
        if (a === undefined) return undefined
        if (Array.isArray(a)) return invalid(`AllowanceBalance input ${name} must be a single argument`)
        return arg(a as Argument)
      }
      const extra = Object.keys(intent.inputs).filter((k) => k !== "allowance" && k !== "clock" && k !== "permit")
      if (extra.length > 0) invalid(`unexpected AllowanceBalance inputs: ${extra.join(", ")}`)
      const allowance = input("allowance") ?? invalid("an AllowanceBalance intent needs an allowance input")
      const clock = input("clock") ?? invalid("an AllowanceBalance intent needs a clock input")
      const permit = input("permit")
      const d = decodeAllowanceBalance(intent.data)
      if (Result.isFailure(d)) return invalid(`AllowanceBalance data: ${d.failure.message}`)
      const { objectId, funder, appType, type, amount, outputKind } = d.success
      if ((appType === undefined) !== (permit === undefined)) {
        invalid("an AllowanceBalance intent has an app type exactly when it has a permit input")
      }
      return {
        _tag: "AllowanceIntent",
        coinType: TypeTag.format(toTypeTag(type)),
        amount: toU64(amount),
        output: outputKind,
        allowanceId: toAddress(objectId),
        ...(funder !== undefined && { funder: toAddress(funder) }),
        ...(appType !== undefined && { appType: TypeTag.format(toTypeTag(appType)) }),
        allowance,
        clock,
        ...(permit !== undefined && { permit }),
        resolve: Allowances.resolve
      }
    }
    if (intent.name !== COIN_WITH_BALANCE) {
      return unsupported(
        `intent ${intent.name}`,
        "only CoinWithBalance (tx.coin / tx.balance) and AllowanceBalance intents are supported"
      )
    }
    if (Object.keys(intent.inputs).length > 0) invalid("a CoinWithBalance intent takes no inputs")
    const d = decodeCoinWithBalance(intent.data)
    if (Result.isFailure(d)) return invalid(`CoinWithBalance data: ${d.failure.message}`)
    const { type, balance, outputKind } = d.success
    const coinType = type === "gas" ? TypeTag.SUI : TypeTag.format(toTypeTag(type))
    return {
      _tag: "BalanceIntent",
      coinType,
      amount: toU64(balance),
      output: outputKind ?? "coin",
      // An explicit SUI type means "not from the gas coin"; for other types the flag is moot (`Ptb.coin`'s default).
      useGasCoin: type === "gas" || coinType !== TypeTag.SUI
    }
  })

  const inputs: Array<Ptb.Input> = json.inputs.map((i, index): Ptb.Input => {
    if ("Pure" in i) return { _tag: "Pure", bytes: toBytes(i.Pure.bytes) }
    if ("Object" in i) return { _tag: "Object", value: toObjectArg(i.Object) }
    if ("FundsWithdrawal" in i) return toWithdrawal(i.FundsWithdrawal)
    if ("UnresolvedObject" in i) {
      const o = i.UnresolvedObject
      const objectId = toAddress(o.objectId)
      const pinned = o.version != null || o.digest != null
      if (pinned && o.initialSharedVersion == null) {
        if (o.version == null || o.digest == null) invalid(`UnresolvedObject ${objectId}: version and digest go together`)
        // Mysten uses a pinned ref as given: owned, or Receiving when a Move
        // call takes it as `Receiving<T>` (which needs the signature to tell).
        if (inMoveCall.has(index)) {
          unsupported(
            `UnresolvedObject ${objectId}`,
            "a version-pinned object passed to a Move call may be a Receiving; resolve it to an Object input first"
          )
        }
        return {
          _tag: "Object",
          value: { _tag: "ImmOrOwnedObject", objectId, version: toU64(o.version!), digest: toDigest(o.digest!) }
        }
      }
      // A shared object's initial version is a property of the object, so the resolver finds the same value.
      return { _tag: "UnresolvedObject", objectId, ...(o.mutable === true && { mutable: true }) }
    }
    // UnresolvedPure
    const uses = pureUses.get(index)
    const kind = uses?.size === 1 ? [...uses][0]! : "other"
    const value = i.UnresolvedPure.value
    if (kind === "u64") {
      if (
        !(typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value)) ||
          (typeof value === "string" && /^\d+$/.test(value)))
      ) {
        invalid(`UnresolvedPure ${index}: not a u64: ${JSON.stringify(value)}`)
      }
      const n = BigInt(value as string | number)
      if (n < 0n || n > U64_MAX) invalid(`UnresolvedPure ${index}: not a u64: ${n}`)
      return { _tag: "Pure", bytes: encodeU64(n) }
    }
    if (kind === "address") {
      if (typeof value !== "string" || !/^(0x)?[0-9a-fA-F]{1,64}$/.test(value)) {
        invalid(`UnresolvedPure ${index}: not an address: ${JSON.stringify(value)}`)
      }
      return { _tag: "Pure", bytes: encodeAddress(toAddress(value as string)) }
    }
    return unsupported(
      `UnresolvedPure input ${index}`,
      "an untyped pure value needs its Move parameter type; serialize it (tx.pure.u64(...), ...) before encoding"
    )
  })

  const g = json.gasData
  return {
    draft: { inputs, commands },
    ...(json.sender != null && { sender: toAddress(json.sender) }),
    ...(json.expiration != null && { expiration: toExpiration(json.expiration) }),
    ...(g.owner !== null && { gasOwner: toAddress(g.owner) }),
    ...(g.price !== null && { gasPrice: toU64(g.price) }),
    ...(g.budget !== null && { gasBudget: toU64(g.budget) }),
    ...(g.payment !== null && { gasPayment: g.payment.map(toRef) })
  }
}

/** Schema-valid transaction JSON -> an `Unresolved` transaction. */
export const toUnresolved = (json: TransactionJson): Effect.Effect<Unresolved, InvalidTransactionJson | UnsupportedTransactionJson> =>
  Effect.suspend(() => {
    let tx: Unresolved
    try {
      tx = toUnresolvedSync(json)
    } catch (e) {
      if (e instanceof Fail) return Effect.fail(e.error)
      throw e
    }
    // A fully resolved transaction's digest must be its own. A digest beside
    // unresolved inputs or intents describes some other resolution: not checked.
    const claimed = json.digest
    const resolved = json.inputs.every((i) => !("UnresolvedPure" in i) && !("UnresolvedObject" in i)) &&
      json.commands.every((c) => !("$Intent" in c))
    if (typeof claimed !== "string" || !resolved) return Effect.succeed(tx)
    return Effect.matchEffect(toTransactionData(tx), {
      onFailure: () => Effect.succeed(tx),
      onSuccess: (data) => {
        const actual = Hash.transactionDigest(T.encode(data))
        return actual === claimed
          ? Effect.succeed(tx)
          : Effect.fail(new InvalidTransactionJson({ issue: `digest ${claimed} is not this transaction's (${actual})` }))
      }
    })
  })

/** A JSON string (or parsed value) from `Transaction.toJSON()` -> an `Unresolved` transaction. */
export const decode = (input: unknown): Effect.Effect<Unresolved, InvalidTransactionJson | UnsupportedTransactionJson> =>
  Effect.flatMap(parse(input), toUnresolved)

// -----------------------------------------------------------------------------
// Finishing
// -----------------------------------------------------------------------------

/** As a `Resolve.Plan`, for running `Resolve` steps by hand. Needs a sender (from the JSON or `sender`). */
export const toPlan = (tx: Unresolved, sender?: Address.Address): Effect.Effect<Resolve.Plan, Resolve.Incomplete> => {
  const s = sender ?? tx.sender
  return s === undefined
    ? Effect.fail(new Resolve.Incomplete({ missing: "sender" }))
    : Effect.succeed({ ...tx, sender: s })
}

/** The `TransactionData` of a transaction that is already fully resolved (no network). */
export const toTransactionData = (tx: Unresolved): Effect.Effect<T.TransactionData, Resolve.Incomplete | Resolve.InvalidTransaction> =>
  Effect.flatMap(toPlan(tx), Resolve.finish)

/**
 * Finish with the default pipeline (`Tx.resolve`), keeping whatever the JSON
 * already fixed: sender, gas owner, price, budget, expiration, and its gas
 * payment (as `Resolve.fixed`). `options` override the JSON.
 */
export const resolve = <E = never, R = never>(tx: Unresolved, options: Partial<Tx.ResolveOptions<E, R>> = {}) =>
  Effect.flatMap(toPlan(tx, options.sender), (plan) => {
    const payment = options.payment ?? (plan.gasPayment ? Resolve.fixed(plan.gasPayment) : undefined)
    const gasOwner = options.gasOwner ?? plan.gasOwner
    const gasPrice = options.gasPrice ?? plan.gasPrice
    const gasBudget = options.gasBudget ?? plan.gasBudget
    const expiration = options.expiration ?? plan.expiration
    return Tx.resolve<E, R>(plan.draft, {
      sender: plan.sender,
      ...(gasOwner !== undefined && { gasOwner }),
      ...(gasPrice !== undefined && { gasPrice }),
      ...(gasBudget !== undefined && { gasBudget }),
      ...(expiration !== undefined && { expiration }),
      ...(payment !== undefined && { payment })
    })
  })
