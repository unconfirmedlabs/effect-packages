/**
 * gRPC-web over Effect's `HttpClient`, with messages encoded by `effect/protobuf`
 * from per-method descriptor chunks. Methods are generated handles:
 * `unary(Rpc.LedgerService_GetObject, req)` takes a `GetObjectRequest` and
 * returns a `GetObjectResponse`, and ships only the descriptors it needs.
 *
 * Everything HTTP-shaped (auth headers, proxies, logging, recording for tests)
 * is `HttpClient` middleware; this module only frames and decodes.
 */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { type RpcCode, RpcCode as GrpcCode, RpcError } from "../RpcError.ts"
import type { Rpc } from "./Rpc.ts"

// -----------------------------------------------------------------------------
// Framing
// -----------------------------------------------------------------------------

const frame = (msg: Uint8Array) => {
  const out = new Uint8Array(5 + msg.length)
  new DataView(out.buffer).setUint32(1, msg.length, false)
  out.set(msg, 5)
  return out
}

const parseTrailers = (bytes: Uint8Array) => {
  const out: Record<string, string> = {}
  for (const line of new TextDecoder().decode(bytes).split("\r\n")) {
    const i = line.indexOf(":")
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

const statusOf = (method: string, get: (key: string) => string | undefined): RpcError | undefined => {
  const raw = get("grpc-status")
  if (raw === undefined || raw === "0") return undefined
  let message = get("grpc-message") ?? ""
  try {
    message = decodeURIComponent(message)
  } catch {
    // keep the raw message
  }
  return new RpcError({ method, code: GrpcCode[Number(raw)] ?? "UNKNOWN", message })
}

interface Frame {
  /**
   * `data`, `compressed` (flag bit 0: compressed per `grpc-encoding`) and `trailer` are wire frames.
   * `malformed` is a frame header with reserved flag bits set (its payload is the flag byte); nothing
   * after it is parsed. `incomplete` marks a body that ended inside a frame or before its trailers.
   */
  readonly kind: "data" | "compressed" | "trailer" | "malformed" | "incomplete"
  readonly payload: Uint8Array
}

interface Reassembly {
  /** Body chunks not yet consumed, oldest first; the first `offset` bytes of `chunks[0]` are consumed. */
  readonly chunks: Array<Uint8Array>
  offset: number
  size: number
  trailerSeen: boolean
  broken: boolean
}

/** Consume `n` buffered bytes; each byte is copied at most once. */
const take = (s: Reassembly, n: number): Uint8Array => {
  const first = s.chunks[0]!
  let out: Uint8Array
  if (first.length - s.offset >= n) {
    out = first.subarray(s.offset, s.offset + n)
    s.offset += n
  } else {
    out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      const c = s.chunks[0]!
      const k = Math.min(c.length - s.offset, n - filled)
      out.set(c.subarray(s.offset, s.offset + k), filled)
      filled += k
      s.offset += k
      if (s.offset === c.length) {
        s.chunks.shift()
        s.offset = 0
      }
    }
  }
  if (s.chunks.length > 0 && s.offset === s.chunks[0]!.length) {
    s.chunks.shift()
    s.offset = 0
  }
  s.size -= n
  return out
}

/** The 5-byte frame header at the front of the buffer (`size >= 5`), not consumed. */
const peekHeader = (s: Reassembly) => {
  const h = new Uint8Array(5)
  let filled = 0
  for (let i = 0, off = s.offset; filled < 5; i++, off = 0) {
    const c = s.chunks[i]!
    const k = Math.min(c.length - off, 5 - filled)
    h.set(c.subarray(off, off + k), filled)
    filled += k
  }
  return { flags: h[0]!, length: new DataView(h.buffer).getUint32(1, false) }
}

/**
 * Incrementally split a gRPC-web body into frames, in time linear in its size.
 * A body that ends inside a frame or without a trailers frame ends with an
 * `incomplete` marker: the server or a proxy cut the response short.
 */
export const toFrames = <E>(body: Stream.Stream<Uint8Array, E>): Stream.Stream<Frame, E> =>
  body.pipe(
    Stream.mapAccum((): Reassembly => ({ chunks: [], offset: 0, size: 0, trailerSeen: false, broken: false }), (s, chunk: Uint8Array) => {
      const out: Array<Frame> = []
      if (s.broken) return [s, out] as const
      if (chunk.length > 0) {
        s.chunks.push(chunk)
        s.size += chunk.length
      }
      while (s.size >= 5) {
        const { flags, length } = peekHeader(s)
        if ((flags & 0x7e) !== 0) {
          // Not gRPC-web, e.g. a body still under its Content-Encoding (zstd starts 0x28, gzip 0x1f).
          s.broken = true
          s.chunks.length = 0
          s.size = 0
          out.push({ kind: "malformed", payload: new Uint8Array([flags]) })
          break
        }
        if (s.size - 5 < length) break
        take(s, 5)
        const payload = length === 0 ? new Uint8Array(0) : take(s, length)
        const kind = (flags & 0x80) !== 0 ? "trailer" : (flags & 1) !== 0 ? "compressed" : "data"
        if (kind === "trailer") s.trailerSeen = true
        out.push({ kind, payload })
      }
      return [s, out] as const
    }, {
      onHalt: (s): ReadonlyArray<Frame> =>
        s.broken || (s.trailerSeen && s.size === 0) ? [] : [{ kind: "incomplete", payload: new Uint8Array(0) }]
    })
  )

// -----------------------------------------------------------------------------
// Compression (docs/design/grpc-compression.md §4)
// -----------------------------------------------------------------------------

let decodable: ReadonlyArray<string> | undefined

/** Per-message encodings this runtime's `DecompressionStream` decodes, best first; probed once. */
const decodableEncodings = (): ReadonlyArray<string> =>
  decodable ??= ["zstd", "gzip"].filter((encoding) => {
    try {
      new DecompressionStream(encoding as "gzip")
      return true
    } catch {
      return false
    }
  })

/**
 * Whether to ask for `Accept-Encoding: zstd` ourselves: only on Node 24+, whose `fetch` decodes zstd
 * but doesn't ask for it. Bun's `fetch` already asks, and browsers set the header themselves (it is
 * forbidden to page code; `fetch` drops a page's value without an error). Elsewhere the client's
 * default stands, since a client that asked for zstd and can't decode it would get an unreadable body.
 */
const askForZstd = (): boolean => {
  const v = (globalThis as { process?: { versions?: Record<string, string | undefined> } }).process?.versions
  return v?.node !== undefined && v.bun === undefined && v.deno === undefined && Number(v.node.split(".")[0]) >= 24
}

const inflate = (encoding: string, bytes: Uint8Array): Promise<Uint8Array> =>
  new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(encoding as "gzip")))
    .arrayBuffer()
    .then((b) => new Uint8Array(b))

/** gRPC's HTTP-to-status mapping, for a response that carries no `grpc-status` (5xx are kept retryable). */
export const httpCode = (status: number): RpcCode =>
  status === 400
    ? "INTERNAL"
    : status === 401
    ? "UNAUTHENTICATED"
    : status === 403
    ? "PERMISSION_DENIED"
    : status === 404
    ? "UNIMPLEMENTED"
    : status === 429 || status >= 500
    ? "UNAVAILABLE"
    : "UNKNOWN"

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface GrpcWebOptions {
  /**
   * Base URL of a full node or RPC provider, e.g. `https://fullnode.mainnet.sui.io:443`.
   * Method paths are appended to it; trailing slashes are stripped.
   */
  readonly url: string
  /** Extra headers on every call (API keys, routing). */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Bound on each unary call; a call without an answer in time fails with a
   * retryable `DEADLINE_EXCEEDED`. Server streams are not bounded. Default 30 seconds.
   */
  readonly requestTimeout?: Duration.Input
  /**
   * Send `traceparent` / `b3` headers. Off by default, as in every other
   * layer here: browsers preflight them, and a provider with a strict CORS
   * allow-list refuses them. Spans are recorded either way.
   */
  readonly tracerPropagation?: boolean
  /**
   * Ask for compressed responses; the server picks what to apply. On (the default): per-message
   * `grpc-encoding` with the encodings this runtime decodes (`zstd` where `DecompressionStream`
   * has it, and `gzip`), and on Node 24+ `Accept-Encoding: zstd, gzip`, so a provider can compress
   * a whole stream (`fetch` decodes it). Off: `grpc-accept-encoding: identity`, `Accept-Encoding`
   * left to the client. See docs/design/grpc-compression.md.
   */
  readonly compression?: boolean
}

export class GrpcWeb extends /* @__PURE__ */ Context.Service<GrpcWeb, {
  readonly unary: <I, O>(method: Rpc<I, O, false>, request: I) => Effect.Effect<O, RpcError>
  readonly serverStream: <I, O>(method: Rpc<I, O, true>, request: I) => Stream.Stream<O, RpcError>
}>()("@unconfirmed/sui/GrpcWeb") {
  static readonly layer = (options: GrpcWebOptions): Layer.Layer<GrpcWeb, never, HttpClient.HttpClient> =>
    Layer.effect(
      GrpcWeb,
      Effect.gen(function*() {
        const http = yield* HttpClient.HttpClient
        const base = options.url.replace(/\/+$/, "")
        const timeout = Duration.fromInputUnsafe(options.requestTimeout ?? "30 seconds")
        const tracerPropagation = options.tracerPropagation ?? false
        const decodes = options.compression === false ? [] : decodableEncodings()
        const headers: Record<string, string> = {
          ...options.headers,
          "x-grpc-web": "1",
          accept: "application/grpc-web+proto",
          "grpc-accept-encoding": decodes.length > 0 ? decodes.join(",") : "identity"
        }
        if (options.compression !== false && askForZstd()) headers["accept-encoding"] = "zstd, gzip"

        const call = <I, O>(method: Rpc<I, O, boolean>, request: I): Stream.Stream<O, RpcError> => {
          const path = method.path
          const codec = method.codec()
          const fail = (message: string, code: RpcCode = "UNAVAILABLE") => new RpcError({ method: path, code, message })

          return Effect.try({
            try: () => frame(codec.encode(request)),
            catch: (e) => fail(`invalid request: ${e instanceof Error ? e.message : String(e)}`, "INVALID_ARGUMENT")
          }).pipe(
            Effect.flatMap((body) =>
              HttpClientRequest.post(`${base}/${path}`).pipe(
                HttpClientRequest.setHeaders(headers),
                HttpClientRequest.bodyUint8Array(body, "application/grpc-web+proto"),
                http.execute,
                Effect.provideService(HttpClient.TracerPropagationEnabled, tracerPropagation),
                Effect.mapError((e) => fail(e.message))
              )
            ),
            Effect.flatMap((res) => {
              // A trailers-only response carries its status in the headers.
              const err = statusOf(path, (k) => res.headers[k])
              if (err) return Effect.fail(err)
              if (res.status !== 200) return Effect.fail(fail(`HTTP ${res.status}`, httpCode(res.status)))
              const decode = (payload: Uint8Array) =>
                Result.match(codec.decode(payload), {
                  onSuccess: (m) => Effect.succeed<ReadonlyArray<O>>([m]),
                  onFailure: (e) => Effect.fail(fail(`malformed response: ${e.message}`, "DATA_LOSS"))
                })
              return Effect.succeed(
                toFrames(res.stream.pipe(Stream.mapError((e) => fail(e.message)))).pipe(
                  Stream.mapEffect((f) => {
                    if (f.kind === "data") return decode(f.payload)
                    if (f.kind === "incomplete") return Effect.fail(fail("the response ended before its gRPC trailers"))
                    if (f.kind === "trailer") {
                      const t = parseTrailers(f.payload)
                      const e = statusOf(path, (k) => t[k])
                      return e ? Effect.fail(e) : Effect.succeed<ReadonlyArray<O>>([])
                    }
                    if (f.kind === "malformed") {
                      const coding = res.headers["content-encoding"]
                      return Effect.fail(fail(
                        coding !== undefined && coding !== "identity"
                          ? `the body is still Content-Encoding: ${coding}: this HttpClient doesn't decode it (use FetchHttpClient, or compression: false)`
                          : `malformed gRPC-web frame (flags 0x${f.payload[0]!.toString(16)})`,
                        "INTERNAL"
                      ))
                    }
                    // gRPC: a compressed message we can't decompress is INTERNAL.
                    const encoding = res.headers["grpc-encoding"]?.trim().toLowerCase()
                    if (encoding === undefined || !decodes.includes(encoding)) {
                      return Effect.fail(fail(
                        `compressed message with ${encoding === undefined ? "no grpc-encoding" : `grpc-encoding ${encoding}, which we didn't offer`}`,
                        "INTERNAL"
                      ))
                    }
                    return Effect.tryPromise({
                      try: () => inflate(encoding, f.payload),
                      catch: (e) => fail(`could not decompress a ${encoding} message: ${e instanceof Error ? e.message : String(e)}`, "INTERNAL")
                    }).pipe(Effect.flatMap(decode))
                  }),
                  Stream.flatMap((xs) => Stream.fromIterable(xs))
                )
              )
            }),
            Stream.unwrap
          )
        }

        return GrpcWeb.of({
          unary: (method, request) =>
            // Read through to the trailers: an error status after the message must not be dropped.
            call(method, request).pipe(
              Stream.runFold((): Option.Option<any> => Option.none(), (acc, m) => (Option.isNone(acc) ? Option.some(m) : acc)),
              Effect.flatMap(Option.match({
                onNone: () => Effect.fail(new RpcError({ method: method.path, code: "INTERNAL", message: "no response message" })),
                onSome: Effect.succeed
              })),
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  Effect.fail(new RpcError({ method: method.path, code: "DEADLINE_EXCEEDED", message: `no answer within ${Duration.format(timeout)}` }))
              }),
              Effect.withSpan(`grpc ${method.path}`, { attributes: { "rpc.system": "grpc", "rpc.method": method.path } })
            ),
          serverStream: (method, request) => call(method, request)
        })
      })
    )
}
