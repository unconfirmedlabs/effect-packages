/**
 * The durable `Journal`, over Effect's `KeyValueStore` (`effect/persistence`).
 *
 * One key per entry, `entry:<digest>`, holding the entry as JSON with a schema
 * version (`{"v":1,...}`; entries written before versioning have no `v` and
 * are read as version 1). Nothing is read-modify-written, so two journals (or
 * two processes) over one store do not lose each other's entries. A terminal
 * entry also gets a settled marker, `settled:<digest>`: a negative index that
 * lets `listUnresolved` skip it (one `keys` plus one read per unresolved
 * entry, however many settled ones the store keeps). The write order makes a
 * crash cost at worst one spurious read, never a hidden entry:
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
 * An entry that cannot be read back (does not parse or decode, has a schema
 * version this code does not know, sits under another digest's key, or holds
 * bytes of another digest) is reported in the listing's `corrupt` list, never
 * a failure of the whole listing; `get` of it is a `JournalError`, and
 * `remove` deletes it.
 *
 * Building the layer does no network work; call `Lifecycle.reconcileAll`.
 */
import * as Hash from "@unconfirmed/sui/Hash"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { type CorruptEntry, Journal, type JournalService } from "./Journal.ts"
import { isUnresolved, JournalEntry, millisOf, oldestFirst, type Unresolved } from "./JournalEntry.ts"
import { JournalError } from "./Outcome.ts"

const ENTRY = "entry:"
const SETTLED = "settled:"
const CONCURRENCY = 8

/**
 * The stored schema version. Bump it, and keep reading the older ones, when
 * `JournalEntry` changes shape. An added optional field (`include`) is no
 * change of shape: older entries decode without it, and older code reading a
 * newer entry drops it rather than reporting the entry corrupt, so the signed
 * bytes are never stranded.
 */
export const VERSION = 1

const decodeEntry = Schema.decodeUnknownEffect(JournalEntry)
const encodeEntry = Schema.encodeEffect(JournalEntry)

const journalError = (cause: unknown): JournalError =>
  new JournalError({ message: cause instanceof Error ? cause.message : String(cause) })

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** The stored JSON for an entry, versioned. */
const encode = (entry: JournalEntry): Effect.Effect<string, JournalError> =>
  Effect.map(Effect.mapError(encodeEntry(entry), journalError), (encoded) => JSON.stringify({ v: VERSION, ...encoded }))

/**
 * Decode and check a stored value: the reason it is unreadable, or the entry.
 * It must be a known version, sit under its own digest, and signed bytes must
 * hash to that digest.
 */
const decode = (key: string, raw: string): Effect.Effect<Result.Result<JournalEntry, string>> =>
  Effect.gen(function*() {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (e) {
      return Result.fail(`not JSON: ${messageOf(e)}`)
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) return Result.fail("not a JSON object")
    const { v, ...rest } = json as Record<string, unknown>
    if (v !== undefined && v !== VERSION) return Result.fail(`unknown journal schema version ${JSON.stringify(v)}`)
    const decoded = yield* Effect.result(decodeEntry(rest))
    if (decoded._tag === "Failure") return Result.fail(`does not decode: ${messageOf(decoded.failure)}`)
    const entry = decoded.success
    if (entry.digest !== key) return Result.fail(`the entry under ${key} is for ${entry.digest}`)
    if (entry._tag === "Signed" || entry._tag === "Unknown") {
      const computed = Hash.transactionDigest(entry.signed.bytes)
      if (computed !== entry.digest || entry.signed.digest !== entry.digest) {
        return Result.fail(`the entry ${entry.digest} holds bytes with digest ${computed}`)
      }
    }
    return Result.succeed(entry)
  })

type Read =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Entry"; readonly entry: JournalEntry }
  | { readonly _tag: "Corrupt"; readonly corrupt: CorruptEntry }

/** Read one entry; a store failure is a `JournalError`, an unreadable value is `Corrupt`. */
const read = (kv: KeyValueStore.KeyValueStore, digest: string): Effect.Effect<Read, JournalError> =>
  kv.get(`${ENTRY}${digest}`).pipe(
    Effect.mapError(journalError),
    Effect.flatMap((raw): Effect.Effect<Read> =>
      raw === undefined
        ? Effect.succeed({ _tag: "Missing" })
        : Effect.map(decode(digest, raw), (r): Read =>
          r._tag === "Success"
            ? { _tag: "Entry", entry: r.success }
            : { _tag: "Corrupt", corrupt: { key: digest, reason: r.failure } })
    )
  )

/** `read` for `get`: an unreadable entry is a `JournalError`. */
const readEntry = (kv: KeyValueStore.KeyValueStore, digest: string): Effect.Effect<Option.Option<JournalEntry>, JournalError> =>
  Effect.flatMap(read(kv, digest), (r) =>
    r._tag === "Missing"
      ? Effect.succeedNone
      : r._tag === "Entry"
      ? Effect.succeedSome(r.entry)
      : Effect.fail(new JournalError({ message: `the journal entry ${digest} cannot be read: ${r.corrupt.reason}` })))

/** Removing a key that is absent is a no-op in every `KeyValueStore`. */
const clearMarker = (kv: KeyValueStore.KeyValueStore, digest: string) =>
  Effect.mapError(kv.remove(`${SETTLED}${digest}`), journalError)

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
    const confirmed = yield* read(kv, entry.digest).pipe(
      Effect.map((again) => again._tag === "Entry" && !isUnresolved(again.entry)),
      Effect.orElseSucceed(() => false)
    )
    if (!confirmed) yield* Effect.mapError(kv.remove(key), journalError)
  })

/** A journal over `store`, optionally under a key prefix. Every member fails only with `JournalError`. */
export const make = (store: KeyValueStore.KeyValueStore, options?: { readonly prefix?: string }): JournalService => {
  const kv = options?.prefix === undefined ? store : KeyValueStore.prefix(store, options.prefix)
  return {
    put: Effect.fn("Journal.put")(function*(entry: JournalEntry) {
      const json = yield* encode(entry)
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
      const reads = yield* Effect.forEach(
        entries.filter((digest) => !settled.has(digest)),
        (digest) =>
          read(kv, digest).pipe(
            Effect.tap((r) => r._tag === "Entry" && !isUnresolved(r.entry) ? Effect.ignore(settleMarker(kv, r.entry)) : Effect.void)
          ),
        { concurrency: CONCURRENCY }
      )
      const unresolved: Array<Unresolved> = []
      const corrupt: Array<CorruptEntry> = []
      for (const r of reads) {
        if (r._tag === "Entry" && isUnresolved(r.entry)) unresolved.push(r.entry)
        else if (r._tag === "Corrupt") corrupt.push(r.corrupt)
      }
      if (corrupt.length > 0) {
        yield* Effect.logWarning(`the journal holds ${corrupt.length} unreadable entr${corrupt.length === 1 ? "y" : "ies"}`).pipe(
          Effect.annotateLogs({ corrupt: corrupt.map((c) => `${c.key}: ${c.reason}`).join("; ") })
        )
      }
      return { entries: unresolved.sort(oldestFirst), corrupt }
    }).pipe(Effect.withSpan("Journal.listUnresolved")),
    pruneSettled: Effect.fn("Journal.pruneSettled")(function*(before: DateTime.DateTime) {
      const cutoff = DateTime.toEpochMillis(before)
      const { entries, settled: markers } = yield* listKeys(kv)
      const reads = yield* Effect.forEach(entries, (digest) => read(kv, digest), { concurrency: CONCURRENCY })
      const prunable: Array<JournalEntry> = []
      for (const r of reads) {
        if (r._tag === "Entry" && !isUnresolved(r.entry) && millisOf(r.entry) < cutoff) prunable.push(r.entry)
      }
      // Marker first: a crash in between leaves an unmarked settled entry, read once later.
      // Then re-read: an unresolved entry written for the digest since the bulk
      // read (the same bytes submitted again) is never deleted. Without a
      // compare-and-set the window between this re-read and the remove remains.
      const deleted = yield* Effect.forEach(
        prunable,
        (entry) =>
          Effect.gen(function*() {
            yield* clearMarker(kv, entry.digest)
            const again = yield* read(kv, entry.digest)
            if (
              again._tag !== "Entry" || isUnresolved(again.entry) || again.entry._tag !== entry._tag ||
              millisOf(again.entry) !== millisOf(entry)
            ) {
              if (again._tag === "Entry" && !isUnresolved(again.entry)) yield* Effect.ignore(settleMarker(kv, again.entry))
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
        (digest) => clearMarker(kv, digest),
        { concurrency: CONCURRENCY, discard: true }
      )
      return deleted.reduce((a: number, b: number) => a + b, 0)
    }),
    remove: Effect.fn("Journal.remove")(function*(digest: string) {
      // Entry first: a crash in between leaves an orphan marker, which `pruneSettled` clears.
      yield* Effect.mapError(kv.remove(`${ENTRY}${digest}`), journalError)
      yield* clearMarker(kv, digest)
    })
  }
}

export interface Options {
  /**
   * `"fail"` refuses to build while the store holds unresolved or unreadable
   * entries (settle them first with `Lifecycle.reconcileAll` under another
   * journal layer, or by hand); `"ignore"` builds and leaves them for
   * `reconcileAll`. Default `"ignore"`.
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
        const { entries, corrupt } = yield* journal.listUnresolved
        if (entries.length > 0 || corrupt.length > 0) {
          const parts = [
            ...(entries.length > 0
              ? [`${entries.length} unresolved submission(s): ${entries.map((e) => e.digest).join(", ")}`]
              : []),
            ...(corrupt.length > 0
              ? [`${corrupt.length} unreadable entr${corrupt.length === 1 ? "y" : "ies"}: ${corrupt.map((c) => c.key).join(", ")}`]
              : [])
          ]
          return yield* new JournalError({
            message: `the journal holds ${parts.join(" and ")}; settle them with Lifecycle.reconcileAll ` +
              `(unreadable ones with Journal.remove) or build with { onUnresolved: "ignore" }`
          })
        }
      }
      return journal
    })
  )
