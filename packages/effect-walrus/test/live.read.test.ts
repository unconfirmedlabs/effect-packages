/**
 * Reads against testnet (read-only, no funds). Opt in with SUI_LIVE=1. §6.3,
 * through the one-line `Walrus.layer`:
 *
 * 1. A recently certified blob (permanent, end epoch at least two epochs away,
 *    under 1 MB) is picked at run time from `BlobCertified` events.
 *    `Read.status` is certified, `Read.metadata` verifies, `Read.blob` returns
 *    bytes whose id matches; they equal what `Aggregator.verified` gets from
 *    the public aggregator and what `@mysten/walrus` `readBlob` returns.
 * 2. A random id: `Read.blob` is `BlobNotFound`, `Read.status` is
 *    `Nonexistent`, the aggregator answers `GatewayError { status: 404 }`.
 *
 * Committees and the system object are checked in `live.chain.test.ts`.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { walrus } from "@mysten/walrus"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Aggregator from "../src/Aggregator.ts"
import * as BlobId from "../src/BlobId.ts"
import * as Committee from "../src/Committee.ts"
import * as Encoder from "../src/Encoder.ts"
import * as Read from "../src/Read.ts"
import * as Status from "../src/Status.ts"
import * as Walrus from "../src/Walrus.ts"
import { describeReadFailure, live, readableCandidates, suiLayer, TESTNET_FULLNODE } from "./support.ts"

const suite = live ? describe : describe.skip
const MAX_CANDIDATE = 1_000_000

const layer = Layer.mergeAll(
  Walrus.layer({ network: "testnet", nodes: { requestTimeout: "15 seconds" } }).pipe(Layer.provideMerge(suiLayer)),
  Aggregator.layer({ url: Aggregator.TESTNET_URL })
).pipe(Layer.provide(FetchHttpClient.layer))

const runLive = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.provide(effect, layer))

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) => {
  if (Exit.isSuccess(exit)) return "success"
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error._tag : "defect"
}

suite("live testnet reads (SUI_LIVE=1)", () => {
  test("a recently certified blob: status, metadata, bytes whose id matches; the aggregator and @mysten/walrus agree", async () => {
    const result = await runLive(
      Effect.gen(function*() {
        const { current } = yield* (yield* Effect.service(Committee.Committees)).get
        const candidates = yield* readableCandidates(current.epoch)
        const skipped: Array<string> = []
        for (const candidate of candidates.slice(0, 20)) {
          const metadata = yield* Effect.result(Read.metadata(candidate.blobId))
          if (Result.isFailure(metadata)) {
            skipped.push(`${candidate.blobId} metadata: ${describeReadFailure(metadata.failure)}`)
            continue
          }
          if (metadata.success.unencodedLength >= MAX_CANDIDATE) continue
          const status = yield* Read.status(candidate.blobId)
          const started = performance.now()
          const read = yield* Effect.result(Read.blob(candidate.blobId))
          if (Result.isFailure(read)) {
            // A failed read of a candidate is logged and the next one is tried; only a wrong answer fails.
            expect(read.failure._tag).not.toBe("InconsistentBlob")
            skipped.push(`${candidate.blobId} read: ${describeReadFailure(read.failure)}`)
            continue
          }
          if (skipped.length > 0) console.warn(`skipped candidates:\n  ${skipped.join("\n  ")}`)
          const bytes = read.success
          const elapsed = performance.now() - started
          const encoder = yield* Effect.service(Encoder.Encoder)
          const { blobId } = yield* encoder.blobId(current.nShards, bytes)
          const viaAggregator = yield* Effect.result(Aggregator.verified(candidate.blobId))
          return { candidate, metadata: metadata.success, status, bytes, elapsed, blobId, viaAggregator }
        }
        return yield* Effect.die(new Error(`no readable candidate among ${candidates.length}:\n  ${skipped.join("\n  ")}`))
      })
    )
    console.log(
      `Read.blob ${result.candidate.blobId}: ${result.bytes.length} bytes in ${(result.elapsed / 1000).toFixed(1)} s (n = 1000, strict)`
    )
    expect(Status.certifiedEpoch(result.status)).toBeDefined()
    expect(result.metadata.blobId).toBe(result.candidate.blobId)
    expect(result.bytes.length).toBe(result.metadata.unencodedLength)
    expect(result.blobId).toBe(result.candidate.blobId)

    // The public aggregator is someone else's service: only a wrong answer fails the test.
    if (Result.isSuccess(result.viaAggregator)) expect(result.viaAggregator.success).toEqual(result.bytes)
    else {
      const e = result.viaAggregator.failure
      expect(e._tag).not.toBe("InconsistentBlob")
      console.warn(`aggregator failed (${e._tag}: ${"message" in e ? e.message : ""}); comparison skipped`)
    }

    // So does @mysten/walrus (best effort: it fails on its own bugs, §2).
    const client = new SuiGrpcClient({ network: "testnet", baseUrl: TESTNET_FULLNODE }).$extend(walrus())
    const theirs = await Promise.race([
      client.walrus.readBlob({ blobId: result.candidate.blobId }).then((b) => b, (e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve(new Error("timed out")), 45_000))
    ])
    if (theirs instanceof Uint8Array) expect(theirs).toEqual(result.bytes)
    else console.warn(`@mysten/walrus readBlob failed (${String(theirs)}); comparison skipped`)
  }, 120_000)

  test("a random id: BlobNotFound, Nonexistent, and the aggregator's 404", async () => {
    const random = BlobId.fromBytes(crypto.getRandomValues(new Uint8Array(32)))
    if (Result.isFailure(random)) throw new Error("unreachable")
    const { read, status, gateway } = await runLive(
      Effect.gen(function*() {
        const read = yield* Effect.exit(Read.blob(random.success))
        const status = yield* Read.status(random.success)
        const gateway = yield* Effect.exit(Aggregator.blob(random.success))
        return { read, status, gateway }
      })
    )
    expect(failureTag(read)).toBe("BlobNotFound")
    expect(status).toEqual({ _tag: "Nonexistent" })
    expect(failureTag(gateway)).toBe("GatewayError")
    expect(Exit.isFailure(gateway) && gateway.cause.reasons.find((r) => r._tag === "Fail")).toMatchObject({ error: { status: 404 } })
  }, 60_000)
})
