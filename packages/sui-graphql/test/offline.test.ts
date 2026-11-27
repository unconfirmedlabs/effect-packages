/**
 * Offline: batching, error mapping and decoding against scripted transports
 * (a `GraphQLProtocol` for GraphQL-level answers, an `HttpClient` for HTTP-level ones).
 */
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { GraphQLClientError, GraphQLProtocol } from "effect/graphql"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Address, Chain, Checkpoints, Objects, Packages, RpcError, Transactions } from "@unconfirmed/sui"
import * as SuiGraphQL from "../src/index.ts"
import { rpcCode } from "../src/convert.ts"

const A = Address.normalize

type Answer = { body: unknown; status?: number }
type Request = GraphQLProtocol.GraphQLRequest

/** A protocol answering every request from `handler`, recording what it was asked. */
const scripted = (
  handler: (request: Request) => Effect.Effect<Answer, GraphQLClientError.TransportError>,
  subscribe: (request: Request) => Stream.Stream<Answer, GraphQLClientError.TransportError> = () => Stream.empty
) => {
  const requests: Array<Request> = []
  const layer = Layer.succeed(GraphQLProtocol.GraphQLProtocol, {
    execute: (request) => Effect.suspend(() => {
      requests.push(request)
      return handler(request)
    }),
    subscribe: (request) => Stream.suspend(() => {
      requests.push(request)
      return subscribe(request)
    })
  })
  return { layer, requests }
}

const services = Layer.mergeAll(
  SuiGraphQL.ObjectsGraphQL.layer,
  SuiGraphQL.PackagesGraphQL.layer,
  SuiGraphQL.TransactionsGraphQL.layer,
  SuiGraphQL.CheckpointsGraphQL.layer
)

const run = <A, E>(
  effect: Effect.Effect<A, E, Objects.Objects | Packages.Packages | Transactions.Transactions | Checkpoints.Checkpoints>,
  protocol: Layer.Layer<GraphQLProtocol.GraphQLProtocol>
) => Effect.runPromise(effect.pipe(Effect.provide(services.pipe(Layer.provide(protocol)))))

const objectJson = (address: string, version = 7) => ({
  address: A(address),
  version,
  digest: "4DJfuRY7y2Y9gmatQMyXiMpLVy2awKFMxdSqgBkvmmig",
  owner: { __typename: "Shared", initialSharedVersion: 1 },
  asMoveObject: { contents: { type: { repr: "0x2::clock::Clock" }, bcs: "AAECAw==" } },
  asMovePackage: null,
  previousTransaction: { digest: "D7" }
})

const getObjects = (ids: ReadonlyArray<string>) =>
  Effect.flatMap(Effect.service(Objects.Objects), (o) =>
    Effect.forEach(ids, (id) => Effect.result(o.get(A(id))), { concurrency: "unbounded" }))

describe("Objects.get batching", () => {
  test("concurrent gets coalesce into one deduplicated multiGetObjects", async () => {
    const { layer, requests } = scripted((req) => {
      const { keys } = req.variables as { keys: Array<{ address: string }> }
      return Effect.succeed({
        body: { data: { multiGetObjects: keys.map((k) => (k.address.endsWith("dead") ? null : objectJson(k.address))) } }
      })
    })
    const results = await run(getObjects(["0x6", "0x8", "0x6", "0xdead", "0x8"]), layer)
    expect(requests.length).toBe(1)
    expect(requests[0]!.operationName).toBe("MultiGetObjects")
    expect((requests[0]!.variables as any).keys).toEqual([{ address: A("0x6") }, { address: A("0x8") }, { address: A("0xdead") }])
    expect(results.map((r) => r._tag)).toEqual(["Success", "Success", "Success", "Failure", "Success"])
    const ok = results[0]!
    if (ok._tag !== "Success") throw new Error("expected success")
    expect(ok.success.version).toBe(7n)
    expect(ok.success.previousTransaction).toBe("D7")
    expect(ok.success.owner).toEqual({ _tag: "Shared", initialSharedVersion: 1n })
    expect([...ok.success.contents]).toEqual([0, 1, 2, 3])
    const missing = results[3]!
    expect(missing._tag === "Failure" && missing.failure).toEqual(new Objects.ObjectNotFound({ objectId: A("0xdead") }))
  })

  test("more than 50 ids split into batches", async () => {
    const { layer, requests } = scripted((req) => {
      const { keys } = req.variables as { keys: Array<{ address: string }> }
      return Effect.succeed({ body: { data: { multiGetObjects: keys.map((k) => objectJson(k.address)) } } })
    })
    const ids = Array.from({ length: 120 }, (_, i) => `0x${(i + 1).toString(16)}`)
    const results = await run(getObjects(ids), layer)
    expect(results.every((r) => r._tag === "Success")).toBe(true)
    expect(requests.map((r) => (r.variables as any).keys.length)).toEqual([50, 50, 20])
  })

  test("a GraphQL error under one entry fails only that lookup", async () => {
    const { layer } = scripted(() =>
      Effect.succeed({
        body: {
          data: { multiGetObjects: [objectJson("0x6"), null] },
          errors: [{ message: "boom", path: ["multiGetObjects", 1], extensions: { code: "INTERNAL_SERVER_ERROR" } }]
        }
      })
    )
    const [a, b] = await run(getObjects(["0x6", "0x7"]), layer)
    expect(a!._tag).toBe("Success")
    expect(b!._tag === "Failure" && b!.failure._tag).toBe("RpcError")
    expect(b!._tag === "Failure" && (b!.failure as RpcError.RpcError).code).toBe("INTERNAL")
  })

  test("a transport failure fails the whole batch as UNAVAILABLE", async () => {
    const { layer } = scripted(() => Effect.fail(new GraphQLClientError.TransportError({ description: "connection reset" })))
    const results = await run(getObjects(["0x6", "0x7"]), layer)
    for (const r of results) {
      expect(r._tag === "Failure" && r.failure).toMatchObject({ _tag: "RpcError", code: "UNAVAILABLE", method: "MultiGetObjects" })
    }
  })

  test("a malformed object is DATA_LOSS for that lookup only", async () => {
    const { layer, requests } = scripted(() =>
      Effect.succeed({
        body: {
          data: {
            multiGetObjects: [
              objectJson("0x5"),
              { ...objectJson("0x6"), owner: { __typename: "Martian" } },
              { ...objectJson("0x7"), owner: null },
              objectJson("0x8")
            ]
          }
        }
      })
    )
    const results = await run(getObjects(["0x5", "0x6", "0x7", "0x8"]), layer)
    expect(requests.length).toBe(1)
    expect(results.map((r) => r._tag)).toEqual(["Success", "Failure", "Failure", "Success"])
    for (const r of [results[1]!, results[2]!]) {
      expect(r._tag === "Failure" && r.failure).toMatchObject({ _tag: "RpcError", code: "DATA_LOSS" })
    }
  })
})

describe("error mapping", () => {
  const codeFor = async (answer: Effect.Effect<Answer, GraphQLClientError.TransportError>) => {
    const { layer } = scripted(() => answer)
    const e = await run(
      Effect.flip(Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.get("abc"))),
      layer
    )
    return e._tag === "RpcError" ? e.code : e._tag
  }
  const gqlError = (extensions: object | undefined, message = "nope", status?: number) =>
    Effect.succeed({ body: { data: null, errors: [{ message, ...(extensions && { extensions }) }] }, ...(status && { status }) })

  test("GraphQL error codes", async () => {
    expect(await codeFor(gqlError({ code: "GRAPHQL_VALIDATION_FAILED" }))).toBe("INVALID_ARGUMENT")
    expect(await codeFor(gqlError({ code: "GRAPHQL_PARSE_FAILED" }))).toBe("INVALID_ARGUMENT")
    expect(await codeFor(gqlError({ code: "BAD_USER_INPUT" }))).toBe("INVALID_ARGUMENT")
    expect(await codeFor(gqlError({ code: "INTERNAL_SERVER_ERROR" }))).toBe("INTERNAL")
    expect(await codeFor(gqlError({ code: "REQUEST_TIMEOUT" }))).toBe("DEADLINE_EXCEEDED")
    expect(await codeFor(gqlError({ code: "FEATURE_UNAVAILABLE" }))).toBe("UNIMPLEMENTED")
    expect(await codeFor(gqlError(undefined, "Failed to parse \"String\": Expected digest to be 32B"))).toBe("INVALID_ARGUMENT")
    expect(await codeFor(gqlError(undefined, "something odd"))).toBe("UNKNOWN")
    expect(await codeFor(gqlError(undefined, "slow down", 429))).toBe("RESOURCE_EXHAUSTED")
    expect(await codeFor(gqlError(undefined, "bad gateway", 502))).toBe("UNAVAILABLE")
  })

  test("transport failures", async () => {
    const T = (fields: { status?: number }) =>
      Effect.fail(new GraphQLClientError.TransportError({ description: "x", ...fields }))
    expect(await codeFor(T({}))).toBe("UNAVAILABLE")
    expect(await codeFor(T({ status: 429 }))).toBe("RESOURCE_EXHAUSTED")
    expect(await codeFor(T({ status: 503 }))).toBe("UNAVAILABLE")
    expect(await codeFor(T({ status: 504 }))).toBe("DEADLINE_EXCEEDED")
    expect(await codeFor(T({ status: 401 }))).toBe("UNAUTHENTICATED")
    expect(await codeFor(T({ status: 403 }))).toBe("PERMISSION_DENIED")
    expect(await codeFor(T({ status: 404 }))).toBe("UNIMPLEMENTED")
  })

  test("not a GraphQL body / wrong shape is DATA_LOSS", async () => {
    expect(await codeFor(Effect.succeed({ body: "<html>" }))).toBe("DATA_LOSS")
    expect(await codeFor(Effect.succeed({ body: { data: { transactionEffects: { digest: 1 } } } }))).toBe("DATA_LOSS")
  })

  test("domain errors: missing transaction, missing function", async () => {
    expect(await codeFor(Effect.succeed({ body: { data: { transactionEffects: null } } }))).toBe("TransactionNotFound")
    const { layer, requests } = scripted(() => Effect.succeed({ body: { data: { package: { module: null }, object: { address: "0x2" } } } }))
    const target = { package: A("0x2"), module: "nope", function: "nope" }
    const e = await run(Effect.flip(Effect.flatMap(Effect.service(Packages.Packages), (p) => p.getFunction(target))), layer)
    expect(e).toMatchObject({ _tag: "RpcError", code: "NOT_FOUND", method: "GetMoveFunction" })
    expect(requests.length).toBe(1)
  })

  test("rpcCode covers every reason", () => {
    const err = (reason: GraphQLClientError.Reason) => new GraphQLClientError.GraphQLClientError({ operation: "Op", reason })
    expect(rpcCode(err(new GraphQLClientError.EncodeError({ description: "x" })))).toBe("INVALID_ARGUMENT")
    expect(rpcCode(err(new GraphQLClientError.DecodeError({ description: "x" })))).toBe("DATA_LOSS")
    expect(rpcCode(err(new GraphQLClientError.PaginationError({ description: "x", cursor: null })))).toBe("INTERNAL")
  })
})

describe("over a scripted HttpClient", () => {
  const http = (respond: (body: any, url: string) => Response) => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = []
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) => {
        const body = JSON.parse(new TextDecoder().decode((request.body as any).body))
        seen.push({ url: url.toString(), headers: request.headers, body })
        return Effect.succeed(HttpClientResponse.fromWeb(request, respond(body, url.toString())))
      })
    )
    return { layer, seen }
  }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

  const all = (layer: Layer.Layer<HttpClient.HttpClient>) =>
    SuiGraphQL.layer({ url: "https://example.test/graphql", headers: { "x-api-key": "k" } }).pipe(Layer.provide(layer))

  test("headers are sent; HTTP 429 and 503 map to RESOURCE_EXHAUSTED and UNAVAILABLE", async () => {
    for (const [status, code] of [[429, "RESOURCE_EXHAUSTED"], [503, "UNAVAILABLE"]] as const) {
      const { layer, seen } = http(() => new Response("Throttled", { status, headers: { "content-type": "text/plain" } }))
      const e = await Effect.runPromise(
        Effect.flip(Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.get("abc"))).pipe(Effect.provide(all(layer)))
      )
      expect(e).toMatchObject({ _tag: "RpcError", code })
      expect(seen[0]!.headers["x-api-key"]).toBe("k")
      expect(seen[0]!.url).toBe("https://example.test/graphql")
    }
  })

  test("simulate: bytes go as base64 JSON, failures carry command and abort code", async () => {
    const { layer, seen } = http(() =>
      json({
        data: {
          simulateTransaction: {
            effects: {
              digest: "D1",
              status: "FAILURE",
              executionError: { message: "MoveAbort(...) in 2nd command", abortCode: "17" },
              gasEffects: { gasSummary: { computationCost: 1000, storageCost: 20, storageRebate: 3, nonRefundableStorageFee: 0 } },
              objectChanges: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  address: "0x5",
                  idCreated: true,
                  idDeleted: false,
                  inputState: null,
                  outputState: {
                    version: 9,
                    digest: "4DJfuRY7y2Y9gmatQMyXiMpLVy2awKFMxdSqgBkvmmig",
                    owner: { __typename: "AddressOwner", address: { address: "0x1" } },
                    asMoveObject: { contents: { type: { repr: "0x2::foo::Bar" } } },
                    asMovePackage: null
                  }
                }]
              }
            },
            outputs: [{ returnValues: [{ value: { bcs: "AQI=" } }] }]
          }
        }
      })
    )
    const sim = await Effect.runPromise(
      Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.simulate(new Uint8Array([1, 2, 3]), { checks: false })).pipe(
        Effect.provide(all(layer))
      )
    )
    expect(seen[0]!.body.variables).toEqual({ transaction: { bcs: { value: "AQID" } }, checksEnabled: false })
    expect(sim.effects.status).toEqual({ _tag: "Failure", description: "MoveAbort(...) in 2nd command", command: 1, abortCode: 17n })
    expect(sim.effects.gasUsed).toEqual({ computationCost: 1000n, storageCost: 20n, storageRebate: 3n, nonRefundableStorageFee: 0n })
    expect(sim.effects.changedObjects).toEqual([{
      objectId: A("0x5"),
      type: "0x2::foo::Bar",
      operation: "Created",
      version: 9n,
      digest: "4DJfuRY7y2Y9gmatQMyXiMpLVy2awKFMxdSqgBkvmmig" as any,
      owner: { _tag: "AddressOwner", address: A("0x1") },
      inputVersion: undefined,
      inputDigest: undefined,
      inputOwner: undefined
    }])
    expect(sim.returnValues.map((r) => r.map((b) => [...b]))).toEqual([[[1, 2]]])
  })

  test("subscriptions go to /subscriptions over graphql-sse", async () => {
    const { layer, seen } = http((_, url) =>
      url.endsWith("/subscriptions")
        ? new Response(
          "event: next\ndata: {\"data\":{\"checkpoints\":{\"cursor\":\"c1\",\"node\":{\"sequenceNumber\":5,\"digest\":\"d5\"}}}}\n\n" +
            "event: complete\ndata:\n\n",
          { headers: { "content-type": "text/event-stream" } }
        )
        : json({ errors: [{ message: "Subscriptions are not supported on this transport." }] })
    )
    const got = await Effect.runPromise(
      Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.subscribe.pipe(Stream.runCollect)).pipe(Effect.provide(all(layer)))
    )
    expect(got).toEqual([{ sequenceNumber: 5n, digest: "d5" }])
    expect(seen[0]!.url).toBe("https://example.test/graphql/subscriptions")
    expect(seen[0]!.headers["x-api-key"]).toBe("k")
  })
})

describe("Checkpoints", () => {
  test("list pages through the connection with an exclusive end", async () => {
    const { layer, requests } = scripted((req) => {
      const after = (req.variables as any).after
      return Effect.succeed({
        body: {
          data: {
            checkpoints: after === null
              ? { pageInfo: { hasNextPage: true, endCursor: "p1" }, nodes: [{ sequenceNumber: 10, digest: "a" }] }
              : { pageInfo: { hasNextPage: false, endCursor: "p2" }, nodes: [{ sequenceNumber: 11, digest: "b" }] }
          }
        }
      })
    })
    const cps = await run(
      Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.list({ start: 10n, end: 12n }).pipe(Stream.runCollect)),
      layer
    )
    expect(cps.map((c) => c.sequenceNumber)).toEqual([10n, 11n])
    expect(requests.map((r) => r.variables)).toEqual([
      { first: 50, after: null, filter: { afterCheckpoint: 9, beforeCheckpoint: 12 } },
      { first: 50, after: "p1", filter: { afterCheckpoint: 9, beforeCheckpoint: 12 } }
    ])
  })

  test("subscribe resumes from the last cursor after a dropped connection", async () => {
    let attempt = 0
    const event = (n: number) => ({ body: { data: { checkpoints: { cursor: `c${n}`, node: { sequenceNumber: n, digest: `d${n}` } } } } })
    const { layer, requests } = scripted(
      () => Effect.die("no queries"),
      () => {
        attempt++
        return attempt === 1
          ? Stream.make(event(1), event(2)).pipe(
            Stream.concat(Stream.fail(new GraphQLClientError.TransportError({ description: "dropped" })))
          )
          : Stream.make(event(3))
      }
    )
    const got = await run(
      Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.subscribe.pipe(Stream.take(3), Stream.runCollect)),
      layer
    )
    expect(got.map((c) => c.sequenceNumber)).toEqual([1n, 2n, 3n])
    expect(requests.map((r) => r.variables)).toEqual([{ after: null }, { after: "c2" }])
  })

  test("a non-retryable subscription failure ends the stream with RpcError", async () => {
    const { layer } = scripted(
      () => Effect.die("no queries"),
      () => Stream.make({ body: { errors: [{ message: "Subscriptions are not supported on this transport." }] }, status: 200 })
    )
    const e = await run(
      Effect.flip(Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.subscribe.pipe(Stream.runCollect))),
      layer
    )
    expect(e).toMatchObject({ _tag: "RpcError", method: "SubscribeCheckpoints", code: "UNIMPLEMENTED" })
  })
})

// -----------------------------------------------------------------------------
// Review regressions
// -----------------------------------------------------------------------------

const transportDown = () => Effect.fail(new GraphQLClientError.TransportError({ description: "connection reset" }))

describe("failures are not cached", () => {
  test("Packages.getFunction retries after a transport failure, then caches the success", async () => {
    let calls = 0
    const { layer, requests } = scripted(() => {
      calls++
      return calls === 1
        ? transportDown()
        : Effect.succeed({
          body: {
            data: {
              package: { module: { function: { isEntry: false, parameters: [{ signature: { ref: "&", body: "u64" } }] } } },
              object: { address: "0x2" }
            }
          }
        })
    })
    const target = { package: A("0x2"), module: "m", function: "f" }
    const results = await run(
      Effect.flatMap(Effect.service(Packages.Packages), (p) =>
        Effect.all([Effect.result(p.getFunction(target)), Effect.result(p.getFunction(target)), Effect.result(p.getFunction(target))])),
      layer
    )
    expect(results.map((r) => r._tag)).toEqual(["Failure", "Success", "Success"])
    expect(requests.length).toBe(2)
  })

  test("Chain.info and referenceGasPrice retry after a transport failure", async () => {
    let calls = 0
    const { layer } = scripted((req) => {
      calls++
      if (calls <= 2) return transportDown()
      return Effect.succeed({
        body: {
          data: req.operationName === "ChainInfo"
            ? {
              chainIdentifier: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
              epoch: { epochId: 3, checkpoints: { nodes: [{ sequenceNumber: 7 }] } },
              checkpoint: { sequenceNumber: 9 },
              serviceConfig: { availableRange: { first: { sequenceNumber: 0 } } }
            }
            : { epoch: { referenceGasPrice: "750" } }
        }
      })
    })
    const out = await Effect.runPromise(
      Effect.flatMap(Effect.service(Chain.Chain), (c) =>
        Effect.all([Effect.result(c.info), Effect.result(c.referenceGasPrice), c.info, c.referenceGasPrice])).pipe(
          Effect.provide(SuiGraphQL.ChainGraphQL.layer.pipe(Layer.provide(layer)))
        )
    )
    expect(out[0]._tag).toBe("Failure")
    expect(out[1]._tag).toBe("Failure")
    expect(out[2].chain).toBe("testnet")
    expect(out[2].epochFirstCheckpoint).toBe(7n)
    expect(out[2].lowestAvailableCheckpoint).toBe(0n)
    expect(out[3]).toBe(750n)
  })
})

describe("subscribe gives up", () => {
  const event = (n: number) => ({ body: { data: { checkpoints: { cursor: `c${n}`, node: { sequenceNumber: n, digest: `d${n}` } } } } })
  const withTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(effect)
      for (let i = 0; i < 50; i++) yield* TestClock.adjust("10 seconds")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()))

  test("after MAX_RECONNECTS consecutive failures, with the last RpcError", async () => {
    const { layer, requests } = scripted(
      () => Effect.die("no queries"),
      () => Stream.fail(new GraphQLClientError.TransportError({ description: "connection refused" }))
    )
    const e = await run(
      withTestClock(Effect.flip(Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.subscribe.pipe(Stream.runCollect)))),
      layer
    )
    expect(e).toMatchObject({ _tag: "RpcError", code: "UNAVAILABLE", method: "SubscribeCheckpoints" })
    expect(requests.length).toBe(SuiGraphQL.CheckpointsGraphQL.MAX_RECONNECTS + 1)
  })

  test("progress resets the failure count", async () => {
    let attempt = 0
    const { layer, requests } = scripted(
      () => Effect.die("no queries"),
      () => {
        attempt++
        const fail = Stream.fail(new GraphQLClientError.TransportError({ description: "dropped" }))
        // Every third connection delivers one checkpoint before dropping.
        return attempt % 3 === 0 ? Stream.make(event(attempt)).pipe(Stream.concat(fail)) : fail
      }
    )
    const got = await run(
      withTestClock(Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.subscribe.pipe(Stream.take(4), Stream.runCollect))),
      layer
    )
    expect(got.map((c) => c.sequenceNumber)).toEqual([3n, 6n, 9n, 12n])
    expect(requests.length).toBe(12)
  })
})

describe("objectChanges paging", () => {
  const change = (n: number) => ({
    address: `0x${n.toString(16)}`,
    idCreated: false,
    idDeleted: false,
    inputState: null,
    outputState: {
      version: 2,
      digest: "4DJfuRY7y2Y9gmatQMyXiMpLVy2awKFMxdSqgBkvmmig",
      owner: { __typename: "Immutable" },
      asMoveObject: null,
      asMovePackage: { address: "0x1" }
    }
  })
  const effectsJson = (hasNextPage: boolean) => ({
    digest: "11111111111111111111111111111111",
    status: "SUCCESS",
    executionError: null,
    gasEffects: null,
    objectChanges: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "p1" : null }, nodes: [change(1), change(2)] }
  })

  test("Transactions.get reads every page", async () => {
    const { layer, requests } = scripted((req) =>
      Effect.succeed({
        body: {
          data: req.operationName === "GetTransactionEffects"
            ? { transactionEffects: effectsJson(true) }
            : (req.variables as any).after === "p1"
            ? { transactionEffects: { objectChanges: { pageInfo: { hasNextPage: true, endCursor: "p2" }, nodes: [change(3)] } } }
            : { transactionEffects: { objectChanges: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [change(4)] } } }
        }
      })
    )
    const fx = await run(Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.get("11111111111111111111111111111111")), layer)
    expect(fx.changedObjects.map((c) => c.objectId)).toEqual([1, 2, 3, 4].map((n) => A(`0x${n}`)))
    expect(fx.changedObjects[0]!.type).toBe("package")
    expect(requests.map((r) => [r.operationName, (r.variables as any).after])).toEqual([
      ["GetTransactionEffects", undefined],
      ["GetObjectChanges", "p1"],
      ["GetObjectChanges", "p2"]
    ])
  })

  test("simulate fails loudly instead of truncating", async () => {
    const { layer } = scripted(() =>
      Effect.succeed({ body: { data: { simulateTransaction: { effects: effectsJson(true), outputs: [] } } } })
    )
    const e = await run(
      Effect.flip(Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.simulate(new Uint8Array([1])))),
      layer
    )
    expect(e).toMatchObject({ _tag: "RpcError", code: "OUT_OF_RANGE" })
  })
})

describe("parity with gRPC answers", () => {
  test("getFunction on an object that is not a package is INVALID_ARGUMENT", async () => {
    const { layer } = scripted(() => Effect.succeed({ body: { data: { package: null, object: { address: A("0x6") } } } }))
    const e = await run(
      Effect.flip(Effect.flatMap(Effect.service(Packages.Packages), (p) =>
        p.getFunction({ package: A("0x6"), module: "clock", function: "timestamp_ms" }))),
      layer
    )
    expect(e).toMatchObject({ _tag: "RpcError", code: "INVALID_ARGUMENT" })
  })

  test("getFunction on a missing package is NOT_FOUND", async () => {
    const { layer } = scripted(() => Effect.succeed({ body: { data: { package: null, object: null } } }))
    const e = await run(
      Effect.flip(Effect.flatMap(Effect.service(Packages.Packages), (p) =>
        p.getFunction({ package: A("0xabc"), module: "m", function: "f" }))),
      layer
    )
    expect(e).toMatchObject({ _tag: "RpcError", code: "NOT_FOUND" })
  })

  test("Checkpoints.list with start >= end is empty and sends nothing", async () => {
    const { layer, requests } = scripted(() => Effect.die("unexpected request"))
    const cps = await run(
      Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) =>
        Effect.all([c.list({ start: 100n, end: 50n }).pipe(Stream.runCollect), c.list({ start: 5n, end: 5n }).pipe(Stream.runCollect)])),
      layer
    )
    expect(cps).toEqual([[], []])
    expect(requests.length).toBe(0)
  })
})

describe("retryability", () => {
  const codeOf = async (body: unknown, status: number) => {
    const { layer } = scripted(() => Effect.succeed({ body, status }))
    const e = await run(Effect.flip(Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.get("abc"))), layer)
    return e._tag === "RpcError" ? [e.code, e.retryable] : [e._tag]
  }
  const err = (code: string) => ({ data: null, errors: [{ message: "x", extensions: { code } }] })

  test("a 5xx with INTERNAL_SERVER_ERROR in the body is UNAVAILABLE (retryable)", async () => {
    expect(await codeOf(err("INTERNAL_SERVER_ERROR"), 500)).toEqual(["UNAVAILABLE", true])
    expect(await codeOf(err("INTERNAL_SERVER_ERROR"), 200)).toEqual(["INTERNAL", false])
  })

  test("HTTP 413 is not retryable", async () => {
    const T = Effect.fail(new GraphQLClientError.TransportError({ description: "too large", status: 413 }))
    const { layer } = scripted(() => T)
    const e = await run(Effect.flip(Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.get("abc"))), layer)
    expect(e).toMatchObject({ code: "INVALID_ARGUMENT" })
    expect((e as RpcError.RpcError).retryable).toBe(false)
  })

  test("an unrecognised extensions.code falls back to the HTTP status, else UNKNOWN", async () => {
    expect(await codeOf(err("SOMETHING_NEW"), 200)).toEqual(["UNKNOWN", false])
    expect(await codeOf(err("SOMETHING_NEW"), 400)).toEqual(["INVALID_ARGUMENT", false])
  })

  test("Sui's per-query limits are not retryable; other RESOURCE_EXHAUSTED is", async () => {
    const limit = { data: null, errors: [{ message: "Exceeded the maximum number (21) of queries that require dedicated access", extensions: { code: "RESOURCE_EXHAUSTED" } }] }
    expect(await codeOf(limit, 200)).toEqual(["INVALID_ARGUMENT", false])
    expect(await codeOf(err("RESOURCE_EXHAUSTED"), 200)).toEqual(["RESOURCE_EXHAUSTED", true])
  })
})

describe("Objects.listOwned", () => {
  test("pages through the connection, passing the type filter", async () => {
    const node = (n: number) => ({
      address: `0x${n}`,
      version: n,
      digest: "4DJfuRY7y2Y9gmatQMyXiMpLVy2awKFMxdSqgBkvmmig",
      owner: { __typename: "AddressOwner", address: { address: "0x1" } },
      contents: { type: { repr: "0x2::coin::Coin<0x2::sui::SUI>" }, bcs: "AAEC" },
      previousTransaction: null
    })
    const { layer, requests } = scripted((req) => {
      const after = (req.variables as any).after
      const page = after === null
        ? { pageInfo: { hasNextPage: true, endCursor: "a" }, nodes: [node(1), node(2)] }
        : after === "a"
        ? { pageInfo: { hasNextPage: true, endCursor: "b" }, nodes: [node(3)] }
        : { pageInfo: { hasNextPage: false, endCursor: "c" }, nodes: [] }
      return Effect.succeed({ body: { data: { address: { objects: page } } } })
    })
    const objs = await run(
      Effect.flatMap(Effect.service(Objects.Objects), (o) =>
        o.listOwned(A("0x1"), { type: "0x2::coin::Coin", pageSize: 2 }).pipe(Stream.runCollect)),
      layer
    )
    expect(objs.map((o) => o.version)).toEqual([1n, 2n, 3n])
    expect(objs[0]!.owner).toEqual({ _tag: "AddressOwner", address: A("0x1") })
    expect(objs[0]!.previousTransaction).toBeUndefined()
    expect(requests.map((r) => r.variables)).toEqual([
      { owner: A("0x1"), first: 2, after: null, type: "0x2::coin::Coin" },
      { owner: A("0x1"), first: 2, after: "a", type: "0x2::coin::Coin" },
      { owner: A("0x1"), first: 2, after: "b", type: "0x2::coin::Coin" }
    ])
  })
})
