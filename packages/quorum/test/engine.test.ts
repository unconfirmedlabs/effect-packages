import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Quorum from "../src/Quorum.ts"
import { makeWorld, NodeError, timed, value } from "./world.ts"

const dies = <A, E>(exit: Exit.Exit<A, E>) => Exit.isFailure(exit) && Cause.hasDies(exit.cause)

describe("function-valued concurrency", () => {
  test("widens by one lane per final failure; unstarted members are reported as such", async () => {
    // 10 members: the first 6 fail after 1 s, the 7th answers after 1 s, the rest never.
    const world = makeWorld([
      ...Array.from({ length: 6 }, () => ({ delay: 1000, outcomes: [new NodeError("nf", false)] as const })),
      { delay: 1000 },
      { delay: "never" as const },
      { delay: "never" as const },
      { delay: "never" as const }
    ])
    const seen: Array<Quorum.Progress> = []
    const { exit, at } = await timed(Quorum.run(world.members, {
      weight: world.weight,
      run: world.run,
      threshold: 1,
      concurrency: (p) => {
        seen.push(p)
        return 3 + p.failed
      }
    }))
    const r = value(exit)
    // t=0: 0,1,2 start. t=1000: each failure widens the window by one and frees its lane: 3..8 start.
    // t=2000: 3,4,5 fail (widening to 12, so 9 starts) and then 6 succeeds.
    expect(at).toBe(2000)
    expect(world.events.filter((e) => e.what === "start").map((e) => [e.at, e.id])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1000, 3],
      [1000, 4],
      [1000, 5],
      [1000, 6],
      [1000, 7],
      [1000, 8],
      [2000, 9]
    ])
    expect(world.maxInFlight).toBe(6)
    expect(r.successes.map((s) => s.index)).toEqual([6])
    expect(r.unsettled.map((u) => [u.index, u.started])).toEqual([[7, true], [8, true], [9, true]])
    expect(seen[0]).toEqual({ succeeded: 0, failed: 0, reachedWeight: 0, failedWeight: 0 })
  })

  test("returning a non-positive or fractional limit is a defect", async () => {
    for (const bad of [0, 1.5]) {
      const world = makeWorld([{ delay: 1000 }])
      const { exit } = await timed(Quorum.run(world.members, {
        weight: world.weight,
        run: world.run,
        threshold: 1,
        concurrency: () => bad
      }))
      expect(dies(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) && Cause.squash(exit.cause))).toContain("Quorum: concurrency")
    }
  })

})

describe("after the threshold is reached", () => {
  test("a defect during the linger window keeps the reached quorum", async () => {
    const world = makeWorld([
      { delay: 1000 },
      { delay: 1100 },
      { delay: 1200, outcomes: ["die"] },
      { delay: 1500 }
    ])
    const { exit, at } = await timed(Quorum.run(world.members, {
      weight: world.weight,
      run: world.run,
      threshold: 1,
      linger: "1 second"
    }))
    const r = value(exit)
    // The defect ends the window: what arrived before it is kept, the rest is interrupted.
    expect(at).toBe(1200)
    expect(r.successes.map((s) => s.index)).toEqual([0, 1])
    expect(r.unsettled.map((u) => [u.index, u.started])).toEqual([[3, true]])
    expect(world.of("interrupted")).toEqual([3])
  })

  test("a member that interrupts itself during the linger window keeps the quorum", async () => {
    const world = makeWorld([{ delay: 1000 }, { delay: 1200, outcomes: ["interrupt"] }])
    const { exit, at } = await timed(Quorum.run(world.members, {
      weight: world.weight,
      run: world.run,
      threshold: 1,
      linger: "1 second"
    }))
    expect(value(exit).successes.map((s) => s.index)).toEqual([0])
    expect(at).toBe(1200)
  })

  test("a defect before the threshold still fails the call", async () => {
    const world = makeWorld([{ delay: 1000, outcomes: ["die"] }, { delay: 1200 }])
    const { exit } = await timed(Quorum.run(world.members, {
      weight: world.weight,
      run: world.run,
      threshold: 1,
      linger: "1 second"
    }))
    expect(dies(exit)).toBe(true)
  })

  test("a defect during the giveUp grace still fails the call (no quorum was reached)", async () => {
    const world = makeWorld([
      { delay: 100, outcomes: [new NodeError("nf", false)] },
      { delay: 200, outcomes: ["die"] },
      { delay: 5000 }
    ])
    const { exit } = await timed(Quorum.run(world.members, {
      weight: world.weight,
      run: world.run,
      threshold: 2,
      giveUp: { when: () => true, weight: 1, grace: "1 second" }
    }))
    expect(dies(exit)).toBe(true)
  })

  test("settlements queued in the same turn as the deciding one are kept", async () => {
    const done: Array<number> = []
    const r = await Effect.runPromise(Quorum.run([0, 1, 2, 3], {
      weight: () => 1,
      threshold: 1,
      run: (m) =>
        Effect.sync(() => {
          done.push(m)
          return m
        })
    }))
    expect(done).toEqual([0, 1, 2, 3])
    expect(r.successes.map((s) => s.index)).toEqual([0, 1, 2, 3])
    expect(r.weight).toBe(4)
    expect(r.unsettled).toEqual([])
  })

  test("agree: answers queued with the deciding one join their groups", async () => {
    const r = await Effect.runPromise(Quorum.agree(["a", "a", "b", "a"], {
      weight: () => 1,
      run: (m) => Effect.succeed(m),
      key: (v) => v,
      threshold: 1
    }))
    expect(r.weight).toBe(4)
    expect(r.groups.map((g) => [g.key, g.weight])).toEqual([["a", 3], ["b", 1]])
    expect(r.winner.key).toBe("a")
  })
})
