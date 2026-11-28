/**
 * Programmable transaction blocks as Effects.
 *
 * A PTB "recipe" is an ordinary Effect that requires the `PtbBuilder` service:
 *
 *   const pay = (to: Address, amount: bigint) => Effect.gen(function*() {
 *     const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(amount)])
 *     yield* Ptb.transferObjects([coin!], yield* Ptb.address(to))
 *   })
 *
 * Consequences of that one decision:
 * - Recipes compose with `yield*`, `Effect.forEach`, `Effect.all` — no `tx.add(thunk)`.
 * - A recipe's requirements are in its type. One that needs chain data
 *   (Walrus reading its system object for prices) says `R = PtbBuilder | Walrus`;
 *   one that does not is guaranteed buildable offline.
 * - A recipe's failures are in its type, too.
 * - `Ptb.build` gives each build a fresh builder: no shared mutable
 *   `Transaction` object escapes, so a recipe can't be "half-applied" twice.
 *
 * Pure arguments are typed by their BCS schema at the call site
 * (`Ptb.pure(Bcs.u64, 5n)`), so there is no "UnresolvedPure" phase and no
 * round-trip to fetch a function signature just to serialize a number.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "./Address.ts"
import type { Coins } from "./Coins.ts"
import * as Allowances from "./internal/allowances.ts"
import type { Objects } from "./Objects.ts"
import type { AllowanceError, InsufficientBalance, InvalidBalanceIntent, Plan } from "./Resolve.ts"
import * as Resolve from "./Resolve.ts"
import type { RpcError } from "./RpcError.ts"
import * as T from "./TransactionData.ts"
import * as TypeTag from "./TypeTag.ts"

/** An object input whose version/ownership the resolver will look up. */
export interface UnresolvedObject {
  readonly _tag: "UnresolvedObject"
  readonly objectId: Address.Address
  /** Force shared-object mutability; otherwise inferred from how it's used. */
  readonly mutable?: boolean
}

export type Input = T.CallArg | UnresolvedObject

/**
 * "A `Coin<T>` (or `Balance<T>`) worth `amount`", left for `Resolve.balances`
 * to source: from the sender's address balance when it suffices, otherwise by
 * merging owned coins (topped up from the address balance), or for SUI from the
 * gas coin. Its result is the requested coin or balance.
 */
export interface BalanceIntent {
  readonly _tag: "BalanceIntent"
  /** Normalized coin type `T` (not `Coin<T>`). */
  readonly coinType: string
  readonly amount: bigint
  readonly output: "coin" | "balance"
  /** SUI only: split from the gas coin when the address balance is short. */
  readonly useGasCoin: boolean
}

/**
 * "A `Coin<T>` (or `Balance<T>`) worth `amount`, spent from a funder's address
 * balance under a shared `0x2::allowance::Allowance<Balance<T>>`", left for
 * `Resolve.balances` to check against the allowance and replace with a
 * `SenderAllowance` withdrawal and `allowance::balance_spend` (or
 * `app_balance_spend` with a `SpendPermit<A>`). Never falls back to the
 * sender's own funds. Matches `@mysten/sui`'s `AllowanceBalance` intent.
 */
export interface AllowanceIntent {
  readonly _tag: "AllowanceIntent"
  /** Normalized coin type `T` (not `Balance<T>`). */
  readonly coinType: string
  readonly amount: bigint
  readonly output: "coin" | "balance"
  /** The allowance's object id. */
  readonly allowanceId: Address.Address
  /** The funder, if the caller knows it; checked against the allowance. */
  readonly funder?: Address.Address
  /** Normalized app type `A` for an app-bound allowance. */
  readonly appType?: string
  /** The allowance object input (resolved by `Resolve.balances`, shared and mutable). */
  readonly allowance: T.Argument
  /** The `0x6` clock input. */
  readonly clock: T.Argument
  /** The `SpendPermit<A>` (app-bound allowances only). */
  readonly permit?: T.Argument
  /**
   * The resolver `Resolve.allowances` runs for every allowance intent of a plan. It travels with the
   * intent so that only programs that make allowance intents ship it.
   */
  readonly resolve: (
    plan: Plan
  ) => Effect.Effect<Plan, AllowanceError | InsufficientBalance | InvalidBalanceIntent | RpcError, Objects | Coins>
}

export type Command = T.Command | BalanceIntent | AllowanceIntent

/** What a build produces: commands plus inputs and intents that may still need resolving. */
export interface Draft {
  readonly inputs: ReadonlyArray<Input>
  readonly commands: ReadonlyArray<Command>
}

export class InvalidPureValue extends /* @__PURE__ */ Schema.TaggedError<InvalidPureValue>()("InvalidPureValue", {
  issue: Schema.String
}) {
  override get message(): string {
    return this.issue
  }
}

/** Run a parse that throws on bad input (an address, a type string); a throw is `InvalidPureValue`, not a defect. */
const attempt = <A>(f: () => A): Effect.Effect<A, InvalidPureValue> =>
  Effect.try({ try: f, catch: (e) => new InvalidPureValue({ issue: e instanceof Error ? e.message : String(e) }) })

/**
 * The builder's state for one build. Internal: recipes use the `Ptb`
 * functions, and `memo` for anything that must happen once per build.
 */
interface MutableDraft {
  inputs: Array<Input>
  commands: Array<Command>
  objectIndex: Map<string, number>
  memo?: Map<unknown, Effect.Effect<any, any, any>>
}

export class PtbBuilder extends /* @__PURE__ */ Context.Service<PtbBuilder, MutableDraft>()("@unconfirmed/sui/PtbBuilder") {}

const addCommand = (command: Command) =>
  Effect.map(Effect.service(PtbBuilder), (d): T.Argument => {
    d.commands.push(command)
    return { _tag: "Result", value: d.commands.length - 1 }
  })

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

export const gas: T.Argument = { _tag: "GasCoin" }

export const nested = (result: T.Argument, index: number): T.Argument => {
  if (result._tag !== "Result") throw new Error("nested() needs a command result")
  return { _tag: "NestedResult", value: [result.value, index] }
}

/** A pure argument, serialized now by its BCS schema. */
export const pure = <A, E>(schema: Schema.Codec<A, E>, value: A) => {
  const encode = Bcs.encode(schema)
  return Effect.flatMap(Effect.service(PtbBuilder), (d) =>
    Result.match(encode(value), {
      onFailure: (e) => Effect.fail(new InvalidPureValue({ issue: e.message })),
      onSuccess: (bytes) => {
        d.inputs.push({ _tag: "Pure", bytes })
        return Effect.succeed<T.Argument>({ _tag: "Input", value: d.inputs.length - 1 })
      }
    }))
}

export const u8 = (v: number) => pure(Bcs.u8, v)
export const u64 = (v: bigint) => pure(Bcs.u64, v)
export const bool = (v: boolean) => pure(Bcs.bool, v)
export const string = (v: string) => pure(Bcs.string, v)
export const address = (v: string) => Effect.flatMap(attempt(() => Address.normalize(v)), (a) => pure(Bcs.Address, a))

/** Widen an existing object input to mutable: a repeat use can only widen it. */
const widen = (d: MutableDraft, index: number) => {
  const input = d.inputs[index]!
  if (input._tag === "UnresolvedObject" && input.mutable === false) d.inputs[index] = { ...input, mutable: true }
  if (input._tag === "Object" && input.value._tag === "SharedObject" && input.value.mutability._tag !== "Mutable") {
    d.inputs[index] = { _tag: "Object", value: { ...input.value, mutability: { _tag: "Mutable" } } }
  }
}

/**
 * An object input by id. The same id always maps to the same input; a repeat
 * with `mutable: true` widens one forced immutable.
 */
export const object = (objectId: string, options?: { readonly mutable?: boolean }) =>
  Effect.flatMap(attempt(() => Address.normalize(objectId)), (id) =>
    Effect.map(Effect.service(PtbBuilder), (d): T.Argument => {
      const existing = d.objectIndex.get(id)
      if (existing !== undefined) {
        if (options?.mutable === true) widen(d, existing)
        return { _tag: "Input", value: existing }
      }
      d.inputs.push({ _tag: "UnresolvedObject", objectId: id, ...(options?.mutable !== undefined && { mutable: options.mutable }) })
      d.objectIndex.set(id, d.inputs.length - 1)
      return { _tag: "Input", value: d.inputs.length - 1 }
    }))

/**
 * An already-resolved object input (offline builds, sponsored flows),
 * deduplicated by id together with `object` and `sharedObject`.
 */
export const objectArg = (arg: T.ObjectArg) => Effect.map(Effect.service(PtbBuilder), (d) => addObject(d, arg))

const addObject = (d: MutableDraft, arg: T.ObjectArg): T.Argument => {
  const existing = d.objectIndex.get(arg.objectId)
  if (existing !== undefined) {
    if (arg._tag === "SharedObject" && arg.mutability._tag === "Mutable") widen(d, existing)
    return { _tag: "Input", value: existing }
  }
  d.inputs.push({ _tag: "Object", value: arg })
  d.objectIndex.set(arg.objectId, d.inputs.length - 1)
  return { _tag: "Input", value: d.inputs.length - 1 }
}

/** An object at a known version: its id, version and digest, as another source gives them (the digest as base58 text). */
export interface ObjectReference {
  readonly objectId: string
  readonly version: bigint
  readonly digest: string
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

/**
 * A base58 string of exactly 32 bytes (leading `1`s are zero bytes). Checked
 * here rather than through the BCS schema or a base58 codec, which would ship
 * 3–20 KB more with every generated call.
 */
const isDigest = (s: unknown): s is T.ObjectDigest => {
  if (typeof s !== "string" || s.length === 0 || s.length > 44) return false
  let n = 0n
  let zeros = 0
  for (const c of s) {
    const d = B58.indexOf(c)
    if (d < 0) return false
    if (n === 0n && d === 0) zeros++
    n = n * 58n + BigInt(d)
  }
  const hex = n === 0n ? "" : n.toString(16)
  return zeros + Math.ceil(hex.length / 2) === 32
}

/** `objectArg` for a reference given as plain values: the id normalized, the version and digest checked. */
const reference = (_tag: "ImmOrOwnedObject" | "Receiving", ref: ObjectReference) =>
  Effect.flatMap(attempt(() => Address.normalize(ref.objectId)), (objectId) =>
    typeof ref.version === "bigint" && ref.version >= 0n && ref.version <= U64_MAX && isDigest(ref.digest)
      ? objectArg({ _tag, objectId, version: ref.version, digest: ref.digest })
      : Effect.fail(new InvalidPureValue({ issue: `invalid object reference ${objectId}: version ${ref.version}, digest ${ref.digest}` })))

/** An owned or immutable object at a known version (`ImmOrOwnedObject`). An invalid id, version or digest is `InvalidPureValue`. */
export const owned = (ref: ObjectReference) => reference("ImmOrOwnedObject", ref)

/** An object sent to another object, received at a known version (`Receiving`, for a `Receiving<T>` parameter). */
export const receiving = (ref: ObjectReference) => reference("Receiving", ref)

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

export const moveCall = (call: {
  readonly target: `${string}::${string}::${string}`
  readonly typeArguments?: ReadonlyArray<string>
  readonly arguments?: ReadonlyArray<T.Argument>
}) =>
  Effect.flatMap(
    attempt(() => {
      const [pkg, module, fn] = call.target.split("::") as [string, string, string]
      return { package: Address.normalize(pkg), module, function: fn, typeArguments: (call.typeArguments ?? []).map(TypeTag.parse) }
    }),
    (target) => addCommand({ _tag: "MoveCall", ...target, arguments: call.arguments ?? [] })
  )

/** One coin per amount, as a tuple of the same length: `const [a, b] = yield* splitCoins(gas, [x, y])` needs no `!`. */
export const splitCoins = <const Amounts extends ReadonlyArray<T.Argument>>(coin: T.Argument, amounts: Amounts) =>
  Effect.map(
    addCommand({ _tag: "SplitCoins", coin, amounts }),
    (r) => amounts.map((_, i) => nested(r, i)) as unknown as { -readonly [K in keyof Amounts]: T.Argument }
  )

export const mergeCoins = (destination: T.Argument, sources: ReadonlyArray<T.Argument>) =>
  addCommand({ _tag: "MergeCoins", destination, sources })

export const transferObjects = (objects: ReadonlyArray<T.Argument>, address: T.Argument) =>
  addCommand({ _tag: "TransferObjects", objects, address })

export const makeMoveVec = (elements: ReadonlyArray<T.Argument>, type?: string) =>
  Effect.flatMap(
    attempt(() => (type === undefined ? Option.none() : Option.some(TypeTag.parse(type)))),
    (t) => addCommand({ _tag: "MakeMoveVec", type: t, elements })
  )

// -----------------------------------------------------------------------------
// Address balances
// -----------------------------------------------------------------------------

const U64_MAX = (1n << 64n) - 1n

const checkAmount = (amount: bigint) =>
  amount >= 0n && amount <= U64_MAX
    ? Effect.void
    : Effect.fail(new InvalidPureValue({ issue: `amount ${amount} is not a u64` }))

/** Where a withdrawal draws from. */
export type WithdrawFrom =
  | "sender"
  | "sponsor"
  | { readonly allowance: string; readonly funder: string }

/**
 * A `FundsWithdrawal` input: the right to withdraw up to `amount` of `type`
 * (default SUI) from an address balance. Redeem it with `redeemCoin` /
 * `redeemBalance`.
 */
export const withdrawal = (options: {
  readonly amount: bigint
  readonly type?: string
  readonly from?: WithdrawFrom
}) =>
  Effect.flatMap(checkAmount(options.amount), () =>
    Effect.flatMap(
      attempt((): T.CallArg => {
        const from = options.from ?? "sender"
        return {
          _tag: "FundsWithdrawal",
          reservation: { _tag: "MaxAmountU64", value: options.amount },
          typeArg: { _tag: "Balance", value: TypeTag.parse(options.type ?? TypeTag.SUI) },
          withdrawFrom: from === "sender"
            ? { _tag: "Sender" }
            : from === "sponsor"
            ? { _tag: "Sponsor" }
            : { _tag: "SenderAllowance", funder: Address.normalize(from.funder), allowance: Address.normalize(from.allowance) }
        }
      }),
      (input) =>
        Effect.map(Effect.service(PtbBuilder), (d): T.Argument => {
          d.inputs.push(input)
          return { _tag: "Input", value: d.inputs.length - 1 }
        })
    ))

/** `0x2::coin::redeem_funds<T>(withdrawal)`: a `Coin<T>` from a withdrawal. */
export const redeemCoin = (withdrawal: T.Argument, type: string = TypeTag.SUI) =>
  moveCall({ target: "0x2::coin::redeem_funds", typeArguments: [type], arguments: [withdrawal] })

/** `0x2::balance::redeem_funds<T>(withdrawal)`: a `Balance<T>` from a withdrawal. */
export const redeemBalance = (withdrawal: T.Argument, type: string = TypeTag.SUI) =>
  moveCall({ target: "0x2::balance::redeem_funds", typeArguments: [type], arguments: [withdrawal] })

/** `0x2::coin::send_funds<T>(coin, recipient)`: deposit a coin into `recipient`'s address balance. */
export const sendFunds = (coin: T.Argument, recipient: T.Argument, type: string = TypeTag.SUI) =>
  moveCall({ target: "0x2::coin::send_funds", typeArguments: [type], arguments: [coin, recipient] })

/** `0x2::balance::send_funds<T>(balance, recipient)`: deposit a balance into `recipient`'s address balance. */
export const sendBalance = (balance: T.Argument, recipient: T.Argument, type: string = TypeTag.SUI) =>
  moveCall({ target: "0x2::balance::send_funds", typeArguments: [type], arguments: [balance, recipient] })

/** A shared-object input by id, deduplicated like `object`; a repeat use can only widen it to mutable. */
export const sharedObject = (objectId: string, initialSharedVersion: bigint, mutable: boolean) =>
  Effect.flatMap(attempt(() => Address.normalize(objectId)), (id) =>
    Effect.map(Effect.service(PtbBuilder), (d): T.Argument => {
      const existing = d.objectIndex.get(id)
      if (existing !== undefined) {
        if (mutable) widen(d, existing)
        return { _tag: "Input", value: existing }
      }
      d.inputs.push({
        _tag: "Object",
        value: { _tag: "SharedObject", objectId: id, initialSharedVersion, mutability: { _tag: mutable ? "Mutable" : "Immutable" } }
      })
      d.objectIndex.set(id, d.inputs.length - 1)
      return { _tag: "Input", value: d.inputs.length - 1 }
    }))

/** The `0x6` clock, shared and immutable. */
export const clock = /* @__PURE__ */ sharedObject(Address.CLOCK, 1n, false)

/**
 * An allowance to spend under: its id, or the id with the funder (checked
 * against the allowance) and, for an app-bound allowance, the app type `A` and
 * a `SpendPermit<A>` the app's own Move code produced in this transaction.
 */
export type AllowanceReference =
  | string
  | {
    readonly objectId: string
    readonly funder?: string
    readonly app?: { readonly type: string; readonly permit: T.Argument }
  }

/** Options for `coin` / `balance`: from the sender's funds, or under an allowance. */
export type IntentOptions =
  | {
    readonly amount: bigint
    /** The coin type `T`, not `Coin<T>`. Default SUI. */
    readonly type?: string
    /** SUI only: split from the gas coin when the address balance is short. Default `true`. */
    readonly useGasCoin?: boolean
    readonly allowance?: never
  }
  | {
    readonly amount: bigint
    readonly type?: string
    /** Spend only from the allowance's funder; never falls back to the sender's funds. */
    readonly allowance: AllowanceReference
    readonly useGasCoin?: never
  }

const allowanceIntent = (
  output: AllowanceIntent["output"],
  options: { readonly amount: bigint; readonly type?: string; readonly allowance: AllowanceReference }
) =>
  Effect.gen(function*() {
    const ref = typeof options.allowance === "string" ? { objectId: options.allowance } : options.allowance
    const parsed = yield* attempt(() => ({
      allowanceId: Address.normalize(ref.objectId),
      coinType: TypeTag.normalizeString(options.type ?? TypeTag.SUI),
      ...(ref.funder !== undefined && { funder: Address.normalize(ref.funder) }),
      ...(ref.app !== undefined && { appType: TypeTag.normalizeString(ref.app.type), permit: ref.app.permit })
    }))
    // Input order matches @mysten/sui: allowance, clock, then the permit.
    const allowance = yield* object(parsed.allowanceId)
    const clockArg = yield* clock
    return yield* addCommand({
      _tag: "AllowanceIntent",
      amount: options.amount,
      output,
      ...parsed,
      allowance,
      clock: clockArg,
      resolve: Allowances.resolve
    })
  })

const intent = (output: BalanceIntent["output"]) => (options: IntentOptions) =>
  Effect.flatMap(checkAmount(options.amount), () =>
    options.allowance !== undefined
      ? allowanceIntent(output, { ...options, allowance: options.allowance })
      : Effect.flatMap(attempt(() => TypeTag.normalizeString(options.type ?? TypeTag.SUI)), (coinType) =>
        addCommand({ _tag: "BalanceIntent", coinType, amount: options.amount, output, useGasCoin: options.useGasCoin ?? true })))

/**
 * A `Coin<T>` worth `amount` (default SUI), sourced by `Resolve.balances`:
 * address balance first, then owned coins, then (SUI, unless
 * `useGasCoin: false`) the gas coin.
 *
 * With `allowance`, it is spent from the allowance funder's address balance
 * instead (`Resolve.balances` reads the allowance, checks it, and emits a
 * `SenderAllowance` withdrawal plus `allowance::balance_spend`).
 */
export const coin = /* @__PURE__ */ intent("coin")

/** A `Balance<T>` worth `amount`, sourced like `coin` (also under an `allowance`). */
export const balance = /* @__PURE__ */ intent("balance")

export const publish = (modules: ReadonlyArray<Uint8Array>, dependencies: ReadonlyArray<string>) =>
  Effect.flatMap(attempt(() => dependencies.map(Address.normalize)), (deps) => addCommand({ _tag: "Publish", modules, dependencies: deps }))

export const upgrade = (options: {
  readonly modules: ReadonlyArray<Uint8Array>
  readonly dependencies: ReadonlyArray<string>
  readonly package: string
  readonly ticket: T.Argument
}) =>
  Effect.flatMap(
    attempt(() => ({ dependencies: options.dependencies.map(Address.normalize), package: Address.normalize(options.package) })),
    (ids) => addCommand({ _tag: "Upgrade", modules: options.modules, ...ids, ticket: options.ticket })
  )

// -----------------------------------------------------------------------------
// Building
// -----------------------------------------------------------------------------

/**
 * Run a recipe against a fresh builder. Whatever else the recipe needs (`R`)
 * is still required; `PtbBuilder` is not.
 */
export const build = <A, E, R>(
  recipe: Effect.Effect<A, E, R>
): Effect.Effect<{ readonly value: A; readonly draft: Draft }, E, Exclude<R, PtbBuilder>> =>
  Effect.suspend(() => {
    const d: MutableDraft = { inputs: [], commands: [], objectIndex: new Map() }
    return recipe.pipe(
      Effect.map((value) => ({ value, draft: { inputs: d.inputs, commands: d.commands } })),
      Effect.provideService(PtbBuilder, d)
    )
  })

/** A draft with no unresolved inputs or intents is already a `ProgrammableTransaction`. */
export const toProgrammable = (draft: Draft): T.ProgrammableTransaction | undefined =>
  draft.inputs.every((i) => i._tag !== "UnresolvedObject") &&
    draft.commands.every((c) => c._tag !== "BalanceIntent" && c._tag !== "AllowanceIntent")
    ? { inputs: draft.inputs as ReadonlyArray<T.CallArg>, commands: draft.commands as ReadonlyArray<T.Command> }
    : undefined

/**
 * Run `effect` once per build: the first use of `key` in a build runs it, and
 * every later use in the same build (concurrent ones included) gets its
 * result. A new build starts with no memos. For steps that must appear once
 * per transaction however many recipes ask for them (registering a key, one
 * shared setup call). `key` is compared by identity (`Map` semantics): use a
 * string, a symbol or an object owned by the caller, one per kind of step.
 */
export const memo = <A, E, R>(key: unknown, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | PtbBuilder> =>
  Effect.flatMap(Effect.service(PtbBuilder), (d) => {
    const memos = d.memo ??= new Map()
    const hit = memos.get(key) as Effect.Effect<A, E, R> | undefined
    if (hit !== undefined) return hit
    return Effect.flatMap(Effect.cached(effect), (once) => {
      const raced = memos.get(key) as Effect.Effect<A, E, R> | undefined
      if (raced !== undefined) return raced
      memos.set(key, once)
      return once
    })
  })

/**
 * Build a recipe whose inputs are all resolved (`objectArg`, `owned`,
 * `receiving`, `sharedObject`, pure values) to `TransactionKind` bytes:
 * what `@mysten/sui` gives for `tx.build({ onlyTransactionKind: true })`.
 * An input left for the resolver (`Ptb.object(id)`) or a coin/balance intent
 * is `Incomplete`; a command using a later result is `InvalidTransaction`.
 */
export const buildKind = <A, E, R>(
  recipe: Effect.Effect<A, E, R>
): Effect.Effect<
  { readonly value: A; readonly bytes: Uint8Array },
  E | Resolve.Incomplete | Resolve.InvalidTransaction,
  Exclude<R, PtbBuilder>
> =>
  Effect.flatMap(build(recipe), ({ value, draft }): Effect.Effect<
    { readonly value: A; readonly bytes: Uint8Array },
    Resolve.Incomplete | Resolve.InvalidTransaction
  > => {
    const programmable = toProgrammable(draft)
    if (programmable === undefined) {
      return Effect.fail(
        new Resolve.Incomplete({ missing: "resolved inputs: buildKind takes no Ptb.object(id) inputs and no coin/balance intents" })
      )
    }
    return Effect.map(Resolve.encodeKind({ _tag: "ProgrammableTransaction", ...programmable }), (bytes) => ({ value, bytes }))
  })

const decodeKind = /* @__PURE__ */ Bcs.decode(T.TransactionKind)

/**
 * A recipe step that adds the inputs and commands of `TransactionKind` bytes
 * (from `buildKind`, or `@mysten/sui`'s `onlyTransactionKind`) to the current
 * build, as `Transaction.fromKind` does. Built alone, it gives the same kind
 * bytes back; later steps can use its inputs and results. An object it
 * shares with earlier steps becomes one input. Bytes that aren't a
 * programmable transaction kind are `InvalidTransaction`.
 */
export const fromKind = (bytes: Uint8Array) =>
  Effect.flatMap(Effect.service(PtbBuilder), (d) => {
    const decoded = decodeKind(bytes)
    if (Result.isFailure(decoded)) {
      return Effect.fail(new Resolve.InvalidTransaction({ reason: `not TransactionKind bytes: ${decoded.failure.message}` }))
    }
    const kind = decoded.success
    const bad = Resolve.checkReferences(kind)
    if (bad) return Effect.fail(bad)
    const inputs = kind.inputs.map((input): T.Argument => {
      if (input._tag === "Object") return addObject(d, input.value)
      d.inputs.push(input)
      return { _tag: "Input", value: d.inputs.length - 1 }
    })
    const offset = d.commands.length
    const remap = (a: T.Argument): T.Argument =>
      a._tag === "Input"
        ? inputs[a.value]!
        : a._tag === "Result"
        ? { _tag: "Result", value: a.value + offset }
        : a._tag === "NestedResult"
        ? { _tag: "NestedResult", value: [a.value[0] + offset, a.value[1]] }
        : a
    for (const c of kind.commands) d.commands.push(Resolve.mapArguments(c, remap))
    return Effect.succeed({
      inputs,
      results: kind.commands.map((_, i): T.Argument => ({ _tag: "Result", value: offset + i }))
    })
  })
