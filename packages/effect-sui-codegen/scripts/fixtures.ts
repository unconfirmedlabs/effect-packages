/**
 * Regenerate the fixture's package summaries (`sui move summary`), pruned to
 * the modules the tests reach, then the golden output.
 *
 *   bun packages/sui-codegen/scripts/fixtures.ts
 */
import * as Effect from "effect/Effect"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import * as Generate from "../src/Generate.ts"
import { fixtureDir as fixture, goldenDir, goldenRuns, renderGolden } from "../test/support.ts"

const summaries = join(fixture, "package_summaries")

await Effect.runPromise(Generate.summarize(fixture))

// Keep the modules reachable from these.
const seeds = [
  ...readdirSync(join(summaries, "fixture")).map((f) => `fixture/${f.replace(/\.json$/, "")}`),
  "sui/coin",
  "sui/balance",
  "std/option"
]
const keep = new Set<string>()
const queue = [...seeds]
const refs = (node: unknown, out: Set<string>) => {
  if (Array.isArray(node)) return node.forEach((n) => refs(n, out))
  if (typeof node !== "object" || node === null) return
  const dt = (node as { Datatype?: { module: { address: string; name: string } } }).Datatype
  if (dt !== undefined) out.add(`${dt.module.address}/${dt.module.name}`)
  for (const v of Object.values(node)) refs(v, out)
}
while (queue.length > 0) {
  const m = queue.pop()!
  if (keep.has(m)) continue
  keep.add(m)
  const json = JSON.parse(readFileSync(join(summaries, `${m}.json`), "utf-8"))
  const out = new Set<string>()
  // Seeds' signatures matter (parameter abilities); for the rest, only what their layouts use.
  refs(seeds.includes(m) ? [json.structs, json.enums, json.functions] : [json.structs, json.enums], out)
  queue.push(...out)
}
for (const pkg of readdirSync(summaries).filter((f) => !f.endsWith(".json"))) {
  for (const f of readdirSync(join(summaries, pkg))) {
    if (!keep.has(`${pkg}/${f.replace(/\.json$/, "")}`)) rmSync(join(summaries, pkg, f))
  }
}
console.log(`kept ${keep.size} modules`)

// Golden output.
for (const run of Object.keys(goldenRuns) as Array<keyof typeof goldenRuns>) {
  const files = await Effect.runPromise(renderGolden(run))
  rmSync(join(goldenDir, run), { recursive: true, force: true })
  for (const f of files) {
    const path = join(goldenDir, run, f.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, f.contents)
  }
  console.log(`${run}: ${files.map((f) => f.path).join(", ")}`)
}
