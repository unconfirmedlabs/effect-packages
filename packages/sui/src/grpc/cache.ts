/**
 * Success-only caching. Effect's `cachedWithTTL` and `RequestResolver.withCache`
 * also keep failures, so one transient `UNAVAILABLE` would be replayed to every
 * caller (and every retry) until it expires.
 */
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"

/** `self`, with its last success reused for `ttl`. Failures are never kept. */
export const successFor = <A, E, R>(self: Effect.Effect<A, E, R>, ttl: Duration.Input): Effect.Effect<A, E, R> => {
  const ms = Duration.toMillis(ttl)
  let cached: { readonly value: A; readonly expires: number } | undefined
  return Effect.flatMap(Clock.currentTimeMillis, (now) =>
    cached && now < cached.expires
      ? Effect.succeed(cached.value)
      : Effect.tap(self, (value) => Effect.map(Clock.currentTimeMillis, (t) => (cached = { value, expires: t + ms }))))
}

/** Memoize successes by key, forever, up to `capacity` entries (oldest evicted). Failures are never kept. */
export const successByKey = <K, A>(capacity: number) => {
  const map = new Map<K, A>()
  return <E, R>(key: K, compute: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      if (map.has(key)) return Effect.succeed(map.get(key)!)
      return Effect.tap(compute, (value) =>
        Effect.sync(() => {
          map.set(key, value)
          if (map.size > capacity) map.delete(map.keys().next().value!)
        }))
    })
}
