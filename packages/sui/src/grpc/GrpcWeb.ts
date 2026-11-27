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
  readonly trailer: boolean
  readonly payload: Uint8Array
}

/** Incrementally split a gRPC-web body into frames. */
const toFrames = <E>(body: Stream.Stream<Uint8Array, E>): Stream.Stream<Frame, E> =>
  body.pipe(
    Stream.mapAccum(() => new Uint8Array(0), (buffer: Uint8Array, chunk: Uint8Array) => {
      const merged = buffer.length === 0 ? chunk : concat(buffer, chunk)
      const out: Array<Frame> = []
      let pos = 0
      while (merged.length - pos >= 5) {
        const len = new DataView(merged.buffer, merged.byteOffset + pos + 1, 4).getUint32(0, false)
        if (merged.length - pos - 5 < len) break
        out.push({ trailer: (merged[pos]! & 0x80) !== 0, payload: merged.subarray(pos + 5, pos + 5 + len) })
        pos += 5 + len
      }
      return [merged.slice(pos), out] as const
    })
  )

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface GrpcWebOptions {
  /** A full node or RPC provider, e.g. `https://fullnode.mainnet.sui.io:443`. */
  readonly baseUrl: string
  /** Extra headers on every call (API keys, routing). */
  readonly headers?: Readonly<Record<string, string>>
}

export class GrpcWeb extends Context.Service<GrpcWeb, {
  readonly unary: <I, O>(method: Rpc<I, O, false>, request: I) => Effect.Effect<O, RpcError>
  readonly serverStream: <I, O>(method: Rpc<I, O, true>, request: I) => Stream.Stream<O, RpcError>
}>()("@unconfirmed/sui/GrpcWeb") {
  static readonly layer = (options: GrpcWebOptions): Layer.Layer<GrpcWeb, never, HttpClient.HttpClient> =>
    Layer.effect(
      GrpcWeb,
      Effect.gen(function*() {
        const http = yield* HttpClient.HttpClient
        const baseUrl = options.baseUrl.replace(/\/+$/, "")

        const call = <I, O>(method: Rpc<I, O, boolean>, request: I): Stream.Stream<O, RpcError> => {
          const path = method.path
          const codec = method.codec()
          const fail = (message: string, code: RpcCode = "UNAVAILABLE") => new RpcError({ method: path, code, message })

          return HttpClientRequest.post(`${baseUrl}/${path}`).pipe(
            HttpClientRequest.setHeaders({ ...options.headers, "x-grpc-web": "1", accept: "application/grpc-web+proto" }),
            HttpClientRequest.bodyUint8Array(frame(codec.encode(request)), "application/grpc-web+proto"),
            http.execute,
            Effect.mapError((e) => fail(e.message)),
            Effect.flatMap((res) => {
              // A trailers-only response carries its status in the headers.
              const err = statusOf(path, (k) => res.headers[k])
              if (err) return Effect.fail(err)
              if (res.status !== 200) {
                return Effect.fail(fail(`HTTP ${res.status}`, res.status >= 500 || res.status === 429 ? "UNAVAILABLE" : "UNKNOWN"))
              }
              return Effect.succeed(
                toFrames(res.stream.pipe(Stream.mapError((e) => fail(e.message)))).pipe(
                  Stream.mapEffect((f) => {
                    if (f.trailer) {
                      const t = parseTrailers(f.payload)
                      const e = statusOf(path, (k) => t[k])
                      return e ? Effect.fail(e) : Effect.succeed<ReadonlyArray<O>>([])
                    }
                    return Result.match(codec.decode(f.payload), {
                      onSuccess: (m) => Effect.succeed<ReadonlyArray<O>>([m]),
                      onFailure: (e) => Effect.fail(fail(`malformed response: ${e.message}`, "DATA_LOSS"))
                    })
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
            call(method, request).pipe(
              Stream.runHead,
              Effect.flatMap(Option.match({
                onNone: () => Effect.fail(new RpcError({ method: method.path, code: "INTERNAL", message: "no response message" })),
                onSome: Effect.succeed
              })),
              Effect.withSpan(`grpc ${method.path}`, { attributes: { "rpc.system": "grpc", "rpc.method": method.path } })
            ),
          serverStream: (method, request) => call(method, request)
        })
      })
    )
}
