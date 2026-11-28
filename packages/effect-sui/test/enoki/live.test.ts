/** Live Enoki calls, only when `ENOKI_API_KEY` is set. */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { EnokiClient } from "../../src/enoki/EnokiClient.ts"
import * as EnokiHttp from "../../src/enoki/EnokiHttp.ts"
import { Ed25519 } from "@unconfirmed/effect-sui"

const apiKey = process.env.ENOKI_API_KEY

describe.skipIf(!apiKey)("Enoki (live)", () => {
  const run = <A, E>(f: (c: EnokiClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(EnokiClient), f).pipe(
        Effect.provide(EnokiHttp.layer({ apiKey: apiKey! })),
        Effect.provide(FetchHttpClient.layer)
      )
    )

  test("getApp decodes", async () => {
    const app = await run((c) => c.getApp)
    expect(Array.isArray(app.allowedOrigins)).toBe(true)
  })

  test("createZkLoginNonce answers a 27-character nonce", async () => {
    const ephemeral = await Effect.runPromise(Ed25519.generate)
    const nonce = await run((c) => c.createZkLoginNonce({ network: "testnet", ephemeralPublicKey: ephemeral.publicKey }))
    expect(nonce.nonce.length).toBe(27)
    expect(nonce.maxEpoch).toBeGreaterThanOrEqual(nonce.epoch)
  })
})
