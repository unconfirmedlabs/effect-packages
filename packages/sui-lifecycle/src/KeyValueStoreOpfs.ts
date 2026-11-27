/**
 * A `KeyValueStore` (`effect/persistence`) over the Origin Private File System
 * (`navigator.storage.getDirectory()`): one file per key in a sub-directory
 * (default `sui-lifecycle`; `a/b` nests).
 *
 * - **File names.** A key becomes `k.` plus the key with every character
 *   outside `[A-Za-z0-9_-]` written as `%XX` per UTF-8 byte, so `entry:Ab1`
 *   is `k.entry%3AAb1`. The mapping is reversible (that is how `keys` works),
 *   never yields `/`, `\`, `.` or `..`, and leaves case alone (OPFS names are
 *   case-sensitive). Files in the directory that are not of this form
 *   (browser swap files, anything else) are ignored by `keys`, `size` and
 *   `clear`. A name longer than {@link MAX_NAME_LENGTH} characters is refused
 *   with `KeyValueStoreError` before touching the disk.
 * - **Atomic writes.** `set` writes through `createWritable()`, which writes
 *   to a swap file and replaces the file only on `close()`; a write that fails
 *   (quota, interruption) aborts the stream and leaves the previous value.
 *   That works on the main thread and in workers. `createSyncAccessHandle()`
 *   is worker-only and writes in place (not atomic), so it is not used.
 * - **Values** are the file's bytes: strings are written as UTF-8, `get`
 *   decodes UTF-8 and `getUint8Array` answers the bytes (as
 *   `KeyValueStore.layerFileSystem` does), so a string and its UTF-8 bytes
 *   are the same value.
 * - **Errors.** Every failure is a `KeyValueStoreError` (the `cause` holds
 *   the `DOMException`): OPFS missing (no `navigator.storage.getDirectory`:
 *   non-secure context, old browsers; `SecurityError` in some private modes),
 *   `QuotaExceededError`, `NoModificationAllowedError` (a worker holds a sync
 *   access handle on the file), `TypeMismatchError` (a directory under the
 *   name), `createWritable` missing. A missing file (`NotFoundError`) is an
 *   absent key: `get` answers `undefined`, `remove` succeeds.
 *
 * Browser caveats:
 * - Safari has `getDirectory` since 15.2 but `createWritable` /
 *   `FileSystemWritableFileStream` only since Safari 26; on older Safari this
 *   store fails `set` (and the layer fails to build) with `KeyValueStoreError`.
 *   Use `KeyValueStoreIndexedDb` there.
 * - Firefox has OPFS since 111; in private browsing `getDirectory` may reject
 *   (`SecurityError`), which fails the layer typed.
 * - Two `createWritable` streams on one file (two tabs) do not lock each
 *   other: the last `close()` wins, whole. `JournalKeyValueStore` writes whole
 *   values per key, so that is enough.
 * - Unlike IndexedDB there is no strict-durability flag: a committed
 *   `close()` is on the browser's storage, but whether it is fsynced before
 *   a power loss is up to the browser.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as KeyValueStore from "effect/persistence/KeyValueStore"

export const DEFAULT_DIRECTORY = "sui-lifecycle"
/** The longest file name produced; longer keys are refused. Most file systems cap names at 255 bytes. */
export const MAX_NAME_LENGTH = 255

const PREFIX = "k."

export interface Options {
  /** The sub-directory of the origin's root, `/`-separated for nesting. Default {@link DEFAULT_DIRECTORY}. */
  readonly directory?: string
  /** The root to use instead of `navigator.storage.getDirectory()` (tests, or a worker's own). */
  readonly root?: () => Promise<FileSystemDirectoryHandle>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
const SAFE = /^[A-Za-z0-9_-]$/

/** The file name of a key: reversible, and safe as an OPFS entry name. */
export const encodeKey = (key: string): string => {
  let out = PREFIX
  for (const ch of key) {
    if (SAFE.test(ch)) out += ch
    else for (const byte of encoder.encode(ch)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  }
  return out
}

/** The key of a file name, or `undefined` for a file this store did not write. */
export const decodeKey = (name: string): string | undefined => {
  if (!name.startsWith(PREFIX)) return undefined
  const body = name.slice(PREFIX.length)
  if (!/^(?:[A-Za-z0-9_-]|%[0-9A-F]{2})*$/.test(body)) return undefined
  try {
    const key = decodeURIComponent(body)
    return encodeKey(key) === name ? key : undefined
  } catch {
    return undefined
  }
}

const describe = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "name" in cause && "message" in cause
    ? `${(cause as Error).name}: ${(cause as Error).message}`
    : String(cause)

const storeError = (method: string, cause: unknown, key?: string): KeyValueStore.KeyValueStoreError =>
  new KeyValueStore.KeyValueStoreError({
    method,
    ...(key === undefined ? {} : { key }),
    message: `OPFS ${method}${key === undefined ? "" : ` of ${JSON.stringify(key)}`} failed: ${describe(cause)}`,
    cause
  })

const isNotFound = (cause: unknown) =>
  typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "NotFoundError"

const tryAsync = <A>(method: string, key: string | undefined, f: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => storeError(method, cause, key) })

const nameOf = (method: string, key: string): Effect.Effect<string, KeyValueStore.KeyValueStoreError> => {
  if (decoder.decode(encoder.encode(key)) !== key) {
    return Effect.fail(storeError(method, new Error("the key is not well-formed UTF-16 (a lone surrogate)"), key))
  }
  const name = encodeKey(key)
  return name.length > MAX_NAME_LENGTH
    ? Effect.fail(storeError(method, new Error(`the key encodes to ${name.length} characters, over ${MAX_NAME_LENGTH}`), key))
    : Effect.succeed(name)
}

/** Our file names in `dir`. */
const listNames = async (dir: FileSystemDirectoryHandle): Promise<Array<string>> => {
  const names: Array<string> = []
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind === "file" && decodeKey(name) !== undefined) names.push(name)
  }
  return names
}

const defaultRoot = (): Promise<FileSystemDirectoryHandle> => {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage
  if (storage === undefined || typeof storage.getDirectory !== "function") {
    return Promise.reject(new Error("the Origin Private File System (navigator.storage.getDirectory) is not available"))
  }
  return storage.getDirectory()
}

/** Write `value` to `handle` atomically: a swap file, committed on `close()`, aborted on failure. */
const writeAtomic = async (handle: FileSystemFileHandle, value: string | Uint8Array): Promise<void> => {
  if (typeof (handle as { createWritable?: unknown }).createWritable !== "function") {
    throw Object.assign(
      new Error("FileSystemFileHandle.createWritable is not available (Safari before 26); use KeyValueStoreIndexedDb"),
      { name: "NotSupportedError" }
    )
  }
  const stream = await handle.createWritable({ keepExistingData: false })
  try {
    await stream.write(typeof value === "string" ? value : (value as Uint8Array<ArrayBuffer>))
  } catch (cause) {
    await stream.abort().catch(() => {})
    throw cause
  }
  await stream.close()
}

/** The store over `directory` (resolved, and created, now). */
export const make = (options?: Options): Effect.Effect<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError> =>
  Effect.gen(function*() {
    const path = (options?.directory ?? DEFAULT_DIRECTORY).split("/").filter((p) => p.length > 0)
    const dir = yield* tryAsync("open", undefined, async () => {
      let d = await (options?.root ?? defaultRoot)()
      for (const part of path) d = await d.getDirectoryHandle(part, { create: true })
      return d
    })
    const FileHandle = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle
    if (FileHandle !== undefined && !("createWritable" in FileHandle.prototype)) {
      return yield* storeError(
        "open",
        Object.assign(new Error("FileSystemFileHandle.createWritable is not available (Safari before 26); use KeyValueStoreIndexedDb"), {
          name: "NotSupportedError"
        })
      )
    }

    const read = <A>(method: string, convert: (file: File) => Promise<A>) => (key: string) =>
      Effect.flatMap(nameOf(method, key), (name) =>
        tryAsync(method, key, async () => {
          let handle: FileSystemFileHandle
          try {
            handle = await dir.getFileHandle(name)
          } catch (cause) {
            if (isNotFound(cause)) return undefined
            throw cause
          }
          try {
            return await convert(await handle.getFile())
          } catch (cause) {
            if (isNotFound(cause)) return undefined // removed between the two calls
            throw cause
          }
        }))

    const removeName = async (name: string) => {
      try {
        await dir.removeEntry(name)
      } catch (cause) {
        if (!isNotFound(cause)) throw cause
      }
    }

    return KeyValueStore.make({
      get: read("get", async (file) => decoder.decode(await file.arrayBuffer())),
      getUint8Array: read("getUint8Array", async (file) => new Uint8Array(await file.arrayBuffer())),
      set: (key, value) =>
        Effect.flatMap(nameOf("set", key), (name) =>
          tryAsync("set", key, async () => writeAtomic(await dir.getFileHandle(name, { create: true }), value))),
      remove: (key) => Effect.flatMap(nameOf("remove", key), (name) => tryAsync("remove", key, () => removeName(name))),
      has: (key) =>
        Effect.flatMap(nameOf("has", key), (name) =>
          tryAsync("has", key, async () => {
            try {
              await dir.getFileHandle(name)
              return true
            } catch (cause) {
              if (isNotFound(cause)) return false
              throw cause
            }
          })),
      clear: tryAsync("clear", undefined, async () => {
        for (const name of await listNames(dir)) await removeName(name)
      }),
      clearPrefix: (prefix) =>
        tryAsync("clearPrefix", prefix, async () => {
          for (const name of await listNames(dir)) if (decodeKey(name)!.startsWith(prefix)) await removeName(name)
        }),
      size: tryAsync("size", undefined, async () => (await listNames(dir)).length),
      keys: tryAsync("keys", undefined, async () => (await listNames(dir)).map((name) => decodeKey(name)!))
    })
  })

/** `KeyValueStore` over OPFS. */
export const layer = (options?: Options): Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError> =>
  Layer.effect(KeyValueStore.KeyValueStore, make(options))
