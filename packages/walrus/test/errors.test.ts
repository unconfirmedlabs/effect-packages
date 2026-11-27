/** Error classes render a short `message` from their fields (review X-6), and never echo unbounded input. */
import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Schema from "effect/Schema"
import { BlobId } from "../src/BlobId.ts"
import * as Errors from "../src/Errors.ts"

const blobId = Schema.decodeSync(BlobId)("A".repeat(43))

describe("error messages", () => {
  test("render their fields, also through Cause.pretty", () => {
    const failures = [{ node: "https://n1", weight: 2, kind: "Timeout", message: "timed out" }]
    const e = new Errors.NotEnoughSlivers({ blobId, weight: 3, required: 5, failures })
    expect(e.message).toBe(`not enough slivers for blob ${blobId}: weight 3 of 5, 1 failed`)
    expect(String(new Errors.TipTooHigh({ tip: 10n, max: 5n }))).toBe("TipTooHigh: relay tip 10 exceeds the maximum 5")
    expect(Cause.pretty(Cause.fail(new Errors.InvalidSliver({ reason: "bad header" })))).toContain("InvalidSliver: bad header")
  })

  test("a long invalid blob id is truncated", () => {
    expect(new Errors.InvalidBlobId({ input: "x".repeat(1000) }).message.length).toBeLessThan(100)
  })
})
