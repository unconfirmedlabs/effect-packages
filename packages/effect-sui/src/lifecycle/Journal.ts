/**
 * `Journal`: what this process has put on the wire.
 *
 * A `Context.Reference` with an in-memory default, so it never appears in an
 * `R` and the shortest program needs no wiring. The default is computed once
 * and is process-wide (it keeps the latest {@link MEMORY_SETTLED_CAP} settled
 * entries); a test (or a process that wants its own) provides `layerMemory`,
 * and a long-lived service provides the durable `JournalKeyValueStore.layer`,
 * then calls `Lifecycle.reconcileAll` at startup.
 */
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { isUnresolved, type JournalEntry, millisOf, oldestFirst, type Unresolved } from "./JournalEntry.ts"
import type { JournalError } from "./Outcome.ts"

/**
 * A stored entry that cannot be read back: it does not decode (truncated
 * write, a foreign value under the journal's keys, an unknown schema version)
 * or does not match its key. Listings report it instead of failing, so one
 * bad entry never strands the others; `remove(key)` deletes it.
 */
export interface CorruptEntry {
  /** The digest part of its key. */
  readonly key: string
  readonly reason: string
}

export interface UnresolvedListing {
  /** Every readable `Signed` / `Unknown` entry, oldest first. */
  readonly entries: ReadonlyArray<Unresolved>
  /** Entries that could not be read, by key. */
  readonly corrupt: ReadonlyArray<CorruptEntry>
}

export interface JournalService {
  /** Record an entry, replacing any earlier one for the same digest. */
  readonly put: (entry: JournalEntry) => Effect.Effect<void, JournalError>
  /** The entry for `digest`; an entry that cannot be read is a `JournalError`. */
  readonly get: (digest: string) => Effect.Effect<Option.Option<JournalEntry>, JournalError>
  /** Every unresolved entry, plus the entries that could not be read. */
  readonly listUnresolved: Effect.Effect<UnresolvedListing, JournalError>
  /**
   * Delete settled entries (`Executed`, `Failed`, `NotApplied`) recorded
   * strictly before `before`; answer how many. Unresolved and corrupt entries
   * are never deleted here, however old: use `remove`.
   */
  readonly pruneSettled: (before: DateTime.DateTime) => Effect.Effect<number, JournalError>
  /**
   * Delete the entry for `digest` (or a corrupt entry's key), whatever it
   * holds. The way to drop an unresolved submission you have given up on, e.g.
   * one whose validity window closed long ago but that no evidence settles.
   * The journal then forgets the bytes: nothing will reconcile or re-send them.
   */
  readonly remove: (digest: string) => Effect.Effect<void, JournalError>
}

/** Settled entries the in-memory journal keeps; the oldest are dropped beyond this. */
export const MEMORY_SETTLED_CAP = 10_000

/**
 * An in-memory journal over a `Map`. Survives nothing. Keeps every unresolved
 * entry and the latest `maxSettled` settled ones (default
 * {@link MEMORY_SETTLED_CAP}), so a long-lived process does not grow without bound.
 */
export const makeMemory = (options?: { readonly maxSettled?: number }): JournalService => {
  const max = options?.maxSettled ?? MEMORY_SETTLED_CAP
  const entries = new Map<string, JournalEntry>()
  // Settled digests in insertion order (a Set iterates in insertion order).
  const settled = new Set<string>()
  return {
    put: (entry) =>
      Effect.sync(() => {
        entries.set(entry.digest, entry)
        settled.delete(entry.digest)
        if (isUnresolved(entry)) return
        settled.add(entry.digest)
        while (settled.size > max) {
          const oldest = settled.values().next().value!
          settled.delete(oldest)
          entries.delete(oldest)
        }
      }),
    get: (digest) => Effect.sync(() => Option.fromNullishOr(entries.get(digest))),
    listUnresolved: Effect.sync(() => ({
      entries: [...entries.values()].filter(isUnresolved).sort(oldestFirst),
      corrupt: []
    })),
    pruneSettled: (before) =>
      Effect.sync(() => {
        const cutoff = DateTime.toEpochMillis(before)
        let n = 0
        for (const [digest, entry] of entries) {
          if (!isUnresolved(entry) && millisOf(entry) < cutoff) {
            entries.delete(digest)
            settled.delete(digest)
            n++
          }
        }
        return n
      }),
    remove: (digest) =>
      Effect.sync(() => {
        entries.delete(digest)
        settled.delete(digest)
      })
  }
}

export const Journal = Context.Reference<JournalService>("@unconfirmed/effect-sui/lifecycle/Journal", {
  defaultValue: () => makeMemory()
})

/** A fresh in-memory journal. */
export const layerMemory: Layer.Layer<never> = Layer.sync(Journal, () => makeMemory())
