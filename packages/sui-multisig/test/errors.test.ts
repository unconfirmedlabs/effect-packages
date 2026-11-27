/** Error classes render a short `message` from their fields (review X-6). */
import { describe, expect, test } from "bun:test"
import * as MultiSig from "../src/index.ts"

describe("error messages", () => {
  test("InvalidMultiSig", () => {
    const e = new MultiSig.InvalidMultiSig({ reason: "threshold exceeds total weight" })
    expect(e.message).toBe("threshold exceeds total weight")
    expect(String(e)).toBe("InvalidMultiSig: threshold exceeds total weight")
  })
})
