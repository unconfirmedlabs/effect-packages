/** Every error class renders a short `message` from its fields (review X-6). */
import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Errors from "../src/Errors.ts"

describe("error messages", () => {
  test("render their fields", () => {
    const cases: Array<[Error, string]> = [
      [new Errors.InvalidEncoding({ what: "G1", reason: "point at infinity" }), "invalid G1 encoding: point at infinity"],
      [new Errors.InvalidShares({ reason: "duplicate index" }), "duplicate index"],
      [new Errors.DecryptionFailed({ reason: "tag" }), "decryption failed: bad AES-GCM tag"],
      [new Errors.DecryptionFailed({ reason: "mac" }), "decryption failed: bad HMAC-CTR mac"],
      [new Errors.InvalidCiphertext({ reason: "bad version" }), "bad version"],
      [new Errors.NotEnoughKeys({ required: 2, available: 1 }), "1 keys available, needs 2"],
      [new Errors.InvalidKeyServer({ objectId: "0x1", reason: "bad pop", kind: "Unavailable" }), "invalid key server 0x1 (Unavailable): bad pop"],
      [new Errors.InvalidKeyServer({ objectId: "0x1", reason: "not a key server" }), "invalid key server 0x1: not a key server"],
      [new Errors.NotFirstVersion({ packageId: "0x2", version: 3n }), "package 0x2 is version 3, not the first"],
      [new Errors.SessionKeyExpired({ expiresAt: 10, now: 20 }), "session key expired at 10, now 20"],
      [new Errors.InvalidApproval({ reason: "not a seal_approve call" }), "not a seal_approve call"]
    ]
    for (const [e, message] of cases) {
      expect(e.message).toBe(message)
      expect(String(e)).toBe(`${(e as unknown as { _tag: string })._tag}: ${message}`)
    }
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
