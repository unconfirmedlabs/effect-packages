/**
 * `Journal`: what this process has put on the wire.
 *
 * A `Context.Reference` with an in-memory default, so it never appears in an
 * `R` and the shortest program needs no wiring. The default is computed once
 * and is process-wide; a test (or a process that wants its own) provides
 * `layerMemory`, and a long-lived service provides the durable
 * `JournalKeyValueStore.layer`, then calls `Lifecycle.reconcileAll` at startup.
 */
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { isUnresolved, type JournalEntry, millisOf, oldestFirst, type Unresolved } from "./JournalEntry.ts"
import type { JournalError } from "./Outcome.ts"

export interface JournalService {
  /** Record an entry, replacing any earlier one for the same digest. */
  readonly put: (entry: JournalEntry) => Effect.Effect<void, JournalError>
  readonly get: (digest: string) => Effect.Effect<Option.Option<JournalEntry>, JournalError>
  /** Every `Signed` / `Unknown` entry, oldest first. */
  readonly listUnresolved: Effect.Effect<ReadonlyArray<Unresolved>, JournalError>
  /**
   * Delete settled entries (`Executed`, `Failed`, `NotApplied`) recorded
   * strictly before `before`; answer how many. Unresolved entries are never
   * deleted, however old.
   */
  readonly pruneSettled: (before: DateTime.DateTime) => Effect.Effect<number, JournalError>
}

/** An in-memory journal over a `Map`. Survives nothing. */
export const makeMemory = (): JournalService => {
  const entries = new Map<string, JournalEntry>()
  return {
    put: (entry) => Effect.sync(() => void entries.set(entry.digest, entry)),
    get: (digest) => Effect.sync(() => Option.fromNullishOr(entries.get(digest))),
    listUnresolved: Effect.sync(() => [...entries.values()].filter(isUnresolved).sort(oldestFirst)),
    pruneSettled: (before) =>
      Effect.sync(() => {
        const cutoff = DateTime.toEpochMillis(before)
        let n = 0
        for (const [digest, entry] of entries) {
          if (!isUnresolved(entry) && millisOf(entry) < cutoff) {
            entries.delete(digest)
            n++
          }
        }
        return n
      })
  }
}

export const Journal = Context.Reference<JournalService>("@unconfirmed/sui-lifecycle/Journal", {
  defaultValue: makeMemory
})

/** A fresh in-memory journal. */
export const layerMemory: Layer.Layer<never> = Layer.sync(Journal, makeMemory)
