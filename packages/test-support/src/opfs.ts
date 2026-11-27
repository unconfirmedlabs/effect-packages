/**
 * An in-memory Origin Private File System for tests (Bun has none):
 * `FileSystemDirectoryHandle`, `FileSystemFileHandle` and
 * `FileSystemWritableFileStream` with the parts of their behaviour a store
 * relies on.
 *
 * - `createWritable()` writes to a swap buffer (empty unless
 *   `keepExistingData`); `close()` replaces the file's bytes in one step;
 *   `abort()` (or a failed write) discards the swap, leaving the old value.
 * - Errors are `DOMException`s with the browsers' names: `NotFoundError`,
 *   `TypeMismatchError`, `QuotaExceededError` (when a write would take the
 *   total over `quota` bytes), `InvalidStateError` (a closed stream).
 * - `fail` injects a failure: before each operation it is called with the
 *   operation and entry name, and an exception it returns is thrown.
 */

export type Operation =
  | "getDirectoryHandle"
  | "getFileHandle"
  | "removeEntry"
  | "entries"
  | "getFile"
  | "createWritable"
  | "write"
  | "close"

export interface FakeOpfsOptions {
  /** Total bytes the whole tree may hold. Default unlimited. */
  readonly quota?: number
  /** Called before every operation; a returned exception is thrown by it. */
  fail?: ((operation: Operation, name: string) => unknown) | undefined
  /** Leave `createWritable` off file handles (Safari before 26). */
  readonly noCreateWritable?: boolean
}

const domError = (name: string, message: string) => new DOMException(message, name)

class Root {
  constructor(readonly options: FakeOpfsOptions) {}
  used = 0
  check(operation: Operation, name: string) {
    const e = this.options.fail?.(operation, name)
    if (e !== undefined) throw e
  }
}

class FakeFile {
  bytes: Uint8Array = new Uint8Array(0)
}

class FakeDir {
  readonly entries = new Map<string, FakeFile | FakeDir>()
}

const toBytes = async (data: unknown): Promise<Uint8Array> => {
  if (typeof data === "string") return new TextEncoder().encode(data)
  if (data instanceof Uint8Array) return new Uint8Array(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === "write") {
    return toBytes((data as { data: unknown }).data)
  }
  throw new TypeError("unsupported write data")
}

class FakeWritable {
  private swap: Uint8Array
  private state: "open" | "closed" | "aborted" = "open"
  constructor(private readonly root: Root, private readonly file: FakeFile, private readonly name: string, keep: boolean) {
    this.swap = keep ? new Uint8Array(file.bytes) : new Uint8Array(0)
  }
  async write(data: unknown): Promise<void> {
    if (this.state !== "open") throw domError("InvalidStateError", "the stream is closed")
    try {
      this.root.check("write", this.name)
      const chunk = await toBytes(data)
      const next = new Uint8Array(this.swap.length + chunk.length)
      next.set(this.swap)
      next.set(chunk, this.swap.length)
      const quota = this.root.options.quota
      if (quota !== undefined && this.root.used - this.file.bytes.length + next.length > quota) {
        throw domError("QuotaExceededError", "the quota has been exceeded")
      }
      this.swap = next
    } catch (e) {
      // A failed write errors the stream: the swap is discarded.
      this.state = "aborted"
      throw e
    }
  }
  async close(): Promise<void> {
    if (this.state !== "open") throw domError("InvalidStateError", "the stream is closed")
    this.root.check("close", this.name)
    this.state = "closed"
    this.root.used += this.swap.length - this.file.bytes.length
    this.file.bytes = this.swap
  }
  async abort(): Promise<void> {
    this.state = "aborted"
  }
}

class FakeFileHandle {
  readonly kind = "file"
  constructor(private readonly root: Root, readonly name: string, readonly file: FakeFile) {
    if (!root.options.noCreateWritable) {
      Object.defineProperty(this, "createWritable", {
        value: async (options?: { keepExistingData?: boolean }) => {
          this.root.check("createWritable", this.name)
          return new FakeWritable(this.root, this.file, this.name, options?.keepExistingData ?? false)
        }
      })
    }
  }
  async getFile(): Promise<File> {
    this.root.check("getFile", this.name)
    return new File([new Uint8Array(this.file.bytes)], this.name)
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory"
  constructor(private readonly root: Root, readonly name: string, readonly dir: FakeDir) {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    this.root.check("getDirectoryHandle", name)
    let entry = this.dir.entries.get(name)
    if (entry === undefined) {
      if (!options?.create) throw domError("NotFoundError", `no directory ${name}`)
      entry = new FakeDir()
      this.dir.entries.set(name, entry)
    }
    if (!(entry instanceof FakeDir)) throw domError("TypeMismatchError", `${name} is a file`)
    return new FakeDirectoryHandle(this.root, name, entry)
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    this.root.check("getFileHandle", name)
    if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new TypeError(`invalid name ${name}`)
    }
    let entry = this.dir.entries.get(name)
    if (entry === undefined) {
      if (!options?.create) throw domError("NotFoundError", `no file ${name}`)
      entry = new FakeFile()
      this.dir.entries.set(name, entry)
    }
    if (!(entry instanceof FakeFile)) throw domError("TypeMismatchError", `${name} is a directory`)
    return new FakeFileHandle(this.root, name, entry)
  }
  async removeEntry(name: string): Promise<void> {
    this.root.check("removeEntry", name)
    const entry = this.dir.entries.get(name)
    if (entry === undefined) throw domError("NotFoundError", `no entry ${name}`)
    if (entry instanceof FakeDir && entry.entries.size > 0) throw domError("InvalidModificationError", `${name} is not empty`)
    if (entry instanceof FakeFile) this.root.used -= entry.bytes.length
    this.dir.entries.delete(name)
  }
  async *entries(): AsyncGenerator<[string, FakeFileHandle | FakeDirectoryHandle]> {
    this.root.check("entries", this.name)
    for (const [name, entry] of [...this.dir.entries]) {
      yield [name, entry instanceof FakeDir ? new FakeDirectoryHandle(this.root, name, entry) : new FakeFileHandle(this.root, name, entry)]
    }
  }
  async *keys(): AsyncGenerator<string> {
    for await (const [name] of this.entries()) yield name
  }
}

export interface FakeOpfs {
  /** The root, as `navigator.storage.getDirectory()` would answer it. */
  readonly getDirectory: () => Promise<FileSystemDirectoryHandle>
  /** The raw bytes at a `/`-separated path, or `undefined`. */
  readonly read: (path: string) => Uint8Array | undefined
  /** Names in the directory at a `/`-separated path. */
  readonly list: (path: string) => ReadonlyArray<string>
  /** Put a file directly (bypassing the handles). */
  readonly put: (path: string, bytes: Uint8Array) => void
  readonly options: FakeOpfsOptions
}

export const makeFakeOpfs = (options: FakeOpfsOptions = {}): FakeOpfs => {
  const root = new Root(options)
  const top = new FakeDir()
  const walk = (parts: ReadonlyArray<string>, create: boolean): FakeDir | undefined => {
    let d = top
    for (const p of parts) {
      let next = d.entries.get(p)
      if (next === undefined && create) {
        next = new FakeDir()
        d.entries.set(p, next)
      }
      if (!(next instanceof FakeDir)) return undefined
      d = next
    }
    return d
  }
  const split = (path: string) => path.split("/").filter((p) => p.length > 0)
  return {
    getDirectory: async () => new FakeDirectoryHandle(root, "", top) as unknown as FileSystemDirectoryHandle,
    read: (path) => {
      const parts = split(path)
      const entry = walk(parts.slice(0, -1), false)?.entries.get(parts[parts.length - 1]!)
      return entry instanceof FakeFile ? entry.bytes : undefined
    },
    list: (path) => [...(walk(split(path), false)?.entries.keys() ?? [])],
    put: (path, bytes) => {
      const parts = split(path)
      const file = new FakeFile()
      file.bytes = bytes
      root.used += bytes.length
      walk(parts.slice(0, -1), true)!.entries.set(parts[parts.length - 1]!, file)
    },
    options
  }
}
