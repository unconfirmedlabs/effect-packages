import { describe, expect, test } from "bun:test"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Config from "../src/Config.ts"

const A = "0x" + "ab".repeat(32)
const B = "0x" + "cd".repeat(32)

const reason = (servers: ReadonlyArray<Config.ServerInput>): string => {
  const r = Config.make(servers)
  if (Result.isSuccess(r)) throw new Error("expected a refusal")
  expect(r.failure._tag).toBe("InvalidConfig")
  return r.failure.reason
}

describe("Config.make", () => {
  test("normalises ids and defaults the weight", () => {
    const r = Result.getOrThrow(Config.make([{ objectId: "AB".repeat(32) }, { objectId: B.toUpperCase().replace("0X", "0x"), weight: 3 }]))
    expect(r.servers).toEqual([{ objectId: A as any, weight: 1 }, { objectId: B as any, weight: 3 }])
  })

  test("keeps the API key redacted and the aggregator URL", () => {
    const r = Result.getOrThrow(
      Config.make([{ objectId: A, apiKeyName: "x-api-key", apiKey: "secret", aggregatorUrl: "https://agg.example" }])
    )
    const s = r.servers[0]!
    expect(s.apiKey?.name).toBe("x-api-key")
    expect(Redacted.isRedacted(s.apiKey?.value)).toBe(true)
    expect(Redacted.value(s.apiKey!.value)).toBe("secret")
    expect(String(s.apiKey!.value)).not.toContain("secret")
    expect(s.aggregatorUrl).toBe("https://agg.example")
    const pre = Redacted.make("k")
    expect(Result.getOrThrow(Config.make([{ objectId: A, apiKeyName: "k", apiKey: pre }])).servers[0]!.apiKey!.value).toBe(pre)
  })

  test("refusals; errors never contain the API key", () => {
    expect(reason([])).toContain("no key servers")
    for (const objectId of ["0x2", A + "0", " " + A]) expect(reason([{ objectId }])).toContain("not 64 hex digits")
    expect(reason([{ objectId: A }, { objectId: A.toUpperCase().replace("0X", "") }])).toContain("duplicate")
    for (const weight of [0, 1.5]) expect(reason([{ objectId: A, weight }])).toContain("positive integer")
    expect(reason([{ objectId: A, weight: 200 }, { objectId: B, weight: 56 }])).toContain("exceeds 255")
    expect(Result.isSuccess(Config.make([{ objectId: A, weight: 200 }, { objectId: B, weight: 55 }]))).toBe(true)
    expect(reason([{ objectId: A, apiKeyName: "k" }])).toContain("together")
    expect(reason([{ objectId: A, apiKeyName: "k", apiKey: "" }])).toContain("empty")
    const badName = reason([{ objectId: A, apiKeyName: "bad name", apiKey: "hunter2" }])
    expect(badName).toContain("header name")
    expect(badName).not.toContain("hunter2")
    for (const aggregatorUrl of ["ftp://x.example", "https://user:pw@x.example", "not a url"]) {
      expect(reason([{ objectId: A, aggregatorUrl }])).toContain("aggregatorUrl")
    }
  })

  test("SEAL-11: inputs that are accepted but cannot work are refused", () => {
    // A query or fragment would end up before the route: https://agg/base?token=abc/v1/fetch_key.
    for (const aggregatorUrl of ["https://agg.example/base?token=abc", "https://agg.example/#frag"]) {
      expect(reason([{ objectId: A, aggregatorUrl }])).toContain("without query or fragment")
    }
    // A header value with CR, LF or NUL (fetch would throw on every request) or edge whitespace.
    for (const apiKey of ["abc\r\nX-Injected: 1", " abc"]) {
      const r = reason([{ objectId: A, apiKeyName: "X-Key", apiKey }])
      expect(r).toContain("not a valid HTTP header value")
      expect(r).not.toContain("abc")
    }
    expect(Result.isSuccess(Config.make([{ objectId: A, apiKeyName: "X-Key", apiKey: "a b\tc" }]))).toBe(true)
    // A protocol header must not be replaced by the API key.
    for (const apiKeyName of ["Content-Type", "client-sdk-version"]) {
      expect(reason([{ objectId: A, apiKeyName, apiKey: "v" }])).toContain("sets itself")
    }
  })
})
