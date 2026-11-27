/**
 * Success-only caching. Effect's `cachedWithTTL` and `RequestResolver.withCache`
 * also keep failures, so one transient `UNAVAILABLE` would be replayed to every
 * caller (and every retry) until it expires.
 *
 * Concurrent misses share one computation: the first caller runs it and the
 * others wait for its result. A failure is handed to the callers that were
 * waiting and then forgotten; if the running caller is interrupted, a waiter
 * starts again on its own.
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"

/** Run `compute` once for all concurrent callers that share `slot`. */
const shared = <A, E, R>(
  get: () => Deferred.Deferred<A, E> | undefined,
  set: (d: Deferred.Deferred<A, E> | undefined) => void,
  compute: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const running = get()
    if (running) {
      return Effect.flatMap(Effect.exit(Deferred.await(running)), (exit): Effect.Effect<A, E, R> =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? shared(get, set, compute) : exit)
    }
    const d = Deferred.makeUnsafe<A, E>()
    set(d)
    return Effect.onExit(compute, (exit) =>
      Effect.sync(() => {
        if (get() === d) set(undefined)
        Deferred.doneUnsafe(d, exit)
      }))
  })

/** `self`, with its last success reused for `ttl`. Failures are never kept. */
export const successFor = <A, E, R>(self: Effect.Effect<A, E, R>, ttl: Duration.Input): Effect.Effect<A, E, R> => {
  const ms = Duration.toMillis(ttl)
  let cached: { readonly value: A; readonly expires: number } | undefined
  let inflight: Deferred.Deferred<A, E> | undefined
  const refresh = shared(() => inflight, (d) => (inflight = d), Effect.tap(self, (value) =>
    Effect.map(Clock.currentTimeMillis, (t) => {
      cached = { value, expires: t + ms }
    })))
  return Effect.flatMap(Clock.currentTimeMillis, (now) => (cached && now < cached.expires ? Effect.succeed(cached.value) : refresh))
}

/** Memoize successes by key, forever, up to `capacity` entries (oldest evicted). Failures are never kept. */
export const successByKey = <K, A>(capacity: number) => {
  const map = new Map<K, A>()
  const inflight = new Map<K, Deferred.Deferred<A, any>>()
  return <E, R>(key: K, compute: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      if (map.has(key)) return Effect.succeed(map.get(key)!)
      return shared<A, E, R>(
        () => inflight.get(key),
        (d) => (d ? inflight.set(key, d) : inflight.delete(key)),
        Effect.tap(compute, (value) =>
          Effect.sync(() => {
            map.set(key, value)
            if (map.size > capacity) map.delete(map.keys().next().value!)
          }))
      )
    })
}
