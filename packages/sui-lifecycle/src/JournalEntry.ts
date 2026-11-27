/**
 * One line of the submission journal, as a Schema tagged union so a durable
 * journal stores it as JSON.
 *
 * `Signed` is written before the first execute: the bytes may be on the wire.
 * `Unknown` means the answer never arrived; the bytes are kept for later.
 * `Executed`, `Failed` and `NotApplied` are terminal. `NotApplied` is its own
 * terminal case so a proven-dead submission does not stay unresolved forever.
 */
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { NotAppliedEvidence } from "./Outcome.ts"
import { SignedTransaction } from "./SignedTransaction.ts"

export const JournalEntry = Schema.TaggedUnion({
  Signed: {
    digest: Schema.String,
    signed: SignedTransaction,
    at: Schema.DateTimeUtcFromMillis
  },
  Unknown: {
    digest: Schema.String,
    signed: SignedTransaction,
    lastError: Schema.String,
    attempts: Schema.Int,
    at: Schema.DateTimeUtcFromMillis
  },
  Executed: {
    digest: Schema.String,
    at: Schema.DateTimeUtcFromMillis
  },
  Failed: {
    digest: Schema.String,
    description: Schema.String,
    at: Schema.DateTimeUtcFromMillis
  },
  NotApplied: {
    digest: Schema.String,
    evidence: NotAppliedEvidence,
    at: Schema.DateTimeUtcFromMillis
  }
})
export type JournalEntry = typeof JournalEntry.Type

export type Unresolved = Extract<JournalEntry, { readonly _tag: "Signed" | "Unknown" }>

/** `Signed` and `Unknown` still need an answer from the network. */
export const isUnresolved: (entry: JournalEntry) => entry is Unresolved = JournalEntry.isAnyOf(["Signed", "Unknown"])

export const millisOf = (entry: JournalEntry): number => DateTime.toEpochMillis(entry.at)

/** Oldest first, then by digest, for a stable order. */
export const oldestFirst = (a: JournalEntry, b: JournalEntry): number =>
  millisOf(a) - millisOf(b) || (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0)
