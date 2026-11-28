import * as Effect from "effect/Effect"
import { dirname, join } from "node:path"
import * as Generate from "../src/Generate.ts"
import * as Render from "../src/Render.ts"
import * as Summary from "../src/Summary.ts"

const here = dirname(new URL(import.meta.url).pathname)
export const fixtureDir = join(here, "fixtures/fixture")
export const goldenDir = join(here, "golden")

/** The golden runs: the fixture, and framework modules from the same (pruned) summaries. */
export const goldenRuns = {
  fixture: [{ package: undefined, modules: undefined }],
  framework: [{ package: "sui", modules: ["balance", "coin"] }, { package: "std", modules: ["option"] }]
} as const

export const renderGolden = (run: keyof typeof goldenRuns) =>
  Effect.gen(function*() {
    const roots = goldenRuns[run]
    const models = yield* Effect.forEach(roots, (r) => Summary.load(fixtureDir, { package: r.package }))
    return Render.render(
      Generate.merge(models),
      models.map((m, i) => ({ address: m.root, modules: roots[i]!.modules }))
    )
  })
