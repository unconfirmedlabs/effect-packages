/**
 * Runs in a real browser (see browser-smoke.test.ts): the IndexedDB and OPFS
 * stores under the durable journal, and Web Locks across two layers.
 * Publishes its result as `window.__smoke`.
 */
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { JournalEntry } from "../../src/lifecycle/JournalEntry.ts"
import * as JournalKeyValueStore from "../../src/lifecycle/JournalKeyValueStore.ts"
import * as KeyValueStoreIndexedDb from "../../src/lifecycle/KeyValueStoreIndexedDb.ts"
import * as KeyValueStoreOpfs from "../../src/lifecycle/KeyValueStoreOpfs.ts"
import * as SenderLock from "../../src/lifecycle/SenderLock.ts"
import * as SenderLockWebLocks from "../../src/lifecycle/SenderLockWebLocks.ts"

const journalRoundTrip = (store: Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError>) =>
  Effect.gen(function*() {
    const kv = yield* KeyValueStore.KeyValueStore
    yield* kv.clear
    const journal = JournalKeyValueStore.make(kv)
    yield* journal.put(JournalEntry.cases.Executed.make({ digest: "D1", at: DateTime.makeUnsafe(5) }))
    yield* kv.set("bin", new Uint8Array([0, 1, 255]))
    const entry = yield* journal.get("D1")
    return {
      tag: Option.map(entry, (e) => e._tag).pipe(Option.getOrNull),
      keys: [...(yield* kv.keys)].sort(),
      bin: [...((yield* kv.getUint8Array("bin")) ?? [])]
    }
  }).pipe(Effect.provide(store))

const locks = Effect.gen(function*() {
  const tab = () => Effect.provide(Effect.service(SenderLock.SenderLock), SenderLockWebLocks.layer)
  const one = yield* tab()
  const two = yield* tab()
  let inFlight = 0
  let max = 0
  const work = Effect.gen(function*() {
    max = Math.max(max, ++inFlight)
    yield* Effect.sleep(20)
    inFlight--
  })
  yield* Effect.all([one.withLocks(["0xa", "0xb"])(work), two.withLocks(["0xb", "0xa"])(work)], { concurrency: "unbounded" })
  const holder = yield* Effect.forkChild(one.withLocks(["0xc"])(Effect.never))
  yield* Effect.sleep(20)
  yield* Fiber.interrupt(holder)
  const after = yield* two.withLocks(["0xc"])(Effect.succeed("released")).pipe(Effect.timeout(2_000))
  return { max, after }
})

/** Each part on its own: its result, or its typed failure as `Tag: message`. */
const part = <A, E extends { readonly _tag: string; readonly message: string }>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, {
    onSuccess: (ok) => ({ ok }),
    onFailure: (e) => ({ error: `${e._tag}: ${e.message}` })
  })

const program = Effect.all({
  indexedDb: part(journalRoundTrip(KeyValueStoreIndexedDb.layer({ database: "smoke" }))),
  opfs: part(journalRoundTrip(KeyValueStoreOpfs.layer({ directory: "smoke" }))),
  locks: part(locks)
})

Effect.runPromise(program).then((r) => {
  ;(globalThis as { __smoke?: unknown }).__smoke = r
}, (e) => {
  ;(globalThis as { __smoke?: unknown }).__smoke = { defect: String(e) }
})
