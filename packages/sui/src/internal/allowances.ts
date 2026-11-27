/**
 * Allowance resolution (`Ptb.coin({ allowance })` / `Ptb.balance({ allowance })`).
 *
 * Internal: an `AllowanceIntent` carries this resolver (`Ptb.ts`,
 * `TransactionJson.ts`), and `Resolve.allowances` / `Resolve.balances` call it
 * through the intent, so a program that never makes an allowance intent does
 * not ship it (the `Allowance` BCS layout, the checks, the clock read).
 *
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { type Address, normalize } from "../Address.ts"
import { Coins } from "../Coins.ts"
import { Objects } from "../Objects.ts"
import type { AllowanceIntent, Command, Input } from "../Ptb.ts"
import {
  type AllowanceError,
  AllowanceAppMismatch,
  AllowanceExpired,
  AllowanceNotFound,
  AllowanceNotStarted,
  AllowanceSpenderMismatch,
  InsufficientAllowance,
  InsufficientBalance,
  InvalidAllowance,
  type InvalidBalanceIntent,
  mapArguments,
  moveCall,
  movedTo,
  type Plan,
  remapWith,
  reservedBy,
  rewrite,
  singleResult
} from "../Resolve.ts"
import type { RpcError } from "../RpcError.ts"
import type * as T from "../TransactionData.ts"
import * as TypeTag from "../TypeTag.ts"

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

/** The resolver every `AllowanceIntent` carries; see `Resolve.allowances`. */
export const resolve = (
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
