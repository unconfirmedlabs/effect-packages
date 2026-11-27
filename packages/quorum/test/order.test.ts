import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Random from "effect/Random"
import * as Quorum from "../src/Quorum.ts"

/** The order in which members start, when all of them run one at a time. */
const startOrder = (weights: ReadonlyArray<number>, order: Quorum.Order) => {
  const started: Array<number> = []
  return Effect.as(
    Quorum.run(weights.map((weight, id) => ({ id, weight })), {
      weight: (m) => m.weight,
      run: (m) => Effect.sync(() => started.push(m.id)),
      threshold: weights.reduce((a, b) => a + b, 0),
      concurrency: 1,
      order
    }),
    started
  )
}

const weights = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

describe("order", () => {
  test("18. shuffle and weightedShuffle are deterministic under a seed and are permutations", async () => {
    for (const order of ["shuffle", "weightedShuffle"] as const) {
      const a = await Effect.runPromise(startOrder(weights, order).pipe(Random.withSeed("seed-1")))
      const b = await Effect.runPromise(startOrder(weights, order).pipe(Random.withSeed("seed-1")))
      const c = await Effect.runPromise(startOrder(weights, order).pipe(Random.withSeed("seed-2")))
      expect(a).toEqual(b)
      expect([...a].sort((x, y) => x - y)).toEqual(weights.map((_, i) => i))
      expect(c).not.toEqual(a)
    }
  })

  test("19. weightedShuffle: weight 10 starts before weight 1 in about 10/11 of runs", async () => {
    const runs = 2000
    const firsts = await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: runs }, (_, seed) => seed),
        (seed) => Effect.map(startOrder([1, 10], "weightedShuffle").pipe(Random.withSeed(seed)), (o) => o[0])
      )
    )
    const heavyFirst = firsts.filter((id) => id === 1).length / runs
    expect(Math.abs(heavyFirst - 10 / 11)).toBeLessThan(0.03)
  })
})
