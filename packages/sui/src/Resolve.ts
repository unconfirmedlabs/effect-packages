/**
 * Turning a `Draft` into `TransactionData`, as a pipeline of small steps.
 *
 * Each step is `Plan -> Effect<Plan, E, R>`: it fills in one thing and states
 * exactly which capability it needs. `Tx.resolve` runs the default pipeline;
 * anything else (a sponsor setting gas, a custom coin picker, a policy check
 * that rejects some Move calls) is one more step in the `pipe`.
 *
 *   inputs    Objects | Packages   object refs, shared mutability, Receiving
 *   balances  Coins                `Ptb.coin` / `Ptb.balance` from address balance or coins
 *   gasPrice  Chain                reference gas price
 *   budget    Transactions | Chain dry run with a placeholder payment
 *   payment   (strategy)           `auto` (default): address balance, else coins;
 *                                  or `addressBalance`, `coins`, `fixed(refs)`
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { type Address, normalize } from "./Address.ts"
import { Chain } from "./Chain.ts"
import { Coins } from "./Coins.ts"
import type { ObjectNotFound } from "./Objects.ts"
import { Objects, type SuiObject } from "./Objects.ts"
import type { MoveFunction } from "./Packages.ts"
import { Packages } from "./Packages.ts"
import * as CoinReservation from "./CoinReservation.ts"
import type { BalanceIntent, Command, Draft, Input } from "./Ptb.ts"
import type { RpcError } from "./RpcError.ts"
import * as T from "./TransactionData.ts"
import { Transactions } from "./Transactions.ts"
import * as TypeTag from "./TypeTag.ts"

export interface Plan {
  readonly sender: Address
  readonly draft: Draft
  readonly gasOwner?: Address
  readonly gasPrice?: bigint
  readonly gasBudget?: bigint
  readonly gasPayment?: ReadonlyArray<T.ObjectRef>
  readonly expiration?: T.TransactionExpiration
}

export class Incomplete extends Schema.TaggedError<Incomplete>()("Incomplete", {
  missing: Schema.String
}) {}

export class GasEstimationFailed extends Schema.TaggedError<GasEstimationFailed>()("GasEstimationFailed", {
  description: Schema.String
}) {}

export class InsufficientGas extends Schema.TaggedError<InsufficientGas>()("InsufficientGas", {
  owner: Schema.String,
  required: Schema.BigInt,
  available: Schema.BigInt
}) {}

export class InsufficientBalance extends Schema.TaggedError<InsufficientBalance>()("InsufficientBalance", {
  owner: Schema.String,
  coinType: Schema.String,
  required: Schema.BigInt,
  available: Schema.BigInt
}) {}

export class InvalidBalanceIntent extends Schema.TaggedError<InvalidBalanceIntent>()("InvalidBalanceIntent", {
  reason: Schema.String
}) {}

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
      default:
        return
    }
  })
  return out
}

const objectArg = (o: SuiObject, usage: Usage | undefined, forced: boolean | undefined): T.ObjectArg => {
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

/**
 * Resolve object inputs. All lookups run at once; the `Objects` and
 * `Packages` implementations batch and cache them.
 */
export const inputs = (plan: Plan): Effect.Effect<Plan, ObjectNotFound | RpcError, Objects | Packages> =>
  Effect.gen(function*() {
    const unresolved = plan.draft.inputs.flatMap((input, index) =>
      input._tag === "UnresolvedObject" ? [{ input, index }] : []
    )
    if (unresolved.length === 0) return plan
    const objects = yield* Objects
    const packages = yield* Packages
    const calls = plan.draft.commands.flatMap((c, index) => (c._tag === "MoveCall" ? [{ c, index }] : []))
    const [resolved, functions] = yield* Effect.all([
      Effect.forEach(unresolved, ({ input }) => objects.get(input.objectId), { concurrency: "unbounded" }),
      Effect.forEach(
        calls,
        ({ c, index }) => Effect.map(packages.getFunction(c), (f) => [index, f] as const),
        { concurrency: "unbounded" }
      )
    ], { concurrency: "unbounded" })
    const use = usages(plan.draft, new Map(functions))
    const next = [...plan.draft.inputs]
    unresolved.forEach(({ input, index }, i) => {
      next[index] = { _tag: "Object", value: objectArg(resolved[i]!, use.get(index), input.mutable) }
    })
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
    default:
      return []
  }
}

const mapArguments = (c: T.Command, f: (a: T.Argument) => T.Argument): T.Command => {
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
    default:
      return c
  }
}

const encodeU64 = Bcs.encodeSync(Bcs.u64)
const encodeAddress = Bcs.encodeSync(Bcs.Address)
const GAS = "gas"

const moveCall = (target: string, typeArgument: string, args: ReadonlyArray<T.Argument>): T.Command => {
  const [pkg, module, fn] = target.split("::") as [string, string, string]
  return {
    _tag: "MoveCall",
    package: normalize(pkg),
    module,
    function: fn,
    typeArguments: [TypeTag.parse(typeArgument)],
    arguments: args
  }
}

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
 * Run it after `Resolve.inputs` (so coins already used as inputs are skipped)
 * and before the gas steps.
 */
export const balances = (
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
        const balance = yield* coinsService.getBalance(plan.sender, t.coinType)
        const reserved = reservedBy(plan, plan.sender, t.coinType)
        const ab = balance.addressBalance - reserved
        if (ab < 0n) {
          return yield* new InsufficientBalance({ owner: plan.sender, coinType: t.coinType, required: reserved, available: balance.addressBalance })
        }
        t.addressBalance = ab
        if (key === GAS || ab >= t.total) return
        if (balance.total - reserved < t.total) {
          return yield* new InsufficientBalance({ owner: plan.sender, coinType: t.coinType, required: t.total, available: balance.total - reserved })
        }
        // Owned coins, topped up from the address balance.
        const needFromCoins = t.total - ab
        const picked = yield* coinsService.list(plan.sender, t.coinType).pipe(
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
    const remap = (a: T.Argument): T.Argument => {
      if (a._tag === "Result") return results.get(a.value)!(undefined)
      if (a._tag === "NestedResult") return results.get(a.value[0])!(a.value[1])
      return a
    }
    const pending = new Map<string, Array<T.Argument>>()

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
      const r = result
      results.set(index, (n) => {
        if (n === undefined || n === 0) return r
        throw new Error(`a coin/balance intent has a single result; NestedResult(${index}, ${n}) is invalid`)
      })
    }

    return { ...plan, draft: { inputs, commands: out } }
  })

// -----------------------------------------------------------------------------
// gas
// -----------------------------------------------------------------------------

export const gasPrice = (plan: Plan): Effect.Effect<Plan, RpcError, Chain> =>
  plan.gasPrice !== undefined
    ? Effect.succeed(plan)
    : Effect.map(Effect.flatMap(Effect.service(Chain), (c) => c.referenceGasPrice), (gasPrice) => ({ ...plan, gasPrice }))

/** A `ValidDuring` expiration for this epoch and the next: the replay protection address-balance gas needs. */
export const validDuring = Effect.fn("Resolve.validDuring")(function*() {
  const info = yield* Effect.flatMap(Effect.service(Chain), (c) => c.info)
  return {
    _tag: "ValidDuring",
    minEpoch: Option.some(info.epoch),
    maxEpoch: Option.some(info.epoch + 1n),
    minTimestamp: Option.none(),
    maxTimestamp: Option.none(),
    chain: info.chainId,
    nonce: crypto.getRandomValues(new Uint32Array(1))[0]!
  } satisfies T.TransactionExpiration
})

const MAX_BUDGET = 50_000_000_000n
const GAS_SAFE_OVERHEAD = 1000n

const programmable = (draft: Draft) =>
  Effect.suspend(() =>
    draft.inputs.some((i) => i._tag === "UnresolvedObject")
      ? Effect.fail(new Incomplete({ missing: "object inputs (run Resolve.inputs)" }))
      : draft.commands.some((c) => c._tag === "BalanceIntent")
      ? Effect.fail(new Incomplete({ missing: "coin/balance intents (run Resolve.balances)" }))
      : Effect.succeed<T.TransactionKind>({
        _tag: "ProgrammableTransaction",
        inputs: draft.inputs as ReadonlyArray<T.CallArg>,
        commands: draft.commands as ReadonlyArray<T.Command>
      })
  )

/**
 * Estimate the budget with a dry run: maximum budget, empty payment and a
 * `ValidDuring` expiration, so the node mocks the gas coin and the estimate
 * does not depend on which coins pay.
 */
export const budget = (
  plan: Plan
): Effect.Effect<Plan, RpcError | GasEstimationFailed | Incomplete, Transactions | Chain> =>
  plan.gasBudget !== undefined
    ? Effect.succeed(plan)
    : Effect.gen(function*() {
      const price = plan.gasPrice ?? (yield* Effect.flatMap(Effect.service(Chain), (c) => c.referenceGasPrice))
      const kind = yield* programmable(plan.draft)
      const dryRun = T.encode({
        _tag: "V1",
        kind,
        sender: plan.sender,
        gasData: { payment: [], owner: plan.gasOwner ?? plan.sender, price, budget: MAX_BUDGET },
        expiration: plan.expiration ?? (yield* validDuring())
      })
      const sim = yield* Effect.flatMap(Effect.service(Transactions), (t) => t.simulate(dryRun))
      if (sim.effects.status._tag === "Failure") {
        return yield* new GasEstimationFailed({ description: sim.effects.status.description })
      }
      const g = sim.effects.gasUsed
      const base = g.computationCost + GAS_SAFE_OVERHEAD * price
      const total = base + g.storageCost - g.storageRebate
      return { ...plan, gasPrice: price, gasBudget: total > base ? total : base }
    })

/** How gas is paid. A strategy is just a step. */
export type PaymentStrategy<E = never, R = never> = (plan: Plan) => Effect.Effect<Plan, E, R>

/** Does any command take the gas coin as an argument? */
export const usesGasCoin = (draft: Draft): boolean =>
  draft.commands.some((c) => argumentsOf(c).some((a) => a._tag === "GasCoin"))

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

const keepExpiration = (plan: Plan) =>
  plan.expiration?._tag === "ValidDuring" || plan.expiration?._tag === "Validity"
    ? Effect.succeed(plan.expiration)
    : validDuring()

const needBudget = (plan: Plan) =>
  plan.gasBudget === undefined
    ? Effect.fail(new Incomplete({ missing: "gas budget (run Resolve.budget first)" }))
    : Effect.succeed(plan.gasBudget)

/** A reservation ref for whatever the owner's SUI address balance holds beyond the transaction's own withdrawals. */
const reservation = (owner: Address, available: bigint) =>
  Effect.map(Effect.flatMap(Effect.service(Chain), (c) => c.info), (info) =>
    CoinReservation.make({ reserved: available, owner, chainId: info.chainId, epoch: info.epoch }))

/**
 * Pay entirely from the gas owner's SUI address balance, or fail with
 * `InsufficientGas` before anything is signed. No coin is touched: the payment
 * is empty with a `ValidDuring` expiration, or, when the transaction uses the
 * gas coin, a single coin reservation that funds it from the balance.
 */
export const addressBalance: PaymentStrategy<RpcError | InsufficientGas | Incomplete, Chain | Coins> = (plan) =>
  Effect.gen(function*() {
    if (plan.gasPayment !== undefined) return plan
    const budget = yield* needBudget(plan)
    const owner = plan.gasOwner ?? plan.sender
    const balance = yield* Effect.flatMap(Effect.service(Coins), (c) => c.getBalance(owner, TypeTag.SUI))
    const available = balance.addressBalance - reservedBy(plan, owner, TypeTag.SUI)
    if (available < budget) return yield* new InsufficientGas({ owner, required: budget, available: available < 0n ? 0n : available })
    if (usesGasCoin(plan.draft)) return { ...plan, gasPayment: [yield* reservation(owner, available)] }
    return { ...plan, gasPayment: [], expiration: yield* keepExpiration(plan) }
  })

const pickCoins = (plan: Plan, owner: Address, target: bigint, limit: number) =>
  Effect.gen(function*() {
    const used = new Set(plan.draft.inputs.flatMap((i) => (i._tag === "Object" ? [i.value.objectId] : [])))
    const picked = yield* Effect.flatMap(Effect.service(Coins), (c) =>
      c.list(owner).pipe(
        Stream.filter((coin) => !used.has(coin.ref.objectId)),
        Stream.scan((): { total: bigint; refs: Array<T.ObjectRef> } => ({ total: 0n, refs: [] }), (acc, coin) => ({
          total: acc.total + coin.balance,
          refs: [...acc.refs, coin.ref]
        })),
        Stream.takeUntil((acc) => acc.total >= target || acc.refs.length >= limit),
        Stream.runLast
      ))
    return Option.getOrElse(picked, () => ({ total: 0n, refs: [] as Array<T.ObjectRef> }))
  })

/**
 * The recommended default, matching `@mysten/sui`: pay from the address
 * balance when it covers the budget (plus the transaction's own SUI
 * withdrawals) and the gas coin isn't used; otherwise pay with SUI coins,
 * and when the gas coin is used let a coin reservation add whatever the
 * address balance holds. Fails with `InsufficientGas` when neither covers it.
 */
export const auto: PaymentStrategy<RpcError | InsufficientGas | Incomplete, Chain | Coins> = (plan) =>
  Effect.gen(function*() {
    if (plan.gasPayment !== undefined) return plan
    const budget = yield* needBudget(plan)
    const owner = plan.gasOwner ?? plan.sender
    const gasCoin = usesGasCoin(plan.draft)
    const balance = yield* Effect.flatMap(Effect.service(Coins), (c) => c.getBalance(owner, TypeTag.SUI))
    const withdrawals = reservedBy(plan, owner, TypeTag.SUI)
    const available = balance.addressBalance - withdrawals

    if (budget === 0n || (!gasCoin && available >= budget)) {
      return { ...plan, gasPayment: [], expiration: yield* keepExpiration(plan) }
    }
    if (gasCoin && available > 0n) {
      const coins = yield* pickCoins(plan, owner, budget > available ? budget - available : 0n, 255)
      if (coins.total + available < budget) {
        return yield* new InsufficientGas({ owner, required: budget, available: coins.total + available })
      }
      return { ...plan, gasPayment: [yield* reservation(owner, available), ...coins.refs] }
    }
    const coins = yield* pickCoins(plan, owner, budget, 256)
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

/** Select SUI coins owned by the gas owner until they cover the budget (at most 256). */
export const coins: PaymentStrategy<RpcError | InsufficientGas | Incomplete, Coins> = (plan) =>
  Effect.gen(function*() {
    if (plan.gasPayment !== undefined) return plan
    if (plan.gasBudget === undefined) return yield* new Incomplete({ missing: "gas budget (run Resolve.budget first)" })
    const owner = plan.gasOwner ?? plan.sender
    const budget = plan.gasBudget
    const best = yield* pickCoins(plan, owner, budget, 256)
    if (best.total < budget) return yield* new InsufficientGas({ owner, required: budget, available: best.total })
    return { ...plan, gasPayment: best.refs }
  })

// -----------------------------------------------------------------------------
// finish
// -----------------------------------------------------------------------------

export const finish = (plan: Plan): Effect.Effect<T.TransactionData, Incomplete> =>
  Effect.gen(function*() {
    const kind = yield* programmable(plan.draft)
    if (plan.gasPrice === undefined) return yield* new Incomplete({ missing: "gas price" })
    if (plan.gasBudget === undefined) return yield* new Incomplete({ missing: "gas budget" })
    if (plan.gasPayment === undefined) return yield* new Incomplete({ missing: "gas payment" })
    return {
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
    } satisfies T.TransactionData
  })
