/**
 * The outcome taxonomy. Every failure of a submission is on exactly one axis:
 *
 *   applied      on chain; gas was charged          ExecutionFailed
 *   not_applied  provably never applied, never will  NotApplied, JournalError
 *                (only raised before these bytes were ever sent)
 *   unknown      may or may not have applied         SubmissionUnknown,
 *                DigestMismatch, and anything outside this taxonomy
 *
 * Only `not_applied` is safe to retry by rebuilding. `unknown` carries the
 * signed bytes: re-send them (`Lifecycle.resubmit`) or reconcile them later;
 * identical bytes land at most once.
 */
import * as Tx from "../Tx.ts"
import type { Effects } from "../Transactions.ts"
import * as Schema from "effect/Schema"
import { SignedTransaction } from "./SignedTransaction.ts"

/** The transaction reached the chain and Move aborted. Gas was charged. (Core's error, reused.) */
export const ExecutionFailed = Tx.ExecutionFailed
export type ExecutionFailed = Tx.ExecutionFailed

export const NotAppliedEvidence = Schema.Literals(["expired", "inputConsumed", "refused"])
export type NotAppliedEvidence = typeof NotAppliedEvidence.Type

/**
 * The transaction did not apply, and the lifecycle will not send it again:
 * - `expired`: its epoch window closed and it is absent, observed twice (around
 *   a recheck) by one `Evidence` backend whose history covers the window, with
 *   `Transactions` missing it too: it never applied and never will;
 * - `inputConsumed`: another transaction consumed an object version these bytes
 *   pinned: it never applied and never will;
 * - `refused`: the node refused the first send outright (`INVALID_ARGUMENT`),
 *   so nothing executed then. This is the node's verdict at that moment, not
 *   proof that the bytes can never land: some refusals are time-dependent
 *   (e.g. an unfunded address balance) and the node may still hold the bytes.
 *   It means this process will not send them again on its own
 *   (`Lifecycle.resubmit(..., { retryRefused: true })` does on request).
 */
export class NotApplied extends Schema.TaggedError<NotApplied>()("NotApplied", {
  digest: Schema.String,
  evidence: NotAppliedEvidence,
  message: Schema.optionalKey(Schema.String)
}) {}

/**
 * The outcome is not known. `signed` (absent only when reconciling a bare
 * digest) is what to re-send or reconcile later.
 */
export class SubmissionUnknown extends Schema.TaggedError<SubmissionUnknown>()("SubmissionUnknown", {
  digest: Schema.String,
  signed: Schema.optionalKey(SignedTransaction),
  reason: Schema.String
}) {
  override get message(): string {
    return `outcome of ${this.digest} unknown: ${this.reason}`
  }
}

/**
 * The journal could not be read or written. Raised only before bytes that were
 * never sent go out (so `not_applied`): by `run` (bytes it signed just now) on
 * any journal failure before the send, and by `submit` when the `Signed` write
 * fails for bytes the journal has never seen. Once the bytes may have left — an
 * earlier send, a re-send, `submit` unable to read the journal — a journal
 * failure becomes `SubmissionUnknown` instead, and later writes are logged,
 * never raised.
 */
export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  message: Schema.String
}) {}

/**
 * A `SignedTransaction` whose `digest` is not the digest of its bytes: a
 * corrupt or tampered record. Nothing was sent or concluded; what happened to
 * either transaction is unknown.
 */
export class DigestMismatch extends Schema.TaggedError<DigestMismatch>()("DigestMismatch", {
  digest: Schema.String,
  computed: Schema.String
}) {
  override get message(): string {
    return `digest ${this.digest} does not match the bytes (${this.computed})`
  }
}

export type Outcome = "applied" | "not_applied" | "unknown"

/**
 * Where a failure sits. Within the taxonomy: `ExecutionFailed` is `applied`,
 * `NotApplied` and `JournalError` are `not_applied`, `SubmissionUnknown` and
 * `DigestMismatch` are `unknown`.
 *
 * Every other value — a timeout around `run`, a raw `RpcError`, a defect — is
 * `unknown`, because nothing says it happened before the bytes left. Pass
 * `{ phase: "beforeSubmit" }` when you know it did: every error of
 * `Lifecycle.run` outside the taxonomy (build, resolve, sign) is raised before
 * submission, so `outcome(e, { phase: "beforeSubmit" })` is right for an error
 * taken straight from `run`'s error channel, and wrong for one you added around it.
 */
export const outcome = (error: unknown, options?: { readonly phase?: "beforeSubmit" }): Outcome => {
  const tag = typeof error === "object" && error !== null ? (error as { readonly _tag?: unknown })._tag : undefined
  switch (tag) {
    case "ExecutionFailed":
      return "applied"
    case "NotApplied":
    case "JournalError":
      return "not_applied"
    case "SubmissionUnknown":
    case "DigestMismatch":
      return "unknown"
    default:
      return options?.phase === "beforeSubmit" && typeof tag === "string" ? "not_applied" : "unknown"
  }
}

/** Everything a submission can end in besides success. */
export type SubmitError = ExecutionFailed | NotApplied | SubmissionUnknown | JournalError | DigestMismatch

/** What one reconciled journal entry settled to. */
export type Reconciled =
  | { readonly _tag: "Executed"; readonly digest: string; readonly effects: Effects }
  | { readonly _tag: "ExecutionFailed"; readonly digest: string; readonly error: ExecutionFailed }
  | { readonly _tag: "NotApplied"; readonly digest: string; readonly error: NotApplied }
  | { readonly _tag: "SubmissionUnknown"; readonly digest: string; readonly error: SubmissionUnknown }
  /**
   * The journal entry could not be read (see `Journal.CorruptEntry`); `digest`
   * is its key. Nothing was concluded or sent; `Journal.remove(digest)` drops it.
   */
  | { readonly _tag: "Corrupt"; readonly digest: string; readonly reason: string }
