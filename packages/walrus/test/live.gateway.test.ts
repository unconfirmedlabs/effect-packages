/**
 * The public testnet aggregator and the one-line layer, read-only (no funds).
 * Opt in with SUI_LIVE=1.
 *
 * 1. A recently certified blob: `Read.blob` through `Walrus.layer` and
 *    `Aggregator.verified` through the public aggregator return the same bytes.
 * 2. A random id: the aggregator answers `GatewayError { status: 404 }`.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Aggregator from "../src/Aggregator.ts"
import * as BlobId from "../src/BlobId.ts"
import * as Committee from "../src/Committee.ts"
import * as Read from "../src/Read.ts"
import * as Walrus from "../src/Walrus.ts"
import { describeReadFailure, live, readableCandidates, suiLayer } from "./support.ts"

const suite = live ? describe : describe.skip
const MAX_CANDIDATE = 1_000_000

const layer = Layer.mergeAll(
  Walrus.layer({ network: "testnet" }).pipe(Layer.provide(suiLayer)),
  Aggregator.layer({ url: Aggregator.TESTNET_URL })
).pipe(Layer.provide(FetchHttpClient.layer))

const runLive = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.provide(effect, layer))

suite("live testnet gateways (SUI_LIVE=1)", () => {
  test("Walrus.layer reads a recent blob; the aggregator's verified bytes are the same", async () => {
    const result = await runLive(
      Effect.gen(function*() {
        const { current } = yield* (yield* Effect.service(Committee.Committees)).get
        const candidates = yield* readableCandidates(current.epoch).pipe(Effect.provide(suiLayer))
        const skipped: Array<string> = []
        for (const candidate of candidates.slice(0, 20)) {
          const metadata = yield* Effect.result(Read.metadata(candidate.blobId))
          if (Result.isFailure(metadata)) {
            skipped.push(`${candidate.blobId} metadata: ${describeReadFailure(metadata.failure)}`)
            continue
          }
          if (metadata.success.unencodedLength >= MAX_CANDIDATE) continue
          const viaNodes = yield* Effect.result(Read.blob(candidate.blobId))
          if (Result.isFailure(viaNodes)) {
            // A failed read of a candidate is logged and the next one is tried; only a wrong answer fails.
            expect(viaNodes.failure._tag).not.toBe("InconsistentBlob")
            skipped.push(`${candidate.blobId} read: ${describeReadFailure(viaNodes.failure)}`)
            continue
          }
          if (skipped.length > 0) console.warn(`skipped candidates:\n  ${skipped.join("\n  ")}`)
          const viaAggregator = yield* Effect.result(Aggregator.verified(candidate.blobId))
          return { candidate, viaNodes: viaNodes.success, viaAggregator }
        }
        return yield* Effect.die(new Error(`no readable candidate among ${candidates.length}:\n  ${skipped.join("\n  ")}`))
      })
    )
    if (Result.isFailure(result.viaAggregator)) {
      const e = result.viaAggregator.failure
      // The public aggregator is someone else's service: only a wrong answer fails the test.
      expect(e._tag).not.toBe("InconsistentBlob")
      console.warn(`aggregator failed (${e._tag}: ${"message" in e ? e.message : ""}); comparison skipped`)
      return
    }
    console.log(`aggregator: ${result.candidate.blobId}, ${result.viaNodes.length} bytes, verified`)
    expect(result.viaAggregator.success).toEqual(result.viaNodes)
  }, 120_000)

  test("a random id: GatewayError 404", async () => {
    const random = BlobId.fromBytes(crypto.getRandomValues(new Uint8Array(32)))
    if (Result.isFailure(random)) throw new Error("unreachable")
    const exit = await runLive(Effect.exit(Aggregator.blob(random.success)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
      expect(reason?._tag === "Fail" && reason.error._tag).toBe("GatewayError")
      expect(reason?._tag === "Fail" && reason.error.status).toBe(404)
    }
  }, 60_000)
})
