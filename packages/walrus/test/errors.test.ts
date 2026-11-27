/** Every error class renders a short `message` from its fields (review X-6). */
import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Schema from "effect/Schema"
import { BlobId } from "../src/BlobId.ts"
import * as Errors from "../src/Errors.ts"

const blobId = Schema.decodeSync(BlobId)("A".repeat(43))
const failures = [{ node: "https://n1", weight: 2, kind: "Timeout", message: "timed out" }]

describe("error messages", () => {
  test("render their fields", () => {
    const cases: Array<[Error, string]> = [
      [new Errors.BlobNotFound({ blobId }), `blob ${blobId} not found`],
      [new Errors.BlobBlocked({ blobId }), `blob ${blobId} is blocked`],
      [new Errors.InvalidSliver({ reason: "bad header" }), "bad header"],
      [new Errors.InvalidMetadata({ blobId, reason: "wrong root" }), `invalid metadata for blob ${blobId}: wrong root`],
      [new Errors.BlobTooLarge({ size: 10, max: 5 }), "blob of 10 bytes exceeds the maximum 5"],
      [new Errors.NotEnoughSlivers({ blobId, weight: 3, required: 5, failures }), `not enough slivers for blob ${blobId}: weight 3 of 5, 1 failed`],
      [new Errors.NotEnoughConfirmations({ blobId, weight: 3, required: 5, failures }), `not enough confirmations for blob ${blobId}: weight 3 of 5, 1 failed`],
      [
        new Errors.StatusUnverified({ blobId, groups: [{ status: { _tag: "Nonexistent" }, weight: 2 }] }),
        `status of blob ${blobId} unverified: Nonexistent 2`
      ],
      [new Errors.CertificateStale({ certificateEpoch: 3, epoch: 5 }), "certificate from epoch 3, current epoch 5"],
      [new Errors.TipTooHigh({ tip: 10n, max: 5n }), "relay tip 10 exceeds the maximum 5"],
      [new Errors.InvalidBlobId({ input: "nope" }), `invalid blob id "nope"`]
    ]
    for (const [e, message] of cases) {
      expect(e.message).toBe(message)
      expect(String(e)).toBe(`${(e as unknown as { _tag: string })._tag}: ${message}`)
    }
    expect(Cause.pretty(Cause.fail(new Errors.InvalidSliver({ reason: "bad header" })))).toContain("InvalidSliver: bad header")
  })

  test("a long invalid blob id is truncated", () => {
    expect(new Errors.InvalidBlobId({ input: "x".repeat(1000) }).message.length).toBeLessThan(100)
  })
})
