/**
 * Compressed gRPC-web responses (docs/design/grpc-compression.md), against a
 * local server that implements both layers. The last test (SUI_LIVE=1) checks
 * that a testnet full node compresses a unary answer and that it decodes.
 */
import { afterAll, describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as zlib from "node:zlib"
import { CHECKPOINT_PATHS } from "../src/grpc/convert.ts"
import * as Rpc from "../src/grpc/generated/rpc.ts"
import { GrpcWeb, type GrpcWebOptions } from "../src/grpc/GrpcWeb.ts"
import type { RpcError } from "../src/RpcError.ts"

const frame = (payload: Uint8Array, flags = 0) => {
  const out = new Uint8Array(5 + payload.length)
  out[0] = flags
  new DataView(out.buffer).setUint32(1, payload.length, false)
  out.set(payload, 5)
  return out
}
const trailers = frame(new TextEncoder().encode("grpc-status: 0\r\n"), 0x80)
/** `SubscribeCheckpointsResponse { cursor: n }` and `GetServiceInfoResponse { chain_id }`. */
const subResp = (n: number) => new Uint8Array([0x08, n])
const infoResp = (s: string) => new Uint8Array([0x0a, s.length, ...new TextEncoder().encode(s)])

const compress = (encoding: string, b: Uint8Array): Uint8Array =>
  encoding === "gzip" ? zlib.gzipSync(b) : encoding === "deflate" ? zlib.deflateSync(b) : zlib.zstdCompressSync(b)

/**
 * Layer 1 per the request's `grpc-accept-encoding` (or the test's `x-pick`, which may break the
 * rules); layer 2 (one zstd stream, flushed per frame) on `x-layer2` when `Accept-Encoding` has zstd.
 * With layer 2 the second message waits until the client has the first (`firstSeen`).
 */
let firstSeen: () => void = () => {}
let heldUntilSeen: boolean | undefined
const seen: Array<Record<string, string>> = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const h: Record<string, string> = {}
    req.headers.forEach((v, k) => (h[k] = v))
    seen.push(h)
    const stream = req.url.endsWith("SubscribeCheckpoints")
    const messages = stream ? [subResp(1), subResp(2)] : [infoResp("abc")]
    if (req.headers.has("x-layer2") && /\bzstd\b/.test(req.headers.get("accept-encoding") ?? "")) {
      const acked = new Promise<boolean>((resolve) => {
        firstSeen = () => resolve(true)
        setTimeout(() => resolve(false), 3000)
      })
      const z = zlib.createZstdCompress()
      const flush = () => new Promise<void>((resolve) => z.flush(zlib.constants.ZSTD_e_flush, () => resolve()))
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          z.on("data", (chunk: Buffer) => c.enqueue(new Uint8Array(chunk)))
          z.on("end", () => c.close())
          for (const [i, m] of messages.entries()) {
            if (i === 1) heldUntilSeen = await acked
            z.write(frame(m))
            await flush()
          }
          z.end(trailers)
        }
      })
      return new Response(body, {
        headers: { "content-type": "application/grpc-web+proto", "content-encoding": "zstd", vary: "Accept-Encoding", "cache-control": "no-transform" }
      })
    }
    const offered = (req.headers.get("grpc-accept-encoding") ?? "").split(",").map((s) => s.trim())
    const pick = req.headers.get("x-pick") ?? offered.find((e) => e === "zstd" || e === "gzip")
    const headers: Record<string, string> = { "content-type": "application/grpc-web+proto" }
    if (pick !== undefined && pick !== "no-header") headers["grpc-encoding"] = pick
    const enc = pick === "no-header" ? "zstd" : pick
    const parts = messages.map((m) => (enc === undefined ? frame(m) : frame(compress(enc, m), 1)))
    return new Response(new Blob([...parts, trailers] as Array<Uint8Array<ArrayBuffer>>), { headers })
  }
})
afterAll(() => server.stop(true))

const grpc = (options: Partial<GrpcWebOptions> = {}, http: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer) =>
  GrpcWeb.layer({ url: `http://localhost:${server.port}`, ...options }).pipe(Layer.provide(http))
const info = Effect.flatMap(Effect.service(GrpcWeb), (g) => g.unary(Rpc.LedgerService_GetServiceInfo, {}))
const subscribe = Effect.flatMap(Effect.service(GrpcWeb), (g) =>
  g.serverStream(Rpc.SubscriptionService_SubscribeCheckpoints, {}).pipe(
    Stream.tap((m) => Effect.sync(() => m.cursor === 1n && firstSeen())),
    Stream.map((m) => m.cursor),
    Stream.runCollect
  ))
const failure = async (effect: Effect.Effect<unknown, RpcError, GrpcWeb>, layer: Layer.Layer<GrpcWeb>) => {
  const exit = await Effect.runPromiseExit(Effect.provide(effect, layer))
  if (!Exit.isFailure(exit)) throw new Error("expected a failure")
  return Cause.squash(exit.cause) as RpcError
}

describe("gRPC-web compression", () => {
  test("layer 1: zstd and gzip messages decode, unary and streamed; we offer what we can decode", async () => {
    for (const pick of ["zstd", "gzip"]) {
      const layer = grpc({ headers: { "x-pick": pick } })
      expect((await Effect.runPromise(Effect.provide(info, layer))).chain_id).toBe("abc")
      expect(await Effect.runPromise(Effect.provide(subscribe, layer))).toEqual([1n, 2n])
    }
    expect(seen.at(-1)!["grpc-accept-encoding"]).toBe("zstd,gzip") // Bun's DecompressionStream has zstd
  })

  test("layer 2: each message of a flushed Content-Encoding: zstd stream arrives before the next is sent", async () => {
    const layer = grpc({ headers: { "x-layer2": "1" } })
    expect(await Effect.runPromise(Effect.provide(subscribe, layer))).toEqual([1n, 2n])
    expect(heldUntilSeen).toBe(true) // the server held message 2 until the client had message 1
    expect((await Effect.runPromise(Effect.provide(info, layer))).chain_id).toBe("abc")
  })

  test("a compressed message we can't decode is INTERNAL, and so is a body the HttpClient left encoded", async () => {
    for (const pick of ["deflate", "no-header"]) {
      expect((await failure(info, grpc({ headers: { "x-pick": pick } }))).code).toBe("INTERNAL")
    }
    const raw = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array(compress("zstd", frame(infoResp("abc")))), { headers: { "content-encoding": "zstd" } })
        ))
      )
    )
    const e = await failure(info, grpc({}, raw))
    expect([e.code, e.message.includes("Content-Encoding: zstd")]).toEqual(["INTERNAL", true])
  })

  test("compression: false asks for identity", async () => {
    expect((await Effect.runPromise(Effect.provide(info, grpc({ compression: false })))).chain_id).toBe("abc")
    expect(seen.at(-1)!["grpc-accept-encoding"]).toBe("identity")
  })
})

describe.skipIf(process.env.SUI_LIVE !== "1")("gRPC-web compression, live", () => {
  test("testnet compresses a unary GetCheckpoint per message, and it decodes to the uncompressed answer", async () => {
    const url = process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443"
    const encodings: Array<string | undefined> = []
    const http = Layer.effect(
      HttpClient.HttpClient,
      Effect.map(Effect.service(HttpClient.HttpClient), HttpClient.tap((res) => Effect.sync(() => encodings.push(res.headers["grpc-encoding"]))))
    ).pipe(Layer.provide(FetchHttpClient.layer))
    const get = (compression: boolean, sequence_number?: bigint) =>
      Effect.flatMap(Effect.service(GrpcWeb), (g) =>
        g.unary(Rpc.LedgerService_GetCheckpoint, {
          read_mask: { paths: CHECKPOINT_PATHS },
          ...(sequence_number === undefined ? {} : { checkpoint_id: { _tag: "sequence_number", value: sequence_number } })
        })).pipe(Effect.provide(GrpcWeb.layer({ url, compression }).pipe(Layer.provide(http))))
    const compressed = await Effect.runPromise(get(true))
    const plain = await Effect.runPromise(get(false, compressed.checkpoint!.sequence_number!))
    expect(encodings).toEqual(["zstd", undefined])
    expect(compressed).toEqual(plain)
  }, 30_000)
})
