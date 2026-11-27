import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Quorum from "../src/Quorum.ts"
import { error, makeWorld, type Member, NodeError, type Spec, timed, value } from "./world.ts"

const setup = (
  specs: ReadonlyArray<Spec>,
  options: Partial<Quorum.AgreeOptions<Member, string, string, NodeError, never>> & { threshold: number }
) => {
  const world = makeWorld(specs)
  const effect = Quorum.agree(world.members, {
    weight: world.weight,
    run: world.run,
    key: (v) => v,
    ...options
  })
  return { world, effect }
}

const say = (value: string, delay: number | "never", weight = 1): Spec => ({ value, delay, weight })
const summary = (groups: ReadonlyArray<Quorum.Group<Member, string, string>>) =>
  groups.map((g) => [g.key, g.weight, g.successes.map((s) => s.index)])

describe("Quorum.agree", () => {
  test("13. early agreement: decided at the third answer, the slow fourth interrupted", async () => {
    const { world, effect } = setup([say("a", 100), say("a", 200), say("a", 300), say("a", 1000)], { threshold: 3 })
    const { exit, at } = await timed(effect)
    expect(at).toBe(300)
    const r = value(exit)
    expect(summary([r.winner])).toEqual([["a", 3, [0, 1, 2]]])
    expect(r.weight).toBe(3)
    expect(r.totalWeight).toBe(4)
    expect(r.unsettled.map((u) => [u.index, u.started])).toEqual([[3, true]])
    expect(world.at(3, "interrupted")).toBe(300)
  })

  test("14. waits for the quorum even when a key is over the threshold early", async () => {
    const { world, effect } = setup(
      [say("a", 100), say("a", 200), say("b", 300), say("a", 400), say("a", 1000)],
      { threshold: 2, quorum: 4 }
    )
    const { exit, at } = await timed(effect)
    expect(at).toBe(400)
    const r = value(exit)
    expect(r.winner.key).toBe("a")
    expect(r.winner.weight).toBe(3)
    expect(summary(r.groups)).toEqual([["a", 3, [0, 1, 3]], ["b", 1, [2]]])
    expect(world.of("interrupted")).toEqual([4])
  })

  describe("15. prefer", () => {
    const specs = [say("a", 100), say("a", 200), say("a", 300), say("b", 400), say("b", 500)]

    test("default: the heavier key", async () => {
      const r = value((await timed(setup(specs, { threshold: 2, quorum: 5 }).effect)).exit)
      expect(r.winner.key).toBe("a")
    })

    test("default tie: the first seen", async () => {
      const r = value(
        (await timed(setup([say("b", 100), say("a", 200), say("a", 300), say("b", 400)], { threshold: 2, quorum: 4 })
          .effect)).exit
      )
      expect(r.winner.key).toBe("b")
    })

    test("a preference picks among keys over the threshold", async () => {
      const rank = (k: string) => (k === "b" ? 1 : 0)
      const r = value(
        (await timed(setup(specs, { threshold: 2, quorum: 5, prefer: (x, y) => rank(x.key) - rank(y.key) }).effect))
          .exit
      )
      expect(r.winner.key).toBe("b")
      expect(r.winner.weight).toBe(2)
      expect(r.groups.map((g) => g.key)).toEqual(["a", "b"])
    })
  })

  test("16. split answers: fails as soon as no key can reach the threshold, with every group", async () => {
    const { world, effect } = setup(
      [say("a", 100), say("b", 200), say("c", 300), say("d", 400), say("a", 1000), say("a", 1000)],
      { threshold: 4 }
    )
    const { exit, at } = await timed(effect)
    expect(at).toBe(400)
    const e = error(exit)
    expect(e).toBeInstanceOf(Quorum.AgreementFailed)
    expect(e.reason).toBe("unreachable")
    expect(summary(e.groups)).toEqual([["a", 1, [0]], ["b", 1, [1]], ["c", 1, [2]], ["d", 1, [3]]])
    expect(e.unsettled.map((u) => u.index)).toEqual([4, 5])
    expect(world.of("interrupted").sort()).toEqual([4, 5])
    expect(e.message).toBe("agreement unreachable: best 1 of 4 agreed, 4 responded of 4, 0 failed, 2 unsettled (total 6)")
  })

  test("17. failures shrink what remains: the quorum becomes unreachable", async () => {
    const down = [new NodeError("down")]
    const { effect } = setup(
      [
        { delay: 100, outcomes: down },
        { delay: 200, outcomes: down },
        say("a", 1000),
        say("a", 1000),
        say("a", 1000)
      ],
      { threshold: 2, quorum: 4 }
    )
    const { exit, at } = await timed(effect)
    expect(at).toBe(200)
    const e = error(exit)
    expect(e.reason).toBe("unreachable")
    expect(e.quorum).toBe(4)
    expect(e.failures.map((f) => [f.index, f.error.code])).toEqual([[0, "down"], [1, "down"]])
  })

  test("weighted members and a quorum below the threshold (treated as the threshold)", async () => {
    const { effect } = setup([say("a", 100, 3), say("b", 200, 5), say("a", 300, 2)], { threshold: 5, quorum: 1 })
    const { exit, at } = await timed(effect)
    expect(at).toBe(200)
    expect(value(exit).winner.key).toBe("b")
  })

  test("quorum above the total weight: insufficientWeight, nothing runs", async () => {
    const { world, effect } = setup([say("a", 1), say("a", 1)], { threshold: 1, quorum: 3 })
    const e = error((await timed(effect)).exit)
    expect(e.reason).toBe("insufficientWeight")
    expect(e.unsettled.map((u) => u.started)).toEqual([false, false])
    expect(world.events).toEqual([])
  })

  test("a non-positive threshold, a NaN quorum and a throwing key die", async () => {
    const dies = async (effect: Effect.Effect<unknown, unknown>) => {
      const { exit } = await timed(effect)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }
    await dies(setup([say("a", 1)], { threshold: 0 }).effect)
    await dies(setup([say("a", 1)], { threshold: 1, quorum: NaN }).effect)
    const { world, effect } = setup([say("a", 100), say("a", 1000)], {
      threshold: 2,
      key: () => {
        throw new Error("bad key")
      }
    })
    await dies(effect)
    expect(world.inFlight.size).toBe(0)
  })
})
