/**
 * Generate `@mysten/codegen`'s bindings for the fixture (and `0x2::coin`) into
 * `packages/sui-codegen/.mysten/` (git-ignored), as the reference side of the
 * parity tests. `@mysten/codegen` is a root devDependency only.
 */
import { generateFromPackageSummary } from "@mysten/codegen"
import { join } from "node:path"
import { fixtureDir } from "./support.ts"

export const MYSTEN_PACKAGE = "0x" + "f1".padStart(64, "0")
export const mystenDir = join(fixtureDir, "../../../.mysten")

export const generateMysten = async () => {
  await generateFromPackageSummary({
    package: { package: MYSTEN_PACKAGE, path: fixtureDir },
    prune: true,
    outputDir: mystenDir,
    importExtension: ".ts"
  })
  await generateFromPackageSummary({
    package: { package: "0x2", path: fixtureDir, packageName: "sui", generate: { modules: ["coin"] } },
    prune: true,
    outputDir: mystenDir,
    importExtension: ".ts"
  })
}
