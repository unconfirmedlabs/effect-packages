/**
 * Turning a `Draft` into `TransactionData`, as a pipeline of small steps.
 *
 * Each step is `Plan -> Effect<Plan, E, R>`: it fills in one thing and states
 * exactly which capability it needs. `Tx.resolve` runs the default pipeline;
 * anything else (a sponsor setting gas, a custom coin picker, a policy check
 * that rejects some Move calls) is one more step in the `pipe`.
 *
 *   inputs    Objects | Packages   object refs, shared mutability, Receiving
 *   balances  Coins | Objects      `Ptb.coin` / `Ptb.balance` from address balance or coins,
 *                                  or under an allowance (checked against the allowance)
 *   gasPrice  Chain                reference gas price
 *   budget    Transactions | Chain dry run with a placeholder payment
 *   payment   (strategy)           `auto` (default): address balance, else coins;
 *                                  or `addressBalance`, `coins`, `fixed(refs)`
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { type Address, normalize } from "./Address.ts"
import { Chain, type ChainInfo } from "./Chain.ts"
import { type Balance, type Coin, Coins } from "./Coins.ts"
import type { ObjectNotFound } from "./Objects.ts"
import { Objects, type SuiObject } from "./Objects.ts"
import type { MoveFunction } from "./Packages.ts"
import { Packages } from "./Packages.ts"
import * as CoinReservation from "./CoinReservation.ts"
import type { AllowanceIntent, BalanceIntent, Command, Draft, Input } from "./Ptb.ts"
import type { RpcError } from "./RpcError.ts"
import * as T from "./TransactionData.ts"
import { type Status, Transactions } from "./Transactions.ts"
import * as TypeTag from "./TypeTag.ts"

export interface Plan {
  readonly sender: Address
  readonly draft: Draft
  readonly gasOwner?: Address
  readonly gasPrice?: bigint
  readonly gasBudget?: bigint
  readonly gasPayment?: ReadonlyArray<T.ObjectRef>
  readonly expiration?: T.TransactionExpiration
  /** Reads made up front by `Resolve.prefetch`; later steps use them instead of asking again. */
  readonly prefetched?: Prefetched
}

/** What `Resolve.prefetch` read, all at once, before the steps that need it. */
export interface Prefetched {
  /** Absent when nothing in the plan needed it (budget and expiration given, custom payment). */
  readonly chain?: ChainInfo
  /** Whose SUI `gasBalance` and `gasCoins` are (a step ignores them for anyone else). */
  readonly owner: Address
  readonly gasBalance?: Balance
  /** The owner's SUI coins in listing order: every one when fewer than a page, else the first page. */
  readonly gasCoins?: ReadonlyArray<Coin>
}

export class Incomplete extends /* @__PURE__ */ Schema.TaggedError<Incomplete>()("Incomplete", {
  missing: Schema.String
}) {}

/** The plan can't become valid transaction data (an invalid address, too many inputs, a reference to a later result, ...). */
export class InvalidTransaction extends /* @__PURE__ */ Schema.TaggedError<InvalidTransaction>()("InvalidTransaction", {
  reason: Schema.String
}) {}

/** The budget dry run failed: the transaction would fail on chain as it stands. */
export class GasEstimationFailed extends /* @__PURE__ */ Schema.TaggedError<GasEstimationFailed>()("GasEstimationFailed", {
  description: Schema.String,
  command: Schema.optionalKey(Schema.Number),
  abortCode: Schema.optionalKey(Schema.BigInt),
  /** The aborting module, `0x…::module` (and `::function` when known). */
  location: Schema.optionalKey(Schema.String)
}) {}

/**
 * The gas owner's SUI can't pay. `required` is the budget, plus, when commands
 * spend from the gas coin, the amounts they split off it.
 */
export class InsufficientGas extends /* @__PURE__ */ Schema.TaggedError<InsufficientGas>()("InsufficientGas", {
  owner: Schema.String,
  required: Schema.BigInt,
  available: Schema.BigInt
}) {}

export class InsufficientBalance extends /* @__PURE__ */ Schema.TaggedError<InsufficientBalance>()("InsufficientBalance", {
  owner: Schema.String,
  coinType: Schema.String,
  required: Schema.BigInt,
  available: Schema.BigInt
}) {}

export class InvalidBalanceIntent extends /* @__PURE__ */ Schema.TaggedError<InvalidBalanceIntent>()("InvalidBalanceIntent", {
  reason: Schema.String
}) {}

/** No object with the allowance's id. */
export class AllowanceNotFound extends /* @__PURE__ */ Schema.TaggedError<AllowanceNotFound>()("AllowanceNotFound", {
  allowance: Schema.String
}) {}

/** The object isn't a shared `Allowance<Balance<T>>` for the intent's coin type, or its funder isn't the one the caller named. */
export class InvalidAllowance extends /* @__PURE__ */ Schema.TaggedError<InvalidAllowance>()("InvalidAllowance", {
  allowance: Schema.String,
  reason: Schema.String
}) {}

/**
 * The permit doesn't fit the allowance: an app-bound allowance spent without a
 * `SpendPermit`, a permit for another app, or a permit for an allowance that
 * isn't app-bound. `null` means "no app".
 */
export class AllowanceAppMismatch extends /* @__PURE__ */ Schema.TaggedError<AllowanceAppMismatch>()("AllowanceAppMismatch", {
  allowance: Schema.String,
  allowanceApp: Schema.NullOr(Schema.String),
  permitApp: Schema.NullOr(Schema.String)
}) {}

/** The sender isn't the allowance's spender (`null`: the allowance has none, so nobody can spend). */
export class AllowanceSpenderMismatch extends /* @__PURE__ */ Schema.TaggedError<AllowanceSpenderMismatch>()("AllowanceSpenderMismatch", {
  allowance: Schema.String,
  spender: Schema.NullOr(Schema.String),
  sender: Schema.String
}) {}

/** The allowance's start time (inclusive) is after the chain clock. */
export class AllowanceNotStarted extends /* @__PURE__ */ Schema.TaggedError<AllowanceNotStarted>()("AllowanceNotStarted", {
  allowance: Schema.String,
  startTimestampMs: Schema.BigInt,
  nowMs: Schema.BigInt
}) {}

/** The allowance's expiration (exclusive) has passed on the chain clock. */
export class AllowanceExpired extends /* @__PURE__ */ Schema.TaggedError<AllowanceExpired>()("AllowanceExpired", {
  allowance: Schema.String,
  expirationTimestampMs: Schema.BigInt,
  nowMs: Schema.BigInt
}) {}

/** The transaction's spends would exceed the allowance's lifetime cap or its current rate-limit window. */
export class InsufficientAllowance extends /* @__PURE__ */ Schema.TaggedError<InsufficientAllowance>()("InsufficientAllowance", {
  allowance: Schema.String,
  coinType: Schema.String,
  limit: Schema.Literals(["lifetime", "rate"]),
  required: Schema.BigInt,
  available: Schema.BigInt
}) {}

/** Everything allowance resolution can refuse before signing. */
export type AllowanceError =
  | AllowanceNotFound
  | InvalidAllowance
  | AllowanceAppMismatch
  | AllowanceSpenderMismatch
  | AllowanceNotStarted
  | AllowanceExpired
  | InsufficientAllowance

// -----------------------------------------------------------------------------
// inputs
// -----------------------------------------------------------------------------

const TX_CONTEXT = "0x0000000000000000000000000000000000000000000000000000000000000002::tx_context::TxContext"
const RECEIVING = "0x0000000000000000000000000000000000000000000000000000000000000002::transfer::Receiving"

interface Usage {
  readonly mutable: boolean
  readonly receiving: boolean
}

/** How each input is used: from commands, and from the called functions' parameter references. */
const usages = (draft: Draft, functions: ReadonlyMap<number, MoveFunction>) => {
  const out = new Map<number, Usage>()
  const mark = (arg: T.Argument, mutable: boolean, receiving = false) => {
    if (arg._tag !== "Input") return
    const u = out.get(arg.value)
    out.set(arg.value, { mutable: (u?.mutable ?? false) || mutable, receiving: (u?.receiving ?? false) || receiving })
  }
  draft.commands.forEach((c, i) => {
    switch (c._tag) {
      case "MoveCall": {
        const params = (functions.get(i)?.parameters ?? []).filter((p) => p.typeName !== TX_CONTEXT)
        c.arguments.forEach((a, j) => {
          const p = params[j]
          mark(a, p === undefined || p.reference !== "Immutable", p?.typeName === RECEIVING)
        })
        return
      }
      case "TransferObjects":
        return c.objects.forEach((a) => mark(a, true))
      case "SplitCoins":
        return mark(c.coin, true)
      case "MergeCoins":
        return [c.destination, ...c.sources].forEach((a) => mark(a, true))
      case "MakeMoveVec":
        return c.elements.forEach((a) => mark(a, true))
      case "AllowanceIntent":
        mark(c.allowance, true)
        mark(c.clock, false)
        if (c.permit) mark(c.permit, true)
        return
      default:
        return
    }
  })
  return out
}

const objectArg = (o: SuiObject, usage: Usage | undefined, forced: boolean | undefined): T.ObjectArg | InvalidTransaction => {
  if (o.owner._tag === "Unknown") {
    return new InvalidTransaction({ reason: `object ${o.objectId} has an owner kind (${o.owner.kind}) this SDK can't use as an input` })
  }
  if (o.owner._tag === "Shared" || o.owner._tag === "ConsensusAddressOwner") {
    const mutable = forced ?? usage?.mutable ?? true
    return {
      _tag: "SharedObject",
      objectId: o.objectId,
      initialSharedVersion: o.owner._tag === "Shared" ? o.owner.initialSharedVersion : o.owner.startVersion,
      mutability: { _tag: mutable ? "Mutable" : "Immutable" }
    }
  }
  const ref = { objectId: o.objectId, version: o.version, digest: o.digest }
  return usage?.receiving ? { _tag: "Receiving", ...ref } : { _tag: "ImmOrOwnedObject", ...ref }
}

/** Inputs that allowance intents spend from: `Resolve.balances` reads and resolves those itself. */
const allowanceInputs = (draft: Draft) =>
  new Set(draft.commands.flatMap((c) => (c._tag === "AllowanceIntent" && c.allowance._tag === "Input" ? [c.allowance.value] : [])))

/**
 * Resolve object inputs. All lookups run at once; the `Objects` and
 * `Packages` implementations batch and cache them. Signatures are read only
 * for Move calls that take an unresolved object, once per target. Allowance
 * objects are left for `Resolve.balances`, which reads their contents anyway.
 */
export const inputs = (plan: Plan): Effect.Effect<Plan, ObjectNotFound | RpcError | InvalidTransaction, Objects | Packages> =>
  Effect.gen(function*() {
    const skip = allowanceInputs(plan.draft)
    const unresolved = plan.draft.inputs.flatMap((input, index) =>
      input._tag === "UnresolvedObject" && !skip.has(index) ? [{ input, index }] : []
    )
    if (unresolved.length === 0) return plan
    const objects = yield* Objects
    const packages = yield* Packages
    const pending = new Set(unresolved.map(({ index }) => index))
    const targetOf = (c: Extract<Command, { _tag: "MoveCall" }>) => `${c.package}::${c.module}::${c.function}`
    const calls = plan.draft.commands.flatMap((c, index) =>
      c._tag === "MoveCall" && c.arguments.some((a) => a._tag === "Input" && pending.has(a.value)) ? [{ c, index }] : []
    )
    const targets = new Map(calls.map(({ c }) => [targetOf(c), c] as const))
    const [resolved, signatures] = yield* Effect.all([
      Effect.forEach(unresolved, ({ input }) => objects.get(input.objectId), { concurrency: "unbounded" }),
      Effect.forEach(targets, ([key, c]) => Effect.map(packages.getFunction(c), (f) => [key, f] as const), { concurrency: "unbounded" })
    ], { concurrency: "unbounded" })
    const byTarget = new Map(signatures)
    const use = usages(plan.draft, new Map(calls.map(({ c, index }) => [index, byTarget.get(targetOf(c))!] as const)))
    const next = [...plan.draft.inputs]
    for (const [i, { input, index }] of unresolved.entries()) {
      const arg = objectArg(resolved[i]!, use.get(index), input.mutable)
      if (arg instanceof InvalidTransaction) return yield* arg
      next[index] = { _tag: "Object", value: arg }
    }
    return { ...plan, draft: { ...plan.draft, inputs: next } }
  })

// -----------------------------------------------------------------------------
// balances (coin / balance intents)
// -----------------------------------------------------------------------------

/** Every argument a command reads. */
export const argumentsOf = (c: Command): ReadonlyArray<T.Argument> => {
  switch (c._tag) {
    case "MoveCall":
      return c.arguments
    case "TransferObjects":
      return [...c.objects, c.address]
    case "SplitCoins":
      return [c.coin, ...c.amounts]
    case "MergeCoins":
      return [c.destination, ...c.sources]
    case "MakeMoveVec":
      return c.elements
    case "Upgrade":
      return [c.ticket]
    case "AllowanceIntent":
      return c.permit ? [c.allowance, c.clock, c.permit] : [c.allowance, c.clock]
    default:
      return []
  }
}

function mapArguments(c: T.Command, f: (a: T.Argument) => T.Argument): T.Command
function mapArguments(c: Command, f: (a: T.Argument) => T.Argument): Command
function mapArguments(c: Command, f: (a: T.Argument) => T.Argument): Command {
  switch (c._tag) {
    case "MoveCall":
      return { ...c, arguments: c.arguments.map(f) }
    case "TransferObjects":
      return { ...c, objects: c.objects.map(f), address: f(c.address) }
    case "SplitCoins":
      return { ...c, coin: f(c.coin), amounts: c.amounts.map(f) }
    case "MergeCoins":
      return { ...c, destination: f(c.destination), sources: c.sources.map(f) }
    case "MakeMoveVec":
      return { ...c, elements: c.elements.map(f) }
    case "Upgrade":
      return { ...c, ticket: f(c.ticket) }
    case "AllowanceIntent":
      return { ...c, allowance: f(c.allowance), clock: f(c.clock), ...(c.permit && { permit: f(c.permit) }) }
    default:
      return c
  }
}

const encodeU64 = /* @__PURE__ */ Bcs.encodeSync(Bcs.u64)
const encodeAddress = /* @__PURE__ */ Bcs.encodeSync(Bcs.Address)
const GAS = "gas"

const moveCall = (
  target: string,
  typeArguments: string | ReadonlyArray<string>,
  args: ReadonlyArray<T.Argument>
): T.Command => {
  const [pkg, module, fn] = target.split("::") as [string, string, string]
  return {
    _tag: "MoveCall",
    package: normalize(pkg),
    module,
    function: fn,
    typeArguments: (typeof typeArguments === "string" ? [typeArguments] : typeArguments).map(TypeTag.parse),
    arguments: args
  }
}

/** Where a command's results go after a rewrite: the same shape at a new position. */
const movedTo = (at: number) => (n: number | undefined): T.Argument =>
  n === undefined ? { _tag: "Result", value: at } : { _tag: "NestedResult", value: [at, n] }

/** A draft the intent rewrite can't map; thrown inside the rewrite and turned into `InvalidBalanceIntent`. */
class RewriteError {
  constructor(readonly reason: string) {}
}

/** An intent's single result, which is all a `Result` or `NestedResult(_, 0)` of it can mean. */
const singleResult = (index: number, r: T.Argument) => (n: number | undefined): T.Argument => {
  if (n === undefined || n === 0) return r
  throw new RewriteError(`a coin/balance intent has a single result; NestedResult(${index}, ${n}) is invalid`)
}

/** Map a result reference through the rewrite so far; a reference to a command not yet seen is invalid. */
const remapWith = (results: ReadonlyMap<number, (nested: number | undefined) => T.Argument>) => (a: T.Argument): T.Argument => {
  if (a._tag !== "Result" && a._tag !== "NestedResult") return a
  const index = a._tag === "Result" ? a.value : a.value[0]
  const to = results.get(index)
  if (to === undefined) throw new RewriteError(`command result ${index} is used before (or by) the command that makes it`)
  return to(a._tag === "Result" ? undefined : a.value[1])
}

/** Run a rewrite; its `RewriteError` becomes `InvalidBalanceIntent`. */
const rewrite = <A>(f: () => A): Effect.Effect<A, InvalidBalanceIntent> =>
  Effect.try({
    try: f,
    catch: (e) => {
      if (e instanceof RewriteError) return new InvalidBalanceIntent({ reason: e.reason })
      throw e
    }
  })

// -----------------------------------------------------------------------------
// allowances (coin / balance intents under an allowance)
// -----------------------------------------------------------------------------

const Window = /* @__PURE__ */ Bcs.enum({ PeriodicMs: Bcs.u64, CalendarMonths: Bcs.u8 })
const RateLimit = /* @__PURE__ */ Bcs.enum({
  Windowed: Bcs.struct({ limit: Bcs.u256, spent: Bcs.u256, anchorMs: Bcs.option(Bcs.u64), index: Bcs.u64, window: Window })
})

/** `0x2::allowance::Allowance<T>`: settings plus cumulative spend. */
const AllowanceObject = /* @__PURE__ */ Bcs.struct({
  id: Bcs.Address,
  settings: Bcs.struct({
    funder: Bcs.Address,
    spender: Bcs.option(Bcs.Address),
    /** `0x1::type_name::TypeName { name }`: the type without `0x`. */
    app: Bcs.option(Bcs.string),
    lifetimeCap: Bcs.option(Bcs.u256),
    startTimestampMs: Bcs.option(Bcs.u64),
    expirationTimestampMs: Bcs.option(Bcs.u64),
    rateLimit: Bcs.option(RateLimit),
    name: Bcs.string
  }),
  currentSpend: Bcs.u256
})
type AllowanceObject = typeof AllowanceObject.Type

const decodeAllowance = /* @__PURE__ */ Bcs.decode(AllowanceObject)
const decodeClock = /* @__PURE__ */ Bcs.decode(Bcs.struct({ id: Bcs.Address, timestampMs: Bcs.u64 }))

const normalizeType = (s: string) => {
  try {
    return TypeTag.normalizeString(s)
  } catch {
    return s
  }
}

const allowanceType = (coinType: string) => TypeTag.normalizeString(`0x2::allowance::Allowance<0x2::balance::Balance<${coinType}>>`)

/** What the current rate-limit window still allows, from the chain clock (never an under-estimate). */
const rateAvailable = (rate: Extract<AllowanceObject["settings"]["rateLimit"], { _tag: "Some" }>["value"], nowMs: bigint | undefined) => {
  let spent = 0n
  // A periodic window is current when `(now - anchor) / period` is still the charged index.
  // A calendar window may have rolled, so its spend is not counted.
  if (Option.isSome(rate.anchorMs) && rate.window._tag === "PeriodicMs" && nowMs !== undefined && rate.window.value > 0n) {
    const elapsed = nowMs - rate.anchorMs.value
    if (elapsed >= 0n && elapsed / rate.window.value === rate.index) spent = rate.spent
  }
  return rate.limit > spent ? rate.limit - spent : 0n
}

/**
 * Resolve allowance intents (`Ptb.coin({ allowance })` / `Ptb.balance({ allowance })`)
 * as `@mysten/sui`'s `AllowanceBalance` resolver does: each becomes a
 * `SenderAllowance` withdrawal from the funder, `allowance::balance_spend`
 * (or `app_balance_spend<T, A>` with the permit) and, for a coin,
 * `coin::from_balance`. The allowance input becomes a mutable shared object.
 *
 * Before that it reads each allowance (and, if its settings are time-bound or
 * windowed, the clock) and refuses what the chain would abort: the wrong type
 * or funder, a missing or wrong permit, a sender that isn't the spender, a
 * spend outside the start/expiration window, beyond the lifetime cap or the
 * current rate-limit window, or more than the funder's address balance holds.
 *
 * `Resolve.balances` runs this first; it's exported for hand-built pipelines.
 */
export const allowances = (
  plan: Plan
): Effect.Effect<Plan, AllowanceError | InsufficientBalance | InvalidBalanceIntent | RpcError, Objects | Coins> =>
  Effect.gen(function*() {
    const intents = plan.draft.commands.filter((c): c is AllowanceIntent => c._tag === "AllowanceIntent")
    if (intents.length === 0) return plan
    const objects = yield* Objects

    // Read every allowance once.
    const ids = [...new Set(intents.map((i) => i.allowanceId))]
    const read = yield* Effect.forEach(ids, (id) =>
      objects.get(id).pipe(
        Effect.catchTag("ObjectNotFound", () => Effect.fail(new AllowanceNotFound({ allowance: id }))),
        Effect.flatMap((object) => {
          if (object.owner._tag !== "Shared") {
            return Effect.fail(new InvalidAllowance({ allowance: id, reason: `not a shared object (owner: ${object.owner._tag})` }))
          }
          const shared = object.owner
          return Result.match(decodeAllowance(object.contents), {
            onFailure: (e) => Effect.fail(new InvalidAllowance({ allowance: id, reason: `${object.type} is not an Allowance: ${e.message}` })),
            onSuccess: (state) => Effect.succeed({ object, initialSharedVersion: shared.initialSharedVersion, state })
          })
        })
      ), { concurrency: "unbounded" })
    const byId = new Map(ids.map((id, k) => [id, read[k]!] as const))

    // Per intent: type, funder, app binding, spender.
    for (const i of intents) {
      const { object, state } = byId.get(i.allowanceId)!
      const s = state.settings
      const expected = allowanceType(i.coinType)
      if (normalizeType(object.type) !== expected) {
        return yield* new InvalidAllowance({ allowance: i.allowanceId, reason: `expected ${expected}, found ${object.type}` })
      }
      if (i.funder !== undefined && i.funder !== s.funder) {
        return yield* new InvalidAllowance({ allowance: i.allowanceId, reason: `funded by ${s.funder}, not ${i.funder}` })
      }
      const app = Option.isSome(s.app) ? normalizeType(s.app.value) : null
      const permitApp = i.permit !== undefined ? i.appType ?? null : null
      if (app !== permitApp) {
        return yield* new AllowanceAppMismatch({ allowance: i.allowanceId, allowanceApp: app, permitApp })
      }
      if (Option.isNone(s.spender) || s.spender.value !== plan.sender) {
        return yield* new AllowanceSpenderMismatch({
          allowance: i.allowanceId,
          spender: Option.isSome(s.spender) ? s.spender.value : null,
          sender: plan.sender
        })
      }
    }

    // Per allowance: time window, lifetime cap and rate limit against this transaction's total.
    const needsClock = read.some(({ state: { settings: s } }) =>
      Option.isSome(s.startTimestampMs) || Option.isSome(s.expirationTimestampMs) ||
      (Option.isSome(s.rateLimit) && Option.isSome(s.rateLimit.value.anchorMs))
    )
    const nowMs = needsClock
      ? yield* objects.get(normalize("0x6")).pipe(
        Effect.flatMap((o) =>
          Result.match(decodeClock(o.contents), {
            onFailure: () => Effect.succeed(undefined),
            onSuccess: (c) => Effect.succeed(c.timestampMs)
          })
        ),
        Effect.catchTag("ObjectNotFound", () => Effect.succeed(undefined))
      )
      : undefined
    for (const id of ids) {
      const { state } = byId.get(id)!
      const s = state.settings
      const mine = intents.filter((i) => i.allowanceId === id)
      const total = mine.reduce((sum, i) => sum + i.amount, 0n)
      const coinType = mine[0]!.coinType
      if (nowMs !== undefined && Option.isSome(s.startTimestampMs) && nowMs < s.startTimestampMs.value) {
        return yield* new AllowanceNotStarted({ allowance: id, startTimestampMs: s.startTimestampMs.value, nowMs })
      }
      if (nowMs !== undefined && Option.isSome(s.expirationTimestampMs) && nowMs >= s.expirationTimestampMs.value) {
        return yield* new AllowanceExpired({ allowance: id, expirationTimestampMs: s.expirationTimestampMs.value, nowMs })
      }
      if (Option.isSome(s.lifetimeCap)) {
        const available = s.lifetimeCap.value > state.currentSpend ? s.lifetimeCap.value - state.currentSpend : 0n
        if (total > available) return yield* new InsufficientAllowance({ allowance: id, coinType, limit: "lifetime", required: total, available })
      }
      if (Option.isSome(s.rateLimit)) {
        const available = rateAvailable(s.rateLimit.value, nowMs)
        if (total > available) return yield* new InsufficientAllowance({ allowance: id, coinType, limit: "rate", required: total, available })
      }
    }

    // Per funder and type: the funder's address balance, beyond what the transaction already withdraws.
    const owed = new Map<string, { funder: Address; coinType: string; total: bigint }>()
    for (const i of intents) {
      const funder = byId.get(i.allowanceId)!.state.settings.funder
      const key = `${funder}|${i.coinType}`
      const entry = owed.get(key) ?? { funder, coinType: i.coinType, total: 0n }
      owed.set(key, { ...entry, total: entry.total + i.amount })
    }
    const coinsService = yield* Coins
    yield* Effect.forEach(owed.values(), ({ funder, coinType, total }) =>
      Effect.flatMap(coinsService.getBalance(funder, coinType), (balance) => {
        const available = balance.addressBalance - reservedBy(plan, funder, coinType)
        return available < total
          ? Effect.fail(new InsufficientBalance({ owner: funder, coinType, required: total, available: available < 0n ? 0n : available }))
          : Effect.void
      }), { concurrency: "unbounded", discard: true })

    // Rewrite: allowance inputs become mutable shared objects; each intent its withdrawal and spend.
    const inputs: Array<Input> = [...plan.draft.inputs]
    for (const i of intents) {
      if (i.allowance._tag !== "Input") continue
      const { object, initialSharedVersion } = byId.get(i.allowanceId)!
      inputs[i.allowance.value] = {
        _tag: "Object",
        value: { _tag: "SharedObject", objectId: object.objectId, initialSharedVersion, mutability: { _tag: "Mutable" } }
      }
    }
    const out: Array<Command> = []
    const results = new Map<number, (nested: number | undefined) => T.Argument>()
    const remap = remapWith(results)
    yield* rewrite(() => {
    for (const [index, c] of plan.draft.commands.entries()) {
      if (c._tag !== "AllowanceIntent") {
        out.push(mapArguments(c, remap))
        results.set(index, movedTo(out.length - 1))
        continue
      }
      const funder = byId.get(c.allowanceId)!.state.settings.funder
      inputs.push({
        _tag: "FundsWithdrawal",
        reservation: { _tag: "MaxAmountU64", value: c.amount },
        typeArg: { _tag: "Balance", value: TypeTag.parse(c.coinType) },
        withdrawFrom: { _tag: "SenderAllowance", funder, allowance: c.allowanceId }
      })
      const withdrawal: T.Argument = { _tag: "Input", value: inputs.length - 1 }
      const allowance = remap(c.allowance)
      const clock = remap(c.clock)
      out.push(
        c.appType !== undefined && c.permit !== undefined
          ? moveCall("0x2::allowance::app_balance_spend", [c.coinType, c.appType], [allowance, remap(c.permit), withdrawal, clock])
          : moveCall("0x2::allowance::balance_spend", c.coinType, [allowance, withdrawal, clock])
      )
      if (c.output === "coin") out.push(moveCall("0x2::coin::from_balance", c.coinType, [{ _tag: "Result", value: out.length - 1 }]))
      results.set(index, singleResult(index, { _tag: "NestedResult", value: [out.length - 1, 0] }))
    }
    })
    return { ...plan, draft: { inputs, commands: out } }
  })

const senderWithdrawal = (amount: bigint, coinType: string): T.CallArg => ({
  _tag: "FundsWithdrawal",
  reservation: { _tag: "MaxAmountU64", value: amount },
  typeArg: { _tag: "Balance", value: TypeTag.parse(coinType) },
  withdrawFrom: { _tag: "Sender" }
})

interface TypePlan {
  /** Normalized coin type, `T`. */
  readonly coinType: string
  readonly intents: Array<BalanceIntent>
  total: bigint
  /** The sender's address balance of this type, minus existing withdrawals. */
  addressBalance: bigint
  coins: Array<T.ObjectRef>
  coinTotal: bigint
}

/**
 * Source every `Ptb.coin` / `Ptb.balance` intent, replacing each with real
 * commands (and remapping every later result reference), as `@mysten/sui`'s
 * `coinWithBalance` resolver does:
 *
 * - all intents of a type are `balance` and the address balance covers them:
 *   one `balance::redeem_funds` per intent, no coins touched;
 * - otherwise one source coin per type — `coin::redeem_funds` of the whole
 *   amount when the address balance covers it, else the gas coin (SUI with
 *   `useGasCoin`), else owned coins topped up from the address balance — then
 *   a single `SplitCoins` for all intents of that type, `coin::into_balance`
 *   for balance intents, and the remainder sent back to the sender's address
 *   balance (or a zero coin destroyed).
 *
 * Allowance intents (`Ptb.coin({ allowance })`) are resolved first, by
 * `Resolve.allowances`, as `@mysten/sui` resolves `AllowanceBalance` before
 * `CoinWithBalance`; the `Objects` requirement is only used for those.
 *
 * Run it after `Resolve.inputs` (so coins already used as inputs are skipped)
 * and before the gas steps.
 */
export const balances = (
  plan: Plan
): Effect.Effect<Plan, RpcError | InsufficientBalance | InvalidBalanceIntent | AllowanceError, Coins | Objects> =>
  Effect.flatMap(allowances(plan), coinIntents)

const coinIntents = (
  plan: Plan
): Effect.Effect<Plan, RpcError | InsufficientBalance | InvalidBalanceIntent, Coins> =>
  Effect.gen(function*() {
    if (!plan.draft.commands.some((c) => c._tag === "BalanceIntent")) return plan
    const coinsService = yield* Coins

    // Group non-zero intents by source key ("gas" = SUI that may use the gas coin).
    const types = new Map<string, TypePlan>()
    for (const c of plan.draft.commands) {
      if (c._tag !== "BalanceIntent" || c.amount === 0n) continue
      const key = c.coinType === TypeTag.SUI && c.useGasCoin ? GAS : c.coinType
      let t = types.get(key)
      if (!t) types.set(key, t = { coinType: c.coinType, intents: [], total: 0n, addressBalance: 0n, coins: [], coinTotal: 0n })
      t.intents.push(c)
      t.total += c.amount
    }
    if (types.has(GAS) && types.has(TypeTag.SUI)) {
      return yield* new InvalidBalanceIntent({
        reason: "SUI intents that may use the gas coin can't be mixed with ones that don't (useGasCoin: false)"
      })
    }

    // What the sender has, per type (all types at once).
    const used = new Set(plan.draft.inputs.flatMap((i) => (i._tag === "Object" ? [i.value.objectId] : [])))
    yield* Effect.forEach([...types], ([key, t]) =>
      Effect.gen(function*() {
        const balance = yield* balanceOf(plan, coinsService, plan.sender, t.coinType)
        const reserved = reservedBy(plan, plan.sender, t.coinType)
        const ab = balance.addressBalance - reserved
        if (ab < 0n) {
          return yield* new InsufficientBalance({ owner: plan.sender, coinType: t.coinType, required: reserved, available: balance.addressBalance })
        }
        t.addressBalance = ab
        // The gas coin holds the sender's coins and (through a reservation) its
        // address balance, so the gas path needs the same total as the others.
        if (balance.total - reserved < t.total) {
          return yield* new InsufficientBalance({ owner: plan.sender, coinType: t.coinType, required: t.total, available: balance.total - reserved })
        }
        if (key === GAS || ab >= t.total) return
        // Owned coins, topped up from the address balance.
        const needFromCoins = t.total - ab
        const picked = yield* coinsOf(plan, coinsService, plan.sender, t.coinType).pipe(
          Stream.filter((coin) => !used.has(coin.ref.objectId)),
          Stream.scan((): { total: bigint; refs: Array<T.ObjectRef> } => ({ total: 0n, refs: [] }), (acc, coin) => ({
            total: acc.total + coin.balance,
            refs: [...acc.refs, coin.ref]
          })),
          Stream.takeUntil((acc) => acc.total >= needFromCoins),
          Stream.runLast
        )
        const got = Option.getOrElse(picked, () => ({ total: 0n, refs: [] as Array<T.ObjectRef> }))
        if (got.total + ab < t.total) {
          return yield* new InsufficientBalance({ owner: plan.sender, coinType: t.coinType, required: t.total, available: got.total + ab })
        }
        t.coins = got.refs
        t.coinTotal = got.total
      }), { concurrency: "unbounded", discard: true })

    // Rewrite the command list.
    const inputs: Array<Input> = [...plan.draft.inputs]
    const addInput = (arg: T.CallArg): T.Argument => {
      inputs.push(arg)
      return { _tag: "Input", value: inputs.length - 1 }
    }
    const out: Array<Command> = []
    const results = new Map<number, (nested: number | undefined) => T.Argument>()
    const remap = remapWith(results)
    const pending = new Map<string, Array<T.Argument>>()

    yield* rewrite(() => {
    for (const [index, c] of plan.draft.commands.entries()) {
      if (c._tag !== "BalanceIntent") {
        const at = out.length
        out.push(mapArguments(c, remap))
        results.set(index, (n) => (n === undefined ? { _tag: "Result", value: at } : { _tag: "NestedResult", value: [at, n] }))
        continue
      }
      if (c.amount === 0n) {
        const at = out.length
        out.push(moveCall(c.output === "balance" ? "0x2::balance::zero" : "0x2::coin::zero", c.coinType, []))
        results.set(index, (n) => (n === undefined ? { _tag: "Result", value: at } : { _tag: "NestedResult", value: [at, n] }))
        continue
      }
      const key = c.coinType === TypeTag.SUI && c.useGasCoin ? GAS : c.coinType
      const t = types.get(key)!
      let result: T.Argument

      if (t.intents.every((i) => i.output === "balance") && t.addressBalance >= t.total) {
        out.push(moveCall("0x2::balance::redeem_funds", t.coinType, [addInput(senderWithdrawal(c.amount, t.coinType))]))
        result = { _tag: "NestedResult", value: [out.length - 1, 0] }
      } else {
        if (!pending.has(key)) {
          const sources: Array<T.Argument> = []
          let fromAddressBalance = false
          let exact = false
          if (t.addressBalance >= t.total) {
            fromAddressBalance = true
            out.push(moveCall("0x2::coin::redeem_funds", t.coinType, [addInput(senderWithdrawal(t.total, t.coinType))]))
            sources.push({ _tag: "Result", value: out.length - 1 })
          } else if (key === GAS) {
            sources.push({ _tag: "GasCoin" })
          } else {
            const topUp = t.total > t.coinTotal ? t.total - t.coinTotal : 0n
            exact = t.coinTotal + topUp === t.total
            for (const ref of t.coins) sources.push(addInput({ _tag: "Object", value: { _tag: "ImmOrOwnedObject", ...ref } }))
            if (topUp > 0n) {
              fromAddressBalance = true
              out.push(moveCall("0x2::coin::redeem_funds", t.coinType, [addInput(senderWithdrawal(topUp, t.coinType))]))
              sources.push({ _tag: "Result", value: out.length - 1 })
            }
          }
          const base = sources[0]!
          const rest = sources.slice(1)
          for (let i = 0; i < rest.length; i += 500) out.push({ _tag: "MergeCoins", destination: base, sources: rest.slice(i, i + 500) })

          const split = out.length
          out.push({ _tag: "SplitCoins", coin: base, amounts: t.intents.map((i) => addInput({ _tag: "Pure", bytes: encodeU64(i.amount) })) })
          const typeResults: Array<T.Argument> = []
          t.intents.forEach((i, n) => {
            const piece: T.Argument = { _tag: "NestedResult", value: [split, n] }
            if (i.output === "balance") {
              out.push(moveCall("0x2::coin::into_balance", t.coinType, [piece]))
              typeResults.push({ _tag: "NestedResult", value: [out.length - 1, 0] })
            } else {
              typeResults.push(piece)
            }
          })

          // The remainder: back to the sender's address balance, or a zero coin destroyed.
          // A split from the gas coin leaves its remainder in the gas coin.
          if (key !== GAS || fromAddressBalance) {
            if (t.intents.some((i) => i.output === "balance") || fromAddressBalance) {
              out.push(moveCall("0x2::coin::send_funds", t.coinType, [base, addInput({ _tag: "Pure", bytes: encodeAddress(plan.sender) })]))
            } else if (exact) {
              out.push(moveCall("0x2::coin::destroy_zero", t.coinType, [base]))
            }
          }
          pending.set(key, typeResults)
        }
        result = pending.get(key)!.shift()!
      }
      results.set(index, singleResult(index, result))
    }
    })

    return { ...plan, draft: { inputs, commands: out } }
  })

// -----------------------------------------------------------------------------
// gas
// -----------------------------------------------------------------------------

/** How many of the gas owner's SUI coins `prefetch` lists (one page of the gRPC listing). */
const PREFETCH_COINS = 100

/**
 * Everything the default pipeline reads whatever the transaction is, in one
 * round trip: the reference gas price (unless set), chain info (for the dry
 * run's `ValidDuring`, a coin reservation or an address-balance expiration)
 * and, unless `payment: false`, the gas owner's SUI balance and first page of
 * SUI coins. `Tx.resolve` runs it alongside `Resolve.inputs`; later steps use
 * what it read instead of asking again (as `@mysten/sui` does with one
 * `Promise.all`).
 */
export const prefetch = (
  plan: Plan,
  options?: { readonly payment?: boolean }
): Effect.Effect<Plan, RpcError, Chain | Coins> =>
  Effect.gen(function*() {
    const chain = Effect.service(Chain)
    const coins = Effect.service(Coins)
    const owner = plan.gasOwner ?? plan.sender
    const payment = options?.payment !== false && plan.gasPayment === undefined
    const [gasPrice, info, gasBalance, gasCoins] = yield* Effect.all([
      plan.gasPrice !== undefined ? Effect.succeed(plan.gasPrice) : Effect.flatMap(chain, (c) => c.referenceGasPrice),
      payment || (plan.gasBudget === undefined && plan.expiration === undefined)
        ? Effect.flatMap(chain, (c) => c.info)
        : Effect.succeed(undefined),
      payment ? Effect.flatMap(coins, (c) => c.getBalance(owner, TypeTag.SUI)) : Effect.succeed(undefined),
      payment
        ? Effect.flatMap(coins, (c) => Stream.runCollect(Stream.take(c.list(owner, TypeTag.SUI), PREFETCH_COINS)))
        : Effect.succeed(undefined)
    ], { concurrency: "unbounded" })
    return {
      ...plan,
      gasPrice,
      prefetched: {
        ...(info !== undefined && { chain: info }),
        owner,
        ...(gasBalance !== undefined && { gasBalance }),
        ...(gasCoins !== undefined && { gasCoins })
      }
    }
  })

/** `owner`'s balance of `coinType`: the prefetched SUI balance when the plan has it, else read. */
const balanceOf = (plan: Plan, coins: Coins["Service"], owner: Address, coinType: string): Effect.Effect<Balance, RpcError> => {
  const pre = plan.prefetched
  return coinType === TypeTag.SUI && pre?.owner === owner && pre.gasBalance !== undefined
    ? Effect.succeed(pre.gasBalance)
    : coins.getBalance(owner, coinType)
}

/** `owner`'s coins of `coinType`: the prefetched SUI coins when they are all of them, else listed. */
const coinsOf = (plan: Plan, coins: Coins["Service"], owner: Address, coinType: string): Stream.Stream<Coin, RpcError> => {
  const pre = plan.prefetched
  return coinType === TypeTag.SUI && pre?.owner === owner && pre.gasCoins !== undefined && pre.gasCoins.length < PREFETCH_COINS
    ? Stream.fromIterable(pre.gasCoins)
    : coins.list(owner, coinType)
}

const chainInfo = (plan: Plan): Effect.Effect<ChainInfo, RpcError, Chain> =>
  plan.prefetched?.chain !== undefined ? Effect.succeed(plan.prefetched.chain) : Effect.flatMap(Effect.service(Chain), (c) => c.info)

export const gasPrice = (plan: Plan): Effect.Effect<Plan, RpcError, Chain> =>
  plan.gasPrice !== undefined
    ? Effect.succeed(plan)
    : Effect.map(Effect.flatMap(Effect.service(Chain), (c) => c.referenceGasPrice), (gasPrice) => ({ ...plan, gasPrice }))

const validDuringFor = (info: ChainInfo): T.TransactionExpiration => ({
  _tag: "ValidDuring",
  minEpoch: Option.some(info.epoch),
  maxEpoch: Option.some(info.epoch + 1n),
  minTimestamp: Option.none(),
  maxTimestamp: Option.none(),
  chain: info.chainId,
  nonce: crypto.getRandomValues(new Uint32Array(1))[0]!
})

/** A `ValidDuring` expiration for this epoch and the next: the replay protection address-balance gas needs. */
export const validDuring = /* @__PURE__ */ Effect.fn("Resolve.validDuring")(function*() {
  return validDuringFor(yield* Effect.flatMap(Effect.service(Chain), (c) => c.info))
})

const MAX_BUDGET = 50_000_000_000n
const GAS_SAFE_OVERHEAD = 1000n

const programmable = (draft: Draft) =>
  Effect.suspend(() =>
    draft.commands.some((c) => c._tag === "BalanceIntent" || c._tag === "AllowanceIntent")
      ? Effect.fail(new Incomplete({ missing: "coin/balance intents (run Resolve.balances)" }))
      : draft.inputs.some((i) => i._tag === "UnresolvedObject")
      ? Effect.fail(new Incomplete({ missing: "object inputs (run Resolve.inputs)" }))
      : Effect.succeed<T.TransactionKind>({
        _tag: "ProgrammableTransaction",
        inputs: draft.inputs as ReadonlyArray<T.CallArg>,
        commands: draft.commands as ReadonlyArray<T.Command>
      })
  )

/** Commands may only use results of earlier commands. */
const checkReferences = (kind: T.TransactionKind): InvalidTransaction | undefined => {
  if (kind._tag !== "ProgrammableTransaction") return undefined
  for (const [i, c] of kind.commands.entries()) {
    for (const a of argumentsOf(c)) {
      const r = a._tag === "Result" ? a.value : a._tag === "NestedResult" ? a.value[0] : undefined
      if (r !== undefined && r >= i) return new InvalidTransaction({ reason: `command ${i} uses the result of command ${r}` })
      if (a._tag === "Input" && a.value >= kind.inputs.length) return new InvalidTransaction({ reason: `command ${i} uses input ${a.value}, which doesn't exist` })
    }
  }
  return undefined
}

/** BCS bytes of transaction data; data that can't be encoded (bad address, too many inputs) is `InvalidTransaction`. */
export const encode = (data: T.TransactionData): Effect.Effect<Uint8Array, InvalidTransaction> =>
  Effect.suspend(() => {
    const bad = checkReferences(data.kind)
    if (bad) return Effect.fail(bad)
    return Effect.try({
      try: () => T.encode(data),
      catch: (e) => new InvalidTransaction({ reason: e instanceof Error ? e.message : String(e) })
    })
  })

/** A failure status's fields, for the errors that report one. */
export const failureFields = (status: Extract<Status, { _tag: "Failure" }>) => ({
  description: status.description,
  ...(status.command !== undefined && { command: status.command }),
  ...(status.abortCode !== undefined && { abortCode: status.abortCode }),
  ...(status.location !== undefined && {
    location: `${status.location.package}::${status.location.module}${status.location.function !== undefined ? `::${status.location.function}` : ""}`
  })
})

/**
 * Estimate the budget with a dry run: maximum budget, empty payment and a
 * `ValidDuring` expiration, so the node mocks the gas coin and the estimate
 * does not depend on which coins pay.
 */
export const budget = (
  plan: Plan
): Effect.Effect<Plan, RpcError | GasEstimationFailed | Incomplete | InvalidTransaction, Transactions | Chain> =>
  plan.gasBudget !== undefined
    ? Effect.succeed(plan)
    : Effect.gen(function*() {
      const price = plan.gasPrice ?? (yield* Effect.flatMap(Effect.service(Chain), (c) => c.referenceGasPrice))
      const kind = yield* programmable(plan.draft)
      const dryRun = yield* encode({
        _tag: "V1",
        kind,
        sender: plan.sender,
        gasData: { payment: [], owner: plan.gasOwner ?? plan.sender, price, budget: MAX_BUDGET },
        expiration: plan.expiration ?? validDuringFor(yield* chainInfo(plan))
      })
      const sim = yield* Effect.flatMap(Effect.service(Transactions), (t) => t.simulate(dryRun))
      if (sim.effects.status._tag === "Failure") return yield* new GasEstimationFailed(failureFields(sim.effects.status))
      const g = sim.effects.gasUsed
      const base = g.computationCost + GAS_SAFE_OVERHEAD * price
      const total = base + g.storageCost - g.storageRebate
      return { ...plan, gasPrice: price, gasBudget: total > base ? total : base }
    })

/** How gas is paid. A strategy is just a step. */
export type PaymentStrategy<E = never, R = never> = (plan: Plan) => Effect.Effect<Plan, E, R>

/** The errors and requirements of the built-in strategies (`auto`, `addressBalance`, `coins`). */
export type DefaultPaymentError = RpcError | InsufficientGas | Incomplete
export type DefaultPaymentServices = Chain | Coins

/** Does any command take the gas coin as an argument? */
export const usesGasCoin = (draft: Draft): boolean =>
  draft.commands.some((c) => argumentsOf(c).some((a) => a._tag === "GasCoin"))

const decodeU64 = (bytes: Uint8Array): bigint | undefined =>
  bytes.length === 8 ? new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true) : undefined

/**
 * What commands split off the gas coin, as far as the draft says: the pure
 * amounts of every `SplitCoins(GasCoin, ...)`. Other uses (a Move call taking
 * the gas coin, an amount computed on chain) can't be known before execution.
 */
export const gasCoinSpend = (draft: Draft): bigint => {
  let total = 0n
  for (const c of draft.commands) {
    if (c._tag !== "SplitCoins" || c.coin._tag !== "GasCoin") continue
    for (const a of c.amounts) {
      const input = a._tag === "Input" ? draft.inputs[a.value] : undefined
      if (input?._tag === "Pure") total += decodeU64(input.bytes) ?? 0n
    }
  }
  return total
}

/** Who a withdrawal input draws from. */
const withdrawalOwner = (w: T.FundsWithdrawal, plan: Plan): Address =>
  w.withdrawFrom._tag === "SenderAllowance"
    ? w.withdrawFrom.funder
    : w.withdrawFrom._tag === "Sender"
    ? plan.sender
    : plan.gasOwner ?? plan.sender

/** The `coinType` amounts that the transaction's withdrawal inputs reserve from `owner`'s address balance. */
export const reservedBy = (plan: Plan, owner: Address, coinType: string): bigint => {
  let total = 0n
  for (const input of plan.draft.inputs) {
    if (input._tag !== "FundsWithdrawal") continue
    if (withdrawalOwner(input, plan) !== owner) continue
    if (TypeTag.format(input.typeArg.value) !== coinType) continue
    total += input.reservation.value
  }
  return total
}

/**
 * Address-balance gas needs replay protection: a `ValidDuring` window is set
 * when the caller gave no expiration. An explicit one is kept as given, as
 * `@mysten/sui` does (validators refuse `None`/`Epoch` with an empty payment,
 * which is a visible failure rather than a silently widened validity).
 */
const keepExpiration = (plan: Plan) =>
  plan.expiration !== undefined ? Effect.succeed(plan.expiration) : Effect.map(chainInfo(plan), validDuringFor)

const needBudget = (plan: Plan) =>
  plan.gasBudget === undefined
    ? Effect.fail(new Incomplete({ missing: "gas budget (run Resolve.budget first)" }))
    : Effect.succeed(plan.gasBudget)

/** A reservation ref for whatever the owner's SUI address balance holds beyond the transaction's own withdrawals. */
const reservation = (plan: Plan, owner: Address, available: bigint) =>
  Effect.map(chainInfo(plan), (info) => CoinReservation.make({ reserved: available, owner, chainId: info.chainId, epoch: info.epoch }))

const gasBalance = (plan: Plan, owner: Address) =>
  Effect.flatMap(Effect.service(Coins), (c) => balanceOf(plan, c, owner, TypeTag.SUI))

/**
 * Pay entirely from the gas owner's SUI address balance, or fail with
 * `InsufficientGas` before anything is signed. No coin is touched: the payment
 * is empty with a `ValidDuring` expiration, or, when the transaction uses the
 * gas coin, a single coin reservation that funds it from the balance (which
 * must then also cover what commands split off the gas coin).
 */
export const addressBalance: PaymentStrategy<DefaultPaymentError, DefaultPaymentServices> = (plan) =>
  Effect.gen(function*() {
    if (plan.gasPayment !== undefined) return plan
    const budget = yield* needBudget(plan)
    const owner = plan.gasOwner ?? plan.sender
    const balance = yield* gasBalance(plan, owner)
    const available = balance.addressBalance - reservedBy(plan, owner, TypeTag.SUI)
    const gasCoin = usesGasCoin(plan.draft)
    const required = budget + (gasCoin ? gasCoinSpend(plan.draft) : 0n)
    if (available < required) return yield* new InsufficientGas({ owner, required, available: available < 0n ? 0n : available })
    if (gasCoin) return { ...plan, gasPayment: [yield* reservation(plan, owner, available)] }
    return { ...plan, gasPayment: [], expiration: yield* keepExpiration(plan) }
  })

/** SUI coins of `owner` not already used as inputs, in listing order, until they reach `target` or `limit` coins (`target` undefined: all of them, up to `limit`). */
const pickCoins = (plan: Plan, owner: Address, target: bigint | undefined, limit: number) =>
  Effect.gen(function*() {
    const used = new Set(plan.draft.inputs.flatMap((i) => (i._tag === "Object" ? [i.value.objectId] : [])))
    const picked = yield* Effect.flatMap(Effect.service(Coins), (c) =>
      coinsOf(plan, c, owner, TypeTag.SUI).pipe(
        Stream.filter((coin) => !used.has(coin.ref.objectId)),
        Stream.scan((): { total: bigint; refs: Array<T.ObjectRef> } => ({ total: 0n, refs: [] }), (acc, coin) => ({
          total: acc.total + coin.balance,
          refs: [...acc.refs, coin.ref]
        })),
        Stream.takeUntil((acc) => (target !== undefined && acc.total >= target) || acc.refs.length >= limit),
        Stream.runLast
      ))
    return Option.getOrElse(picked, () => ({ total: 0n, refs: [] as Array<T.ObjectRef> }))
  })

/**
 * Payment when commands spend from the gas coin: every SUI coin of the owner
 * not used as an input (up to the 256-object limit, one taken by a reservation
 * of the address balance when it holds any), as `@mysten/sui` does, so the gas
 * coin holds everything the owner has. Fails with `InsufficientGas` when that
 * is less than the budget plus the amounts split off the gas coin.
 */
const payWithGasCoin = (plan: Plan, owner: Address, budget: bigint, available: bigint) =>
  Effect.gen(function*() {
    const fromBalance = available > 0n ? available : 0n
    const limit = fromBalance > 0n ? MAX_GAS_OBJECTS - 1 : MAX_GAS_OBJECTS
    const required = budget + gasCoinSpend(plan.draft)
    // The prefetched first page, when it already covers what the gas coin must
    // hold (as `@mysten/sui` uses its first page); otherwise every coin, listed.
    const used = new Set(plan.draft.inputs.flatMap((i) => (i._tag === "Object" ? [i.value.objectId] : [])))
    const page = plan.prefetched?.owner === owner ? plan.prefetched.gasCoins?.filter((c) => !used.has(c.ref.objectId)).slice(0, limit) : undefined
    const pageTotal = page?.reduce((s, c) => s + c.balance, 0n) ?? 0n
    const coins = page !== undefined && page.length > 0 && pageTotal + fromBalance >= required
      ? { total: pageTotal, refs: page.map((c) => c.ref) }
      : yield* pickCoins(plan, owner, undefined, limit)
    const total = coins.total + fromBalance
    if (total < required || (fromBalance === 0n && coins.refs.length === 0)) {
      return yield* new InsufficientGas({ owner, required, available: total })
    }
    const refs = fromBalance > 0n ? [yield* reservation(plan, owner, fromBalance), ...coins.refs] : coins.refs
    return { ...plan, gasPayment: refs }
  })

const MAX_GAS_OBJECTS = 256

/**
 * The recommended default, matching `@mysten/sui`: pay from the address
 * balance when it covers the budget (plus the transaction's own SUI
 * withdrawals) and the gas coin isn't used. When commands use the gas coin,
 * pay with every SUI coin, plus a coin reservation of the address balance, so
 * the gas coin can cover what they spend. Otherwise pay with SUI coins up to
 * the budget. Fails with `InsufficientGas` when none of that covers it.
 */
export const auto: PaymentStrategy<DefaultPaymentError, DefaultPaymentServices> = (plan) =>
  Effect.gen(function*() {
    if (plan.gasPayment !== undefined) return plan
    const budget = yield* needBudget(plan)
    const owner = plan.gasOwner ?? plan.sender
    const gasCoin = usesGasCoin(plan.draft)
    const balance = yield* gasBalance(plan, owner)
    const available = balance.addressBalance - reservedBy(plan, owner, TypeTag.SUI)

    if (budget === 0n || (!gasCoin && available >= budget)) {
      return { ...plan, gasPayment: [], expiration: yield* keepExpiration(plan) }
    }
    if (gasCoin) return yield* payWithGasCoin(plan, owner, budget, available)
    const coins = yield* pickCoins(plan, owner, budget, MAX_GAS_OBJECTS)
    if (coins.total < budget) {
      return yield* new InsufficientGas({ owner, required: budget, available: coins.total + (available > 0n ? available : 0n) })
    }
    return { ...plan, gasPayment: coins.refs }
  })

/**
 * An empty payment with a `ValidDuring` expiration and no balance check: for
 * simulation (`checks: false`) and for bytes whose payer will be funded
 * before they're submitted. Executing it without a funded address balance
 * fails at the node.
 */
export const unchecked: PaymentStrategy<RpcError, Chain> = (plan) =>
  plan.gasPayment !== undefined
    ? Effect.succeed(plan)
    : Effect.map(keepExpiration(plan), (expiration) => ({ ...plan, gasPayment: [], expiration }))

/** Pay with exactly these coins. */
export const fixed = (payment: ReadonlyArray<T.ObjectRef>): PaymentStrategy => (plan) =>
  Effect.succeed({ ...plan, gasPayment: payment })

/**
 * Pay with SUI coins owned by the gas owner (at most 256): until they cover the
 * budget, or, when commands use the gas coin, all of them (which must cover the
 * budget plus what is split off the gas coin).
 */
export const coins: PaymentStrategy<RpcError | InsufficientGas | Incomplete, Coins> = (plan) =>
  Effect.gen(function*() {
    if (plan.gasPayment !== undefined) return plan
    if (plan.gasBudget === undefined) return yield* new Incomplete({ missing: "gas budget (run Resolve.budget first)" })
    const owner = plan.gasOwner ?? plan.sender
    const budget = plan.gasBudget
    const gasCoin = usesGasCoin(plan.draft)
    const required = budget + (gasCoin ? gasCoinSpend(plan.draft) : 0n)
    const best = yield* pickCoins(plan, owner, gasCoin ? undefined : budget, MAX_GAS_OBJECTS)
    if (best.total < required || (gasCoin && best.refs.length === 0)) return yield* new InsufficientGas({ owner, required, available: best.total })
    return { ...plan, gasPayment: best.refs }
  })

// -----------------------------------------------------------------------------
// finish
// -----------------------------------------------------------------------------

/** The final `TransactionData`; fails with `InvalidTransaction` if it can't be encoded as it stands. */
export const finish = (plan: Plan): Effect.Effect<T.TransactionData, Incomplete | InvalidTransaction> =>
  Effect.gen(function*() {
    const kind = yield* programmable(plan.draft)
    if (plan.gasPrice === undefined) return yield* new Incomplete({ missing: "gas price" })
    if (plan.gasBudget === undefined) return yield* new Incomplete({ missing: "gas budget" })
    if (plan.gasPayment === undefined) return yield* new Incomplete({ missing: "gas payment" })
    const data: T.TransactionData = {
      _tag: "V1",
      kind,
      sender: plan.sender,
      gasData: {
        payment: plan.gasPayment,
        owner: plan.gasOwner ?? plan.sender,
        price: plan.gasPrice,
        budget: plan.gasBudget
      },
      expiration: plan.expiration ?? { _tag: "None" }
    }
    yield* encode(data)
    return data
  })
