import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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

  test("refusals", () => {
    expect(reason([])).toContain("no key servers")
    expect(reason([{ objectId: "0x2" }])).toContain("not 64 hex digits")
    expect(reason([{ objectId: A.slice(0, -1) }])).toContain("not 64 hex digits")
    expect(reason([{ objectId: A + "0" }])).toContain("not 64 hex digits")
    expect(reason([{ objectId: "0x" + "g".repeat(64) }])).toContain("not 64 hex digits")
    expect(reason([{ objectId: " " + A }])).toContain("not 64 hex digits")
    expect(reason([{ objectId: A }, { objectId: A.toUpperCase().replace("0X", "") }])).toContain("duplicate")
    for (const weight of [0, -1, 1.5, NaN, Infinity]) expect(reason([{ objectId: A, weight }])).toContain("positive integer")
    expect(reason([{ objectId: A, weight: 200 }, { objectId: B, weight: 56 }])).toContain("exceeds 255")
    expect(reason([{ objectId: A, apiKeyName: "k" }])).toContain("together")
    expect(reason([{ objectId: A, apiKey: "v" }])).toContain("together")
    expect(reason([{ objectId: A, apiKeyName: "bad name", apiKey: "v" }])).toContain("header name")
    expect(reason([{ objectId: A, apiKeyName: "", apiKey: "v" }])).toContain("header name")
    expect(reason([{ objectId: A, apiKeyName: "k", apiKey: "" }])).toContain("empty")
    for (const aggregatorUrl of ["ftp://x.example", "not a url", "https://user:pw@x.example", "file:///etc/passwd", ""]) {
      expect(reason([{ objectId: A, aggregatorUrl }])).toContain("aggregatorUrl")
    }
  })

  test("255 in total is allowed", () => {
    expect(Result.isSuccess(Config.make([{ objectId: A, weight: 200 }, { objectId: B, weight: 55 }]))).toBe(true)
  })

  test("errors never contain the API key", () => {
    expect(reason([{ objectId: A, apiKeyName: "bad name", apiKey: "hunter2" }])).not.toContain("hunter2")
  })

  test("presets are valid", () => {
    const t = Result.getOrThrow(Config.make([Config.testnet.mysten1, Config.testnet.mysten2, Config.testnet.committee]))
    expect(t.servers.map((s) => s.weight)).toEqual([1, 1, 1])
    expect(t.servers[2]!.aggregatorUrl).toBe("https://seal-aggregator-testnet.mystenlabs.com")
    const m = Result.getOrThrow(Config.make([{ ...Config.mainnet.committee, apiKeyName: "x-api-key", apiKey: "k" }]))
    expect(m.servers[0]!.aggregatorUrl).toBe("https://seal-aggregator-mainnet.mystenlabs.com")
  })

  test("layer", async () => {
    const ok = await Effect.runPromise(Effect.service(Config.SealConfig).pipe(Effect.provide(Config.layer([Config.testnet.mysten1]))))
    expect(ok.servers.length).toBe(1)
    const bad = await Effect.runPromiseExit(Effect.service(Config.SealConfig).pipe(Effect.provide(Config.layer([]))))
    expect(Exit.isFailure(bad)).toBe(true)
  })

  test("find", () => {
    const c = Result.getOrThrow(Config.make([{ objectId: A }]))
    expect(Config.find(c, A as any)?.weight).toBe(1)
    expect(Config.find(c, B as any)).toBeUndefined()
  })
})
