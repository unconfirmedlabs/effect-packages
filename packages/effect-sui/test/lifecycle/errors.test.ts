/** Error classes render a short `message` from their fields (review X-6). */
import { describe, expect, test } from "bun:test"
import * as Outcome from "../src/Outcome.ts"

describe("error messages", () => {
  test("SubmissionUnknown names the digest and reason, never the signed bytes", () => {
    const bytes = new Uint8Array(64).fill(0xab)
    const signature = new Uint8Array(97).fill(0xcd)
    const e = new Outcome.SubmissionUnknown({ digest: "D1", signed: { digest: "D1", bytes, signatures: [signature] }, reason: "timeout" })
    expect(e.message).toBe("outcome of D1 unknown: timeout")
    expect(String(e)).toBe("SubmissionUnknown: outcome of D1 unknown: timeout")
  })
})
