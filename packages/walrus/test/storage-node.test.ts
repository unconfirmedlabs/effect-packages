/**
 * `StorageNodes` over a scripted `HttpClient`: every endpoint's request and
 * decoding, and every row of the §4.4 error mapping, from bodies recorded on
 * testnet (`fixtures/storage-node/recorded.json`) or built from the Rust node's
 * own messages where reads cannot produce them (`synthesized.json`).
 * Live (SUI_LIVE=1): a status and a metadata from one reachable testnet node.
 */
import { describe, expect, test } from "bun:test"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { TestClock } from "effect/testing"
import type { BlobId } from "../src/BlobId.ts"
import * as Encoding from "../src/Encoding.ts"
import * as Messages from "../src/Messages.ts"
import * as StorageNode from "../src/StorageNode.ts"
import {
  committeeNodes,
  fakeNode,
  fakeNodes,
  type FixtureResponse,
  live,
  type Outcome,
  readableCandidates,
  recorded,
  type Recorded,
  replyOf,
  scriptedNodes,
  sliverKey,
  suiLayer,
  synthesized
} from "./support.ts"

const NODE = { url: recorded.node }
const R = recorded.responses
const S = synthesized.responses
const permanentId = recorded.permanent.blobId
const deletableId = recorded.deletable.blobId
const randomId = recorded.randomBlobId

type Service = StorageNode.StorageNodes["Service"]

/** Run `f` against a node that answers `outcome` to every request. */
const run = async <A>(outcome: Outcome, f: (s: Service) => Effect.Effect<A, StorageNode.NodeError>, options?: StorageNode.StorageNodesOptions) => {
  const { layer, requests } = scriptedNodes(() => outcome, options)
  const exit = await Effect.runPromiseExit(Effect.flatMap(Effect.service(StorageNode.StorageNodes), f).pipe(Effect.provide(layer)))
  return { exit, requests: requests as ReadonlyArray<Recorded> }
}
const fixture = async <A>(r: FixtureResponse, f: (s: Service) => Effect.Effect<A, StorageNode.NodeError>) => run(await replyOf(r), f)

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`)
  return exit.value
}
const failure = <A>(exit: Exit.Exit<A, StorageNode.NodeError>): StorageNode.NodeError => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const e = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (!e || e._tag !== "Fail") throw new Error(`expected a typed failure, got ${String(exit.cause)}`)
  return e.error
}
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
const bytesOf = async (file: string) => new Uint8Array(await Bun.file(new URL(`./fixtures/storage-node/${file}`, import.meta.url)).arrayBuffer())

// -----------------------------------------------------------------------------
// Endpoints
// -----------------------------------------------------------------------------

describe("endpoints", () => {
  test("N1 metadata: GET, octet-stream, raw BCS that verifies against the blob id", async () => {
    const { exit, requests } = await fixture(R.metadata!, (s) => s.metadata(NODE, permanentId))
    expect(requests[0]!.method).toBe("GET")
    expect(requests[0]!.url).toBe(`${recorded.node}${R.metadata!.path}`)
    expect(requests[0]!.path).toBe(`/v1/blobs/${permanentId}/metadata`)
    expect(lower(requests[0]!.headers).accept).toBe("application/octet-stream")
    const bytes = value(exit)
    expect(bytes).toEqual(await bytesOf("metadata.bin"))
    const verified = Messages.verifyMetadata(permanentId, bytes, recorded.nShards)
    expect(Result.isSuccess(verified)).toBe(true)
  })

  test("N4 metadata status", async () => {
    const stored = await fixture(R["metadata-status"]!, (s) => s.metadataStatus(NODE, permanentId))
    expect(stored.requests[0]!.path).toBe(`/v1/blobs/${permanentId}/metadata/status`)
    expect(lower(stored.requests[0]!.headers).accept).toBe("application/json")
    expect(value(stored.exit)).toBe("stored")
    const missing = await fixture(R["metadata-status-random"]!, (s) => s.metadataStatus(NODE, randomId))
    expect(value(missing.exit)).toBe("nonexistent")
  })

  test("N3 slivers: GET primary and secondary, raw BCS with the right index", async () => {
    const pair = recorded.pair
    const primary = await fixture(R["sliver-primary"]!, (s) => s.sliver(NODE, permanentId, pair, "primary"))
    expect(primary.requests[0]!.path).toBe(`/v1/blobs/${permanentId}/slivers/${pair}/primary`)
    expect(lower(primary.requests[0]!.headers).accept).toBe("application/octet-stream")
    const p = Messages.parseSliver(value(primary.exit))
    expect(Result.isSuccess(p) && p.success.index).toBe(pair)

    const secondary = await fixture(R["sliver-secondary"]!, (s) => s.sliver(NODE, permanentId, pair, "secondary"))
    expect(secondary.requests[0]!.path).toBe(`/v1/blobs/${permanentId}/slivers/${pair}/secondary`)
    const q = Messages.parseSliver(value(secondary.exit))
    expect(Result.isSuccess(q) && q.success.index).toBe(recorded.nShards - 1 - pair)
  })

  test("N4 sliver status", async () => {
    const { exit, requests } = await fixture(R["sliver-status"]!, (s) => s.sliverStatus(NODE, permanentId, recorded.pair, "primary"))
    expect(requests[0]!.path).toBe(`/v1/blobs/${permanentId}/slivers/${recorded.pair}/primary/status`)
    expect(value(exit)).toBe("stored")
  })

  test("N6 status: an unknown blob is 200 \"nonexistent\"", async () => {
    const { exit, requests } = await fixture(R["status-random"]!, (s) => s.status(NODE, randomId))
    expect(R["status-random"]!.status).toBe(200)
    expect(requests[0]!.method).toBe("GET")
    expect(requests[0]!.path).toBe(`/v1/blobs/${randomId}/status`)
    expect(value(exit)).toEqual({ _tag: "Nonexistent" })
  })

  test("N6 status: permanent and deletable (snake_case counts)", async () => {
    const permanent = value((await fixture(R["status-permanent"]!, (s) => s.status(NODE, permanentId))).exit)
    expect(permanent).toMatchObject({ _tag: "Permanent", isCertified: true, initialCertifiedEpoch: recorded.epoch })
    const deletable = value((await fixture(R["status-deletable"]!, (s) => s.status(NODE, deletableId))).exit)
    expect(deletable).toEqual({
      _tag: "Deletable",
      initialCertifiedEpoch: recorded.epoch,
      deletableCounts: { countDeletableTotal: 1, countDeletableCertified: 1 }
    })
  })

  test("N5 confirmation, permanent: the signed message is the M1 confirmation", async () => {
    const { exit, requests } = await fixture(R["confirmation-permanent"]!, (s) => s.confirmation(NODE, permanentId, { _tag: "Permanent" }))
    expect(requests[0]!.path).toBe(`/v1/blobs/${permanentId}/confirmation/permanent`)
    const signed = value(exit)
    expect(signed.serializedMessage).toEqual(Messages.confirmationMessage(recorded.epoch, permanentId, { _tag: "Permanent" }))
    expect(signed.signature.length).toBe(96)
  })

  test("N5 confirmation, deletable: object id in the path and the message", async () => {
    const persistence = { _tag: "Deletable", objectId: recorded.deletable.objectId } as Messages.Persistence
    const { exit, requests } = await fixture(R["confirmation-deletable"]!, (s) => s.confirmation(NODE, deletableId, persistence))
    expect(requests[0]!.path).toBe(`/v1/blobs/${deletableId}/confirmation/deletable/${recorded.deletable.objectId}`)
    const signed = value(exit)
    expect(signed.serializedMessage).toEqual(Messages.confirmationMessage(recorded.epoch, deletableId, persistence))
    expect(signed.signature.length).toBe(96)
  })

  test("N2 put metadata: PUT, octet-stream body; 201 stored, 200 already stored", async () => {
    const body = new Uint8Array([1, 2, 3, 250])
    const created = await fixture(S["put-metadata-created"]!, (s) => s.putMetadata(NODE, permanentId, body))
    const req = created.requests[0]!
    expect(req.method).toBe("PUT")
    expect(req.path).toBe(`/v1/blobs/${permanentId}/metadata`)
    expect(lower(req.headers)["content-type"]).toBe("application/octet-stream")
    expect(req.body).toEqual(body)
    expect(value(created.exit)).toBe("stored")
    expect(value((await fixture(S["put-metadata-already"]!, (s) => s.putMetadata(NODE, permanentId, body))).exit)).toBe("alreadyStored")
  })

  test("N3 put sliver: PUT, octet-stream body; 201 stored, 200 already stored", async () => {
    const body = await bytesOf("sliver-primary.bin")
    const created = await fixture(S["put-sliver-created"]!, (s) => s.putSliver(NODE, permanentId, 7, "secondary", body))
    const req = created.requests[0]!
    expect(req.method).toBe("PUT")
    expect(req.path).toBe(`/v1/blobs/${permanentId}/slivers/7/secondary`)
    expect(lower(req.headers)["content-type"]).toBe("application/octet-stream")
    expect(req.body).toEqual(body)
    expect(value(created.exit)).toBe("stored")
    expect(value((await fixture(S["put-sliver-already"]!, (s) => s.putSliver(NODE, permanentId, 7, "secondary", body))).exit)).toBe("alreadyStored")
  })

  test("a trailing slash on the node URL is ignored", async () => {
    const { requests } = await fixture(R["status-random"]!, (s) => s.status({ url: `${recorded.node}/` }, randomId))
    expect(requests[0]!.url).toBe(`${recorded.node}/v1/blobs/${randomId}/status`)
  })

  test("no trace headers by default; on with tracerPropagation", async () => {
    const reply = await replyOf(R["status-random"]!)
    const traced = (h: Record<string, string>) => Object.keys(lower(h)).some((k) => k === "traceparent" || k === "b3")
    const off = await run(reply, (s) => s.status(NODE, randomId).pipe(Effect.withSpan("t")))
    expect(traced(off.requests[0]!.headers)).toBe(false)
    const on = await run(reply, (s) => s.status(NODE, randomId).pipe(Effect.withSpan("t")), { tracerPropagation: true })
    expect(traced(on.requests[0]!.headers)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// The §4.4 mapping, one row at a time
// -----------------------------------------------------------------------------

const expectError = (
  e: StorageNode.NodeError,
  expected: { kind: StorageNode.NodeErrorKind; status?: number; reason?: string }
) => {
  expect(e._tag).toBe("NodeError")
  expect(e.node).toBe(recorded.node)
  expect(e.kind).toBe(expected.kind)
  expect(e.status).toBe(expected.status)
  expect(e.reason).toBe(expected.reason)
  expect(e.message.length).toBeGreaterThan(0)
}

describe("error mapping", () => {
  test("transport failure → Unavailable (no status)", async () => {
    const e = failure((await run("network-error", (s) => s.status(NODE, randomId))).exit)
    expectError(e, { kind: "Unavailable" })
    expect(e.retryable).toBe(true)
  })

  test("timeout → Timeout, a typed failure (TestClock)", async () => {
    const { layer } = scriptedNodes(() => "hang", { requestTimeout: "5 seconds" })
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.flatMap(Effect.service(StorageNode.StorageNodes), (s) => s.sliver(NODE, permanentId, 1, "primary")))
        yield* TestClock.adjust("4999 millis")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 millis")
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())))
    )
    const e = failure(exit)
    expectError(e, { kind: "Timeout" })
    expect(e.message).toContain("5s")
    expect(e.retryable).toBe(true)
  })

  test("the default timeout is 30 seconds", async () => {
    const { layer } = scriptedNodes(() => "hang")
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.flatMap(Effect.service(StorageNode.StorageNodes), (s) => s.status(NODE, randomId)))
        yield* TestClock.adjust("29 seconds")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())))
    )
    expect(failure(exit).kind).toBe("Timeout")
  })

  test("scaledTimeout: base + bytes / rate, rounded up to the millisecond; bad rates add nothing", () => {
    const ms = (d: ReturnType<typeof StorageNode.scaledTimeout>) => Duration.toMillis(d)
    expect(ms(StorageNode.scaledTimeout("15 seconds", 0, 125_000))).toBe(15_000)
    // The reviewer's case: a 12.5 MB window at 1 Mbit/s needs 100 s on top of the base.
    expect(ms(StorageNode.scaledTimeout("15 seconds", 12_500_000, 125_000))).toBe(115_000)
    expect(ms(StorageNode.scaledTimeout("60 seconds", 75_000_000, StorageNode.DEFAULT_MIN_UPLOAD_RATE))).toBe(660_000)
    expect(ms(StorageNode.scaledTimeout("1 second", 1, 3))).toBe(1334)
    for (const rate of [0, -1, NaN, Infinity]) expect(ms(StorageNode.scaledTimeout("2 seconds", 1_000_000, rate))).toBe(2000)
  })

  const putTimesOutAt = async (hints: StorageNode.UploadHints | undefined, options: StorageNode.StorageNodesOptions) => {
    const { layer } = scriptedNodes(() => "hang", options)
    return Effect.runPromise(
      Effect.gen(function*() {
        const body = new Uint8Array(250_000)
        const fiber = yield* Effect.forkChild(
          Effect.flatMap(Effect.service(StorageNode.StorageNodes), (s) => s.putSliver(NODE, permanentId, 1, "primary", body, hints))
        )
        let elapsed = 0
        while (fiber.pollUnsafe() === undefined && elapsed < 600_000) {
          yield* TestClock.adjust("100 millis")
          elapsed += 100
        }
        expect(failure(yield* Fiber.await(fiber)).kind).toBe("Timeout")
        return elapsed
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())))
    )
  }

  test("uploads get more time for their bytes: the body, or the shared in-flight window", async () => {
    // 250 kB at 125 kB/s: 2 s on top of 5 s.
    expect(await putTimesOutAt(undefined, { requestTimeout: "5 seconds" })).toBe(7000)
    // 2.5 MB in flight on the same link: 20 s on top.
    expect(await putTimesOutAt({ sharedBytes: 2_500_000 }, { requestTimeout: "5 seconds" })).toBe(25_000)
    // A faster floor.
    expect(await putTimesOutAt({ sharedBytes: 2_500_000 }, { requestTimeout: "5 seconds", minUploadRate: 1_250_000 })).toBe(7000)
  })

  test("a body larger than the caller's limit is Malformed (content-length, or while reading)", async () => {
    const big = new Uint8Array(5000)
    const declared = failure((await run({ status: 200, contentType: "application/octet-stream", body: big }, (s) =>
      s.sliver(NODE, permanentId, 1, "primary", { maxBytes: 4999 }))).exit)
    expectError(declared, { kind: "Malformed", status: 200 })
    expect(declared.message).toContain("exceeds 4999")
    expect(value((await run({ status: 200, body: big }, (s) => s.sliver(NODE, permanentId, 1, "primary", { maxBytes: 5000 }))).exit).length)
      .toBe(5000)
    // Without content-length (a stream): counted while reading.
    const streaming = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(1000))
                controller.close()
              }
            }),
            { status: 200 }
          )
        ))
      )
    )
    const read = (maxBytes: number) =>
      Effect.runPromiseExit(
        Effect.flatMap(Effect.service(StorageNode.StorageNodes), (s) => s.metadata(NODE, permanentId, { maxBytes })).pipe(
          Effect.provide(StorageNode.layer().pipe(Layer.provide(streaming)))
        )
      )
    const capped = failure(await read(9999))
    expectError(capped, { kind: "Malformed", status: 200 })
    expect(capped.message).toContain("more than 9999")
    expect(value(await read(10_000)).length).toBe(10_000)
  })

  test("429 → RateLimited", async () => {
    const e = failure((await fixture(S["rate-limited"]!, (s) => s.sliver(NODE, permanentId, 1, "primary"))).exit)
    expectError(e, { kind: "RateLimited", status: 429 })
    expect(e.message).toContain("Too Many Requests")
  })

  test("5xx → Unavailable (JSON 503 with a reason, plain-text 500)", async () => {
    expectError(failure((await fixture(S.unavailable!, (s) => s.status(NODE, randomId))).exit), {
      kind: "Unavailable",
      status: 503,
      reason: "UNAVAILABLE"
    })
    expectError(failure((await fixture(S.internal!, (s) => s.metadata(NODE, randomId))).exit), { kind: "Unavailable", status: 500 })
  })

  test("404 → NotFound (metadata, sliver)", async () => {
    const md = failure((await fixture(R["metadata-random"]!, (s) => s.metadata(NODE, randomId))).exit)
    expectError(md, { kind: "NotFound", status: 404, reason: "METADATA_NOT_FOUND" })
    expect(md.message).toBe("metadata: the requested metadata is unavailable")
    expect(md.retryable).toBe(false)
    const sliver = failure((await fixture(R["sliver-random"]!, (s) => s.sliver(NODE, randomId, 14, "primary"))).exit)
    expectError(sliver, { kind: "NotFound", status: 404, reason: "SLIVER_NOT_FOUND" })
  })

  test("451 → Blocked (sliver, metadata)", async () => {
    expectError(failure((await fixture(S["sliver-forbidden"]!, (s) => s.sliver(NODE, permanentId, 1, "primary"))).exit), {
      kind: "Blocked",
      status: 451,
      reason: "FORBIDDEN_BLOB"
    })
    expectError(failure((await fixture(S["metadata-forbidden"]!, (s) => s.metadata(NODE, permanentId))).exit), {
      kind: "Blocked",
      status: 451,
      reason: "FORBIDDEN_BLOB"
    })
  })

  test("400 NOT_REGISTERED → NotRegistered (metadata PUT, sliver PUT, confirmation GET)", async () => {
    const md = failure((await fixture(S["put-metadata-not-registered"]!, (s) => s.putMetadata(NODE, randomId, new Uint8Array(1)))).exit)
    expectError(md, { kind: "NotRegistered", status: 400, reason: "NOT_REGISTERED" })
    expect(md.retryable).toBe(true)
    expectError(
      failure((await fixture(S["put-sliver-not-registered"]!, (s) => s.putSliver(NODE, randomId, 1, "primary", new Uint8Array(1)))).exit),
      { kind: "NotRegistered", status: 400, reason: "NOT_REGISTERED" }
    )
    // Recorded: a confirmation for a blob nobody registered.
    expectError(failure((await fixture(R["confirmation-random"]!, (s) => s.confirmation(NODE, randomId, { _tag: "Permanent" }))).exit), {
      kind: "NotRegistered",
      status: 400,
      reason: "NOT_REGISTERED"
    })
  })

  test("400 METADATA_NOT_FOUND on a sliver PUT → NotRegistered; elsewhere → Rejected", async () => {
    const e = failure((await fixture(S["put-sliver-missing-metadata"]!, (s) => s.putSliver(NODE, randomId, 1, "primary", new Uint8Array(1)))).exit)
    expectError(e, { kind: "NotRegistered", status: 400, reason: "METADATA_NOT_FOUND" })
    const body = S["put-sliver-missing-metadata"]!.body!
    expect(StorageNode.fromResponse(recorded.node, "sliver", 400, body).kind).toBe("Rejected")
    expect(StorageNode.fromResponse(recorded.node, "putMetadata", 400, body).kind).toBe("Rejected")
  })

  test("SHARD_NOT_ASSIGNED → ShardNotAssigned (sliver GET, sliver status)", async () => {
    const e = failure((await fixture(R["sliver-not-assigned"]!, (s) => s.sliver(NODE, permanentId, recorded.pairNotAssigned, "primary"))).exit)
    expectError(e, { kind: "ShardNotAssigned", status: 400, reason: "SHARD_NOT_ASSIGNED" })
    expect(e.retryable).toBe(false)
    expectError(failure((await fixture(R["sliver-status-random"]!, (s) => s.sliverStatus(NODE, randomId, recorded.pair, "primary"))).exit), {
      kind: "ShardNotAssigned",
      status: 400,
      reason: "SHARD_NOT_ASSIGNED"
    })
  })

  test("other 4xx → Rejected (index out of range, unparsable blob id, invalid metadata)", async () => {
    expectError(failure((await fixture(R["bad-pair-index"]!, (s) => s.sliver(NODE, permanentId, 5000, "primary"))).exit), {
      kind: "Rejected",
      status: 400,
      reason: "INDEX_OUT_OF_RANGE"
    })
    const text = failure((await fixture(R["bad-blob-id"]!, (s) => s.status(NODE, "not-a-blob-id" as BlobId))).exit)
    expectError(text, { kind: "Rejected", status: 400 })
    expect(text.message).toContain("failed to parse a blob ID")
    expectError(failure((await fixture(S["put-metadata-invalid"]!, (s) => s.putMetadata(NODE, permanentId, new Uint8Array(1)))).exit), {
      kind: "Rejected",
      status: 400,
      reason: "INVALID_METADATA"
    })
  })

  test("a body that does not decode → Malformed", async () => {
    const json = (body: unknown): Outcome => ({ status: 200, contentType: "application/json", body })
    const cases: ReadonlyArray<[Outcome, (s: Service) => Effect.Effect<unknown, StorageNode.NodeError>]> = [
      [{ status: 200, body: "<html>proxy</html>" }, (s) => s.status(NODE, randomId)],
      [json({ success: { code: 200, data: "Nonexistent" } }), (s) => s.status(NODE, randomId)],
      [json({ data: "nonexistent" }), (s) => s.status(NODE, randomId)],
      [json({ success: { code: 200, data: "Stored" } }), (s) => s.sliverStatus(NODE, randomId, 1, "primary")],
      [json({ success: { code: 200, data: "maybe" } }), (s) => s.metadataStatus(NODE, randomId)],
      [json({ success: { code: 200, data: { signed: { serializedMessage: "!!", signature: "AA==" } } } }), (s) =>
        s.confirmation(NODE, randomId, { _tag: "Permanent" })],
      [json({ success: { code: 200, data: { signature: "AA==" } } }), (s) => s.confirmation(NODE, randomId, { _tag: "Permanent" })]
    ]
    for (const [outcome, f] of cases) {
      const e = failure((await run(outcome, f)).exit)
      expectError(e, { kind: "Malformed", status: 200 })
      expect(e.retryable).toBe(false)
    }
  })

  test("an unexpected non-error status (unfollowed redirect) → Malformed", async () => {
    expectError(failure((await run({ status: 304, body: "" }, (s) => s.metadata(NODE, permanentId))).exit), { kind: "Malformed", status: 304 })
  })

  test("an HttpClient that throws is a typed Unavailable, never a defect", async () => {
    const layer = StorageNode.layer().pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => {
        throw new Error("boom")
      })))
    )
    const exit = await Effect.runPromiseExit(Effect.flatMap(Effect.service(StorageNode.StorageNodes), (s) => s.status(NODE, randomId)).pipe(Effect.provide(layer)))
    const e = failure(exit)
    expectError(e, { kind: "Unavailable" })
    expect(e.message).toContain("boom")
  })

  test("retryable: Unavailable, Timeout, RateLimited, NotRegistered", () => {
    const kinds = StorageNode.NodeErrorKind.literals
    const retryable = kinds.filter((kind) => StorageNode.retryable(new StorageNode.NodeError({ node: "n", kind, message: "m" })))
    expect(retryable).toEqual(["Unavailable", "Timeout", "RateLimited", "NotRegistered"])
    for (const kind of kinds) {
      const e = new StorageNode.NodeError({ node: "n", kind, message: "m" })
      expect(e.retryable).toBe(StorageNode.retryable(e))
    }
  })
})

// -----------------------------------------------------------------------------
// The fake node in support.ts speaks the same protocol
// -----------------------------------------------------------------------------

describe("fake node", () => {
  test("register, store, read back, confirm; other shards and unknown hosts fail as real nodes do", async () => {
    const blobId = permanentId
    const metadataBcs = (await bytesOf("metadata.bin")).slice(32)
    const sliver = await bytesOf("sliver-primary.bin")
    const sign = (m: Uint8Array) => new Uint8Array(96).fill(m.length)
    const node = fakeNode({ url: "https://a.test:9185", nShards: 4, shards: [0, 1], epoch: 7, sign })
    const { layer } = fakeNodes([node])
    const held = [0, 1].map((shard) => Encoding.pairOfShard(shard, blobId, 4))
    const other = Encoding.pairOfShard(2, blobId, 4)
    const out = await Effect.runPromise(
      Effect.gen(function*() {
        const s = yield* StorageNode.StorageNodes
        const notYet = yield* Effect.flip(s.putMetadata(node, blobId, metadataBcs))
        const noMetadata = yield* Effect.flip(s.metadata(node, blobId))
        node.registered.add(blobId)
        const beforeMetadata = yield* Effect.flip(s.putSliver(node, blobId, held[0]!, "primary", sliver))
        const first = yield* s.putMetadata(node, blobId, metadataBcs)
        const again = yield* s.putMetadata(node, blobId, metadataBcs)
        const md = yield* s.metadata(node, blobId)
        const early = yield* Effect.flip(s.confirmation(node, blobId, { _tag: "Permanent" }))
        const stores = yield* Effect.forEach(held, (pair) =>
          Effect.all([s.putSliver(node, blobId, pair, "primary", sliver), s.putSliver(node, blobId, pair, "secondary", sliver)]))
        const status = yield* s.sliverStatus(node, blobId, held[1]!, "secondary")
        const back = yield* s.sliver(node, blobId, held[0]!, "primary")
        const notAssigned = yield* Effect.flip(s.sliver(node, blobId, other, "primary"))
        const signed = yield* s.confirmation(node, blobId, { _tag: "Permanent" })
        const elsewhere = yield* Effect.flip(s.status({ url: "https://nowhere.test" }, blobId))
        return { notYet, noMetadata, beforeMetadata, first, again, md, early, stores, status, back, notAssigned, signed, elsewhere }
      }).pipe(Effect.provide(layer))
    )
    expect(out.notYet.kind).toBe("NotRegistered")
    expect(out.noMetadata.kind).toBe("NotFound")
    expect(out.beforeMetadata).toMatchObject({ kind: "NotRegistered", reason: "METADATA_NOT_FOUND" })
    expect([out.first, out.again]).toEqual(["stored", "alreadyStored"])
    expect(Result.isSuccess(Messages.verifyMetadata(blobId, out.md, 1000))).toBe(true)
    expect(out.early).toMatchObject({ kind: "Rejected", reason: "MISSING_SLIVERS" })
    expect(out.stores.flat()).toEqual(["stored", "stored", "stored", "stored"])
    expect(out.status).toBe("stored")
    expect(out.back).toEqual(sliver)
    expect(node.slivers.has(sliverKey(blobId, held[0]!, "primary"))).toBe(true)
    expect(out.notAssigned).toMatchObject({ kind: "ShardNotAssigned", message: "sliver: shard 2 is not assigned to this node in epoch 7" })
    const message = Messages.confirmationMessage(7, blobId, { _tag: "Permanent" })
    expect(out.signed.serializedMessage).toEqual(message)
    expect(out.signed.signature).toEqual(sign(message))
    expect(out.elsewhere).toMatchObject({ kind: "Unavailable", node: "https://nowhere.test" })
  })

  test("intercept: a node can fail, hang or lie per request", async () => {
    const node = fakeNode({
      url: "https://b.test",
      nShards: 4,
      intercept: (req) => (req.path.endsWith("/status") ? { status: 503, body: "busy" } : undefined)
    })
    const { layer } = fakeNodes([node])
    const e = await Effect.runPromise(
      Effect.flip(Effect.flatMap(Effect.service(StorageNode.StorageNodes), (s) => s.status(node, randomId))).pipe(Effect.provide(layer))
    )
    expect(e).toMatchObject({ kind: "Unavailable", status: 503, message: "status: busy" })
    expect(node.requests.map((r) => r.path)).toEqual([`/v1/blobs/${randomId}/status`])
  })
})

// -----------------------------------------------------------------------------
// Live
// -----------------------------------------------------------------------------

const suite = live ? describe : describe.skip

suite("live testnet (SUI_LIVE=1)", () => {
  test("a status and a metadata from one reachable node", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const nodes = [...(yield* committeeNodes)].sort((a, b) => b.shards.length - a.shards.length)
        // A node may not have synced the newest blobs yet (seen live: METADATA_NOT_FOUND for the latest one), so try a few.
        const candidates = (yield* readableCandidates(0, 100)).slice(0, 20)
        const s = yield* StorageNode.StorageNodes
        // About a fifth of testnet is unreachable from fetch (§7 risk 1): take the first node that answers.
        const errors: Array<StorageNode.NodeError> = []
        for (const node of nodes) {
          const status = yield* Effect.result(s.status(node, randomId))
          if (Result.isFailure(status)) {
            errors.push(status.failure)
            continue
          }
          for (const certified of candidates) {
            const metadata = yield* Effect.result(s.metadata(node, certified.blobId))
            if (Result.isFailure(metadata) && metadata.failure.kind === "NotFound") continue
            if (Result.isFailure(metadata)) return yield* metadata.failure
            const blobStatus = yield* s.status(node, certified.blobId)
            return { node, unknown: status.success, metadata: metadata.success, blobStatus, certified, errors }
          }
          return yield* Effect.die(new Error(`${node.url} has none of ${candidates.length} recently certified blobs`))
        }
        return yield* Effect.die(new Error(`no node answered: ${errors.map((e) => e.message).join("; ")}`))
      }).pipe(Effect.provide(Layer.merge(suiLayer, StorageNode.layer({ requestTimeout: "10 seconds" }).pipe(Layer.provide(FetchHttpClient.layer)))))
    )
    expect(result.unknown).toEqual({ _tag: "Nonexistent" })
    expect(Result.isSuccess(Messages.verifyMetadata(result.certified.blobId, result.metadata, 1000))).toBe(true)
    expect(["Permanent", "Deletable"]).toContain(result.blobStatus._tag)
    for (const e of result.errors) expect(["Unavailable", "Timeout"]).toContain(e.kind)
  }, 60_000)
})
