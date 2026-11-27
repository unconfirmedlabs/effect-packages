/** Error classes render a short `message` from their fields (review X-6). */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { InvalidJwt, InvalidZkLoginInput } from "../src/Errors.ts"
import * as Jwt from "../src/Jwt.ts"
import { makeJwt } from "@unconfirmed/test-support/zklogin"

describe("error messages", () => {
  test("render their fields", () => {
    expect(new InvalidZkLoginInput({ reason: "maxEpoch out of range" }).message).toBe("maxEpoch out of range")
    expect(String(new InvalidJwt({ reason: "missing sub" }))).toBe("InvalidJwt: invalid JWT: missing sub")
  })

  test("an InvalidJwt from a real decode does not contain the token", async () => {
    const token = makeJwt({ iss: "https://accounts.example.com", aud: "client", nonce: "n" }).replace(/\.[^.]*$/, "")
    const e = await Effect.runPromise(Effect.flip(Jwt.decode(token)))
    expect(e).toBeInstanceOf(InvalidJwt)
    expect(e.message).toStartWith("invalid JWT: ")
    expect(e.message).not.toContain(token.split(".")[1]!.slice(0, 16))
  })
})
