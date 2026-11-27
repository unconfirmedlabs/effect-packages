/**
 * README examples, checked: every ```ts block of the README (except
 * ```ts nocheck) must appear in a file under `examples/`, which
 * `bun run typecheck` compiles. A block's `import` lines must be imports of
 * that file; the rest must equal, after dedenting, a region of it between
 * `// #region readme` and `// #endregion`. Every region must be used.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface Block {
  readonly line: number
  readonly imports: ReadonlyArray<string>
  readonly body: string
}

const dedent = (lines: ReadonlyArray<string>): string => {
  const trimmed = lines.map((l) => l.trimEnd())
  const indent = Math.min(...trimmed.filter((l) => l.length > 0).map((l) => l.length - l.trimStart().length))
  const out = trimmed.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
  while (out.length > 0 && out[0] === "") out.shift()
  while (out.length > 0 && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}

export const blocks = (markdown: string): Array<Block> => {
  const lines = markdown.split("\n")
  const out: Array<Block> = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "```ts") continue
    const start = i + 1
    let end = start
    while (lines[end]!.trim() !== "```") end++
    const content = lines.slice(start, end)
    out.push({
      line: start,
      imports: content.filter((l) => l.trimStart().startsWith("import ")).map((l) => l.trim().replace(/\s+\/\/.*$/, "")),
      body: dedent(content.filter((l) => !l.trimStart().startsWith("import ")))
    })
    i = end
  }
  return out
}

export interface Example {
  readonly file: string
  readonly imports: ReadonlySet<string>
  readonly regions: ReadonlyArray<string>
}

export const examples = (dir: string): Array<Example> =>
  readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => {
    const lines = readFileSync(join(dir, f), "utf-8").split("\n")
    const regions: Array<string> = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() !== "// #region readme") continue
      let end = i + 1
      while (lines[end]!.trim() !== "// #endregion") end++
      regions.push(dedent(lines.slice(i + 1, end)))
      i = end
    }
    const imports = new Set(lines.filter((l) => l.startsWith("import ")).map((l) => l.trim().replace(/\s+\/\/.*$/, "")))
    return { file: f, imports, regions }
  })

/** Every problem: a block with no matching region (or a missing import), and a region no block uses. */
export const check = (markdown: string, dir: string): Array<string> => {
  const all = examples(dir)
  const used = new Set<string>()
  const problems: Array<string> = []
  for (const b of blocks(markdown)) {
    // A block of imports only needs a file that has them all.
    const home = b.body === ""
      ? all.find((e) => b.imports.every((i) => e.imports.has(i)))
      : all.find((e) => e.regions.includes(b.body))
    if (home === undefined) {
      problems.push(`README line ${b.line}: no region in examples/ matches this block`)
      continue
    }
    if (b.body !== "") used.add(`${home.file}#${home.regions.indexOf(b.body)}`)
    for (const i of b.imports) if (!home.imports.has(i)) problems.push(`README line ${b.line}: examples/${home.file} lacks \`${i}\``)
  }
  for (const e of all) {
    e.regions.forEach((_, k) => {
      if (!used.has(`${e.file}#${k}`)) problems.push(`examples/${e.file}: region ${k + 1} is not in the README`)
    })
  }
  return problems
}
