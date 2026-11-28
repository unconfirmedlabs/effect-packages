/**
 * Recorded chain objects and function signatures (written by
 * `scripts/record-fixtures.ts`) on an in-memory node, so chain-state code runs
 * offline against real testnet and mainnet bytes.
 */
import type * as Objects from "@unconfirmed/sui/Objects"
import type * as Packages from "@unconfirmed/sui/Packages"
import * as Recorded from "@unconfirmed/test-support/recorded"
import type { RecordedObject } from "@unconfirmed/test-support/recorded"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { WalrusConfigService } from "../src/Config.ts"

export type { RecordedObject } from "@unconfirmed/test-support/recorded"
export { recordObject, restoreObject } from "@unconfirmed/test-support/recorded"

export interface Fixture {
  readonly network: "testnet" | "mainnet"
  readonly recordedAt: string
  readonly config: WalrusConfigService
  readonly objects: ReadonlyArray<RecordedObject>
  /** `${package}::${module}::${function}` -> signature. */
  readonly functions: Readonly<Record<string, Packages.MoveFunction>>
}

export const fixturesDir = join(dirname(new URL(import.meta.url).pathname), "fixtures")

export const loadFixture = (network: "testnet" | "mainnet"): Fixture =>
  JSON.parse(readFileSync(join(fixturesDir, `${network}.json`), "utf-8"))

// -----------------------------------------------------------------------------
// Layers
// -----------------------------------------------------------------------------

/** An in-memory node over a fixture: its objects (plus overrides) and the recorded function signatures. `gets()` counts reads by id (to test caching). */
export const objectsLayer = (fixture: Fixture, overrides: ReadonlyArray<Objects.SuiObject> = []) => {
  const byPackage = new Map<string, Record<string, Packages.MoveFunction>>()
  for (const [target, f] of Object.entries(fixture.functions)) {
    const [pkg, module, fn] = target.split("::") as [string, string, string]
    byPackage.set(pkg, { ...byPackage.get(pkg), [`${module}::${fn}`]: f })
  }
  return Recorded.objectsLayer(fixture.objects, overrides, {
    packages: [...byPackage].map(([packageId, functions]) => ({ packageId, functions }))
  })
}
