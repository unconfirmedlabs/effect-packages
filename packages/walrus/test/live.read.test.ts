/**
 * Reads against testnet (read-only, no funds). Opt in with SUI_LIVE=1. §6.3:
 *
 * 1. Committees load, agree with the system object (C5), 1000 shards.
 * 2. A recently certified blob (end epoch at least two epochs away, under 1 MB)
 *    is picked at run time from `BlobCertified` events.
 * 3. `Read.status` is certified, `Read.metadata` verifies, `Read.blob` returns
 *    bytes whose id matches; they equal the public aggregator's and
 *    `@mysten/walrus` `readBlob`'s bytes.
 * 4. A random id: `Read.blob` is `BlobNotFound`, `Read.status` is `Nonexistent`.
 *
 * (The relay's tip config, §6.3 item 5, belongs to W8's `UploadRelay`.)
 */
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { walrus } from "@mysten/walrus"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as BlobId from "../src/BlobId.ts"
import * as Committee from "../src/Committee.ts"
import * as Config from "../src/Config.ts"
import * as Encoder from "../src/Encoder.ts"
import * as Read from "../src/Read.ts"
import * as Status from "../src/Status.ts"
import * as StorageNode from "../src/StorageNode.ts"
import * as System from "../src/System.ts"
import { live, recentCertified, suiLayer, TESTNET_FULLNODE } from "./support.ts"

const suite = live ? describe : describe.skip
const AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space"
const MAX_CANDIDATE = 1_000_000

const layer = Layer.mergeAll(
  Committee.layer(),
  System.layer,
  StorageNode.layer({ requestTimeout: "15 seconds" }).pipe(Layer.provide(FetchHttpClient.layer)),
  Encoder.layer()
).pipe(Layer.provideMerge(Config.layer(Config.testnet)), Layer.provideMerge(suiLayer))

const runLive = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.provide(effect, layer))

suite("live testnet reads (SUI_LIVE=1)", () => {
  test("committees load and agree with the system object", async () => {
    const { committees, state } = await runLive(
      Effect.gen(function*() {
        const committees = yield* (yield* Effect.service(Committee.Committees)).get
        const state = yield* (yield* Effect.service(System.System)).state
        return { committees, state }
      })
    )
    expect(committees.current.nShards).toBe(1000)
    expect(Result.isSuccess(Committee.checkAgainstSystem(committees.current, state))).toBe(true)
  }, 60_000)

  test("a recently certified blob: status, metadata, and bytes whose id matches", async () => {
    const result = await runLive(
      Effect.gen(function*() {
        const { current } = yield* (yield* Effect.service(Committee.Committees)).get
        const candidates = (yield* recentCertified(50)).filter((c) => !c.isExtension && c.endEpoch >= current.epoch + 2)
        for (const candidate of candidates) {
          const metadata = yield* Effect.result(Read.metadata(candidate.blobId))
          if (Result.isFailure(metadata) || metadata.success.unencodedLength >= MAX_CANDIDATE) continue
          const status = yield* Read.status(candidate.blobId)
          const started = performance.now()
          const bytes = yield* Read.blob(candidate.blobId)
          const elapsed = performance.now() - started
          const encoder = yield* Effect.service(Encoder.Encoder)
          const { blobId } = yield* encoder.blobId(current.nShards, bytes)
          return { candidate, metadata: metadata.success, status, bytes, elapsed, blobId }
        }
        return yield* Effect.die(new Error(`no readable candidate among ${candidates.length}`))
      })
    )
    console.log(
      `Read.blob ${result.candidate.blobId}: ${result.bytes.length} bytes in ${(result.elapsed / 1000).toFixed(1)} s (n = 1000, strict)`
    )
    expect(Status.certifiedEpoch(result.status)).toBeDefined()
    expect(result.metadata.blobId).toBe(result.candidate.blobId)
    expect(result.bytes.length).toBe(result.metadata.unencodedLength)
    expect(result.blobId).toBe(result.candidate.blobId)

    // The public aggregator serves the same bytes.
    const response = await fetch(`${AGGREGATOR}/v1/blobs/${result.candidate.blobId}`)
    if (response.ok) expect(new Uint8Array(await response.arrayBuffer()) as Uint8Array).toEqual(result.bytes)
    else console.warn(`aggregator answered ${response.status}; comparison skipped`)

    // So does @mysten/walrus (best effort: it fails on its own bugs, §2).
    const client = new SuiGrpcClient({ network: "testnet", baseUrl: TESTNET_FULLNODE }).$extend(walrus())
    const theirs = await Promise.race([
      client.walrus.readBlob({ blobId: result.candidate.blobId }).then((b) => b, (e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve(new Error("timed out")), 45_000))
    ])
    if (theirs instanceof Uint8Array) expect(theirs).toEqual(result.bytes)
    else console.warn(`@mysten/walrus readBlob failed (${String(theirs)}); comparison skipped`)
  }, 120_000)

  test("a random id: BlobNotFound and Nonexistent", async () => {
    const random = BlobId.fromBytes(crypto.getRandomValues(new Uint8Array(32)))
    if (Result.isFailure(random)) throw new Error("unreachable")
    const { read, status } = await runLive(
      Effect.gen(function*() {
        const read = yield* Effect.exit(Read.blob(random.success))
        const status = yield* Read.status(random.success)
        return { read, status }
      })
    )
    expect(Exit.isFailure(read)).toBe(true)
    if (Exit.isFailure(read)) {
      const reason = read.cause.reasons.find((r) => r._tag === "Fail")
      expect(reason?._tag === "Fail" && reason.error._tag).toBe("BlobNotFound")
    }
    expect(status).toEqual({ _tag: "Nonexistent" })
  }, 60_000)
})
