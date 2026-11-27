/**
 * README examples cannot rot silently: every ```ts block (except ```ts nocheck)
 * must equal a `// #region readme` of a file in `examples/`, and those files
 * are compiled by `bun run typecheck`.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blocks, check } from "../src/readme.ts"

const root = join(import.meta.dir, "..", "..", "..")
const readme = readFileSync(join(root, "README.md"), "utf-8")

test("every checked README block is a compiled example, and every example is in the README", () => {
  expect(blocks(readme).length).toBeGreaterThan(15)
  expect(check(readme, join(root, "examples"))).toEqual([])
})

test("the check notices an edited block", () => {
  const edited = readme.replace("yield* Effect.fromResult(Quilt.encode(entries, nShards))", "yield* Quilt.encode(entries, nShards)")
  expect(edited).not.toBe(readme)
  expect(check(edited, join(root, "examples"))).toEqual([
    expect.stringMatching(/no region in examples\/ matches/),
    expect.stringMatching(/walrus\.ts: region \d+ is not in the README/)
  ])
})
