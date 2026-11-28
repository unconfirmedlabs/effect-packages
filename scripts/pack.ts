/**
 * Stages every public package for npm under `.publish/<package>/`:
 *
 * - `dist/`: JavaScript, declarations and their maps, compiled by `tsconfig.build.json`;
 * - `src/`: the TypeScript sources the maps point at;
 * - a `package.json` whose exports name `dist/` (types first), whose `workspace:` ranges are the
 *   packages' real versions, and without scripts or devDependencies;
 * - README.md and LICENSE.
 *
 * `bun scripts/pack.ts` stages; `--tarballs` also runs `npm pack` into `.publish/tarballs/`.
 * Publish with `npm publish .publish/<package>` (scoped packages are public via publishConfig).
 */
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const out = join(root, ".publish")
const repo = "https://github.com/unconfirmedlabs/effect-packages"

type Manifest = Record<string, any>
const read = (path: string): Manifest => JSON.parse(readFileSync(path, "utf-8"))

const dirs = readdirSync(join(root, "packages")).filter((d) => d.startsWith("effect-")).sort()
const manifests = new Map(dirs.map((d) => [d, read(join(root, "packages", d, "package.json"))]))
const versions = new Map([...manifests.values()].map((m) => [m.name as string, m.version as string]))

const run = (cmd: string, args: Array<string>, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`)
}

const walk = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

/** `./src/X.ts` → `{ types: ./dist/X.d.ts, default: ./dist/X.js }`; anything else is kept as is. */
const target = (value: unknown): unknown => {
  if (typeof value !== "string" || !value.startsWith("./src/") || !value.endsWith(".ts")) return value
  const base = "./dist/" + value.slice("./src/".length, -".ts".length)
  return { types: `${base}.d.ts`, default: `${base}.js` }
}

const resolveWorkspace = (deps: Record<string, string> | undefined) =>
  deps && Object.fromEntries(Object.entries(deps).map(([name, range]) => {
    if (!range.startsWith("workspace:")) return [name, range]
    const version = versions.get(name)
    if (!version) throw new Error(`${name} is not a public workspace package`)
    const spec = range.slice("workspace:".length)
    return [name, spec === "*" ? version : spec === "^" || spec === "~" ? spec + version : spec]
  }))

const manifest = (m: Manifest, dir: string): Manifest => {
  const files = (m.files as Array<string> | undefined)?.filter((f) => f !== "src") ?? []
  return {
    name: m.name,
    version: m.version,
    description: m.description,
    license: m.license,
    repository: m.repository,
    homepage: `${repo}/tree/main/packages/${dir}#readme`,
    bugs: `${repo}/issues`,
    type: m.type,
    sideEffects: m.sideEffects,
    // npm wants bin paths without the leading ./ (it rewrites them, and warns, on publish)
    ...(m.bin && { bin: Object.fromEntries(Object.entries(m.bin).map(([k, v]) => [k, (target(v) as any).default.slice(2)])) }),
    exports: Object.fromEntries(Object.entries(m.exports).map(([k, v]) => [k, target(v)])),
    files: ["dist", "src", ...files],
    ...(m.dependencies && { dependencies: m.dependencies }),
    ...(m.peerDependencies && { peerDependencies: resolveWorkspace(m.peerDependencies) }),
    publishConfig: { access: "public" }
  }
}

const readme = (m: Manifest, dir: string) => {
  const peers = Object.keys(m.peerDependencies ?? {})
  return `# ${m.name}

${m.description}

\`\`\`sh
npm install ${[m.name, ...peers].join(" ")}
\`\`\`

Documentation: ${repo}#readme. Source: ${repo}/tree/main/packages/${dir}.

Licensed under Apache-2.0.
`
}

rmSync(out, { recursive: true, force: true })
run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"])

for (const dir of dirs) {
  const m = manifests.get(dir)!
  const pkg = join(root, "packages", dir)
  const stage = join(out, dir)
  const built = join(out, "build", dir, "src")
  mkdirSync(stage, { recursive: true })
  renameSync(built, join(stage, "dist"))
  cpSync(join(pkg, "src"), join(stage, "src"), { recursive: true })

  // Maps were written for .publish/build/<dir>/src; point their sources at the staged src/.
  for (const file of walk(join(stage, "dist")).filter((f) => f.endsWith(".map"))) {
    const map = JSON.parse(readFileSync(file, "utf-8"))
    const before = join(built, relative(join(stage, "dist"), dirname(file)))
    map.sources = map.sources.map((s: string) =>
      relative(dirname(file), join(stage, "src", relative(join(pkg, "src"), resolve(before, map.sourceRoot ?? "", s)))))
    delete map.sourceRoot
    writeFileSync(file, JSON.stringify(map))
  }

  for (const f of (m.files as Array<string> | undefined) ?? []) {
    if (f !== "src") cpSync(join(pkg, f), join(stage, f), { recursive: true })
  }
  for (const bin of Object.values(m.bin ?? {}) as Array<string>) chmodSync(join(stage, (target(bin) as any).default), 0o755)

  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest(m, dir), null, 2) + "\n")
  writeFileSync(join(stage, "README.md"), readme(m, dir))
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"))
}
rmSync(join(out, "build"), { recursive: true, force: true })

if (process.argv.includes("--tarballs")) {
  const tarballs = join(out, "tarballs")
  mkdirSync(tarballs)
  for (const dir of dirs) run("npm", ["pack", "--silent", "--pack-destination", tarballs], join(out, dir))
}

for (const dir of dirs) {
  if (!existsSync(join(out, dir, "package.json"))) throw new Error(`${dir} was not staged`)
  console.log(`staged ${manifests.get(dir)!.name}@${manifests.get(dir)!.version} → .publish/${dir}`)
}
