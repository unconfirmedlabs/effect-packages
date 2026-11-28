/**
 * A `SenderLock` over the Web Locks API (`navigator.locks`), so the tabs,
 * iframes and workers of one origin serialise their submissions per sender,
 * not only the fibers of one tab. `SenderLock.makeMemory` cannot see another
 * tab: two tabs running for the same address could resolve the same gas coin
 * or owned object and equivocate.
 *
 * - One exclusive lock per address, named `<prefix><address>` (default prefix
 *   {@link DEFAULT_PREFIX}), held for exactly the wrapped effect. Addresses are
 *   deduplicated and taken in ascending order, outermost first, as
 *   `SenderLock.makeMemory` does, so two runs needing the same pair cannot
 *   deadlock (in one tab or across tabs).
 * - Interrupting the effect releases the lock: while waiting, the request's
 *   `AbortSignal` takes it out of the queue; once granted, the promise the
 *   lock callback returned is resolved. A grant that races the interruption
 *   is released at once. A tab that closes or crashes loses its locks (the
 *   browser releases them), so a dead tab never strands a sender.
 * - Not reentrant (nor is the memory lock): don't nest `withLocks` for the
 *   same address in one fiber.
 *
 * **When Web Locks are missing** (`navigator.locks` is undefined outside a
 * secure context, in old browsers, in Node/Bun; `query()` rejects in opaque
 * origins), building `layer` fails with `SenderLockUnavailable`. It does not
 * fall back to in-process locks on its own: a silent fallback would look the
 * same as cross-tab locking and let two tabs equivocate, and the
 * `SenderLockService` contract has no error channel to report it at run
 * time. Opt in with `layerWith({ ifUnavailable: "memory" })` where one
 * context per origin is guaranteed (server-side rendering, a single-tab
 * kiosk), or provide `SenderLock.layerMemory` yourself. A lock request the
 * browser rejects after the probe succeeded (a document that is no longer
 * fully active) is a defect, for the same contract reason.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { makeMemory, SenderLock, type SenderLockService } from "./SenderLock.ts"

export const DEFAULT_PREFIX = "@unconfirmed/effect-sui/lifecycle/sender/"

/** The Web Locks API is missing or unusable here; nothing was locked. */
export class SenderLockUnavailable extends Schema.TaggedError<SenderLockUnavailable>()("SenderLockUnavailable", {
  message: Schema.String
}) {}

/** The subset of `LockManager` used here. */
export interface Locks {
  readonly request: (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>) => Promise<void>
  readonly query?: () => Promise<unknown>
}

export interface Options {
  /** Lock-name prefix; the address is appended. Default {@link DEFAULT_PREFIX}. */
  readonly prefix?: string
  /** The `LockManager` to use instead of `navigator.locks` (tests). */
  readonly locks?: Locks
  /**
   * What `layerWith` does without Web Locks: `"fail"` (default) fails with
   * `SenderLockUnavailable`; `"memory"` falls back to `SenderLock.makeMemory`,
   * which serialises only within this context.
   */
  readonly ifUnavailable?: "fail" | "memory"
}

/** Hold the exclusive lock `name` for `inner`. */
const withLock = (locks: Locks, name: string) => <A, E, R>(inner: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(
      restore(
        Effect.callback<() => void>((resume, signal) => {
          let release: (() => void) | undefined
          locks.request(name, { mode: "exclusive", signal }, () =>
            new Promise<void>((done) => {
              let released = false
              release = () => {
                if (released) return
                released = true
                done()
              }
              // Interrupted between the grant and now: give it straight back.
              if (signal.aborted) release()
              else resume(Effect.succeed(release))
            })).catch((cause: unknown) => {
              if (signal.aborted) return // our own abort while queued
              resume(Effect.die(cause))
            })
          return Effect.sync(() => release?.())
        })
      ),
      (release) => Effect.ensuring(restore(inner), Effect.sync(release))
    )
  )

/** `SenderLockService` over `locks`. */
export const make = (locks: Locks, options?: { readonly prefix?: string }): SenderLockService => {
  const prefix = options?.prefix ?? DEFAULT_PREFIX
  return {
    withLocks: (addresses) => (effect) =>
      // Ascending order, outermost first, so two runs needing the same pair cannot deadlock.
      [...new Set(addresses)].sort().reverse().reduce((inner, address) => withLock(locks, `${prefix}${address}`)(inner), effect)
  }
}

const globalLocks = (): Locks | undefined => {
  const locks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks
  return locks !== undefined && locks !== null && typeof locks.request === "function" ? locks : undefined
}

/** `SenderLock` over `navigator.locks` (or `options.locks`); see the module notes for `ifUnavailable`. */
export const layerWith = (options?: Options): Layer.Layer<never, SenderLockUnavailable> =>
  Layer.effect(
    SenderLock,
    Effect.gen(function*() {
      const locks = options?.locks ?? globalLocks()
      const unavailable = (message: string) =>
        options?.ifUnavailable === "memory"
          ? Effect.as(Effect.logWarning(`${message}; falling back to in-process sender locks`), makeMemory())
          : Effect.fail(new SenderLockUnavailable({ message }))
      if (locks === undefined) {
        return yield* unavailable("the Web Locks API (navigator.locks) is not available (it needs a secure context)")
      }
      if (typeof locks.query === "function") {
        const query = locks.query.bind(locks)
        const probe = yield* Effect.result(Effect.tryPromise(() => query()))
        if (probe._tag === "Failure") {
          const cause = probe.failure.cause
          return yield* unavailable(
            `the Web Locks API refused a query: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`
          )
        }
      }
      return make(locks, options?.prefix === undefined ? {} : { prefix: options.prefix })
    })
  )

/** `SenderLock` over `navigator.locks`; fails with `SenderLockUnavailable` without it. */
export const layer: Layer.Layer<never, SenderLockUnavailable> = layerWith()
