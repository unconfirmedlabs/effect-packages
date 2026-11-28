/**
 * Per-address locks for `Lifecycle.run`.
 *
 * Two builds from one sender that overlap can resolve the same gas coin or
 * owned object at the same version, and one of the two transactions then
 * fails or equivocates. So `run` holds the sender's (and a distinct gas
 * owner's) lock for every build, and keeps it through signing and submission
 * when the built bytes pin a versioned object (owned or receiving input, any
 * gas payment ref). Bytes that pin nothing release it after the build, so
 * address-balance transactions from one sender are sent concurrently.
 *
 * A `Context.Reference` with an in-memory default (one semaphore per address,
 * process-wide), so every `run` in the process shares it with no wiring.
 * Provide `layerMemory` for an isolated set, or your own (e.g. a distributed
 * lock) for several processes.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Semaphore from "effect/Semaphore"

export interface SenderLockService {
  /** Run `effect` holding the locks of every address (deduplicated, taken in ascending order). */
  readonly withLocks: (
    addresses: ReadonlyArray<string>
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * One semaphore per address, kept only while some fiber holds or waits for it
 * (a count of users per address), so a long-lived process does not keep a
 * lock for every sender it has ever seen.
 */
export const makeMemory = (): SenderLockService & { readonly size: () => number } => {
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()
  const acquire = (address: string) =>
    Effect.sync(() => {
      let lock = locks.get(address)
      if (lock === undefined) {
        lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
        locks.set(address, lock)
      }
      lock.users++
      return lock
    })
  const release = (address: string, lock: { users: number }) =>
    Effect.sync(() => {
      lock.users--
      if (lock.users === 0 && locks.get(address) === lock) locks.delete(address)
    })
  const withLock = (address: string) => <A, E, R>(inner: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      acquire(address),
      (lock) => lock.semaphore.withPermits(1)(inner),
      (lock) => release(address, lock)
    )
  return {
    withLocks: (addresses) => (effect) =>
      // Ascending order, so two runs needing the same pair cannot deadlock.
      [...new Set(addresses)].sort().reverse().reduce((inner, address) => withLock(address)(inner), effect),
    size: () => locks.size
  }
}

export const SenderLock = Context.Reference<SenderLockService>("@unconfirmed/sui-lifecycle/SenderLock", {
  defaultValue: makeMemory
})

/** A fresh, isolated set of in-memory locks. */
export const layerMemory: Layer.Layer<never> = Layer.sync(SenderLock, makeMemory)

/** No locking at all, for callers that serialise themselves. */
export const layerNone: Layer.Layer<never> = Layer.succeed(SenderLock, { withLocks: () => (effect) => effect })
