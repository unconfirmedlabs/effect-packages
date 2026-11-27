/**
 * The browser stores and lock, in Bun: `KeyValueStoreIndexedDb` over
 * `fake-indexeddb`, `KeyValueStoreOpfs` over the fake OPFS and
 * `SenderLockWebLocks` over the fake `LockManager` from test-support. The
 * journal suite itself runs over both stores in journal.test.ts; this file
 * covers what is specific to each (connections, encoding, atomicity, every
 * error mapping, interruption, two tabs).
 */
import { afterEach, describe, expect, test } from "bun:test"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Scope from "effect/Scope"
import { forceCloseDatabase, IDBDatabase as FDBDatabase, IDBFactory, IDBObjectStore as FDBObjectStore } from "fake-indexeddb"
import { makeFakeLockManager } from "@unconfirmed/test-support/locks"
import { makeFakeOpfs } from "@unconfirmed/test-support/opfs"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Ptb from "@unconfirmed/sui/Ptb"
import * as Resolve from "@unconfirmed/sui/Resolve"
import * as Journal from "../src/Journal.ts"
import * as KeyValueStoreIndexedDb from "../src/KeyValueStoreIndexedDb.ts"
import * as KeyValueStoreOpfs from "../src/KeyValueStoreOpfs.ts"
import * as Lifecycle from "../src/Lifecycle.ts"
import * as SenderLock from "../src/SenderLock.ts"
import * as SenderLockWebLocks from "../src/SenderLockWebLocks.ts"
import * as SubmitConfig from "../src/SubmitConfig.ts"
import "./stores.ts" // installs IDBKeyRange
import { COIN, layer as worldLayer, makeWorld, ownedObject } from "./world.ts"

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()!()
})
/** Replace `proto[name]` for this test. */
const patch = <T extends object, K extends keyof T>(proto: T, name: K, make: (original: T[K]) => T[K]) => {
  const original = proto[name]
  proto[name] = make(original)
  restores.push(() => {
    proto[name] = original
  })
}
const setGlobal = (name: string, value: unknown) => {
  const g = globalThis as Record<string, unknown>
  const had = name in g
  const original = g[name]
  g[name] = value
  restores.push(() => {
    if (had) g[name] = original
    else delete g[name]
  })
}

const withStore = <A, E>(
  storeLayer: Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError>,
  f: (kv: KeyValueStore.KeyValueStore) => Effect.Effect<A, E>
) => Effect.runPromise(Effect.flatMap(Effect.service(KeyValueStore.KeyValueStore), f).pipe(Effect.provide(storeLayer)))

const buildError = <A>(storeLayer: Layer.Layer<A, KeyValueStore.KeyValueStoreError>) =>
  Effect.runPromise(Effect.flip(Layer.build(storeLayer).pipe(Effect.scoped)))

/** A factory that records every connection it opens. */
const recording = (factory = new IDBFactory()) => {
  const opened: Array<IDBDatabase> = []
  const wrapped = {
    open: (name: string, version?: number) => {
      const req = version === undefined ? factory.open(name) : factory.open(name, version)
      req.addEventListener("success", () => opened.push(req.result))
      return req
    },
    deleteDatabase: (name: string) => factory.deleteDatabase(name),
    databases: () => factory.databases(),
    cmp: (a: unknown, b: unknown) => factory.cmp(a, b)
  } as unknown as IDBFactory
  return { factory, wrapped, opened }
}

const openRaw = (factory: IDBFactory, name: string, version?: number, upgrade?: (db: IDBDatabase) => void) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = version === undefined ? factory.open(name) : factory.open(name, version)
    req.onupgradeneeded = () => upgrade?.(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

describe("KeyValueStoreIndexedDb", () => {
  test("strings and bytes round-trip, and every member works", async () => {
    const r = await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: new IDBFactory() }), (kv) =>
      Effect.gen(function*() {
        yield* kv.set("s", "héllo")
        yield* kv.set("b", new Uint8Array([1, 2, 255]))
        yield* kv.set("p/1", "x")
        yield* kv.set("p/2", "y")
        yield* kv.set("q", "z")
        const out = {
          s: yield* kv.get("s"),
          sBytes: yield* kv.getUint8Array("s"),
          b: yield* kv.getUint8Array("b"),
          bString: yield* kv.get("b"),
          missing: yield* kv.get("nope"),
          has: [yield* kv.has("s"), yield* kv.has("nope")],
          size: yield* kv.size,
          modified: yield* kv.modify("s", (v) => v + "!"),
          modifiedMissing: yield* kv.modify("nope", (v) => v),
          afterModify: yield* kv.get("s"),
          modBytes: yield* kv.modifyUint8Array("b", (v) => v.map((x) => x ^ 1))
        }
        yield* kv.clearPrefix("p/")
        const afterPrefix = [...(yield* kv.keys)].sort()
        yield* kv.remove("q")
        yield* kv.remove("q") // absent: a no-op
        const afterRemove = [...(yield* kv.keys)].sort()
        yield* kv.clear
        return { ...out, afterPrefix, afterRemove, empty: yield* kv.isEmpty }
      }))
    expect(r.s).toBe("héllo")
    expect(r.sBytes).toEqual(new TextEncoder().encode("héllo"))
    expect(r.b).toEqual(new Uint8Array([1, 2, 255]))
    expect(r.bString).toBe("AQL/")
    expect(r.missing).toBeUndefined()
    expect(r.has).toEqual([true, false])
    expect(r.size).toBe(5)
    expect(r.modified).toBe("héllo!")
    expect(r.modifiedMissing).toBeUndefined()
    expect(r.afterModify).toBe("héllo!")
    expect(r.modBytes).toEqual(new Uint8Array([0, 3, 254]))
    expect(r.afterPrefix).toEqual(["b", "q", "s"])
    expect(r.afterRemove).toEqual(["b", "s"])
    expect(r.empty).toBe(true)
  })

  test("values persist across layers; the connection closes with the scope", async () => {
    const { wrapped, opened } = recording()
    await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: wrapped, database: "d", store: "s" }), (kv) => kv.set("k", "v"))
    expect(opened.length).toBe(1)
    expect(() => opened[0]!.transaction("s", "readonly")).toThrow(expect.objectContaining({ name: "InvalidStateError" }))
    const again = await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: wrapped, database: "d", store: "s" }), (kv) => kv.get("k"))
    expect(again).toBe("v")
  })

  test("writes ask for strict durability", async () => {
    const seen: Array<string> = []
    patch(FDBDatabase.prototype, "transaction", (original) =>
      function(this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
        seen.push(`${args[1] ?? "readonly"}:${(args[2] as { durability?: string } | undefined)?.durability ?? "default"}`)
        return original.apply(this, args)
      } as IDBDatabase["transaction"])
    await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: new IDBFactory() }), (kv) => Effect.andThen(kv.set("k", "v"), kv.get("k")))
    expect(seen.filter((s) => !s.startsWith("versionchange"))).toEqual(["readwrite:strict", "readonly:default"])
  })

  test("another tab's upgrade closes the connection, and the next operation reopens it", async () => {
    const { factory, wrapped, opened } = recording()
    const r = await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: wrapped }), (kv) =>
      Effect.gen(function*() {
        yield* kv.set("k", "v")
        const version = opened[0]!.version
        // Another tab opens one version up: ours gets versionchange, closes, and does not block it.
        const other = yield* Effect.promise(() => openRaw(factory, KeyValueStoreIndexedDb.DEFAULT_DATABASE, version + 1))
        other.close()
        const afterUpgrade = yield* kv.get("k")
        // Deleted under us: the store is recreated, empty.
        yield* Effect.promise(() =>
          new Promise<void>((resolve, reject) => {
            const req = factory.deleteDatabase(KeyValueStoreIndexedDb.DEFAULT_DATABASE)
            req.onsuccess = () => resolve()
            req.onerror = () => reject(req.error)
          })
        )
        const afterDelete = yield* kv.get("k")
        yield* kv.set("k", "w")
        // Closed by the browser (storage cleared, ...): reopened too.
        forceCloseDatabase(opened[opened.length - 1]! as never)
        const afterForceClose = yield* kv.get("k")
        return { afterUpgrade, afterDelete, afterForceClose, connections: opened.length }
      }))
    expect(r).toEqual({ afterUpgrade: "v", afterDelete: undefined, afterForceClose: "w", connections: 4 })
  })

  test("a database whose store is missing is upgraded to add it", async () => {
    const factory = new IDBFactory()
    const raw = await openRaw(factory, "shared", 3, (db) => db.createObjectStore("other"))
    raw.close()
    expect(await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: factory, database: "shared" }), (kv) => Effect.andThen(kv.set("k", "v"), kv.get("k"))))
      .toBe("v")
    const after = await openRaw(factory, "shared")
    expect([after.version, Array.from(after.objectStoreNames).sort()]).toEqual([4, ["kv", "other"]])
    after.close()
  })

  describe("errors are KeyValueStoreError", () => {
    test("IndexedDB missing", async () => {
      const e = await buildError(KeyValueStoreIndexedDb.layer())
      expect(e).toBeInstanceOf(KeyValueStore.KeyValueStoreError)
      expect(e.method).toBe("open")
      expect(e.message).toContain("IndexedDB is not available")
    })

    test("open refused (private mode), asynchronously or by a throw", async () => {
      const failing = {
        open: () => {
          const req = {} as { error?: DOMException; onerror?: () => void }
          queueMicrotask(() => {
            req.error = new DOMException("A mutation operation was attempted on a database that did not allow mutations.", "InvalidStateError")
            req.onerror?.()
          })
          return req
        }
      } as unknown as IDBFactory
      const e = await buildError(KeyValueStoreIndexedDb.layer({ indexedDB: failing }))
      expect(e.message).toContain("InvalidStateError")
      const throwing = { open: () => { throw new DOMException("denied", "SecurityError") } } as unknown as IDBFactory
      expect((await buildError(KeyValueStoreIndexedDb.layer({ indexedDB: throwing }))).message).toContain("SecurityError")
    })

    test("an upgrade blocked by a connection that ignores versionchange", async () => {
      const factory = new IDBFactory()
      const stubborn = await openRaw(factory, "blocked", 1) // no store, never closes
      const e = await buildError(KeyValueStoreIndexedDb.layer({ indexedDB: factory, database: "blocked" }))
      expect(e.message).toContain("blocked")
      stubborn.close()
      // Once it is gone, the store opens.
      expect(await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: factory, database: "blocked" }), (kv) => kv.size)).toBe(0)
    })

    test("quota, thrown by put or as the transaction's abort; the old value stays", async () => {
      const r = await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: new IDBFactory() }), (kv) =>
        Effect.gen(function*() {
          yield* kv.set("k", "old")
          let mode: "throw" | "abort" = "throw"
          patch(FDBObjectStore.prototype, "put", (original) =>
            function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
              if (mode === "throw") throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
              const req = original.apply(this, args)
              ;(this.transaction as unknown as { _abort(name: string): void })._abort("QuotaExceededError")
              return req
            } as IDBObjectStore["put"])
          const thrown = yield* Effect.flip(kv.set("k", "new"))
          mode = "abort"
          const aborted = yield* Effect.flip(kv.set("k", "new"))
          return { thrown, aborted, value: yield* kv.get("k") }
        }))
      for (const e of [r.thrown, r.aborted]) {
        expect(e).toBeInstanceOf(KeyValueStore.KeyValueStoreError)
        expect(e.method).toBe("set")
        expect(e.key).toBe("k")
        expect(e.message).toContain("QuotaExceededError")
      }
      expect(r.value).toBe("old")
    })

    test("a transaction aborted by someone else", async () => {
      const e = await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: new IDBFactory() }), (kv) => {
        patch(FDBObjectStore.prototype, "delete", (original) =>
          function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["delete"]>) {
            const req = original.apply(this, args)
            this.transaction.abort()
            return req
          } as IDBObjectStore["delete"])
        return Effect.flip(kv.remove("k"))
      })
      expect(e.method).toBe("remove")
      expect(e.message).toContain("AbortError")
    })

    test("InvalidStateError from transaction(), after one reopen", async () => {
      const { wrapped, opened } = recording()
      const e = await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: wrapped }), (kv) => {
        patch(FDBDatabase.prototype, "transaction", () =>
          (() => {
            throw new DOMException("The database connection is closing.", "InvalidStateError")
          }) as IDBDatabase["transaction"])
        return Effect.flip(kv.get("k"))
      })
      expect(e.method).toBe("get")
      expect(e.message).toContain("InvalidStateError")
      expect(opened.length).toBe(2)
    })

    test("a value this store did not write, and a failing modify function", async () => {
      const factory = new IDBFactory()
      const r = await withStore(KeyValueStoreIndexedDb.layer({ indexedDB: factory, database: "foreign" }), (kv) =>
        Effect.gen(function*() {
          const raw = yield* Effect.promise(() => openRaw(factory, "foreign"))
          yield* Effect.promise(() =>
            new Promise<void>((resolve) => {
              const tx = raw.transaction("kv", "readwrite")
              tx.objectStore("kv").put({ not: "ours" }, "obj")
              tx.oncomplete = () => resolve()
            })
          )
          raw.close()
          yield* kv.set("k", "v")
          return {
            foreign: yield* Effect.flip(kv.get("obj")),
            thrown: yield* Effect.flip(kv.modify("k", () => {
              throw new Error("boom")
            })),
            kept: yield* kv.get("k")
          }
        }))
      expect(r.foreign.message).toContain("not a string or bytes")
      expect(r.thrown.message).toContain("boom")
      expect(r.kept).toBe("v")
    })

    test("using the store after its scope closed", async () => {
      const r = await Effect.runPromise(Effect.gen(function*() {
        const scope = yield* Scope.make()
        const kv = yield* KeyValueStoreIndexedDb.make({ indexedDB: new IDBFactory() }).pipe(Scope.provide(scope))
        yield* Scope.close(scope, Exit.void)
        return yield* Effect.flip(kv.get("k"))
      }))
      expect(r.message).toContain("scope is closed")
    })
  })
})

describe("KeyValueStoreOpfs", () => {
  test("key encoding is reversible and file-name safe", () => {
    expect(KeyValueStoreOpfs.encodeKey("entry:Ab1")).toBe("k.entry%3AAb1")
    for (const key of ["", ".", "..", "a/b\\c", "ü😀", "%41", "settled:x", "k.", " sp ace"]) {
      const name = KeyValueStoreOpfs.encodeKey(key)
      expect(name).toMatch(/^k\.[A-Za-z0-9_%-]*$/)
      expect(KeyValueStoreOpfs.decodeKey(name)).toBe(key)
    }
    // Not ours, or not the canonical encoding.
    for (const name of ["foo", "k.%zz", "k.%41", "k.%3a", "k.a.b", "x.crswap"]) expect(KeyValueStoreOpfs.decodeKey(name)).toBeUndefined()
  })

  test("a file per key in the sub-directory; strings and bytes; foreign files ignored", async () => {
    const opfs = makeFakeOpfs()
    opfs.put("app/data/notes.txt", new Uint8Array([1]))
    opfs.put("app/data/k.%zz", new Uint8Array([1]))
    const r = await withStore(KeyValueStoreOpfs.layer({ root: opfs.getDirectory, directory: "app/data" }), (kv) =>
      Effect.gen(function*() {
        yield* kv.set("entry:A", "{\"v\":1}")
        yield* kv.set("bin", new Uint8Array([0, 255]))
        yield* kv.set("p/1", "x")
        const out = {
          get: yield* kv.get("entry:A"),
          bytes: yield* kv.getUint8Array("bin"),
          missing: yield* kv.get("nope"),
          has: [yield* kv.has("bin"), yield* kv.has("nope")],
          keys: [...(yield* kv.keys)].sort(),
          size: yield* kv.size
        }
        yield* kv.clearPrefix("p/")
        yield* kv.remove("nope") // absent: a no-op
        const afterPrefix = [...(yield* kv.keys)].sort()
        yield* kv.clear
        return { ...out, afterPrefix, empty: yield* kv.isEmpty }
      }))
    expect(r.get).toBe("{\"v\":1}")
    expect(r.bytes).toEqual(new Uint8Array([0, 255]))
    expect(r.missing).toBeUndefined()
    expect(r.has).toEqual([true, false])
    expect(r.keys).toEqual(["bin", "entry:A", "p/1"])
    expect(r.size).toBe(3)
    expect(r.afterPrefix).toEqual(["bin", "entry:A"])
    expect(r.empty).toBe(true)
    expect([...opfs.list("app/data")].sort()).toEqual(["k.%zz", "notes.txt"])
  })

  test("writes commit on close: a failed write or close leaves the old value", async () => {
    const opfs = makeFakeOpfs()
    const r = await withStore(KeyValueStoreOpfs.layer({ root: opfs.getDirectory }), (kv) =>
      Effect.gen(function*() {
        yield* kv.set("k", "old")
        opfs.options.fail = (op) => op === "write" ? new DOMException("disk", "UnknownError") : undefined
        const write = yield* Effect.flip(kv.set("k", "new"))
        opfs.options.fail = (op) => op === "close" ? new DOMException("disk", "InvalidStateError") : undefined
        const close = yield* Effect.flip(kv.set("k", "new"))
        opfs.options.fail = undefined
        return { write, close, value: yield* kv.get("k") }
      }))
    expect(r.write.message).toContain("UnknownError")
    expect(r.close.message).toContain("InvalidStateError")
    expect(r.value).toBe("old")
    expect(new TextDecoder().decode(opfs.read(`${KeyValueStoreOpfs.DEFAULT_DIRECTORY}/k.k`))).toBe("old")
  })

  describe("errors are KeyValueStoreError", () => {
    test("quota; the old value stays", async () => {
      const opfs = makeFakeOpfs({ quota: 8 })
      const r = await withStore(KeyValueStoreOpfs.layer({ root: opfs.getDirectory }), (kv) =>
        Effect.gen(function*() {
          yield* kv.set("k", "small")
          return { e: yield* Effect.flip(kv.set("k", "far too large")), value: yield* kv.get("k") }
        }))
      expect(r.e).toBeInstanceOf(KeyValueStore.KeyValueStoreError)
      expect([r.e.method, r.e.key]).toEqual(["set", "k"])
      expect(r.e.message).toContain("QuotaExceededError")
      expect(r.value).toBe("small")
    })

    test("OPFS missing, or getDirectory refused", async () => {
      const missing = await buildError(KeyValueStoreOpfs.layer())
      expect(missing.method).toBe("open")
      expect(missing.message).toContain("not available")
      setGlobal("navigator", { storage: { getDirectory: () => Promise.reject(new DOMException("private", "SecurityError")) } })
      expect((await buildError(KeyValueStoreOpfs.layer())).message).toContain("SecurityError")
    })

    test("createWritable missing (Safari before 26): at build when detectable, else at set", async () => {
      setGlobal("FileSystemFileHandle", class {})
      expect((await buildError(KeyValueStoreOpfs.layer({ root: makeFakeOpfs().getDirectory }))).message).toContain("createWritable")
      restores.pop()!()
      const e = await withStore(
        KeyValueStoreOpfs.layer({ root: makeFakeOpfs({ noCreateWritable: true }).getDirectory }),
        (kv) => Effect.flip(kv.set("k", "v"))
      )
      expect(e.message).toContain("NotSupportedError")
    })

    test("read, remove, list and type failures; NotFound is absence", async () => {
      const opfs = makeFakeOpfs()
      const r = await withStore(KeyValueStoreOpfs.layer({ root: opfs.getDirectory }), (kv) =>
        Effect.gen(function*() {
          yield* kv.set("k", "v")
          opfs.options.fail = (op) => op === "getFile" ? new DOMException("locked", "NoModificationAllowedError") : undefined
          const read = yield* Effect.flip(kv.get("k"))
          opfs.options.fail = (op) => op === "removeEntry" ? new DOMException("nope", "NotAllowedError") : undefined
          const remove = yield* Effect.flip(kv.remove("k"))
          opfs.options.fail = (op) => op === "entries" ? new DOMException("gone", "NotFoundError") : undefined
          const keys = yield* Effect.flip(kv.keys)
          opfs.options.fail = (op) => op === "getFile" ? new DOMException("raced", "NotFoundError") : undefined
          const raced = yield* kv.get("k")
          opfs.options.fail = undefined
          return { read, remove, keys, raced }
        }))
      expect(r.read.message).toContain("NoModificationAllowedError")
      expect(r.remove.message).toContain("NotAllowedError")
      expect(r.keys.method).toBe("keys")
      expect(r.raced).toBeUndefined()
      // A directory under a key's name.
      const dirs = makeFakeOpfs()
      const e = await withStore(KeyValueStoreOpfs.layer({ root: dirs.getDirectory }), (kv) =>
        Effect.gen(function*() {
          const root = yield* Effect.promise(dirs.getDirectory)
          const dir = yield* Effect.promise(() => root.getDirectoryHandle(KeyValueStoreOpfs.DEFAULT_DIRECTORY))
          yield* Effect.promise(() => dir.getDirectoryHandle("k.k", { create: true }))
          return yield* Effect.flip(kv.get("k"))
        }))
      expect(e.message).toContain("TypeMismatchError")
    })

    test("keys that cannot be file names", async () => {
      const r = await withStore(KeyValueStoreOpfs.layer({ root: makeFakeOpfs().getDirectory }), (kv) =>
        Effect.all([Effect.flip(kv.set("x".repeat(300), "v")), Effect.flip(kv.set("\uD800", "v"))]))
      expect(r[0].message).toContain("over 255")
      expect(r[1].message).toContain("lone surrogate")
    })
  })
})

describe("SenderLockWebLocks", () => {
  const A = "0x" + "a".repeat(64)
  const B = "0x" + "b".repeat(64)
  const name = (address: string) => `${SenderLockWebLocks.DEFAULT_PREFIX}${address}`

  const serviceOf = (l: Layer.Layer<never, SenderLockWebLocks.SenderLockUnavailable>) =>
    Effect.runPromise(Effect.service(SenderLock.SenderLock).pipe(Effect.provide(l)))
  /** One "tab": its own layer, over the origin's shared lock manager. */
  const tab = (locks: ReturnType<typeof makeFakeLockManager>) => serviceOf(SenderLockWebLocks.layerWith({ locks }))

  test("two tabs serialise per address, and different addresses run concurrently", async () => {
    const locks = makeFakeLockManager()
    const [one, two] = await Promise.all([tab(locks), tab(locks)])
    let inFlight = 0
    let max = 0
    const work = Effect.gen(function*() {
      max = Math.max(max, ++inFlight)
      yield* Effect.sleep(10)
      inFlight--
    })
    await Effect.runPromise(Effect.all([one.withLocks([A])(work), two.withLocks([A])(work), one.withLocks([A])(work)], { concurrency: "unbounded" }))
    expect(max).toBe(1)
    max = 0
    await Effect.runPromise(Effect.all([one.withLocks([A])(work), two.withLocks([B])(work)], { concurrency: "unbounded" }))
    expect(max).toBe(2)
    expect(locks.held().size).toBe(0)
  })

  test("several addresses: deduplicated, ascending, and no deadlock across tabs", async () => {
    const locks = makeFakeLockManager()
    const [one, two] = await Promise.all([tab(locks), tab(locks)])
    await Effect.runPromise(one.withLocks([B, A, B])(Effect.void))
    expect(locks.grants).toEqual([name(A), name(B)])
    const work = Effect.sleep(5)
    await Effect.runPromise(
      Effect.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? one : two).withLocks(i % 2 ? [A, B] : [B, A])(work)), { concurrency: "unbounded" })
        .pipe(Effect.timeout(2_000))
    )
    expect(locks.held().size).toBe(0)
  })

  test("interruption releases a held lock, and takes a queued request out of the queue", async () => {
    const locks = makeFakeLockManager()
    const [one, two] = await Promise.all([tab(locks), tab(locks)])
    const r = await Effect.runPromise(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(one.withLocks([A])(Effect.andThen(Deferred.succeed(entered, undefined), Effect.never)))
      yield* Deferred.await(entered)
      const waiter = yield* Effect.forkChild(two.withLocks([A])(Effect.never))
      yield* Effect.sleep(5)
      const queued = locks.pending().get(name(A))
      yield* Fiber.interrupt(waiter)
      const afterWaiter = { pending: locks.pending().size, held: locks.held().get(name(A)) }
      yield* Fiber.interrupt(holder)
      yield* Effect.sleep(1)
      const afterHolder = locks.held().size
      // The lock is free for the other tab now.
      const next = yield* two.withLocks([A])(Effect.succeed("got it")).pipe(Effect.timeout(1_000))
      return { queued, afterWaiter, afterHolder, next }
    }))
    expect(r.queued).toBe(1)
    expect(r.afterWaiter).toEqual({ pending: 0, held: 1 })
    expect(r.afterHolder).toBe(0)
    expect(r.next).toBe("got it")
    expect(locks.grants.filter((g) => g === name(A)).length).toBe(2)
  })

  test("the lock is released when the effect fails or dies", async () => {
    const locks = makeFakeLockManager()
    const one = await tab(locks)
    await Effect.runPromise(Effect.exit(one.withLocks([A])(Effect.fail("no"))))
    await Effect.runPromise(Effect.exit(one.withLocks([A, B])(Effect.die("boom"))))
    expect(locks.held().size).toBe(0)
  })

  test("without Web Locks the layer fails typed, unless asked to fall back to memory", async () => {
    const missing = await Effect.runPromise(Effect.flip(Layer.build(SenderLockWebLocks.layer).pipe(Effect.scoped)))
    expect(missing._tag).toBe("SenderLockUnavailable")
    expect(missing.message).toContain("navigator.locks")
    const refusing = { request: () => Promise.reject(new Error("unused")), query: () => Promise.reject(new DOMException("opaque origin", "SecurityError")) }
    const refused = await Effect.runPromise(Effect.flip(Layer.build(SenderLockWebLocks.layerWith({ locks: refusing })).pipe(Effect.scoped)))
    expect(refused.message).toContain("SecurityError")
    // Opted in: in-process locks, still serialising this context.
    const service = await serviceOf(SenderLockWebLocks.layerWith({ ifUnavailable: "memory" }))
    let inFlight = 0
    let max = 0
    const work = Effect.gen(function*() {
      max = Math.max(max, ++inFlight)
      yield* Effect.sleep(5)
      inFlight--
    })
    await Effect.runPromise(Effect.all([service.withLocks([A])(work), service.withLocks([A])(work)], { concurrency: "unbounded" }))
    expect(max).toBe(1)
  })

  test("navigator.locks is picked up when present", async () => {
    const locks = makeFakeLockManager()
    setGlobal("navigator", { locks })
    const service = await serviceOf(SenderLockWebLocks.layer)
    await Effect.runPromise(service.withLocks([A])(Effect.void))
    expect(locks.grants).toEqual([name(A)])
  })

  test("Lifecycle.run in two tabs, pinned bytes, one sender: serialised build through submit", async () => {
    const world = makeWorld({ executeDelay: 30 })
    const locks = makeFakeLockManager()
    const fast = SubmitConfig.layer({ lookupTimeout: 0, reconcileRecheck: 0, awaitVisibility: false })
    const signer = await Effect.runPromise(Ed25519.generate)
    const coin = ownedObject(COIN, 3n)
    const runIn = (amount: bigint) =>
      Lifecycle.run(
        Effect.gen(function*() {
          const c = (yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(amount)]))[0]!
          yield* Ptb.transferObjects([c], yield* Ptb.address(signer.address))
        }),
        { signer, payment: Resolve.fixed([Objects.refOf(coin)]) }
      ).pipe(Effect.provide(Layer.mergeAll(worldLayer(world), fast, Journal.layerMemory, SenderLockWebLocks.layerWith({ locks }))))
    await Promise.all([Effect.runPromise(runIn(1n)), Effect.runPromise(runIn(2n))])
    expect(world.maxInFlight).toBe(1)
    expect(world.builtDuringExecute).toBe(false)
    expect(locks.held().size).toBe(0)
  })
})
