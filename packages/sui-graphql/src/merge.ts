/** Merging streams that are each sorted by the same key. */
import type * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Pull from "effect/Pull"
import * as Stream from "effect/Stream"

/**
 * One stream in `compare` order from streams already in that order, pulling
 * each only as far as needed. Consecutive items that compare equal (the same
 * item from several sources) are emitted once.
 */
export const mergeSorted = <A, E>(
  streams: ReadonlyArray<Stream.Stream<A, E>>,
  compare: (a: A, b: A) => number
): Stream.Stream<A, E> => {
  if (streams.length === 1) return streams[0]!
  return Stream.unwrap(Effect.gen(function*() {
    const pulls = yield* Effect.forEach(streams, Stream.toPull)
    // `null`: that source has ended.
    const buffers: Array<Array<A> | null> = streams.map(() => [])
    const fill = (i: number) =>
      buffers[i] !== null && buffers[i]!.length === 0
        ? pulls[i]!.pipe(
          Effect.map((chunk) => {
            buffers[i] = [...chunk]
          }),
          Pull.catchDone(() =>
            Effect.sync(() => {
              buffers[i] = null
            })
          )
        )
        : Effect.void
    let last: { readonly value: A } | undefined
    const pull: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E> = Effect.gen(function*() {
      while (true) {
        yield* Effect.forEach(streams, (_, i) => fill(i), { concurrency: "unbounded", discard: true })
        let best = -1
        for (let i = 0; i < buffers.length; i++) {
          const b = buffers[i]
          if (b && b.length > 0 && (best < 0 || compare(b[0]!, buffers[best]![0]!) < 0)) best = i
        }
        if (best < 0) return yield* Cause.done()
        const value = buffers[best]!.shift()!
        if (last !== undefined && compare(last.value, value) === 0) continue
        last = { value }
        return [value] as const
      }
    })
    return Stream.fromPull(Effect.succeed(pull))
  }))
}
