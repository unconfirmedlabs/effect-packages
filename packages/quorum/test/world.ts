/**
 * Scripted members under TestClock. Each member sleeps for its delay, then succeeds, fails or dies;
 * the world records starts, attempts, completions and interruptions with their virtual times.
 */
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"

export class NodeError {
  readonly _tag = "NodeError"
  constructor(readonly code: string, readonly retryable = true) {}
}

export interface Spec {
  readonly weight?: number
  /** Milliseconds per attempt, or "never". */
  readonly delay: number | "never"
  /** Each attempt's outcome, in order; the last repeats. Default: succeed with `value`. */
  readonly outcomes?: ReadonlyArray<"ok" | NodeError | "die" | "interrupt">
  readonly value?: string
}

export interface Member extends Spec {
  readonly id: number
}

export interface Event {
  readonly at: number
  readonly id: number
  readonly what: "start" | "ok" | "fail" | "interrupted"
}

export const makeWorld = (specs: ReadonlyArray<Spec>) => {
  const members: Array<Member> = specs.map((s, id) => ({ ...s, id }))
  const events: Array<Event> = []
  const attempts = new Map<number, number>()
  const inFlight = new Set<number>()
  let maxInFlight = 0

  const log = (id: number, what: Event["what"]) =>
    Effect.map(Clock.currentTimeMillis, (at) => {
      events.push({ at, id, what })
    })

  const run = (m: Member): Effect.Effect<string, NodeError> =>
    Effect.gen(function*() {
      const n = attempts.get(m.id) ?? 0
      attempts.set(m.id, n + 1)
      inFlight.add(m.id)
      maxInFlight = Math.max(maxInFlight, inFlight.size)
      yield* log(m.id, "start")
      if (m.delay === "never") return yield* Effect.never
      yield* Effect.sleep(m.delay)
      const outcomes = m.outcomes ?? ["ok"]
      const outcome = outcomes[Math.min(n, outcomes.length - 1)]!
      if (outcome === "die") return yield* Effect.die(new Error(`boom ${m.id}`))
      if (outcome === "interrupt") return yield* Effect.interrupt
      if (outcome instanceof NodeError) {
        yield* log(m.id, "fail")
        return yield* Effect.fail(outcome)
      }
      yield* log(m.id, "ok")
      return m.value ?? `v${m.id}`
    }).pipe(
      Effect.onInterrupt(() => log(m.id, "interrupted")),
      Effect.ensuring(Effect.sync(() => inFlight.delete(m.id)))
    )

  return {
    members,
    events,
    run,
    weight: (m: Member) => m.weight ?? 1,
    attempts: (id: number) => attempts.get(id) ?? 0,
    get maxInFlight() {
      return maxInFlight
    },
    inFlight,
    of: (what: Event["what"]) => events.filter((e) => e.what === what).map((e) => e.id),
    at: (id: number, what: Event["what"]) => events.find((e) => e.id === id && e.what === what)?.at
  }
}

/** Forks `effect`, advances the clock by `advance`, and returns its exit with the virtual time it ended at. */
export const timed = <A, E>(effect: Effect.Effect<A, E>, advance: Duration.Input = "1 hour") =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        Effect.flatMap(Effect.exit(effect), (exit) => Effect.map(Clock.currentTimeMillis, (at) => ({ exit, at })))
      )
      yield* TestClock.adjust(advance)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()))
  )

export const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected success, got ${String(exit.cause)}`)
}

export const error = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isFailure(exit)) {
    const reason = exit.cause.reasons[0]
    if (reason && reason._tag === "Fail") return reason.error
  }
  throw new Error(`expected a typed failure, got ${Exit.isSuccess(exit) ? "success" : String(exit.cause)}`)
}
