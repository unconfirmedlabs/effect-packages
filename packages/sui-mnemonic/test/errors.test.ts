/** Error classes render a short `message` from their fields (review X-6). */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Mnemonic from "../src/index.ts"

describe("error messages", () => {
  test("InvalidMnemonic explains the problem without the words", async () => {
    const words = "legal winner thank year wave sausage worth useful legal winner thank thank"
    const e = await Effect.runPromise(Effect.flip(Mnemonic.parse(words)))
    expect(e).toBeInstanceOf(Mnemonic.InvalidMnemonic)
    expect(e.message).toBe("unknown word or bad checksum")
    expect(e.message).not.toContain("legal")
    expect(String(e)).toBe("InvalidMnemonic: unknown word or bad checksum")
  })

  test("InvalidPath", () => {
    const e = new Mnemonic.InvalidPath({ scheme: "ED25519", path: "m/44'", reason: "too short" })
    expect(e.message).toBe("invalid ED25519 path m/44': too short")
  })
})
