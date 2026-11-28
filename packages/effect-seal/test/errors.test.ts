import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Errors from "../src/Errors.ts"

/** Errors render a short `message` from their fields, so logs and `Cause.pretty` say what failed (review X-6). */
describe("error messages", () => {
  test("render their fields", () => {
    const cases: Array<[Error, string]> = [
      [new Errors.DecryptionFailed({ reason: "mac" }), "decryption failed: bad HMAC-CTR mac"],
      [new Errors.InvalidKeyServer({ objectId: "0x1", reason: "bad pop", kind: "Unavailable" }), "invalid key server 0x1 (Unavailable): bad pop"],
      [new Errors.InvalidKeyServer({ objectId: "0x1", reason: "not a key server" }), "invalid key server 0x1: not a key server"]
    ]
    for (const [e, message] of cases) expect(String(e)).toBe(`${(e as unknown as { _tag: string })._tag}: ${message}`)
    expect(Cause.pretty(Cause.fail(new Errors.NotEnoughKeys({ required: 2, available: 1 })))).toContain("NotEnoughKeys: 1 keys available")
  })

  test("ThresholdNotMet summarises failures without server messages", () => {
    const error = new Errors.KeyServerError({ server: "0xs", kind: "NoAccess", message: "secret-ish server text" })
    const e = new Errors.ThresholdNotMet({
      reason: "denied",
      threshold: 2,
      weight: 0,
      totalWeight: 3,
      failures: [{ weight: 2, error }],
      unsettled: [{ server: "0xt", weight: 1, started: true }]
    })
    expect(e.message).toBe("threshold 2 not met: 0 reached, denied by 2 (NoAccess), 1 unsettled (total 3)")
    expect(e.message).not.toContain("secret-ish")
  })
})
