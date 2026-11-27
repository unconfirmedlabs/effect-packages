/** Error classes render a short `message` from their fields (review X-6). */
import { describe, expect, test } from "bun:test"
import { Sponsor, ZkLoginFlow } from "../src/index.ts"

describe("error messages", () => {
  test("render their fields", () => {
    expect(String(new Sponsor.UnexpectedSponsoredTransaction({ reason: "gas owner is not the sponsor" }))).toBe(
      "UnexpectedSponsoredTransaction: gas owner is not the sponsor"
    )
    expect(new ZkLoginFlow.InvalidEnokiNonce({ reason: "wrong maxEpoch" }).message).toBe("invalid Enoki nonce: wrong maxEpoch")
  })
})
