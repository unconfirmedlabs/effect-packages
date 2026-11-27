/**
 * Aggregator and publisher (§4.10) over a scripted `HttpClient`: request
 * method, path, query and body for every route; the daemon's error envelope,
 * transport failures, defects and timeouts as `GatewayError`; the
 * `BlobStoreResult` variants (bodies from the Walrus docs,
 * `docs/content/http-api/storing-blobs.mdx`); `Aggregator.verified` with the
 * real WASM at `n = 10`; and the one-line layer's composition.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as HttpClient from "effect/http/HttpClient"
import { TestClock } from "effect/testing"
import * as Address from "@unconfirmed/sui/Address"
import * as Aggregator from "../src/Aggregator.ts"
import * as BlobId from "../src/BlobId.ts"
import * as Committee from "../src/Committee.ts"
import * as Config from "../src/Config.ts"
import * as Encoder from "../src/Encoder.ts"
import * as Publisher from "../src/Publisher.ts"
import * as StorageNode from "../src/StorageNode.ts"
import * as System from "../src/System.ts"
import * as Walrus from "../src/Walrus.ts"
import { type Outcome, type Recorded, scripted } from "./support.ts"

const AGG = "https://aggregator.test"
const PUB = "https://publisher.test"
const ID = "M4hsZGQ1oCktdzegB6HnI6Mi28S2nqOPHxK-W7_4BUk" as BlobId.BlobId
const OBJECT = Address.normalize("0xe91eee8c5b6f35b9a250cfc29e30f0d9e5463a21fd8d1ddb0fc22d44db4eac50")

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason?._tag !== "Fail") throw new Error(`expected a typed failure, got ${String(exit.cause)}`)
  return reason.error
}

const aggregator = (route: (req: Recorded) => Outcome, options?: Partial<Aggregator.AggregatorOptions>) => {
  const http = scripted(route)
  return { layer: Aggregator.layer({ url: `${AGG}/`, ...options }).pipe(Layer.provide(http.layer)), requests: http.requests }
}
const publisher = (route: (req: Recorded) => Outcome, options?: Partial<Publisher.PublisherOptions>) => {
  const http = scripted(route)
  return { layer: Publisher.layer({ url: PUB, ...options }).pipe(Layer.provide(http.layer)), requests: http.requests }
}

const NOT_FOUND = {
  status: 404,
  contentType: "application/json",
  body: {
    error: {
      status: "NOT_FOUND",
      code: 404,
      message: "the requested blob ID does not exist on Walrus, ensure that it was entered correctly",
      details: [{ "@type": "ErrorInfo", reason: "BLOB_NOT_FOUND", domain: "daemon.walrus.space" }]
    }
  }
} as const

describe("Aggregator", () => {
  test("routes: method, path and accept header", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const { layer, requests } = aggregator(() => ({ body: bytes, contentType: "application/octet-stream" }))
    const results = await Effect.runPromise(
      Effect.all([
        Aggregator.blob(ID),
        Aggregator.byObjectId("0x2a" as Address.Address),
        Aggregator.patch("DJHLsgUoKQKEPcw3uehNQwuJjMu5a2sRdn8r-f7iWDAB"),
        Aggregator.byIdentifier(ID, "dir/a file.txt")
      ]).pipe(Effect.provide(layer))
    )
    for (const r of results) expect(r).toEqual(bytes)
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", `${AGG}/v1/blobs/${ID}`],
      ["GET", `${AGG}/v1/blobs/by-object-id/${Address.normalize("0x2a")}`],
      ["GET", `${AGG}/v1/blobs/by-quilt-patch-id/DJHLsgUoKQKEPcw3uehNQwuJjMu5a2sRdn8r-f7iWDAB`],
      ["GET", `${AGG}/v1/blobs/by-quilt-id/${ID}/dir%2Fa%20file.txt`]
    ])
    expect(requests[0]!.headers["accept"]).toBe("application/octet-stream")
    expect(requests[0]!.headers["traceparent"]).toBeUndefined()
  })

  test("the daemon's error envelope, or a plain-text body, becomes GatewayError with status and message", async () => {
    const { layer } = aggregator(() => NOT_FOUND)
    const error = failureOf(await Effect.runPromiseExit(Aggregator.blob(ID).pipe(Effect.provide(layer))))
    expect(error._tag).toBe("GatewayError")
    expect(error.status).toBe(404)
    expect(error.message).toBe(
      "blob: the requested blob ID does not exist on Walrus, ensure that it was entered correctly (BLOB_NOT_FOUND)"
    )
    // A plain-text error body is kept as the message.
    const { layer: text } = aggregator(() => ({ status: 400, body: "Invalid URL: Cannot parse `x` to a base64 blob ID" }))
    const plain = failureOf(await Effect.runPromiseExit(Aggregator.blob(ID).pipe(Effect.provide(text))))
    expect(plain.status).toBe(400)
    expect(plain.message).toBe("blob: Invalid URL: Cannot parse `x` to a base64 blob ID")
    const { layer: empty } = aggregator(() => ({ status: 503 }))
    expect(failureOf(await Effect.runPromiseExit(Aggregator.blob(ID).pipe(Effect.provide(empty)))).message).toBe("blob: HTTP 503")
  })

  test("a defect thrown by the HttpClient is a GatewayError, not a defect", async () => {
    const throwing = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        throw new Error("boom")
      })
    )
    const layer = Aggregator.layer({ url: AGG }).pipe(Layer.provide(throwing))
    const error = failureOf(await Effect.runPromiseExit(Aggregator.blob(ID).pipe(Effect.provide(layer))))
    expect(error.message).toContain("transport defect")
  })

  test("a hung request times out after requestTimeout (TestClock)", async () => {
    const { layer } = aggregator(() => "hang", { requestTimeout: "5 seconds" })
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.exit(Aggregator.blob(ID)))
        yield* TestClock.adjust("4 seconds")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))
    )
    const error = failureOf(exit)
    expect(error.status).toBeUndefined()
    expect(error.message).toBe("blob: no answer within 5s")
  })
})

describe("Aggregator.verified", () => {
  const N = 10
  const state: System.SystemState = {
    systemObjectId: Config.testnet.systemObjectId,
    initialSharedVersion: 1n,
    epoch: 1,
    nShards: N,
    packageId: Address.normalize("0x1"),
    typeOrigin: Address.normalize("0x1"),
    storagePrice: 1n,
    writePrice: 1n,
    members: []
  }
  const bytes = new TextEncoder().encode("verified through an aggregator")

  const run = async (served: Uint8Array) => {
    const blobId = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(Encoder.make(), (e) => e.blobId(N, bytes))).pipe(Effect.map((r) => r.blobId))
    )
    const { layer, requests } = aggregator(() => ({ body: served }))
    const exit = await Effect.runPromiseExit(
      Aggregator.verified(blobId).pipe(
        Effect.provide(Layer.mergeAll(layer, Encoder.layer(), System.layerFromState(state, "0x2::sui::SUI")))
      )
    )
    return { exit, blobId, requests }
  }

  test("bytes that hash to the id are returned; other bytes are InconsistentBlob", async () => {
    const { exit: ok, blobId: id, requests } = await run(bytes)
    expect(Exit.isSuccess(ok) && ok.value).toEqual(bytes)
    expect(requests.map((r) => r.path)).toEqual([`/v1/blobs/${id}`])
    const tampered = bytes.slice()
    tampered[0] = tampered[0]! ^ 1
    const { exit, blobId } = await run(tampered)
    const error = failureOf(exit)
    expect(error._tag).toBe("InconsistentBlob")
    expect(error._tag === "InconsistentBlob" && error.blobId).toBe(blobId)
  })
})

describe("Publisher", () => {
  const NEWLY_CREATED = {
    newlyCreated: {
      blobObject: {
        id: "0xe91eee8c5b6f35b9a250cfc29e30f0d9e5463a21fd8d1ddb0fc22d44db4eac50",
        registeredEpoch: 34,
        blobId: ID,
        size: 17,
        encodingType: "RS2",
        certifiedEpoch: 34,
        storage: {
          id: "0x4748cd83217b5ce7aa77e7f1ad6fc5f7f694e26a157381b9391ac65c47815faf",
          startEpoch: 34,
          endEpoch: 35,
          storageSize: 66034000
        },
        deletable: false
      },
      resourceOperation: { registerFromScratch: { encodedLength: 66034000, epochsAhead: 1 } },
      cost: 132300
    }
  }
  const ALREADY_CERTIFIED = {
    alreadyCertified: {
      blobId: ID,
      event: { txDigest: "4XQHFa9S324wTzYHF3vsBSwpUZuLpmwTHYMFv9nsttSs", eventSeq: "0" },
      endEpoch: 35
    }
  }

  test("PUT /v1/blobs with the query and the raw body", async () => {
    const { layer, requests } = publisher(() => ({ body: NEWLY_CREATED, contentType: "application/json" }))
    const body = new TextEncoder().encode("some other string")
    await Effect.runPromise(
      Effect.all([
        Publisher.store(body),
        Publisher.store(body, { epochs: 5, permanent: true, sendObjectTo: "0xa" as Address.Address }),
        Publisher.store(body, { epochs: 2, permanent: false })
      ]).pipe(Effect.provide(layer))
    )
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ["PUT", "/v1/blobs"],
      ["PUT", `/v1/blobs?epochs=5&permanent=true&send_object_to=${Address.normalize("0xa")}`],
      ["PUT", "/v1/blobs?epochs=2"]
    ])
    expect(requests[0]!.body).toEqual(body)
    expect(requests[0]!.headers["content-type"]).toBe("application/octet-stream")
    expect(requests[0]!.headers["accept"]).toBe("application/json")
  })

  test("newlyCreated", async () => {
    const { layer } = publisher(() => ({ body: NEWLY_CREATED }))
    const result = await Effect.runPromise(Publisher.store(new Uint8Array(17)).pipe(Effect.provide(layer)))
    expect(result).toEqual({
      _tag: "NewlyCreated",
      blobObject: {
        id: OBJECT,
        registeredEpoch: 34,
        blobId: ID,
        size: 17,
        encodingType: "RS2",
        certifiedEpoch: 34,
        storage: {
          id: Address.normalize("0x4748cd83217b5ce7aa77e7f1ad6fc5f7f694e26a157381b9391ac65c47815faf"),
          startEpoch: 34,
          endEpoch: 35,
          storageSize: 66034000
        },
        deletable: false
      },
      resourceOperation: { registerFromScratch: { encodedLength: 66034000, epochsAhead: 1 } },
      cost: 132300,
      sharedBlobObject: undefined
    })
    expect(Publisher.blobIdOf(result)).toBe(ID)
  })

  test("parseStoreResult: alreadyCertified (event or object), markedInvalid, uncertified and shared objects", async () => {
    expect(Publisher.parseStoreResult(ALREADY_CERTIFIED)).toEqual(Result.succeed({
      _tag: "AlreadyCertified",
      blobId: ID,
      endEpoch: 35,
      event: { txDigest: "4XQHFa9S324wTzYHF3vsBSwpUZuLpmwTHYMFv9nsttSs", eventSeq: "0" },
      object: undefined
    }))
    expect(Publisher.parseStoreResult({ alreadyCertified: { blobId: ID, object: "0x2a", endEpoch: 40 } })).toEqual(
      Result.succeed({ _tag: "AlreadyCertified", blobId: ID, endEpoch: 40, event: undefined, object: Address.normalize("0x2a") })
    )
    const parsed = Publisher.parseStoreResult({ markedInvalid: { blobId: ID, event: { txDigest: "abc", eventSeq: 3 } } })
    expect(parsed).toEqual(Result.succeed({ _tag: "MarkedInvalid", blobId: ID, event: { txDigest: "abc", eventSeq: "3" } }))
    const b = NEWLY_CREATED.newlyCreated
    const uncertified = Publisher.parseStoreResult({
      newlyCreated: { ...b, blobObject: { ...b.blobObject, certifiedEpoch: null }, sharedBlobObject: "0x5" }
    })
    expect(uncertified).toMatchObject({ success: { _tag: "NewlyCreated", blobObject: { certifiedEpoch: undefined }, sharedBlobObject: Address.normalize("0x5") } })
  })

  test("the daemon's error variant, bad ids and unknown shapes are rejected", () => {
    expect(Publisher.parseStoreResult({ error: { blobId: null, failurePhase: "register", errorMsg: "insufficient WAL" } }))
      .toEqual(Result.fail("insufficient WAL (phase register)"))
    expect(Result.isFailure(Publisher.parseStoreResult({ alreadyCertified: { blobId: "short", endEpoch: 1 } }))).toBe(true)
    const b = NEWLY_CREATED.newlyCreated
    expect(Result.isFailure(Publisher.parseStoreResult({ newlyCreated: { ...b, blobObject: { ...b.blobObject, id: "nope" } } }))).toBe(true)
    expect(Result.isFailure(Publisher.parseStoreResult({ somethingElse: {} }))).toBe(true)
  })

  test("non-JSON, undecodable and error answers are GatewayError", async () => {
    const cases: Array<[Outcome, number | undefined, string]> = [
      [{ body: "<html>" }, 200, "store: response is not JSON"],
      [{ body: { error: { errorMsg: "boom" } } }, 200, "store: boom"],
      [{ status: 413, body: "Payload Too Large" }, 413, "store: Payload Too Large"],
      [
        {
          status: 500,
          body: { error: { status: "INTERNAL", code: 500, message: "internal error", details: [{ reason: "INTERNAL_ERROR" }] } }
        },
        500,
        "store: internal error (INTERNAL_ERROR)"
      ],
      ["network-error", undefined, ""]
    ]
    for (const [outcome, status, message] of cases) {
      const { layer } = publisher(() => outcome)
      const error = failureOf(await Effect.runPromiseExit(Publisher.store(new Uint8Array(1)).pipe(Effect.provide(layer))))
      expect(error._tag).toBe("GatewayError")
      expect(error.status).toBe(status)
      if (message !== "") expect(error.message).toBe(message)
    }
  })
})

describe("Walrus.layer", () => {
  test("provides config, system, committees, storage nodes and the encoder from one call", async () => {
    // Only the composition is checked here: the services resolve, the config is the network's.
    const stub = Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unused"))),
      Layer.succeed((await import("@unconfirmed/sui/Objects")).Objects, {} as never),
      Layer.succeed((await import("@unconfirmed/sui/Packages")).Packages, {} as never)
    )
    const check = (layer: ReturnType<typeof Walrus.layer>) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const config = yield* Effect.service(Config.WalrusConfig)
          yield* Effect.service(System.System)
          yield* Effect.service(Committee.Committees)
          yield* Effect.service(StorageNode.StorageNodes)
          yield* Effect.service(Encoder.Encoder)
          return config
        }).pipe(Effect.provide(Layer.provide(layer, stub)))
      )
    expect(await check(Walrus.layer({ network: "testnet" }))).toEqual(Config.testnet)
    const custom = { systemObjectId: Address.normalize("0x1"), stakingObjectId: Address.normalize("0x2") }
    expect(await check(Walrus.layer({ config: custom }))).toEqual(custom)
    // An untyped caller with neither network nor config (or an unknown network) gets a defect, not testnet.
    for (const bad of [{}, { network: "devnet" }]) {
      await expect(check(Walrus.layer(bad as Walrus.WalrusOptions))).rejects.toThrow("Walrus.layer: pass network")
    }
  })
})
