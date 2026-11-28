/**
 * The crash-safe transaction lifecycle on top of the core capability services.
 *
 *   const effects = yield* Lifecycle.run(recipe, { signer })
 *
 * `run` = core `Tx.build` -> sign -> journal -> `submit`. Each step is also
 * exported for flows that stop in between.
 *
 * Rules (ported from `@unconfirmed/sui-effect`):
 * - **Submit never rebuilds.** The `Signed` journal entry is written before the
 *   first execute; a retryable transport failure or timeout re-sends the
 *   identical bytes (one digest: they land at most once); when retries run out
 *   `reconcile` decides. Once bytes may have been sent, no transport error
 *   escapes: the answer is `Executed`, `ExecutionFailed`, `NotApplied` or
 *   `SubmissionUnknown` (which carries the bytes).
 * - **Objects, never history listings, are evidence.** `NotApplied` needs proof:
 *   `inputConsumed` (another transaction's own effects consumed exactly a
 *   version these bytes pinned) or `expired` (window closed, then a miss, then
 *   after `reconcileRecheck` both again, on a node whose history covers the
 *   window). Positive evidence (a pinned object last mutated by *this* digest)
 *   vetoes `expired`.
 * - **The journal never changes an answer.** `JournalError` only escapes from
 *   the `Signed` write, before anything was sent; later write failures are
 *   logged and the outcome stands.
 */
import type { Address } from "@unconfirmed/sui/Address"
import { Chain } from "@unconfirmed/sui/Chain"
import { Objects } from "@unconfirmed/sui/Objects"
import * as Resolve from "@unconfirmed/sui/Resolve"
import { RpcError } from "@unconfirmed/sui/RpcError"
import * as Signer from "@unconfirmed/sui/Signer"
import * as T from "@unconfirmed/sui/TransactionData"
import { type Effects, type Include, type IncludeOptions, Transactions } from "@unconfirmed/sui/Transactions"
import * as Tx from "@unconfirmed/sui/Tx"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { Evidence } from "./Evidence.ts"
import { Journal } from "./Journal.ts"
import { SenderLock } from "./SenderLock.ts"
import { includeOf, isUnresolved, JournalEntry } from "./JournalEntry.ts"
import {
  DigestMismatch,
  ExecutionFailed,
  type JournalError,
  NotApplied,
  type Reconciled,
  SubmissionUnknown,
  type SubmitError
} from "./Outcome.ts"
import * as Signed from "./SignedTransaction.ts"
import { SubmitConfig, type SubmitConfigService } from "./SubmitConfig.ts"

type SignedTransaction = Signed.SignedTransaction

/** What the lifecycle reads from the chain. */
export type Services = Transactions | Objects | Chain

type Settled = ExecutionFailed | NotApplied | SubmissionUnknown

/** The optional parts of the effects a submission asked for (`Transactions.IncludeOptions`). */
type Includes = ReadonlyArray<Include> | undefined

const withInclude = (include: Includes): IncludeOptions | undefined => include && { include }

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

/** One line for a failure, never bytes. */
export const describe = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return String(error)
  const e = error as Record<string, unknown>
  const tag = typeof e._tag === "string" ? e._tag : "Error"
  if (tag === "RpcError") return `RpcError ${String(e.code)} from ${String(e.method)}: ${String(e.message)}`
  const detail = e.message ?? e.reason ?? e.description ?? e.evidence
  return typeof detail === "string" && detail.length > 0 ? `${tag}: ${detail}` : tag
}

const isRetryable = (e: RpcError): boolean => e.retryable

const executionFailed = (effects: Effects): ExecutionFailed | undefined =>
  effects.status._tag === "Failure"
    ? new ExecutionFailed({ digest: effects.digest, ...Resolve.failureFields(effects.status) })
    : undefined

/** One `Transactions.get`, with "not found" as `None`. */
const lookupOnce = (digest: string, include?: Includes): Effect.Effect<Option.Option<Effects>, RpcError, Transactions> =>
  Effect.flatMap(Effect.service(Transactions), (t) => t.get(digest, withInclude(include))).pipe(
    Effect.map(Option.some),
    Effect.catchTag("TransactionNotFound", () => Effect.succeedNone)
  )

/**
 * Ask for `digest` every `interval` until it is served or `timeout` passes.
 * `None` means every lookup missed; a transport failure that lasted to the
 * deadline (or was not retryable) is returned as the failure, because it is
 * not a miss. `include` adds those parts to the effects.
 */
export const awaitTransaction = Effect.fnUntraced(function*(
  digest: string,
  options: { readonly timeout: Duration.Input; readonly interval: Duration.Input } & IncludeOptions
): Effect.fn.Return<Option.Option<Effects>, RpcError, Transactions> {
  const interval = Duration.toMillis(options.interval)
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(options.timeout)
  while (true) {
    const result = yield* Effect.result(lookupOnce(digest, options.include))
    if (result._tag === "Success" && Option.isSome(result.success)) return result.success
    if (result._tag === "Failure" && !isRetryable(result.failure)) return yield* result.failure
    if ((yield* Clock.currentTimeMillis) + interval > deadline) {
      return result._tag === "Failure" ? yield* result.failure : Option.none()
    }
    yield* Effect.sleep(interval)
  }
})

// -----------------------------------------------------------------------------
// Journal bookkeeping
// -----------------------------------------------------------------------------

const entry = {
  signed: (signed: SignedTransaction, include: Includes) =>
    Effect.map(DateTime.now, (at) => JournalEntry.cases.Signed.make({ digest: signed.digest, signed, ...withInclude(include), at })),
  executed: (digest: string, include: Includes) =>
    Effect.map(DateTime.now, (at) => JournalEntry.cases.Executed.make({ digest, ...withInclude(include), at })),
  failed: (error: ExecutionFailed) =>
    Effect.map(
      DateTime.now,
      (at) => JournalEntry.cases.Failed.make({ digest: error.digest, description: error.description, at })
    ),
  notApplied: (error: NotApplied) =>
    Effect.map(
      DateTime.now,
      (at) => JournalEntry.cases.NotApplied.make({ digest: error.digest, evidence: error.evidence, at })
    ),
  /** `firstAt`: when the bytes were first journalled, kept across rewrites. */
  unknown: (signed: SignedTransaction, include: Includes, lastError: string, attempts: number, firstAt?: DateTime.Utc) =>
    Effect.map(DateTime.now, (now) =>
      JournalEntry.cases.Unknown.make({
        digest: signed.digest,
        signed,
        ...withInclude(include),
        lastError,
        attempts,
        at: firstAt ?? now
      }))
}

/** Write an entry after the network answered: a failure is logged, never returned. */
const journalSettled = (e: JournalEntry): Effect.Effect<void> =>
  Effect.flatMap(Effect.service(Journal), (j) => j.put(e)).pipe(
    Effect.catchTag("JournalError", (error) =>
      Effect.logError("the journal could not record a settled transaction; the outcome stands", error)),
    Effect.annotateLogs({ digest: e.digest, entry: e._tag })
  )

const terminalEntry = (
  result: Result.Result<Effects, Settled>,
  digest: string,
  include: Includes
): Option.Option<Effect.Effect<JournalEntry>> =>
  result._tag === "Success"
    ? Option.some(entry.executed(digest, include))
    : result.failure._tag === "ExecutionFailed"
    ? Option.some(entry.failed(result.failure))
    : result.failure._tag === "NotApplied"
    ? Option.some(entry.notApplied(result.failure))
    : Option.none()

// -----------------------------------------------------------------------------
// Reconcile
// -----------------------------------------------------------------------------

type InputEvidence =
  | { readonly _tag: "NoEvidence" }
  | { readonly _tag: "ConsumedByOther"; readonly objectId: string; readonly by: string }
  | { readonly _tag: "AppliedByUs"; readonly objectId: string }
  | { readonly _tag: "Unreadable"; readonly objectId: string; readonly reason: string }

/**
 * What the pinned objects prove. A version that has not moved proves nothing.
 * One that moved is read for *who* moved it: this digest (applied), or another
 * transaction whose effects took exactly the pinned version as input
 * (`inputConsumed`). Anything else is inconclusive; every ref is tried.
 */
/**
 * The version of `objectId` that transaction `by` took as input, from its own
 * effects (a failed transaction consumed its inputs too). None when the node
 * does not serve it, answers for another digest, or the object was not an input.
 */
const consumedVersion = (by: string, objectId: string): Effect.Effect<Option.Option<bigint>, RpcError, Transactions> =>
  Effect.map(lookupOnce(by), (found) =>
    Option.flatMap(found, (effects) =>
      effects.digest !== by
        ? Option.none()
        : Option.fromNullishOr(effects.changedObjects.find((c) => c.objectId === objectId)?.inputVersion)))

const inputEvidence = Effect.fnUntraced(function*(
  digest: string,
  signed: SignedTransaction
): Effect.fn.Return<InputEvidence, RpcError, Objects | Transactions> {
  const objects = yield* Objects
  let inconclusive: InputEvidence | undefined
  const remember = (objectId: string, reason: string) => {
    inconclusive ??= { _tag: "Unreadable", objectId, reason }
  }
  const refs = Signed.pinnedRefsOf(signed)
  // All pinned objects at once, so a batching `Objects` sends one request.
  const lives = yield* Effect.forEach(
    refs,
    (pinned) =>
      objects.get(pinned.objectId as Address).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ObjectNotFound", () => Effect.succeedNone)
      ),
    { concurrency: "unbounded" }
  )
  for (const [i, pinned] of refs.entries()) {
    const objectId = pinned.objectId as Address
    const live = lives[i]!
    if (Option.isNone(live)) {
      remember(objectId, "it is gone, and a deleted object names no transaction")
      continue
    }
    if (live.value.version <= pinned.version) continue
    const by = Option.fromNullishOr(live.value.previousTransaction)
    if (Option.isNone(by)) {
      remember(objectId, "the node does not say which transaction last mutated it")
      continue
    }
    if (by.value === digest) return { _tag: "AppliedByUs", objectId }
    const consumed = yield* consumedVersion(by.value, objectId)
    if (Option.isNone(consumed)) {
      remember(objectId, `the node does not say which version transaction ${by.value} consumed`)
      continue
    }
    if (consumed.value === pinned.version) return { _tag: "ConsumedByOther", objectId, by: by.value }
    remember(
      objectId,
      `transaction ${by.value} consumed version ${consumed.value}, not the pinned ${pinned.version}, and the state in between is not served`
    )
  }
  return inconclusive ?? { _tag: "NoEvidence" }
})

/** Whether the epoch window is observably closed right now. */
const expiryClosed = Effect.fnUntraced(function*(signed: SignedTransaction): Effect.fn.Return<boolean, RpcError, Chain> {
  const last = Signed.maxEpochOf(Signed.expirationOf(signed))
  if (last === undefined) return false
  const info = yield* Effect.flatMap(Effect.service(Chain), (c) => c.info)
  return info.epoch > last
})


/** What one `Evidence` observation says about an expired window. */
type Round =
  /** The evidence backend is past the window, does not serve the digest; `gap` says whether its history covers the window. */
  | { readonly _tag: "Absent"; readonly gap: Option.Option<string> }
  /** The evidence backend serves the digest. */
  | { readonly _tag: "Found" }
  /** The evidence backend has not reached the end of the window. */
  | { readonly _tag: "Open" }
  /** No `Evidence` service: the expiry rule is off. */
  | { readonly _tag: "Unobservable" }

/**
 * One observation from one backend (`Evidence.observe`): its epoch, whether it
 * serves the digest and its history, read consistently. Nothing from `Chain`
 * or `Transactions` is joined into it.
 */
const observeRound = Effect.fnUntraced(function*(
  digest: string,
  signed: SignedTransaction
): Effect.fn.Return<Round, RpcError> {
  const expiration = Signed.expirationOf(signed)
  const last = Signed.maxEpochOf(expiration)
  if (last === undefined) return { _tag: "Open" }
  const evidence = yield* Evidence
  const seen = yield* evidence.observe(digest, Signed.minEpochOf(expiration) ?? 0n)
  if (Option.isNone(seen)) return { _tag: "Unobservable" }
  if (seen.value.found) return { _tag: "Found" }
  if (seen.value.epoch <= last) return { _tag: "Open" }
  return { _tag: "Absent", gap: seen.value.gap }
})

const UNOBSERVABLE = "no Evidence service is provided, so the expiry rule is off (see Evidence)"
const FOUND_ELSEWHERE = "the Evidence backend serves this transaction but Transactions does not yet"
const OPEN_ELSEWHERE = "the Evidence backend has not yet reached the end of its window"

/** The reconcile rules, before read failures become `SubmissionUnknown`. */
const recover = Effect.fnUntraced(function*(
  config: SubmitConfigService,
  digest: string,
  signed: SignedTransaction | undefined,
  include: Includes
): Effect.fn.Return<Effects, Settled | RpcError, Services> {
  const unknown = (reason: string) => new SubmissionUnknown({ digest, ...(signed && { signed }), reason })
  const settle = (effects: Effects): Effect.Effect<Effects, Settled> => {
    if (effects.digest !== digest) {
      return Effect.fail(unknown(`the node answered for transaction ${effects.digest}, not ${digest}`))
    }
    const failed = executionFailed(effects)
    return failed ? Effect.fail(failed) : Effect.succeed(effects)
  }

  if (signed !== undefined) {
    const chain = Signed.chainOf(signed)
    const info = yield* Effect.flatMap(Effect.service(Chain), (c) => c.info)
    if (chain !== undefined && chain !== info.chainId) {
      return yield* unknown(`these bytes were built for chain ${chain}, this node is on ${info.chainId}; nothing it says is evidence`)
    }
  }

  const first = yield* awaitTransaction(digest, { timeout: config.lookupTimeout, interval: config.lookupInterval, ...withInclude(include) })
  if (Option.isSome(first)) return yield* settle(first.value)
  if (signed === undefined) return yield* unknown("the node does not know this digest and the signed bytes are not available")

  // Ordered and repeated: closed, missing, (recheck) closed, missing. Each
  // round needs both a `Transactions` miss and one `Evidence` backend that is
  // past the window and does not serve the digest, so a lagging index on one
  // side cannot turn a late landing into `expired`.
  let expired: Option.Option<Option.Option<string>> = Option.none()
  // Why a closed window settled nothing, when it did not.
  let why: string | undefined
  const round = Effect.fnUntraced(function*() {
    const missed = yield* lookupOnce(digest, include)
    if (Option.isSome(missed)) return { _tag: "Settled" as const, effects: missed.value }
    const seen = yield* observeRound(digest, signed)
    if (seen._tag === "Found") {
      const again = yield* lookupOnce(digest, include)
      if (Option.isSome(again)) return { _tag: "Settled" as const, effects: again.value }
    }
    return seen
  })
  if (config.expiryEvidence === "epochThenMiss" && (yield* expiryClosed(signed))) {
    const first = yield* round()
    if (first._tag === "Settled") return yield* settle(first.effects)
    if (first._tag === "Absent") {
      yield* Effect.sleep(config.reconcileRecheck)
      if (yield* expiryClosed(signed)) {
        const second = yield* round()
        if (second._tag === "Settled") return yield* settle(second.effects)
        if (second._tag === "Absent") expired = Option.some(second.gap)
        else why = second._tag === "Found" ? FOUND_ELSEWHERE : second._tag === "Open" ? OPEN_ELSEWHERE : UNOBSERVABLE
      }
    } else {
      why = first._tag === "Found" ? FOUND_ELSEWHERE : first._tag === "Open" ? OPEN_ELSEWHERE : UNOBSERVABLE
    }
  }

  // Positive evidence vetoes "expired", so the objects are read first.
  const evidence = yield* inputEvidence(digest, signed)
  if (evidence._tag === "AppliedByUs") {
    const again = yield* lookupOnce(digest, include)
    if (Option.isSome(again)) return yield* settle(again.value)
    return yield* unknown(
      `object ${evidence.objectId} names this transaction as its last mutation, so it applied, but the node does not serve it` +
        (Option.isSome(expired) ? " (its window has closed; do not re-send it)" : "")
    )
  }

  if (Option.isSome(expired)) {
    if (Option.isNone(expired.value)) return yield* new NotApplied({ digest, evidence: "expired" })
    why = expired.value.value
  }
  const pruned = why

  switch (evidence._tag) {
    case "ConsumedByOther":
      return yield* new NotApplied({
        digest,
        evidence: "inputConsumed",
        message: `object ${evidence.objectId} at the pinned version was consumed by ${evidence.by}`
      })
    case "Unreadable":
      return yield* unknown(
        `object ${evidence.objectId} has moved on or is gone, and ${evidence.reason}, so nothing is proven` +
          (pruned === undefined ? "" : `; ${pruned}`)
      )
    case "NoEvidence":
      return yield* unknown(
        pruned === undefined
          ? "the node does not know this digest and nothing proves it cannot land"
          : `the validity window has closed, but ${pruned}`
      )
  }
})

const reconcileUnjournaled = (digest: string, signed: SignedTransaction | undefined, include: Includes) =>
  Effect.flatMap(Effect.service(SubmitConfig), (config) => recover(config, digest, signed, include)).pipe(
    Effect.catchTag(
      "RpcError",
      (error) => Effect.fail(new SubmissionUnknown({ digest, ...(signed && { signed }), reason: describe(error) }))
    )
  )

/** The journal's entry for a digest; a read failure is logged and reads as none. */
const heldEntry = (digest: string): Effect.Effect<Option.Option<JournalEntry>> =>
  Effect.flatMap(Effect.service(Journal), (j) => j.get(digest)).pipe(
    Effect.catchTag("JournalError", (error) =>
      Effect.as(Effect.logError("the journal could not be read; the outcome stands", error), Option.none()))
  )

/** The `include` asked for, else the one the journal recorded for the digest. */
const includeFor = (digest: string, given: Includes): Effect.Effect<Includes> =>
  given !== undefined
    ? Effect.succeed(given)
    : Effect.map(heldEntry(digest), (held) => Option.isSome(held) ? includeOf(held.value) : undefined)

/**
 * A settled journal entry wins over a weaker conclusion. The chain finding the
 * transaction always stands (it is positive evidence), but a journal that
 * recorded `Executed` / `Failed` is never contradicted by `NotApplied` or
 * `SubmissionUnknown` from a lagging node, and a recorded `NotApplied` is never
 * weakened to `SubmissionUnknown`.
 */
const honourJournal = (
  held: Option.Option<JournalEntry>,
  digest: string,
  signed: SignedTransaction | undefined,
  result: Result.Result<Effects, Settled>
): Result.Result<Effects, Settled> => {
  if (Option.isNone(held) || result._tag === "Success" || result.failure._tag === "ExecutionFailed") return result
  const recorded = held.value
  switch (recorded._tag) {
    case "Executed":
      return Result.fail(
        new SubmissionUnknown({
          digest,
          ...(signed && { signed }),
          reason:
            `the journal records this transaction as executed, but the node does not serve it (${describe(result.failure)}); do not re-send it`
        })
      )
    case "Failed":
      return Result.fail(new ExecutionFailed({ digest, description: recorded.description }))
    case "NotApplied":
      return result.failure._tag === "NotApplied"
        ? result
        : Result.fail(new NotApplied({ digest, evidence: recorded.evidence }))
    default:
      return result
  }
}

/** Write an unresolved entry unless the journal (as just read: `held`) holds a settled one. Write failures are logged. */
const journalUnresolved = (held: Option.Option<JournalEntry>, e: JournalEntry): Effect.Effect<void> =>
  Option.isSome(held) && !isUnresolved(held.value) ? Effect.void : journalSettled(e)

const verified = (signed: SignedTransaction): Effect.Effect<SignedTransaction, DigestMismatch> => {
  const computed = Signed.digestMismatch(signed)
  return computed === undefined
    ? Effect.succeed(signed)
    : Effect.fail(new DigestMismatch({ digest: signed.digest, computed }))
}

export type ReconcileInput = SignedTransaction | SubmissionUnknown | string

/** A bare digest uses the signed bytes of the journal's unresolved entry for it, when they check out. */
const journalledBytes = (digest: string): Effect.Effect<{ digest: string; signed: SignedTransaction | undefined }> =>
  Effect.map(heldEntry(digest), (held) => {
    const signed = Option.isSome(held) && isUnresolved(held.value) ? held.value.signed : undefined
    return {
      digest,
      signed: signed !== undefined && signed.digest === digest && Signed.digestMismatch(signed) === undefined ? signed : undefined
    }
  })

const inputOf = (input: ReconcileInput): Effect.Effect<{ digest: string; signed: SignedTransaction | undefined }, DigestMismatch> =>
  typeof input === "string"
    ? journalledBytes(input)
    : input instanceof SubmissionUnknown
    ? input.signed === undefined
      ? journalledBytes(input.digest)
      : Effect.flatMap(verified(input.signed), (signed) =>
        signed.digest === input.digest
          ? Effect.succeed({ digest: input.digest, signed })
          : Effect.fail(new DigestMismatch({ digest: input.digest, computed: signed.digest })))
    : Effect.map(verified(input), (signed) => ({ digest: signed.digest, signed }))

/**
 * Decide what happened to a transaction. Found is `Executed` / `ExecutionFailed`;
 * not found is `NotApplied` only on evidence, otherwise `SubmissionUnknown`.
 * A bare digest uses the signed bytes the journal holds for it (an unresolved
 * entry); without them it can never be proven absent. A settled journal entry is never
 * contradicted by a weaker answer; a terminal answer settles an unresolved one.
 * Signed bytes whose digest does not match fail with `DigestMismatch`.
 * `include` adds those parts to the effects; without it, the `include` the
 * journal recorded for the submission is used.
 */
export const reconcile = Effect.fn("Lifecycle.reconcile")(function*(
  input: ReconcileInput,
  options?: IncludeOptions
): Effect.fn.Return<Effects, Settled | DigestMismatch, Services> {
  const { digest, signed } = yield* inputOf(input)
  const include = yield* includeFor(digest, options?.include)
  const result = yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(Effect.result(reconcileUnjournaled(digest, signed, include))), (raw) =>
      Effect.gen(function*() {
        const held = yield* heldEntry(digest)
        const result = honourJournal(held, digest, signed, raw)
        const make = terminalEntry(result, digest, include)
        if (Option.isSome(make) && Option.isSome(held) && isUnresolved(held.value)) {
          yield* journalSettled(yield* make.value)
        }
        return result
      }))
  )
  return yield* Effect.fromResult(result)
})

/** Reconcile (with optional rechecks while unknown) and journal the answer. Never fails. */
const settle = Effect.fnUntraced(function*(
  signed: SignedTransaction,
  attempts: number,
  lastError: string | undefined,
  rechecks: number,
  include: Includes
): Effect.fn.Return<Result.Result<Effects, Settled>, never, Services> {
  const config = yield* SubmitConfig
  const answer = Effect.gen(function*() {
    let result = yield* Effect.result(reconcileUnjournaled(signed.digest, signed, include))
    for (let round = 0; round < rechecks; round++) {
      if (result._tag !== "Failure" || result.failure._tag !== "SubmissionUnknown") break
      yield* Effect.sleep(config.reconcileRecheck)
      result = yield* Effect.result(reconcileUnjournaled(signed.digest, signed, include))
    }
    return result
  })
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(answer), (raw) =>
      Effect.gen(function*() {
        const held = yield* heldEntry(signed.digest)
        const result = honourJournal(held, signed.digest, signed, raw)
        const make = terminalEntry(result, signed.digest, include)
        if (Option.isSome(make)) {
          yield* journalSettled(yield* make.value)
        } else {
          // Keep when the bytes were first journalled, and the send error that
          // made them unknown when this round has no new one (reconcileAll).
          const previous = Option.isSome(held) && isUnresolved(held.value) ? held.value : undefined
          yield* journalUnresolved(
            held,
            yield* entry.unknown(
              signed,
              include,
              lastError ?? (previous?._tag === "Unknown"
                ? previous.lastError
                : result._tag === "Failure" ? describe(result.failure) : "unknown"),
              attempts,
              previous?.at
            )
          )
        }
        return result
      }))
  )
})

// -----------------------------------------------------------------------------
// Submit
// -----------------------------------------------------------------------------

const LOCK_CONFLICT = /already locked by a different transaction|rejected as invalid by more than 1\/3 of validators/i
const LOCK_CONFLICT_RECHECKS = 3

/** Wait until reads see an executed transaction. Never fails and never changes the outcome. */
const awaitVisible = (config: SubmitConfigService, digest: string): Effect.Effect<void, never, Transactions> =>
  config.awaitVisibility
    ? awaitTransaction(digest, { timeout: config.visibilityTimeout, interval: config.lookupInterval }).pipe(
      Effect.flatMap((found) =>
        Option.isSome(found)
          ? Effect.void
          : Effect.logDebug("executed but not visible within visibilityTimeout; the outcome stands")
      ),
      Effect.catch((error) => Effect.logDebug(`executed, but waiting for visibility failed: ${describe(error)}`)),
      Effect.annotateLogs({ digest }),
      Effect.withSpan("Lifecycle.awaitVisible")
    )
    : Effect.void

/** What the caller already knows when it sends. */
interface SendHow {
  /** The journal's entry as the caller just read it (undefined: not read). */
  readonly held?: Option.Option<JournalEntry> | undefined
  /** Write `Signed` even over a settled entry (re-sending a `refused` one on request). */
  readonly overwriteSettled?: boolean
  /** The parts of the effects to read back, journalled with the bytes. */
  readonly include?: Includes
}

/**
 * The `Signed` write before a send. Never over a settled entry (unless asked).
 * On bytes that were never sent a failure is an honest `JournalError`; on
 * bytes that may already have gone out (`resent`) it is `SubmissionUnknown`.
 */
const journalBeforeSend = (
  signed: SignedTransaction,
  resent: boolean,
  how: SendHow
): Effect.Effect<void, JournalError | SubmissionUnknown> =>
  Effect.gen(function*() {
    const journal = yield* Journal
    // The caller usually just read the entry; read it here only when it did not.
    const held = how.held ?? (yield* journal.get(signed.digest))
    if (Option.isSome(held) && !isUnresolved(held.value) && !how.overwriteSettled) return
    yield* journal.put(yield* entry.signed(signed, how.include))
  }).pipe(
    Effect.catchTag("JournalError", (error): Effect.Effect<never, JournalError | SubmissionUnknown> =>
      resent
        ? Effect.fail(
          new SubmissionUnknown({
            digest: signed.digest,
            signed,
            reason: `these bytes may already be on chain and the journal could not record the re-send (${error.message}); nothing was re-sent`
          })
        )
        : Effect.fail(error))
  )

const send = Effect.fnUntraced(function*(
  signed: SignedTransaction,
  resent: boolean,
  how: SendHow = {}
): Effect.fn.Return<Effects, ExecutionFailed | NotApplied | SubmissionUnknown | JournalError, Services> {
  const config = yield* SubmitConfig
  const transactions = yield* Transactions
  if (!resent) {
    // Bytes for another chain are never sent (a re-send checks this too):
    // the node would refuse them, and that refusal would be recorded as proof.
    const chain = Signed.chainOf(signed)
    const info = yield* Effect.result(Effect.flatMap(Effect.service(Chain), (c) => c.info))
    if (chain !== undefined && info._tag === "Success" && chain !== info.success.chainId) {
      return yield* new SubmissionUnknown({
        digest: signed.digest,
        signed,
        reason: `these bytes were built for chain ${chain}, this node is on ${info.success.chainId}; nothing was sent`
      })
    }
  }
  yield* journalBeforeSend(signed, resent, how)

  let attempts = 0
  const once = Effect.suspend(() => {
    attempts += 1
    return transactions.execute(signed.bytes, signed.signatures, withInclude(how.include)).pipe(
      Effect.timeoutOrElse({
        duration: config.executeTimeout,
        orElse: () =>
          Effect.fail(
            new RpcError({
              method: "ExecuteTransaction",
              code: "DEADLINE_EXCEEDED",
              message: `no answer within executeTimeout (${Duration.format(config.executeTimeout)})`
            })
          )
      })
    )
  })

  // The attempts are interruptible; from the answer to its journal record, nothing is.
  const result = yield* Effect.uninterruptibleMask((restore) =>
    restore(
      once.pipe(
        Effect.retry({
          schedule: config.resubmit,
          times: Math.max(config.resubmitAttempts - 1, 0),
          while: (e) => e._tag === "RpcError" && isRetryable(e)
        })
      )
    ).pipe(
      Effect.result,
      Effect.tap((answered) => {
        if (answered._tag !== "Success" || answered.success.digest !== signed.digest) return Effect.void
        const failed = executionFailed(answered.success)
        return Effect.flatMap(failed ? entry.failed(failed) : entry.executed(signed.digest, how.include), journalSettled)
      })
    )
  )

  if (result._tag === "Success") {
    const effects = result.success
    if (effects.digest !== signed.digest) {
      return yield* reconcileSigned(signed, `the node answered for transaction ${effects.digest}`, attempts, 0, how.include)
    }
    const failed = executionFailed(effects)
    if (failed) return yield* failed
    yield* awaitVisible(config, signed.digest)
    return effects
  }
  const failure = result.failure
  // Accepted, but the answer can't be read as effects: it may have executed.
  if (failure._tag === "ExecutedEffectsIncomplete") return yield* reconcileSigned(signed, failure.message, attempts, 0, how.include)
  // A lock held by another transaction, whatever the code: the bytes reached
  // validators, so it reconciles (with rechecks while the winner becomes readable).
  if (LOCK_CONFLICT.test(failure.message)) {
    return yield* reconcileSigned(signed, describe(failure), attempts, LOCK_CONFLICT_RECHECKS, how.include)
  }
  // Refused outright on the first send of bytes never sent before: nothing executed.
  if (!resent && attempts === 1 && failure.code === "INVALID_ARGUMENT") {
    const refused = new NotApplied({ digest: signed.digest, evidence: "refused", message: failure.message })
    yield* Effect.flatMap(entry.notApplied(refused), journalSettled)
    return yield* refused
  }
  return yield* reconcileSigned(signed, describe(failure), attempts, 0, how.include)
})

const reconcileSigned = Effect.fnUntraced(function*(
  signed: SignedTransaction,
  lastSend: string,
  attempts: number,
  rechecks: number,
  include: Includes
): Effect.fn.Return<Effects, Settled, Services> {
  const settled = yield* settle(signed, attempts, lastSend, rechecks, include)
  if (settled._tag === "Success") return settled.success
  const failure = settled.failure
  if (failure._tag !== "SubmissionUnknown") return yield* failure
  return yield* new SubmissionUnknown({
    digest: failure.digest,
    signed,
    reason: `${failure.reason}; the last send failed with ${lastSend}`
  })
})

/**
 * What the journal already says decides how to (re-)send: a settled entry is
 * answered from the chain with the journal winning (never re-sent), an
 * unresolved one means these bytes may already be out.
 */
/**
 * How a send was asked for: `fresh` bytes were signed just now (`run`), so a
 * journal failure before the send is an honest `JournalError`; `submit` bytes
 * come from the caller and may have been sent before; `resend` is `resubmit`.
 */
type SendMode = "fresh" | "submit" | "resend"

const sendConsultingJournal = Effect.fnUntraced(function*(
  signed: SignedTransaction,
  mode: SendMode,
  options?: ResubmitOptions
): Effect.fn.Return<Effects, SubmitError, Services> {
  const held = yield* Effect.flatMap(Effect.service(Journal), (j) => j.get(signed.digest)).pipe(
    Effect.catchTag("JournalError", (error): Effect.Effect<never, JournalError | SubmissionUnknown> =>
      mode === "fresh" ? Effect.fail(error) : Effect.fail(
        new SubmissionUnknown({
          digest: signed.digest,
          signed,
          reason: `the journal could not be read (${error.message}); nothing was sent, but these bytes may have been sent before`
        })
      ))
  )
  // Asked for now, else what the earlier send of these bytes asked for.
  const include = options?.include ?? (Option.isSome(held) ? includeOf(held.value) : undefined)
  if (Option.isSome(held)) {
    switch (held.value._tag) {
      case "Executed":
      case "Failed":
        return yield* reconcile(signed, withInclude(include))
      case "NotApplied":
        if (mode === "resend" && options?.retryRefused === true && held.value.evidence === "refused") {
          return yield* resend(signed, { held, overwriteSettled: true, include })
        }
        return yield* new NotApplied({ digest: signed.digest, evidence: held.value.evidence })
      default:
        return yield* resend(signed, { held, include })
    }
  }
  return yield* (mode === "resend" ? resend(signed, { held, include }) : send(signed, false, { held, include }))
})

/**
 * Send signed bytes and find out what happened. Re-sends only the identical
 * bytes; ends in `Executed`, `ExecutionFailed`, `NotApplied` (proven, or
 * `refused` on the first send of bytes the journal has never seen) or
 * `SubmissionUnknown`. Bytes the journal already holds are treated as a
 * re-send (see `resubmit`); bytes built for another chain than the node's are
 * not sent (`SubmissionUnknown`). `JournalError` only from the `Signed` write
 * before bytes the journal has never seen (a journal that cannot be read is
 * `SubmissionUnknown`: the bytes may have been sent before); `DigestMismatch`
 * if the digest is not the bytes'. `include` (`["events", "balanceChanges"]`)
 * adds those to the effects, and is journalled with the bytes so a later
 * reconcile (`reconcileAll` after a crash) reads them too.
 */
export const submit = Effect.fn("Lifecycle.submit")(function*(
  input: SignedTransaction,
  options?: IncludeOptions
): Effect.fn.Return<Effects, SubmitError, Services> {
  const signed = yield* verified(input)
  yield* Effect.annotateCurrentSpan({ "sui.digest": signed.digest })
  return yield* sendConsultingJournal(signed, "submit", options)
})

/** `submit` for bytes signed just now by `run`: a journal read failure before the send is `JournalError`. */
const submitFresh = (signed: SignedTransaction, include: Includes) =>
  Effect.flatMap(verified(signed), (s) => sendConsultingJournal(s, "fresh", withInclude(include))).pipe(
    Effect.withSpan("Lifecycle.submit")
  )

export interface ResubmitOptions extends IncludeOptions {
  /**
   * Re-send bytes the journal records as `NotApplied{refused}`. A refusal
   * means only that this process will not send them again on its own; the
   * same bytes can be valid later (e.g. once the sender is funded), until
   * their window closes. Default false.
   */
  readonly retryRefused?: boolean
}

/**
 * Re-send the identical bytes. Refuses when the journal already says
 * `NotApplied` (unless `retryRefused` and the evidence is `refused`);
 * reconciles instead (journal winning) when the journal says it executed, the
 * bytes name another chain, or their window has closed. Bytes not given
 * (a `SubmissionUnknown` without them) are taken from the journal, as is
 * `include` when not given. Never raises `JournalError`: the bytes may
 * already be out.
 */
export const resubmit = Effect.fn("Lifecycle.resubmit")(function*(
  input: SignedTransaction | SubmissionUnknown,
  options?: ResubmitOptions
): Effect.fn.Return<Effects, Exclude<SubmitError, JournalError>, Services> {
  const { digest, signed } = yield* inputOf(input)
  if (signed === undefined) return yield* reconcile(digest, withInclude(options?.include))
  return yield* (sendConsultingJournal(signed, "resend", options) as Effect.Effect<
    Effects,
    Exclude<SubmitError, JournalError>,
    Services
  >)
})

const resend = Effect.fnUntraced(function*(
  signed: SignedTransaction,
  how: SendHow = {}
): Effect.fn.Return<Effects, Exclude<SubmitError, JournalError>, Services> {
  const info = yield* Effect.result(Effect.flatMap(Effect.service(Chain), (c) => c.info))
  const chain = Signed.chainOf(signed)
  const otherChain = chain !== undefined && info._tag === "Success" && chain !== info.success.chainId
  const closed = otherChain || (yield* Effect.orElseSucceed(expiryClosed(signed), () => false))
  if (closed) {
    const settled = yield* settle(signed, 1, undefined, 0, how.include)
    return settled._tag === "Success" ? settled.success : yield* settled.failure
  }
  // `resent: true` turns a journal failure into SubmissionUnknown, never JournalError.
  return yield* (send(signed, true, how) as Effect.Effect<Effects, Exclude<SubmitError, JournalError>, Services>)
})

export interface ReconcileAllOptions {
  /** Re-send an entry still unknown after reconciling, as identical bytes. Default false. */
  readonly resubmit?: boolean
  /** Entries reconciled at once. Default 8. */
  readonly concurrency?: number
}

/**
 * Settle every unresolved journal entry: the startup call after a crash. Each
 * entry gets `reconcile`'s rules (with one lookup, not `lookupTimeout` of
 * polling: entries left over from a crash are old) and the journal is updated,
 * `concurrency` entries at a time; with `{ resubmit: true }` an entry still
 * unknown is re-sent as identical bytes. Entries the journal cannot read are
 * reported as `Corrupt` (drop them with `Journal.remove`), never a failure of
 * the whole call. Fails only when the journal cannot be listed.
 */
export const reconcileAll = Effect.fn("Lifecycle.reconcileAll")(function*(
  options?: ReconcileAllOptions
): Effect.fn.Return<ReadonlyArray<Reconciled>, JournalError, Services> {
  const journal = yield* Journal
  const config = yield* SubmitConfig
  const once: SubmitConfigService = { ...config, lookupTimeout: Duration.zero }
  const { entries, corrupt } = yield* journal.listUnresolved
  const corruptResults: Array<Reconciled> = corrupt.map((c) => ({ _tag: "Corrupt", digest: c.key, reason: c.reason }))
  const settled = yield* Effect.forEach(entries, (e) =>
    Effect.gen(function*(): Effect.fn.Return<Reconciled, never, Services> {
      const computed = Signed.digestMismatch(e.signed)
      if (computed !== undefined || e.signed.digest !== e.digest) {
        return { _tag: "Corrupt", digest: e.digest, reason: `its bytes have digest ${computed ?? e.signed.digest}, not ${e.digest}` }
      }
      let result = yield* settle(e.signed, e._tag === "Unknown" ? e.attempts : 1, undefined, 0, e.include)
      if (
        options?.resubmit === true && result._tag === "Failure" && result.failure._tag === "SubmissionUnknown"
      ) {
        const sent = yield* Effect.result(resend(e.signed, { include: e.include }))
        result = sent as Result.Result<Effects, Settled>
      }
      return toReconciled(e.digest, result)
    }).pipe(Effect.provideService(SubmitConfig, once)), { concurrency: options?.concurrency ?? 8 })
  return [...corruptResults, ...settled]
})

const toReconciled = (digest: string, result: Result.Result<Effects, Settled | DigestMismatch>): Reconciled => {
  if (result._tag === "Success") return { _tag: "Executed", digest, effects: result.success }
  const error = result.failure
  switch (error._tag) {
    case "ExecutionFailed":
      return { _tag: "ExecutionFailed", digest, error }
    case "NotApplied":
      return { _tag: "NotApplied", digest, error }
    case "SubmissionUnknown":
      return { _tag: "SubmissionUnknown", digest, error }
    case "DigestMismatch":
      return { _tag: "SubmissionUnknown", digest, error: new SubmissionUnknown({ digest, reason: describe(error) }) }
  }
}

// -----------------------------------------------------------------------------
// Sign and run
// -----------------------------------------------------------------------------

/**
 * Sign transaction data (or its bytes) with every signer, concurrently.
 * `chain` is recorded for expirations that name none. A signer that is
 * neither the sender nor the gas owner is `Tx.SignerMismatch` before anyone
 * signs, as in `Tx.execute` (an alias signs through `AddressAlias.signer`);
 * bytes that do not parse as `TransactionData` are signed unchecked.
 */
export const sign = Effect.fn("Lifecycle.sign")(function*(
  data: T.TransactionData | Uint8Array,
  signers: Signer.Signer | ReadonlyArray<Signer.Signer>,
  options?: { readonly chain?: string }
): Effect.fn.Return<SignedTransaction, Signer.SigningError | Tx.SignerMismatch> {
  const bytes = data instanceof Uint8Array ? data : T.encode(data)
  const all = Array.isArray(signers) ? signers : [signers as Signer.Signer]
  const parsed = data instanceof Uint8Array ? Result.getOrUndefined(T.decode(data)) : data
  if (parsed !== undefined) yield* refuseMismatch(all, parsed.sender, parsed.gasData.owner)
  const signatures = yield* Effect.forEach(
    all,
    (s) => Effect.map(Signer.signTransaction(s, bytes), (x) => x.signature),
    { concurrency: "unbounded" }
  )
  return Signed.make(bytes, signatures, options)
})

/** The first signer that is neither `sender` nor `gasOwner`, as `Tx.SignerMismatch`. */
const refuseMismatch = (
  signers: ReadonlyArray<Signer.Signer>,
  sender: Address,
  gasOwner: Address
): Effect.Effect<void, Tx.SignerMismatch> => {
  for (const s of signers) {
    const refused = Tx.signerMismatch(s.address, sender, gasOwner)
    if (refused) return Effect.fail(refused)
  }
  return Effect.void
}

export interface RunOptions<E = never, R = never> extends Omit<Tx.ResolveOptions<E, R>, "sender">, IncludeOptions {
  readonly signer: Signer.Signer
  /** Defaults to the signer's address. */
  readonly sender?: Address
  /** Extra signers, e.g. a sponsor when `gasOwner` is not the sender. */
  readonly cosigners?: ReadonlyArray<Signer.Signer>
}

/**
 * Build (core `Tx.build`), sign, journal, submit. Unless given, the expiration
 * is `ValidDuring` this epoch and the next, so the expiry rule can settle the
 * bytes even when they pin nothing. `include` (`["events", "balanceChanges"]`)
 * adds those to the effects (see `submit`).
 *
 * A signer (or cosigner) that is neither the sender nor the gas owner is
 * `Tx.SignerMismatch` before any network call, as in `Tx.run`.
 *
 * Holds the `SenderLock` of the sender (and a distinct gas owner) for the
 * build, and through signing and submission when the bytes pin a versioned
 * object or gas payment; bytes that pin nothing are signed and sent after the
 * lock is released.
 */
export const run = <A, E1, R1, E2 = never, R2 = never>(recipe: Effect.Effect<A, E1, R1>, options: RunOptions<E2, R2>) =>
  Effect.gen(function*() {
    const { signer, cosigners, sender: given, include, ...resolve } = options
    const sender = given ?? signer.address
    const signers = [signer, ...(cosigners ?? [])]
    yield* refuseMismatch(signers, sender, resolve.gasOwner ?? sender)
    const info = yield* Effect.flatMap(Effect.service(Chain), (c) => c.info)
    const lock = yield* SenderLock
    const locked = yield* lock.withLocks([sender, ...(resolve.gasOwner ? [resolve.gasOwner] : [])])(
      Effect.gen(function*() {
        const expiration = options.expiration ?? (yield* Resolve.validDuring())
        const data = yield* Tx.build(recipe, { ...resolve, expiration, sender })
        if (!Signed.pinsObjects(data)) return { _tag: "Unpinned" as const, data }
        const signed = yield* sign(data, signers, { chain: info.chainId })
        return { _tag: "Done" as const, effects: yield* submitFresh(signed, include) }
      })
    )
    if (locked._tag === "Done") return locked.effects
    return yield* submitFresh(yield* sign(locked.data, signers, { chain: info.chainId }), include)
  }).pipe(Effect.withSpan("Lifecycle.run"))
