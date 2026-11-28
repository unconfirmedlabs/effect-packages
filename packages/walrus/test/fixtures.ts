/**
 * Recorded chain objects (written by `scripts/record-fixtures.ts`) served as
 * `Objects` and `Packages` layers, so chain-state code runs offline against
 * real testnet and mainnet bytes.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Objects from "@unconfirmed/sui/Objects"
import * as Packages from "@unconfirmed/sui/Packages"
import { RpcError } from "@unconfirmed/sui/RpcError"
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

/** `Objects` over a fixture; `gets` counts reads by id (to test caching). */
export const objectsLayer = (fixture: Fixture, overrides: ReadonlyArray<Objects.SuiObject> = []) =>
  Recorded.objectsLayer(fixture.objects, overrides)

export const packagesLayer = (fixture: Fixture) =>
  Layer.succeed(
    Packages.Packages,
    Packages.Packages.of({
      getFunction: (t) => {
        const f = fixture.functions[`${t.package}::${t.module}::${t.function}`]
        return f === undefined
          ? Effect.fail(new RpcError({ method: "GetFunction", code: "NOT_FOUND", message: `${t.module}::${t.function}` }))
          : Effect.succeed(f)
      },
      getModules: () => Effect.die("unused")
    })
  )
