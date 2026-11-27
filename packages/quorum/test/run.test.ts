import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import { TestClock } from "effect/testing"
import * as Quorum from "../src/Quorum.ts"
import { error, makeWorld, type Member, NodeError, type Spec, timed, value } from "./world.ts"

const setup = (specs: ReadonlyArray<Spec>, options: Partial<Quorum.Options<Member, string, NodeError, never>> = {}) => {
  const world = makeWorld(specs)
  const effect = Quorum.run(world.members, { weight: world.weight, run: world.run, threshold: 1, ...options })
  return { world, effect }
}

const defect = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) return Cause.squash(exit.cause)
  throw new Error(`expected a defect, got ${Exit.isSuccess(exit) ? "success" : String(exit.cause)}`)
}

describe("Quorum.run", () => {
  test("1. succeeds at the threshold and interrupts the rest", async () => {
    const { world, effect } = setup([{ delay: 1000 }, { delay: 2000 }, { delay: 10_000 }], { threshold: 2 })
    const { exit, at } = await timed(effect)
    const r = value(exit)
    expect(at).toBe(2000)
    expect(r.successes.map((s) => [s.index, s.value])).toEqual([[0, "v0"], [1, "v1"]])
    expect(r.weight).toBe(2)
    expect(r.totalWeight).toBe(3)
    expect(r.unsettled).toEqual([{ member: world.members[2]!, index: 2, weight: 1, started: true }])
    expect(world.at(2, "interrupted")).toBe(2000)
    expect(world.inFlight.size).toBe(0)
  })

  test("2. returns on the crossing success", async () => {
    const { world, effect } = setup([{ delay: "never" }, { delay: 500 }, { delay: "never" }, { delay: 700 }], {
      threshold: 2
    })
    const { exit, at } = await timed(effect)
    expect(at).toBe(700)
    expect(value(exit).successes.map((s) => s.index)).toEqual([1, 3])
    expect(world.of("interrupted").sort()).toEqual([0, 2])
  })

  test("3. the last member to settle reaches the threshold: success", async () => {
    const { effect } = setup(
      [{ delay: 100, outcomes: [new NodeError("x")] }, { delay: 200 }, { delay: 300 }],
      { threshold: 2 }
    )
    const { exit, at } = await timed(effect)
    expect(at).toBe(300)
    const r = value(exit)
    expect(r.weight).toBe(2)
    expect(r.failures.map((f) => f.index)).toEqual([0])
    expect(r.unsettled).toEqual([])
  })

  test("4. fails fast once the threshold is out of reach", async () => {
    const fail = [new NodeError("down")]
    const { world, effect } = setup(
      [
        { weight: 3, delay: 1000, outcomes: fail },
        { weight: 3, delay: 1000, outcomes: fail },
        { weight: 3, delay: 10_000 },
        { weight: 1, delay: 10_000 }
      ],
      { threshold: 7 }
    )
    const { exit, at } = await timed(effect)
    expect(at).toBe(1000)
    const e = error(exit)
    expect(e._tag).toBe("QuorumFailed")
    expect(e.reason).toBe("unreachable")
    expect(e.failures.map((f) => f.index)).toEqual([0, 1])
    expect(world.of("interrupted").sort()).toEqual([2, 3])
    expect(world.inFlight.size).toBe(0)
  })

  test("5. weights: one heavy member alone, or many light ones", async () => {
    const heavy = setup([{ delay: 300 }, { delay: 200 }, { weight: 5, delay: 100 }], { threshold: 5 })
    const h = await timed(heavy.effect)
    expect(h.at).toBe(100)
    expect(value(h.exit).successes.map((s) => s.index)).toEqual([2])

    const light = setup([{ delay: 100 }, { delay: 200 }, { delay: 300 }, { weight: 5, delay: 1000 }], {
      threshold: 3
    })
    const l = await timed(light.effect)
    expect(l.at).toBe(300)
    expect(value(l.exit).successes.map((s) => s.index)).toEqual([0, 1, 2])
  })

  describe("6. retry", () => {
    test("fails twice, then succeeds", async () => {
      const { world, effect } = setup(
        [{ delay: 1000, outcomes: [new NodeError("a"), new NodeError("b"), "ok"] }],
        { schedule: Schedule.spaced("1 second") }
      )
      const { exit, at } = await timed(effect)
      // attempts at 0-1 s, 2-3 s, 4-5 s
      expect(at).toBe(5000)
      expect(value(exit).successes.length).toBe(1)
      expect(world.attempts(0)).toBe(3)
    })

    test("`while` returning false ends the member after one attempt", async () => {
      const { world, effect } = setup(
        [{ delay: 100, outcomes: [new NodeError("fatal", false)] }, { delay: 5000 }],
        { schedule: Schedule.spaced("1 second"), while: (e) => e.retryable, threshold: 2 }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(100)
      expect(error(exit).failures.map((f) => f.error.code)).toEqual(["fatal"])
      expect(world.attempts(0)).toBe(1)
    })

    test("an exhausted schedule records the last error", async () => {
      const { world, effect } = setup(
        [{ delay: 100, outcomes: [new NodeError("e1"), new NodeError("e2"), new NodeError("e3")] }],
        { schedule: Schedule.recurs(2) }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(300)
      expect(error(exit).failures.map((f) => f.error.code)).toEqual(["e3"])
      expect(world.attempts(0)).toBe(3)
    })

    test("without a schedule, one attempt", async () => {
      const { world, effect } = setup([{ delay: 100, outcomes: [new NodeError("x"), "ok"] }])
      const { exit } = await timed(effect)
      expect(error(exit).reason).toBe("unreachable")
      expect(world.attempts(0)).toBe(1)
    })
  })

  describe("7. concurrency", () => {
    test("at most N in flight, started in order", async () => {
      const { world, effect } = setup(
        [{ delay: 300 }, { delay: 100 }, { delay: 100 }, { delay: 100 }, { delay: 100 }],
        { concurrency: 2, threshold: 5 }
      )
      const { exit, at } = await timed(effect)
      expect(value(exit).weight).toBe(5)
      expect(world.maxInFlight).toBe(2)
      expect(world.of("start")).toEqual([0, 1, 2, 3, 4])
      expect(world.events.filter((e) => e.what === "start").map((e) => e.at)).toEqual([0, 0, 100, 200, 300])
      expect(at).toBe(400)
    })

    test("a retrying member keeps its slot", async () => {
      const { world, effect } = setup(
        [{ delay: 1000, outcomes: [new NodeError("a"), "ok"] }, { delay: 100 }],
        { concurrency: 1, threshold: 2, schedule: Schedule.spaced("1 second") }
      )
      const { exit, at } = await timed(effect)
      expect(value(exit).weight).toBe(2)
      expect(world.at(1, "start")).toBe(3000)
      expect(at).toBe(3100)
    })
  })

  describe("8. linger", () => {
    // The Rust client's default: half the time to quorum, plus 500 ms.
    const linger = (elapsed: Duration.Duration) => Duration.sum(Duration.times(elapsed, 0.5), Duration.millis(500))

    test("keeps going for the window, keeps what arrives, interrupts the rest", async () => {
      const { world, effect } = setup(
        [{ delay: 1000 }, { delay: 2000 }, { delay: 3000 }, { delay: 5000 }],
        { threshold: 2, linger }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(3500)
      const r = value(exit)
      expect(r.successes.map((s) => s.index)).toEqual([0, 1, 2])
      expect(r.weight).toBe(3)
      expect(r.unsettled.map((u) => [u.index, u.started])).toEqual([[3, true]])
      expect(world.at(3, "interrupted")).toBe(3500)
    })

    test("returns as soon as everything has settled", async () => {
      const { effect } = setup(
        [{ delay: 1000 }, { delay: 2000 }, { delay: 2500, outcomes: [new NodeError("late")] }],
        { threshold: 2, linger }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(2500)
      const r = value(exit)
      expect(r.successes.length).toBe(2)
      expect(r.failures.map((f) => f.error.code)).toEqual(["late"])
    })

    test("a fixed window keeps starting queued members", async () => {
      const { world, effect } = setup(
        [{ delay: 100 }, { delay: 100 }, { delay: 100 }],
        { threshold: 1, concurrency: 1, linger: "250 millis" }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(300)
      expect(value(exit).successes.map((s) => s.index)).toEqual([0, 1, 2])
      expect(world.of("start")).toEqual([0, 1, 2])
    })

    test("a non-positive window is no window", async () => {
      const { effect } = setup([{ delay: 100 }, { delay: 200 }], { threshold: 1, linger: 0 })
      const { exit, at } = await timed(effect)
      expect(at).toBe(100)
      expect(value(exit).unsettled.length).toBe(1)
    })
  })

  describe("9. edge cases", () => {
    test("empty list: threshold 0 succeeds, threshold 1 is insufficientWeight", async () => {
      let calls = 0
      const run = () => Effect.sync(() => calls++)
      const ok = await timed(Quorum.run([], { weight: () => 1, run, threshold: 0 }))
      expect(value(ok.exit)).toEqual({ successes: [], weight: 0, totalWeight: 0, failures: [], unsettled: [] })
      const no = await timed(Quorum.run([], { weight: () => 1, run, threshold: 1 }))
      expect(error(no.exit).reason).toBe("insufficientWeight")
      expect(calls).toBe(0)
    })

    test("threshold above the total: insufficientWeight, nothing runs, all unsettled and unstarted", async () => {
      const { world, effect } = setup([{ delay: 1 }, { weight: 2, delay: 1 }], { threshold: 4 })
      const e = error((await timed(effect)).exit)
      expect(e.reason).toBe("insufficientWeight")
      expect(e.totalWeight).toBe(3)
      expect(e.unsettled.map((u) => [u.index, u.weight, u.started])).toEqual([[0, 1, false], [1, 2, false]])
      expect(e.message).toBe("quorum insufficient weight: total 3 is below 4")
      expect(world.events).toEqual([])
    })

    test("threshold <= 0 succeeds at once without running anything", async () => {
      const { world, effect } = setup([{ delay: 1 }], { threshold: 0 })
      const r = value((await timed(effect)).exit)
      expect(r.successes).toEqual([])
      expect(r.unsettled.map((u) => u.started)).toEqual([false])
      expect(world.events).toEqual([])
    })

    test("a zero-weight member is dropped", async () => {
      const { world, effect } = setup([{ weight: 0, delay: 1 }, { delay: 10 }], { threshold: 1 })
      const r = value((await timed(effect)).exit)
      expect(r.totalWeight).toBe(1)
      expect(r.successes.map((s) => s.index)).toEqual([1])
      expect(r.unsettled).toEqual([])
      expect(world.attempts(0)).toBe(0)
    })

    test("negative, NaN and infinite weights die, naming the index", async () => {
      for (const w of [-1, NaN, Infinity]) {
        const { world, effect } = setup([{ delay: 1 }, { weight: w, delay: 1 }])
        const d = defect((await timed(effect)).exit)
        expect(String(d)).toContain("member 1")
        expect(world.events).toEqual([])
      }
    })

    test("a throwing weight dies", async () => {
      const exit = (await timed(Quorum.run([1], {
        weight: () => {
          throw new Error("no weight")
        },
        run: Effect.succeed,
        threshold: 1
      }))).exit
      expect(String(defect(exit))).toContain("no weight")
    })

    test("invalid threshold and concurrency die", async () => {
      for (const options of [{ threshold: NaN }, { threshold: Infinity }, { concurrency: 0 }, { concurrency: 1.5 }, {
        concurrency: NaN
      }]) {
        const { world, effect } = setup([{ delay: 1 }], options)
        defect((await timed(effect)).exit)
        expect(world.events).toEqual([])
      }
    })

    test("duplicates are separate members and both count", async () => {
      const world = makeWorld([{ delay: 10 }])
      const m = world.members[0]!
      const r = value((await timed(Quorum.run([m, m], { weight: world.weight, run: world.run, threshold: 2 }))).exit)
      expect(r.successes.map((s) => s.index).sort()).toEqual([0, 1])
      expect(world.attempts(0)).toBe(2)
    })
  })

  test("10. a defect in one member fails the call and interrupts the others", async () => {
    const { world, effect } = setup([{ delay: 1000, outcomes: ["die"] }, { delay: 5000 }, { delay: 5000 }], {
      threshold: 2
    })
    const { exit, at } = await timed(effect)
    expect(at).toBe(1000)
    expect(String(defect(exit))).toContain("boom 0")
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
    expect(world.of("interrupted").sort()).toEqual([1, 2])
    expect(world.inFlight.size).toBe(0)
  })

  test("10b. a member that interrupts itself interrupts the call", async () => {
    const { world, effect } = setup([{ delay: 1000, outcomes: ["interrupt"] }, { delay: 5000 }])
    const { exit, at } = await timed(effect)
    expect(at).toBe(1000)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(world.inFlight.size).toBe(0)
  })

  test("11. interrupting the caller interrupts every attempt and waits for them", async () => {
    const { world, effect } = setup([{ delay: 1000 }, { delay: 5000 }, { delay: 5000 }, { delay: "never" }], {
      threshold: 4
    })
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(effect)
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(world.of("interrupted").sort()).toEqual([1, 2, 3])
    expect(world.inFlight.size).toBe(0)
  })

  test("12. the failure value", async () => {
    const { effect } = setup(
      [
        { weight: 2, delay: 1000, value: "secret-value" },
        { weight: 3, delay: 2000, outcomes: [new NodeError("secret-error")] },
        { weight: 3, delay: 10_000 },
        { weight: 3, delay: 10_000 }
      ],
      { threshold: 9, concurrency: 2 }
    )
    const { exit, at } = await timed(effect)
    expect(at).toBe(2000)
    const e = error(exit)
    expect(e).toBeInstanceOf(Quorum.QuorumFailed)
    expect(e.reason).toBe("unreachable")
    expect(e.threshold).toBe(9)
    expect(e.totalWeight).toBe(11)
    expect(e.weight).toBe(2)
    expect(e.successes.map((s) => [s.index, s.weight, s.value])).toEqual([[0, 2, "secret-value"]])
    expect(e.failures.map((f) => [f.index, f.weight, f.error.code])).toEqual([[1, 3, "secret-error"]])
    expect(e.unsettled.map((u) => [u.index, u.weight, u.started])).toEqual([[2, 3, true], [3, 3, false]])
    expect(e.message).toBe("quorum unreachable: 2 of 9 reached, 3 failed, 6 unsettled (total 11)")
    expect(e.message).not.toContain("secret")
  })

  describe("20. giveUp", () => {
    const notFound = () => new NodeError("notFound", false)
    const isNotFound = (e: NodeError) => e.code === "notFound"

    test("fails at once without grace when matching failures reach the weight", async () => {
      const { world, effect } = setup(
        [
          { weight: 3, delay: 1000, outcomes: [notFound()] },
          { weight: 3, delay: 2000, outcomes: [notFound()] },
          { weight: 3, delay: 10_000 },
          { weight: 1, delay: 10_000 }
        ],
        { giveUp: { when: isNotFound, weight: 6 } }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(2000)
      const e = error(exit)
      expect(e.reason).toBe("gaveUp")
      expect(e.failures.map((f) => f.index)).toEqual([0, 1])
      expect(e.unsettled.map((u) => [u.index, u.started])).toEqual([[2, true], [3, true]])
      expect(e.message).toBe("quorum gave up: 0 of 1 reached, 6 failed, 4 unsettled (total 10)")
      expect(world.of("interrupted").sort()).toEqual([2, 3])
      expect(world.inFlight.size).toBe(0)
    })

    test("a zero grace is no grace", async () => {
      const { effect } = setup([{ delay: 100, outcomes: [notFound()] }, { delay: 200 }], {
        giveUp: { when: isNotFound, weight: 1, grace: 0 }
      })
      const { exit, at } = await timed(effect)
      expect(at).toBe(100)
      expect(error(exit).reason).toBe("gaveUp")
    })

    test("non-matching failures do not count", async () => {
      const giveUp = { when: isNotFound, weight: 2 }
      const a = setup(
        [{ delay: 100, outcomes: [notFound()] }, { delay: 200, outcomes: [new NodeError("down")] }, { delay: 1000 }],
        { giveUp }
      )
      const ra = await timed(a.effect)
      expect(ra.at).toBe(1000)
      expect(value(ra.exit).failures.map((f) => f.error.code)).toEqual(["notFound", "down"])

      const b = setup(
        [
          { delay: 100, outcomes: [notFound()] },
          { delay: 200, outcomes: [new NodeError("down")] },
          { delay: 300, outcomes: [notFound()] },
          { delay: 1000 }
        ],
        { giveUp }
      )
      const rb = await timed(b.effect)
      expect(rb.at).toBe(300)
      expect(error(rb.exit).reason).toBe("gaveUp")
      expect(error(rb.exit).failures.map((f) => f.index)).toEqual([0, 1, 2])
    })

    test("a retrying member counts only once its failure is final", async () => {
      const seen: Array<string> = []
      const { world, effect } = setup(
        [{ delay: 100, outcomes: [new NodeError("notFound")] }, { delay: "never" }],
        {
          schedule: Schedule.recurs(2),
          giveUp: {
            when: (e, m) => {
              seen.push(`${m.id}:${e.code}`)
              return isNotFound(e)
            },
            weight: 1
          }
        }
      )
      const { exit, at } = await timed(effect)
      // attempts end at 100, 200 and 300 ms; only the last is final
      expect(at).toBe(300)
      expect(error(exit).reason).toBe("gaveUp")
      expect(world.attempts(0)).toBe(3)
      expect(seen).toEqual(["0:notFound"])
    })

    test("with grace, a threshold reached inside the window succeeds", async () => {
      const { world, effect } = setup(
        [{ delay: 100, outcomes: [notFound()] }, { delay: 1500 }, { delay: "never" }],
        { giveUp: { when: isNotFound, weight: 1, grace: "2 seconds" } }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(1500)
      const r = value(exit)
      expect(r.successes.map((s) => s.index)).toEqual([1])
      expect(r.failures.map((f) => f.index)).toEqual([0])
      expect(r.unsettled.map((u) => [u.index, u.started])).toEqual([[2, true]])
      expect(world.at(2, "interrupted")).toBe(1500)
    })

    test("with grace, the window keeps starting queued members", async () => {
      const { world, effect } = setup(
        [{ delay: 100, outcomes: [notFound()] }, { delay: 100, outcomes: [notFound()] }, { delay: 300 }],
        { concurrency: 1, giveUp: { when: isNotFound, weight: 1, grace: "1 second" } }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(500)
      expect(value(exit).successes.map((s) => s.index)).toEqual([2])
      expect(world.of("start")).toEqual([0, 1, 2])
    })

    test("the window ends in gaveUp at the exact time", async () => {
      const { world, effect } = setup(
        [{ delay: 100, outcomes: [notFound()] }, { delay: 5000 }],
        { giveUp: { when: isNotFound, weight: 1, grace: "2 seconds" } }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(2100)
      const e = error(exit)
      expect(e.reason).toBe("gaveUp")
      expect(e.unsettled.map((u) => [u.index, u.started])).toEqual([[1, true]])
      expect(world.at(1, "interrupted")).toBe(2100)
    })

    test("the window ends early, as gaveUp, once the threshold is out of reach", async () => {
      const { effect } = setup(
        [{ delay: 100, outcomes: [notFound()] }, { delay: 500, outcomes: [new NodeError("down")] }],
        { giveUp: { when: isNotFound, weight: 1, grace: "2 seconds" } }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(500)
      expect(error(exit).reason).toBe("gaveUp")
      expect(error(exit).failures.map((f) => f.index)).toEqual([0, 1])
    })

    test("unreachable still wins when it comes first", async () => {
      const { effect } = setup(
        [
          { weight: 3, delay: 1000, outcomes: [new NodeError("down")] },
          { weight: 3, delay: 2000, outcomes: [notFound()] },
          { weight: 3, delay: 10_000 },
          { weight: 1, delay: 10_000 }
        ],
        { threshold: 7, giveUp: { when: isNotFound, weight: 3, grace: "5 seconds" } }
      )
      const { exit, at } = await timed(effect)
      expect(at).toBe(2000)
      expect(error(exit).reason).toBe("unreachable")
    })

    test("invalid weight or grace dies", async () => {
      const cases: Array<Quorum.GiveUp<Member, NodeError>> = [
        { when: isNotFound, weight: 0 },
        { when: isNotFound, weight: -1 },
        { when: isNotFound, weight: NaN },
        { when: isNotFound, weight: Infinity },
        { when: isNotFound, weight: 1, grace: -1 },
        { when: isNotFound, weight: 1, grace: NaN },
        { when: isNotFound, weight: 1, grace: "-1 second" }
      ]
      for (const giveUp of cases) {
        const { world, effect } = setup([{ delay: 100 }], { giveUp })
        const d = defect((await timed(effect)).exit)
        expect(d).toBeInstanceOf(Cause.IllegalArgumentError)
        expect(String((d as Error).message)).toStartWith("Quorum: giveUp.")
        expect(world.attempts(0)).toBe(0)
      }
    })
  })

  test("helpers", () => {
    const failures = [
      { member: "a", index: 0, weight: 2, error: "notFound" },
      { member: "b", index: 1, weight: 3, error: "down" },
      { member: "c", index: 2, weight: 4, error: "notFound" }
    ]
    expect(Quorum.weightOf(failures)).toBe(9)
    expect(Quorum.failedWeight(failures, (e) => e === "notFound")).toBe(6)
  })
})

// Type tests: compile-time only.
export const typeTests = () => {
  class Other {
    readonly _tag = "Other"
  }
  const members: ReadonlyArray<{ id: number }> = []
  const run = (_: { id: number }): Effect.Effect<string, NodeError, "Service"> => Effect.die("unused") as never

  const ok: Effect.Effect<
    Quorum.Reached<{ id: number }, string, NodeError>,
    Quorum.QuorumFailed<{ id: number }, string, NodeError>,
    "Service"
  > = Quorum.run(members, { weight: () => 1, run, threshold: 1, schedule: Schedule.spaced("1 second") })

  const withInput: Schedule.Schedule<unknown, NodeError> = Schedule.recurs(1)
  Quorum.run(members, { weight: () => 1, run, threshold: 1, schedule: withInput })

  const wrongInput = Schedule.identity<Other>()
  // @ts-expect-error a schedule over another error type does not compile
  Quorum.run(members, { weight: () => 1, run, threshold: 1, schedule: wrongInput })

  return ok
}
