/**
 * Error classes render a short `message` from their fields (review X-6), so
 * `String(e)`, `Cause.pretty` and promise rejections say more than the tag.
 */
import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Objects, Resolve } from "../src/index.ts"

const ID = "0x" + "ab".repeat(32)

describe("error messages", () => {
  test("render their fields, optional ones only when present", () => {
    const cases: Array<[Error, string]> = [
      [new Resolve.GasEstimationFailed({ description: "MoveAbort", command: 1, abortCode: 7n, location: "0x2::m::f" }), "gas estimation failed: MoveAbort in command 1, abort code 7 at 0x2::m::f"],
      [new Resolve.GasEstimationFailed({ description: "InsufficientGas" }), "gas estimation failed: InsufficientGas"],
      [new Resolve.AllowanceSpenderMismatch({ allowance: ID, spender: null, sender: "0x1" }), `allowance ${ID} spender is none, sender is 0x1`]
    ]
    for (const [e, message] of cases) expect(String(e)).toBe(`${(e as unknown as { _tag: string })._tag}: ${message}`)
  })

  test("show in Cause.pretty and promise rejections; encoding is unchanged", async () => {
    const e = new Objects.ObjectNotFound({ objectId: ID })
    expect(Cause.pretty(Cause.fail(e))).toContain(`ObjectNotFound: object ${ID} not found`)
    const rejected = await Effect.runPromise(Effect.fail(e)).catch((x: unknown) => x as Error)
    expect(rejected.message).toContain(`object ${ID} not found`)
    expect(Schema.encodeSync(Objects.ObjectNotFound)(e)).toEqual({ _tag: "ObjectNotFound", objectId: ID })
  })
})
