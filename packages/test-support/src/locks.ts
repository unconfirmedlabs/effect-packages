/**
 * A fake Web Locks `LockManager` for tests (Bun has none): exclusive and
 * shared modes, FIFO queuing per name, `ifAvailable`, and `AbortSignal`
 * (a queued request whose signal aborts rejects with `AbortError` and leaves
 * the queue; a granted lock ignores its signal). A lock is held until the
 * promise its callback returned settles. One instance stands for one origin:
 * give two "tabs" the same instance.
 */

interface Request {
  readonly name: string
  readonly mode: LockMode
  readonly grant: () => void
}

export interface FakeLockManager {
  readonly request: (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>) => Promise<void>
  readonly query: () => Promise<{ held: Array<{ name: string; mode: LockMode }>; pending: Array<{ name: string; mode: LockMode }> }>
  /** Names currently held, with their holder count. */
  readonly held: () => ReadonlyMap<string, number>
  /** Requests waiting, per name. */
  readonly pending: () => ReadonlyMap<string, number>
  /** Every grant, in order, as `name`. */
  readonly grants: Array<string>
}

export const makeFakeLockManager = (): FakeLockManager => {
  const held = new Map<string, { mode: LockMode; count: number }>()
  const queue: Array<Request> = []
  const grants: Array<string> = []

  const grantable = (name: string, mode: LockMode) => {
    const h = held.get(name)
    return h === undefined || (h.mode === "shared" && mode === "shared")
  }
  const pump = () => {
    for (let i = 0; i < queue.length; i++) {
      const r = queue[i]!
      // FIFO per name: an earlier waiter for the same name blocks later ones.
      if (queue.slice(0, i).some((q) => q.name === r.name)) continue
      if (!grantable(r.name, r.mode)) continue
      queue.splice(i, 1)
      i--
      r.grant()
    }
  }
  const take = (name: string, mode: LockMode) => {
    const h = held.get(name)
    if (h === undefined) held.set(name, { mode, count: 1 })
    else h.count++
    grants.push(name)
  }
  const drop = (name: string) => {
    const h = held.get(name)!
    if (--h.count === 0) held.delete(name)
    pump()
  }

  const request = (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const mode = options.mode ?? "exclusive"
      const signal = options.signal
      if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"))
      const run = () => {
        take(name, mode)
        let result: Promise<void>
        try {
          result = Promise.resolve(callback({ name, mode } as Lock))
        } catch (e) {
          result = Promise.reject(e)
        }
        result.then(
          (v) => {
            drop(name)
            resolve(v)
          },
          (e) => {
            drop(name)
            reject(e)
          }
        )
      }
      if (options.ifAvailable) {
        if (grantable(name, mode) && !queue.some((q) => q.name === name)) run()
        else Promise.resolve(callback(null)).then(resolve, reject)
        return
      }
      const entry: Request = {
        name,
        mode,
        grant: () => {
          signal?.removeEventListener("abort", onAbort)
          run()
        }
      }
      const onAbort = () => {
        const i = queue.indexOf(entry)
        if (i === -1) return
        queue.splice(i, 1)
        reject(signal?.reason ?? new DOMException("aborted", "AbortError"))
        pump()
      }
      signal?.addEventListener("abort", onAbort)
      queue.push(entry)
      pump()
    })

  return {
    request,
    query: async () => ({
      held: [...held].map(([name, h]) => ({ name, mode: h.mode })),
      pending: queue.map((q) => ({ name: q.name, mode: q.mode }))
    }),
    held: () => new Map([...held].map(([name, h]) => [name, h.count])),
    pending: () => {
      const m = new Map<string, number>()
      for (const q of queue) m.set(q.name, (m.get(q.name) ?? 0) + 1)
      return m
    },
    grants
  }
}
