/**
 * A `KeyValueStore` (`effect/persistence`) over IndexedDB: the recommended
 * durable store for `JournalKeyValueStore` in a browser.
 *
 * - One object store (default `kv`) in one database (default
 *   `@unconfirmed/sui-lifecycle`), opened once per layer scope and closed when
 *   the scope closes. Keys are the store's strings; strings are stored as
 *   strings and `Uint8Array`s as bytes (structured clone), so both round-trip.
 *   `get` of a binary value answers its Base64, and `getUint8Array` of a
 *   string its UTF-8, as `KeyValueStore.layerMemory` does.
 * - One IDB transaction per operation, resolved on the transaction's
 *   `complete` (not the request's `success`), with `durability: "strict"` on
 *   writes where the browser supports it (Chromium; Firefox and Safari treat
 *   every commit as strict and ignore the hint). `modify` reads and writes in
 *   one transaction, so it is atomic across tabs.
 * - Another tab upgrading or deleting the database fires `versionchange`: the
 *   connection is closed at once (so it never blocks the other tab) and the
 *   next operation reopens it. A connection the browser closes under us
 *   (`close` event, storage cleared) is reopened the same way. When the store
 *   is missing (a new database, or one created by other code under this name)
 *   the database is reopened one version up to create it; if a connection
 *   that ignores `versionchange` blocks that upgrade, opening fails with
 *   `KeyValueStoreError` rather than hanging.
 * - Every failure is a `KeyValueStoreError` (the `cause` holds the
 *   `DOMException`, the `message` its name): IndexedDB missing (`indexedDB`
 *   undefined, as in some embedded webviews and old private modes), `open`
 *   refused (Firefox < 115 private mode: `InvalidStateError`), quota
 *   (`QuotaExceededError`, usually as a transaction abort), an aborted
 *   transaction, `InvalidStateError` / `TransactionInactiveError`, or a value
 *   of another type under a key.
 *
 * The write order `JournalKeyValueStore` relies on holds: each operation's
 * effect completes only once its transaction has committed, and IndexedDB
 * orders overlapping readwrite transactions by creation.
 */
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Layer from "effect/Layer"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import type * as Scope from "effect/Scope"

export const DEFAULT_DATABASE = "@unconfirmed/sui-lifecycle"
export const DEFAULT_STORE = "kv"

export interface Options {
  /** The database name. Default {@link DEFAULT_DATABASE}. */
  readonly database?: string
  /** The object store name. Default {@link DEFAULT_STORE}. */
  readonly store?: string
  /** The `IDBFactory` to use instead of `globalThis.indexedDB` (tests, or a worker's own). */
  readonly indexedDB?: IDBFactory
}

const describe = (cause: unknown): string =>
  cause instanceof Error || (typeof cause === "object" && cause !== null && "name" in cause && "message" in cause)
    ? `${(cause as Error).name}: ${(cause as Error).message}`
    : String(cause)

const storeError = (method: string, cause: unknown, key?: string): KeyValueStore.KeyValueStoreError =>
  new KeyValueStore.KeyValueStoreError({
    method,
    ...(key === undefined ? {} : { key }),
    message: `IndexedDB ${method}${key === undefined ? "" : ` of ${JSON.stringify(key)}`} failed: ${describe(cause)}`,
    cause
  })

const isInvalidState = (cause: unknown) =>
  typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "InvalidStateError"

const encoder = new TextEncoder()

/** A stored value as a string (`get`), or the reason it is not one we wrote. */
const asString = (value: unknown): string | { readonly invalid: string } =>
  typeof value === "string"
    ? value
    : value instanceof Uint8Array
    ? Base64.encode(value)
    : value instanceof ArrayBuffer
    ? Base64.encode(new Uint8Array(value))
    : { invalid: `holds a ${typeof value}, not a string or bytes` }

const asBytes = (value: unknown): Uint8Array | { readonly invalid: string } =>
  typeof value === "string"
    ? encoder.encode(value)
    : value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : { invalid: `holds a ${typeof value}, not a string or bytes` }

class Invalid extends Error {
  override readonly name = "InvalidValue"
}

/**
 * Open (or reopen) the connection; `undefined` resolves once a blocked
 * upgrade gives up. The returned connection closes itself on `versionchange`
 * and reports its closing through `onGone`.
 */
const openDatabase = (
  factory: IDBFactory,
  name: string,
  store: string,
  onGone: (db: IDBDatabase) => void
): Promise<IDBDatabase> => {
  const request = (version?: number) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false
      const req = version === undefined ? factory.open(name) : factory.open(name, version)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
      req.onsuccess = () => {
        const db = req.result
        if (settled) return db.close() // blocked earlier and already failed
        settled = true
        resolve(db)
      }
      req.onerror = () => {
        if (settled) return
        settled = true
        reject(req.error ?? new Error("open failed"))
      }
      req.onblocked = () => {
        if (settled) return
        settled = true
        reject(
          Object.assign(new Error(`opening ${name} v${version} is blocked by a connection that ignores versionchange`), {
            name: "BlockedError"
          })
        )
      }
    })
  const watch = (db: IDBDatabase): IDBDatabase => {
    db.onversionchange = () => {
      db.close()
      onGone(db)
    }
    db.onclose = () => onGone(db)
    return db
  }
  return request().then((db) => {
    if (db.objectStoreNames.contains(store)) return watch(db)
    const next = db.version + 1
    db.close()
    return request(next).then(watch)
  })
}

/** The store, open for the current scope. Fails with `KeyValueStoreError` when IndexedDB is missing or refuses to open. */
export const make = (options?: Options): Effect.Effect<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError, Scope.Scope> =>
  Effect.gen(function*() {
    const factory = options?.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (factory === undefined || factory === null) {
      return yield* storeError("open", new Error("IndexedDB is not available in this environment"))
    }
    const name = options?.database ?? DEFAULT_DATABASE
    const storeName = options?.store ?? DEFAULT_STORE
    let current: Promise<IDBDatabase> | undefined
    let disposed = false
    const gone = (db: IDBDatabase) => {
      // Forget it only if it is still the current one.
      void current?.then((c) => {
        if (c === db) current = undefined
      }, () => {})
    }
    const connection = (): Promise<IDBDatabase> => {
      if (disposed) return Promise.reject(new Error("the store's scope is closed"))
      if (current === undefined) {
        const opening = openDatabase(factory, name, storeName, gone)
        current = opening
        // A failed open is not cached: the next operation tries again.
        opening.catch(() => {
          if (current === opening) current = undefined
        })
      }
      return current
    }
    const drop = (db: IDBDatabase) => {
      try {
        db.close()
      } catch {
        // already closed
      }
      current = undefined // found closed: the next connection() opens afresh
    }

    yield* Effect.acquireRelease(
      Effect.tryPromise({ try: connection, catch: (cause) => storeError("open", cause) }),
      () =>
        Effect.promise(async () => {
          disposed = true
          const open = current
          current = undefined
          if (open !== undefined) await open.then((db) => db.close(), () => {})
        })
    )

    /**
     * Run `body` in one transaction and answer its result once the
     * transaction commits. A connection found closed (`InvalidStateError`
     * from `transaction()`) is reopened once.
     */
    const run = <A>(
      method: string,
      key: string | undefined,
      mode: IDBTransactionMode,
      body: (store: IDBObjectStore, done: (a: A) => void, fail: (e: unknown) => void) => void
    ): Effect.Effect<A, KeyValueStore.KeyValueStoreError> =>
      Effect.callback<A, KeyValueStore.KeyValueStoreError>((resume, signal) => {
        let finished = false
        let tx: IDBTransaction | undefined
        const finish = (effect: Effect.Effect<A, KeyValueStore.KeyValueStoreError>) => {
          if (finished) return
          finished = true
          resume(effect)
        }
        const attempt = (retry: boolean) => {
          connection().then((db) => {
            if (finished || signal.aborted) return
            try {
              tx = mode === "readwrite"
                ? db.transaction(storeName, mode, { durability: "strict" })
                : db.transaction(storeName, mode)
            } catch (cause) {
              if (retry && isInvalidState(cause)) {
                drop(db)
                return attempt(false)
              }
              return finish(Effect.fail(storeError(method, cause, key)))
            }
            let result: { readonly value: A } | undefined
            let failure: { readonly cause: unknown } | undefined
            tx.oncomplete = () =>
              finish(failure !== undefined
                ? Effect.fail(storeError(method, failure.cause, key))
                : result === undefined
                ? Effect.fail(storeError(method, new Error("the transaction committed without a result"), key))
                : Effect.succeed(result.value))
            tx.onabort = () => {
              const cause = tx?.error ?? failure?.cause ??
                Object.assign(new Error("the transaction was aborted"), { name: "AbortError" })
              finish(Effect.fail(storeError(method, cause, key)))
            }
            // A request error bubbles to the transaction and aborts it; onabort reports it.
            tx.onerror = (event) => {
              if (failure === undefined) failure = { cause: (event.target as IDBRequest | null)?.error ?? tx?.error }
            }
            try {
              body(
                tx.objectStore(storeName),
                (a) => {
                  result = { value: a }
                },
                (cause) => {
                  failure = { cause }
                  try {
                    tx?.abort()
                  } catch {
                    // already finishing
                  }
                }
              )
            } catch (cause) {
              failure = { cause }
              try {
                tx.abort()
              } catch {
                finish(Effect.fail(storeError(method, cause, key)))
              }
            }
          }, (cause) => finish(Effect.fail(storeError(method, cause, key))))
        }
        attempt(true)
        // Interrupted: abort the transaction (a no-op once it has committed).
        return Effect.sync(() => {
          finished = true
          try {
            tx?.abort()
          } catch {
            // committed or already aborted
          }
        })
      })

    const request = <A>(req: IDBRequest, done: (a: A) => void, map: (raw: unknown) => A) => {
      req.onsuccess = () => done(map(req.result))
    }

    const getWith = <A>(method: string, convert: (value: unknown) => A | { readonly invalid: string }) => (key: string) =>
      run<A | undefined>(method, key, "readonly", (store, done, fail) =>
        request(store.get(key), (raw: unknown) => {
          if (raw === undefined) return done(undefined)
          const value = convert(raw)
          if (typeof value === "object" && value !== null && "invalid" in value) fail(new Invalid(value.invalid))
          else done(value as A)
        }, (raw) => raw))

    const modifyWith = <V extends string | Uint8Array>(
      method: string,
      convert: (value: unknown) => V | { readonly invalid: string }
    ) =>
    (key: string, f: (value: V) => V) =>
      run<V | undefined>(method, key, "readwrite", (store, done, fail) => {
        const req = store.get(key)
        req.onsuccess = () => {
          if (req.result === undefined) return done(undefined)
          const value = convert(req.result)
          if (typeof value === "object" && "invalid" in value) return fail(new Invalid(value.invalid))
          let next: V
          try {
            next = f(value)
          } catch (cause) {
            return fail(cause)
          }
          request(store.put(next, key), done, () => next)
        }
      })

    const allKeys = (store: IDBObjectStore, done: (keys: Array<string>) => void) =>
      request(store.getAllKeys(), done, (raw) => (raw as Array<IDBValidKey>).filter((k): k is string => typeof k === "string"))

    return KeyValueStore.make({
      get: getWith("get", asString),
      getUint8Array: getWith("getUint8Array", asBytes),
      set: (key, value) =>
        run<void>("set", key, "readwrite", (store, done) => request(store.put(value, key), done, () => undefined)),
      remove: (key) => run<void>("remove", key, "readwrite", (store, done) => request(store.delete(key), done, () => undefined)),
      has: (key) => run<boolean>("has", key, "readonly", (store, done) => request(store.count(key), done, (n) => (n as number) > 0)),
      clear: run<void>("clear", undefined, "readwrite", (store, done) => request(store.clear(), done, () => undefined)),
      clearPrefix: (prefix) =>
        run<void>("clearPrefix", prefix, "readwrite", (store, done) => {
          const KeyRange = (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange
          // With IDBKeyRange, walk from the prefix and stop past it; without, scan every key.
          const ranged = KeyRange !== undefined && prefix.length > 0
          const req = ranged ? store.openKeyCursor(KeyRange.lowerBound(prefix)) : store.openKeyCursor()
          req.onsuccess = () => {
            const cursor = req.result
            if (cursor === null) return done(undefined)
            const key = cursor.primaryKey
            if (typeof key === "string" && key.startsWith(prefix)) {
              store.delete(key)
              cursor.continue()
            } else if (ranged) {
              done(undefined)
            } else {
              cursor.continue()
            }
          }
        }),
      size: run<number>("size", undefined, "readonly", (store, done) => allKeys(store, (keys) => done(keys.length))),
      keys: run<ReadonlyArray<string>>("keys", undefined, "readonly", (store, done) => allKeys(store, done)),
      modify: modifyWith("modify", asString),
      modifyUint8Array: modifyWith("modifyUint8Array", asBytes)
    })
  })

/** `KeyValueStore` over IndexedDB, open for the layer's lifetime. */
export const layer = (options?: Options): Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError> =>
  Layer.effect(KeyValueStore.KeyValueStore, make(options))
