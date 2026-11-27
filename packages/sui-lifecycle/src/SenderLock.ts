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

export const makeMemory = (): SenderLockService => {
  const locks = new Map<string, Semaphore.Semaphore>()
  const lockOf = (address: string) => {
    let lock = locks.get(address)
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1)
      locks.set(address, lock)
    }
    return lock
  }
  return {
    withLocks: (addresses) => (effect) =>
      // Ascending order, so two runs needing the same pair cannot deadlock.
      [...new Set(addresses)].sort().reverse().reduce(
        (inner, address) => lockOf(address).withPermits(1)(inner),
        effect
      )
  }
}

export const SenderLock = Context.Reference<SenderLockService>("@unconfirmed/sui-lifecycle/SenderLock", {
  defaultValue: makeMemory
})

/** A fresh, isolated set of in-memory locks. */
export const layerMemory: Layer.Layer<never> = Layer.sync(SenderLock, makeMemory)

/** No locking at all, for callers that serialise themselves. */
export const layerNone: Layer.Layer<never> = Layer.succeed(SenderLock, { withLocks: () => (effect) => effect })
