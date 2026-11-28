/**
 * `StorageNodes` over a scripted `HttpClient`: every endpoint's request and
 * decoding, and the §4.4 error mapping (the kinds the read and write quorums
 * act on), from bodies recorded on testnet (`fixtures/storage-node/recorded.json`)
 * or built from the Rust node's own messages where reads cannot produce them
 * (`synthesized.json`). Real nodes are exercised by the live read tests.
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
import { TestClock } from "effect/testing"
import type { BlobId } from "../src/BlobId.ts"
import * as Messages from "../src/Messages.ts"
import * as StorageNode from "../src/StorageNode.ts"
import { type FixtureResponse, type Outcome, recorded, type Recorded, replyOf, scriptedNodes, synthesized } from "./support.ts"

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
  test("N1 metadata and N3 slivers: GET, octet-stream, raw BCS (metadata verifies, slivers carry their index)", async () => {
    const md = await fixture(R.metadata!, (s) => s.metadata(NODE, permanentId))
    expect(md.requests[0]!.method).toBe("GET")
    expect(md.requests[0]!.url).toBe(`${recorded.node}/v1/blobs/${permanentId}/metadata`)
    expect(lower(md.requests[0]!.headers).accept).toBe("application/octet-stream")
    expect(value(md.exit)).toEqual(await bytesOf("metadata.bin"))
    expect(Result.isSuccess(Messages.verifyMetadata(permanentId, value(md.exit), recorded.nShards))).toBe(true)

    const pair = recorded.pair
    for (const [axis, index] of [["primary", pair], ["secondary", recorded.nShards - 1 - pair]] as const) {
      const sliver = await fixture(R[`sliver-${axis}`]!, (s) => s.sliver(NODE, permanentId, pair, axis))
      expect(sliver.requests[0]!.path).toBe(`/v1/blobs/${permanentId}/slivers/${pair}/${axis}`)
      const p = Messages.parseSliver(value(sliver.exit))
      expect(Result.isSuccess(p) && p.success.index).toBe(index)
    }
  })

  test("N4 / N6 statuses: JSON, snake_case counts, an unknown blob is 200 \"nonexistent\"", async () => {
    const cases: ReadonlyArray<readonly [FixtureResponse, (s: Service) => Effect.Effect<unknown, StorageNode.NodeError>, string, unknown]> = [
      [R["metadata-status"]!, (s) => s.metadataStatus(NODE, permanentId), `/v1/blobs/${permanentId}/metadata/status`, "stored"],
      [R["metadata-status-random"]!, (s) => s.metadataStatus(NODE, randomId), `/v1/blobs/${randomId}/metadata/status`, "nonexistent"],
      [R["sliver-status"]!, (s) => s.sliverStatus(NODE, permanentId, recorded.pair, "primary"), `/v1/blobs/${permanentId}/slivers/${recorded.pair}/primary/status`, "stored"],
      [R["status-random"]!, (s) => s.status(NODE, randomId), `/v1/blobs/${randomId}/status`, { _tag: "Nonexistent" }],
      [R["status-deletable"]!, (s) => s.status(NODE, deletableId), `/v1/blobs/${deletableId}/status`, {
        _tag: "Deletable",
        initialCertifiedEpoch: recorded.epoch,
        deletableCounts: { countDeletableTotal: 1, countDeletableCertified: 1 }
      }]
    ]
    for (const [reply, f, path, expected] of cases) {
      const { exit, requests } = await fixture(reply, f)
      expect(requests[0]!.path).toBe(path)
      expect(lower(requests[0]!.headers).accept).toBe("application/json")
      expect(value(exit)).toEqual(expected)
    }
    expect(R["status-random"]!.status).toBe(200)
    const permanent = value((await fixture(R["status-permanent"]!, (s) => s.status(NODE, permanentId))).exit)
    expect(permanent).toMatchObject({ _tag: "Permanent", isCertified: true, initialCertifiedEpoch: recorded.epoch })
  })

  test("N5 confirmations: the signed message is the M1 confirmation; a deletable blob's object id is in the path", async () => {
    const deletable = { _tag: "Deletable", objectId: recorded.deletable.objectId } as Messages.Persistence
    const cases = [
      [R["confirmation-permanent"]!, permanentId, { _tag: "Permanent" } as Messages.Persistence, `/v1/blobs/${permanentId}/confirmation/permanent`],
      [R["confirmation-deletable"]!, deletableId, deletable, `/v1/blobs/${deletableId}/confirmation/deletable/${recorded.deletable.objectId}`]
    ] as const
    for (const [reply, blobId, persistence, path] of cases) {
      const { exit, requests } = await fixture(reply, (s) => s.confirmation(NODE, blobId, persistence))
      expect(requests[0]!.path).toBe(path)
      const signed = value(exit)
      expect(signed.serializedMessage).toEqual(Messages.confirmationMessage(recorded.epoch, blobId, persistence))
      expect(signed.signature.length).toBe(96)
    }
  })

  test("N2 / N3 puts: PUT, octet-stream body; 201 stored, 200 already stored", async () => {
    const metadata = new Uint8Array([1, 2, 3, 250])
    const sliver = await bytesOf("sliver-primary.bin")
    const cases = [
      [S["put-metadata-created"]!, S["put-metadata-already"]!, (s: Service) => s.putMetadata(NODE, permanentId, metadata), `/v1/blobs/${permanentId}/metadata`, metadata],
      [S["put-sliver-created"]!, S["put-sliver-already"]!, (s: Service) => s.putSliver(NODE, permanentId, 7, "secondary", sliver), `/v1/blobs/${permanentId}/slivers/7/secondary`, sliver]
    ] as const
    for (const [created, already, f, path, body] of cases) {
      const first = await fixture(created, f)
      const req = first.requests[0]!
      expect([req.method, req.path]).toEqual(["PUT", path])
      expect(lower(req.headers)["content-type"]).toBe("application/octet-stream")
      expect(req.body).toEqual(body)
      expect(value(first.exit)).toBe("stored")
      expect(value((await fixture(already, f)).exit)).toBe("alreadyStored")
    }
  })

  test("no trace headers by default (nodes do not allow them in CORS); on with tracerPropagation", async () => {
    const reply = await replyOf(R["status-random"]!)
    const traced = (h: Record<string, string>) => Object.keys(lower(h)).some((k) => k === "traceparent" || k === "b3")
    const off = await run(reply, (s) => s.status(NODE, randomId).pipe(Effect.withSpan("t")))
    expect(traced(off.requests[0]!.headers)).toBe(false)
    const on = await run(reply, (s) => s.status(NODE, randomId).pipe(Effect.withSpan("t")), { tracerPropagation: true })
    expect(traced(on.requests[0]!.headers)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// The §4.4 mapping
// -----------------------------------------------------------------------------

const expectError = (e: StorageNode.NodeError, expected: { kind: StorageNode.NodeErrorKind; status?: number | undefined; reason?: string | undefined }) => {
  expect({ tag: e._tag, node: e.node, kind: e.kind, status: e.status, reason: e.reason })
    .toEqual({ tag: "NodeError", node: recorded.node, status: undefined, reason: undefined, ...expected })
  expect(e.message.length).toBeGreaterThan(0)
}

describe("error mapping", () => {
  test("every status and reason a node sends maps to the kind the quorums act on", async () => {
    const empty = new Uint8Array(1)
    const cases: ReadonlyArray<readonly [FixtureResponse, (s: Service) => Effect.Effect<unknown, StorageNode.NodeError>, StorageNode.NodeErrorKind, number, string?]> = [
      [S["rate-limited"]!, (s) => s.sliver(NODE, permanentId, 1, "primary"), "RateLimited", 429],
      [S.unavailable!, (s) => s.status(NODE, randomId), "Unavailable", 503, "UNAVAILABLE"],
      [S.internal!, (s) => s.metadata(NODE, randomId), "Unavailable", 500],
      [R["metadata-random"]!, (s) => s.metadata(NODE, randomId), "NotFound", 404, "METADATA_NOT_FOUND"],
      [R["sliver-random"]!, (s) => s.sliver(NODE, randomId, 14, "primary"), "NotFound", 404, "SLIVER_NOT_FOUND"],
      [S["sliver-forbidden"]!, (s) => s.sliver(NODE, permanentId, 1, "primary"), "Blocked", 451, "FORBIDDEN_BLOB"],
      [S["metadata-forbidden"]!, (s) => s.metadata(NODE, permanentId), "Blocked", 451, "FORBIDDEN_BLOB"],
      [S["put-metadata-not-registered"]!, (s) => s.putMetadata(NODE, randomId, empty), "NotRegistered", 400, "NOT_REGISTERED"],
      [S["put-sliver-not-registered"]!, (s) => s.putSliver(NODE, randomId, 1, "primary", empty), "NotRegistered", 400, "NOT_REGISTERED"],
      // Recorded: a confirmation for a blob nobody registered.
      [R["confirmation-random"]!, (s) => s.confirmation(NODE, randomId, { _tag: "Permanent" }), "NotRegistered", 400, "NOT_REGISTERED"],
      // METADATA_NOT_FOUND on a sliver PUT: the node has not seen the registration yet.
      [S["put-sliver-missing-metadata"]!, (s) => s.putSliver(NODE, randomId, 1, "primary", empty), "NotRegistered", 400, "METADATA_NOT_FOUND"],
      [R["sliver-not-assigned"]!, (s) => s.sliver(NODE, permanentId, recorded.pairNotAssigned, "primary"), "ShardNotAssigned", 400, "SHARD_NOT_ASSIGNED"],
      [R["sliver-status-random"]!, (s) => s.sliverStatus(NODE, randomId, recorded.pair, "primary"), "ShardNotAssigned", 400, "SHARD_NOT_ASSIGNED"],
      [R["bad-pair-index"]!, (s) => s.sliver(NODE, permanentId, 5000, "primary"), "Rejected", 400, "INDEX_OUT_OF_RANGE"],
      [R["bad-blob-id"]!, (s) => s.status(NODE, "not-a-blob-id" as BlobId), "Rejected", 400],
      [S["put-metadata-invalid"]!, (s) => s.putMetadata(NODE, permanentId, empty), "Rejected", 400, "INVALID_METADATA"]
    ]
    for (const [reply, f, kind, status, reason] of cases) {
      expectError(failure((await fixture(reply, f)).exit), { kind, status, reason })
    }
    // METADATA_NOT_FOUND anywhere else is a plain rejection.
    const body = S["put-sliver-missing-metadata"]!.body!
    expect(StorageNode.fromResponse(recorded.node, "sliver", 400, body).kind).toBe("Rejected")
    expect(StorageNode.fromResponse(recorded.node, "putMetadata", 400, body).kind).toBe("Rejected")
  })

  test("retryable: Unavailable, Timeout, RateLimited, NotRegistered", () => {
    const kinds = StorageNode.NodeErrorKind.literals
    const retryable = kinds.filter((kind) => StorageNode.retryable(new StorageNode.NodeError({ node: "n", kind, message: "m" })))
    expect(retryable).toEqual(["Unavailable", "Timeout", "RateLimited", "NotRegistered"])
    expect(kinds.every((kind) => new StorageNode.NodeError({ node: "n", kind, message: "m" }).retryable === retryable.includes(kind))).toBe(true)
  })

  test("transport failures and an HttpClient that throws are Unavailable, never defects", async () => {
    expectError(failure((await run("network-error", (s) => s.status(NODE, randomId))).exit), { kind: "Unavailable" })
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

  test("a body that does not decode, or an unfollowed redirect, is Malformed", async () => {
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
    for (const [outcome, f] of cases) expectError(failure((await run(outcome, f)).exit), { kind: "Malformed", status: 200 })
    expectError(failure((await run({ status: 304, body: "" }, (s) => s.metadata(NODE, permanentId))).exit), { kind: "Malformed", status: 304 })
  })

  test("a body larger than the caller's limit is Malformed (content-length, or while reading)", async () => {
    const big = new Uint8Array(5000)
    const declared = failure((await run({ status: 200, contentType: "application/octet-stream", body: big }, (s) =>
      s.sliver(NODE, permanentId, 1, "primary", { maxBytes: 4999 }))).exit)
    expectError(declared, { kind: "Malformed", status: 200 })
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
    expectError(failure(await read(9999)), { kind: "Malformed", status: 200 })
    expect(value(await read(10_000)).length).toBe(10_000)
  })
})

// -----------------------------------------------------------------------------
// Timeouts (TestClock)
// -----------------------------------------------------------------------------

describe("timeouts", () => {
  test("a hung request is a typed Timeout after requestTimeout", async () => {
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
    expectError(failure(exit), { kind: "Timeout" })
  })

  test("scaledTimeout: base + bytes / rate, rounded up to the millisecond; bad rates add nothing", () => {
    const ms = (d: ReturnType<typeof StorageNode.scaledTimeout>) => Duration.toMillis(d)
    // The reviewer's case: a 12.5 MB window at 1 Mbit/s needs 100 s on top of the base.
    expect(ms(StorageNode.scaledTimeout("15 seconds", 12_500_000, 125_000))).toBe(115_000)
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
})
