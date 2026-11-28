/**
 * Build the committed WebAssembly artifacts in `wasm/` from the Rust crate there (`wasm/src/`).
 *
 *   bun run build:wasm         (in packages/effect-walrus)
 *   bun run build:wasm:check   rebuild into a temporary directory and compare with the committed files
 *
 * Needs the toolchain in `rust-toolchain.toml` (rustup picks it), the
 * `wasm-bindgen` CLI at the version `Cargo.toml` pins, and Binaryen's
 * `wasm-opt` from the root `binaryen` devDependency. Two builds of the crate:
 *
 * - SIMD (`-C target-feature=+simd128`): `nodejs/` (CommonJS, loads
 *   synchronously) and `web/` (ES module, `init`), as wasm-bindgen emits them.
 * - Scalar (no `simd128`): `web/walrus_wasm_nosimd_bg.wasm` only, for browsers
 *   without WebAssembly SIMD; `web.js` picks it after feature detection. Its
 *   wasm-bindgen glue is identical to the SIMD build's (checked).
 *
 * Each `.wasm` then goes through `wasm-opt -O3`. Paths are remapped so the
 * output does not depend on where the repo or the cargo home lives.
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

// The crate and its built artifacts live in `wasm/`. The remap below keeps naming it `/walrus-wasm`, so the
// binaries stay byte-identical to the ones built when it was its own package.
const root = join(dirname(new URL(import.meta.url).pathname), "../wasm")
const check = process.argv.includes("--check")
const WASM_BINDGEN = "0.2.127"
const OPT = process.env.WASM_OPT_LEVEL ?? "-O3"

const run = (cmd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}): string => {
  const r = spawnSync(cmd, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`)
  return r.stdout
}

const bindgenVersion = run("wasm-bindgen", ["--version"]).trim()
if (bindgenVersion !== `wasm-bindgen ${WASM_BINDGEN}`) {
  throw new Error(`need wasm-bindgen ${WASM_BINDGEN} (cargo install wasm-bindgen-cli --version ${WASM_BINDGEN} --locked), found "${bindgenVersion}"`)
}
const wasmOpt = join(root, "../../../node_modules/.bin/wasm-opt")
if (!existsSync(wasmOpt)) throw new Error("wasm-opt not found: run bun install at the repo root")
console.log(run("rustc", ["--version"]).trim())
console.log(bindgenVersion)
console.log(run(wasmOpt, ["--version"]).trim())

const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo")
const remap = `--remap-path-prefix=${cargoHome}=/cargo --remap-path-prefix=${root}=/walrus-wasm`

const cargo = (targetDir: string, simd: boolean) => {
  run("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown", "--target-dir", targetDir], {
    RUSTFLAGS: `${simd ? "-C target-feature=+simd128 " : ""}${remap}`
  })
  return join(targetDir, "wasm32-unknown-unknown/release/walrus_wasm.wasm")
}

const bindgen = (wasm: string, target: "nodejs" | "web", outDir: string) =>
  run("wasm-bindgen", ["--target", target, "--remove-name-section", "--out-dir", outDir, wasm])

const optimize = (file: string) => run(wasmOpt, [OPT, file, "-o", file])

const out = check ? mkdtempSync(join(tmpdir(), "walrus-wasm-")) : root
const work = mkdtempSync(join(tmpdir(), "walrus-wasm-work-"))
try {
  const simd = cargo(join(root, "target/simd"), true)
  const scalar = cargo(join(root, "target/nosimd"), false)

  for (const dir of ["nodejs", "web"]) {
    rmSync(join(out, dir), { recursive: true, force: true })
    mkdirSync(join(out, dir), { recursive: true })
  }
  bindgen(simd, "nodejs", join(out, "nodejs"))
  bindgen(simd, "web", join(out, "web"))
  bindgen(scalar, "web", work)
  for (const file of ["walrus_wasm.js", "walrus_wasm.d.ts", "walrus_wasm_bg.wasm.d.ts"]) {
    if (readFileSync(join(work, file), "utf8") !== readFileSync(join(out, "web", file), "utf8")) {
      throw new Error(`the scalar build's ${file} differs from the SIMD build's`)
    }
  }
  cpSync(join(work, "walrus_wasm_bg.wasm"), join(out, "web/walrus_wasm_nosimd_bg.wasm"))
  // The nodejs glue is CommonJS (`require`, `__dirname`) inside a `"type": "module"` package.
  writeFileSync(join(out, "nodejs/package.json"), `{ "type": "commonjs" }\n`)
  for (const file of ["nodejs/walrus_wasm_bg.wasm", "web/walrus_wasm_bg.wasm", "web/walrus_wasm_nosimd_bg.wasm"]) {
    optimize(join(out, file))
  }

  const files = ["nodejs", "web"].flatMap((d) => readdirSync(join(out, d)).sort().map((f) => `${d}/${f}`))
  for (const f of files) console.log(`${String(readFileSync(join(out, f)).length).padStart(8)}  ${f}`)

  if (check) {
    const differ = files.filter((f) => !existsSync(join(root, f)) || !readFileSync(join(root, f)).equals(readFileSync(join(out, f))))
    const committed = ["nodejs", "web"].flatMap((d) => readdirSync(join(root, d)).map((f) => `${d}/${f}`))
    const extra = committed.filter((f) => !files.includes(f))
    if (differ.length > 0 || extra.length > 0) {
      console.error(`differs from the committed artifacts: ${[...differ, ...extra].join(", ")}`)
      process.exitCode = 1
    } else {
      console.log("reproduced the committed artifacts byte for byte")
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
  if (check) rmSync(out, { recursive: true, force: true })
}
