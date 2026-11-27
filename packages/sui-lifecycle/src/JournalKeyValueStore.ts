/**
 * The durable `Journal`, over Effect's `KeyValueStore` (`effect/persistence`).
 *
 * One key per entry, `entry:<digest>`, holding the entry as JSON; nothing is
 * read-modify-written, so two journals (or two processes) over one store do
 * not lose each other's entries. A terminal entry also gets a settled marker,
 * `settled:<digest>`: a negative index that lets `listUnresolved` skip it
 * (one `keys` plus one read per unresolved entry, however many settled ones
 * the store keeps). The write order makes a crash cost at worst one spurious
 * read, never a hidden entry:
 *
 * - unresolved put: clear marker, write entry, clear marker again;
 * - terminal put: write entry, write marker, re-read the entry and remove the
 *   marker unless the read confirms a terminal entry;
 * - a listing that reads an unmarked terminal entry marks it the same way
 *   (best effort).
 *
 * The one window it cannot close (it would need compare-and-set): a settling
 * writer that dies between its marker write and its re-read while another
 * writer's unresolved put of the same digest landed just before the marker.
 * That entry is then hidden from listings (never from `get`) until rewritten.
 *
 * Building the layer does no network work; call `Lifecycle.reconcileAll`.
 */
import * as Hash from "@unconfirmed/sui/Hash"
import * as Arr from "effect/Array"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Schema from "effect/Schema"
import { Journal, type JournalService } from "./Journal.ts"
import { isUnresolved, JournalEntry, millisOf, oldestFirst } from "./JournalEntry.ts"
import { JournalError } from "./Outcome.ts"

const ENTRY = "entry:"
const SETTLED = "settled:"
const CONCURRENCY = 8

const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(JournalEntry))
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(JournalEntry))

const journalError = (cause: unknown): JournalError =>
  new JournalError({ message: cause instanceof Error ? cause.message : String(cause) })

/**
 * An entry read from the store is checked, not trusted: it must sit under its
 * own digest, and signed bytes must hash to that digest.
 */
const checkEntry = (key: string) => (entry: JournalEntry): Effect.Effect<Option.Option<JournalEntry>, JournalError> => {
  if (entry.digest !== key) {
    return Effect.fail(new JournalError({ message: `the entry under ${key} is for ${entry.digest}` }))
  }
  if (entry._tag === "Signed" || entry._tag === "Unknown") {
    const computed = Hash.transactionDigest(entry.signed.bytes)
    if (computed !== entry.digest || entry.signed.digest !== entry.digest) {
      return Effect.fail(new JournalError({ message: `the entry ${entry.digest} holds bytes with digest ${computed}` }))
    }
  }
  return Effect.succeed(Option.some(entry))
}

const readEntry = (kv: KeyValueStore.KeyValueStore, digest: string) =>
  kv.get(`${ENTRY}${digest}`).pipe(
    Effect.mapError(journalError),
    Effect.flatMap((raw) =>
      raw === undefined
        ? Effect.succeed(Option.none<JournalEntry>())
        : decodeEntry(raw).pipe(Effect.mapError(journalError), Effect.flatMap(checkEntry(digest)))
    )
  )

const clearMarker = (kv: KeyValueStore.KeyValueStore, digest: string) =>
  Effect.gen(function*() {
    const key = `${SETTLED}${digest}`
    if (yield* kv.has(key)) yield* kv.remove(key)
  }).pipe(Effect.mapError(journalError))

const listKeys = (kv: KeyValueStore.KeyValueStore) =>
  Effect.map(Effect.mapError(kv.keys, journalError), (keys) => {
    const entries: Array<string> = []
    const settled = new Set<string>()
    for (const key of keys) {
      if (key.startsWith(ENTRY)) entries.push(key.slice(ENTRY.length))
      else if (key.startsWith(SETTLED)) settled.add(key.slice(SETTLED.length))
    }
    return { entries, settled }
  })

/** Mark settled, re-read, and take the marker back unless the read confirms a terminal entry. */
const settleMarker = (kv: KeyValueStore.KeyValueStore, entry: JournalEntry) =>
  Effect.gen(function*() {
    const key = `${SETTLED}${entry.digest}`
    yield* Effect.mapError(kv.set(key, entry._tag), journalError)
    const confirmed = yield* readEntry(kv, entry.digest).pipe(
      Effect.map((again) => Option.isSome(again) && !isUnresolved(again.value)),
      Effect.orElseSucceed(() => false)
    )
    if (!confirmed) yield* Effect.mapError(kv.remove(key), journalError)
  })

/** A journal over `store`, optionally under a key prefix. Every member fails only with `JournalError`. */
export const make = (store: KeyValueStore.KeyValueStore, options?: { readonly prefix?: string }): JournalService => {
  const kv = options?.prefix === undefined ? store : KeyValueStore.prefix(store, options.prefix)
  return {
    put: Effect.fn("Journal.put")(function*(entry: JournalEntry) {
      const json = yield* Effect.mapError(encodeEntry(entry), journalError)
      const set = Effect.mapError(kv.set(`${ENTRY}${entry.digest}`, json), journalError)
      if (isUnresolved(entry)) {
        yield* clearMarker(kv, entry.digest)
        yield* set
        yield* clearMarker(kv, entry.digest)
      } else {
        yield* set
        yield* settleMarker(kv, entry)
      }
    }),
    get: (digest) => readEntry(kv, digest).pipe(Effect.withSpan("Journal.get")),
    listUnresolved: Effect.gen(function*() {
      const { entries, settled } = yield* listKeys(kv)
      const read = yield* Effect.forEach(
        entries.filter((digest) => !settled.has(digest)),
        (digest) =>
          readEntry(kv, digest).pipe(
            Effect.tap((entry) =>
              Option.isSome(entry) && !isUnresolved(entry.value)
                ? Effect.ignore(settleMarker(kv, entry.value))
                : Effect.void
            )
          ),
        { concurrency: CONCURRENCY }
      )
      return Arr.getSomes(read).filter(isUnresolved).sort(oldestFirst)
    }).pipe(Effect.withSpan("Journal.listUnresolved")),
    pruneSettled: Effect.fn("Journal.pruneSettled")(function*(before: DateTime.DateTime) {
      const cutoff = DateTime.toEpochMillis(before)
      const { entries, settled: markers } = yield* listKeys(kv)
      const read = Arr.getSomes(
        yield* Effect.forEach(entries, (digest) => readEntry(kv, digest), { concurrency: CONCURRENCY })
      )
      const prunable = read.filter((entry) => !isUnresolved(entry) && millisOf(entry) < cutoff)
      // Marker first: a crash in between leaves an unmarked settled entry, read once later.
      // Then re-read: an unresolved entry written for the digest since the bulk
      // read (the same bytes submitted again) is never deleted. Without a
      // compare-and-set the window between this re-read and the remove remains.
      const deleted = yield* Effect.forEach(
        prunable,
        (entry) =>
          Effect.gen(function*() {
            yield* Effect.mapError(kv.remove(`${SETTLED}${entry.digest}`), journalError)
            const again = yield* readEntry(kv, entry.digest)
            if (
              Option.isNone(again) || isUnresolved(again.value) || again.value._tag !== entry._tag ||
              millisOf(again.value) !== millisOf(entry)
            ) {
              if (Option.isSome(again) && !isUnresolved(again.value)) yield* Effect.ignore(settleMarker(kv, again.value))
              return 0
            }
            yield* Effect.mapError(kv.remove(`${ENTRY}${entry.digest}`), journalError)
            return 1
          }),
        { concurrency: CONCURRENCY }
      )
      const present = new Set(entries)
      yield* Effect.forEach(
        [...markers].filter((digest) => !present.has(digest)),
        (digest) => Effect.mapError(kv.remove(`${SETTLED}${digest}`), journalError),
        { concurrency: CONCURRENCY, discard: true }
      )
      return deleted.reduce((a: number, b: number) => a + b, 0)
    })
  }
}

export interface Options {
  /**
   * `"fail"` refuses to build while the store holds unresolved entries (settle
   * them first with `Lifecycle.reconcileAll` under another journal layer, or by
   * hand); `"ignore"` builds and leaves them for `reconcileAll`. Default `"ignore"`.
   */
  readonly onUnresolved?: "fail" | "ignore"
  /** A key prefix, so several journals can share one store. */
  readonly prefix?: string
}

/** The durable journal as a layer over whatever `KeyValueStore` is provided. */
export const layer = (options?: Options): Layer.Layer<never, JournalError, KeyValueStore.KeyValueStore> =>
  Layer.effect(
    Journal,
    Effect.gen(function*() {
      const journal = make(yield* KeyValueStore.KeyValueStore, options?.prefix === undefined ? {} : { prefix: options.prefix })
      if (options?.onUnresolved === "fail") {
        const unresolved = yield* journal.listUnresolved
        if (unresolved.length > 0) {
          return yield* new JournalError({
            message: `the journal holds ${unresolved.length} unresolved submission(s): ${
              unresolved.map((e) => e.digest).join(", ")
            }; settle them with Lifecycle.reconcileAll or build with { onUnresolved: "ignore" }`
          })
        }
      }
      return journal
    })
  )
