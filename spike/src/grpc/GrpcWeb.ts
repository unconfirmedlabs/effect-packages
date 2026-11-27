/**
 * gRPC-web over Effect's HttpClient, with messages encoded by `effect/protobuf`
 * from the sui-apis descriptor set. ~150 lines replaces @protobuf-ts/runtime,
 * runtime-rpc and grpcweb-transport, and inherits from HttpClient for free:
 * interruption (no AbortSignal plumbing), tracing, middleware (auth headers,
 * retries, logging), and a test seam (swap the HttpClient layer).
 *
 * Messages are plain objects keyed by proto field name (snake_case) exactly as
 * `ProtobufMessage` produces them; the typed domain layer above decodes them
 * with Schema.
 */
import { Context, Effect, Layer, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ProtobufDescriptor, ProtobufMessage } from "effect/protobuf"
import { descriptorSetBase64 } from "./descriptor.generated.ts"

export const GrpcCode = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED"
] as const
export type GrpcCode = (typeof GrpcCode)[number]

const RETRYABLE: ReadonlySet<GrpcCode> = new Set(["UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED"])

/**
 * Every failure of a call, transport included, as one status-coded error. A
 * network failure is `UNAVAILABLE` (the request may not have reached a node);
 * a node's answer is its own status. `retryable` is decided here, once.
 */
export class GrpcError extends Schema.TaggedError<GrpcError>()("GrpcError", {
  method: Schema.String,
  code: Schema.Literals(GrpcCode),
  message: Schema.String
}) {
  get retryable(): boolean {
    return RETRYABLE.has(this.code)
  }
}

// -----------------------------------------------------------------------------

const registry = Result.getOrThrow(
  ProtobufDescriptor.fromFileDescriptorSet(Uint8Array.from(atob(descriptorSetBase64), (c) => c.charCodeAt(0)))
)

const methodDescriptor = (path: string) => {
  const [service, method] = path.split("/") as [string, string]
  const svc = registry.getService(service)
  const m = svc?.methods.find((x) => x.name === method)
  if (!m) throw new Error(`unknown gRPC method ${path}`)
  return m
}

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

const statusOf = (method: string, h: Record<string, string | undefined>): GrpcError | undefined => {
  const raw = h["grpc-status"]
  if (raw === undefined || raw === "0") return undefined
  return new GrpcError({
    method,
    code: GrpcCode[Number(raw)] ?? "UNKNOWN",
    message: decodeURIComponent(h["grpc-message"] ?? "")
  })
}

/** Incrementally split a gRPC-web body into data frames, failing on an error trailer. */
const frames = (method: string) => <E>(body: Stream.Stream<Uint8Array, E>): Stream.Stream<Uint8Array, E | GrpcError> =>
  body.pipe(
    Stream.mapAccum(() => new Uint8Array(0), (buffer: Uint8Array, chunk: Uint8Array) => {
      const merged = new Uint8Array(buffer.length + chunk.length)
      merged.set(buffer)
      merged.set(chunk, buffer.length)
      const out: Array<{ flag: number; payload: Uint8Array }> = []
      let pos = 0
      while (merged.length - pos >= 5) {
        const len = new DataView(merged.buffer, merged.byteOffset + pos + 1, 4).getUint32(0, false)
        if (merged.length - pos - 5 < len) break
        out.push({ flag: merged[pos]!, payload: merged.slice(pos + 5, pos + 5 + len) })
        pos += 5 + len
      }
      return [merged.slice(pos), out] as const
    }),
    Stream.mapEffect(({ flag, payload }) => {
      if ((flag & 0x80) === 0) return Effect.succeed([payload])
      const err = statusOf(method, parseTrailers(payload))
      return err ? Effect.fail(err) : Effect.succeed([] as Array<Uint8Array>)
    }),
    Stream.flatMap((xs) => Stream.fromIterable(xs))
  )

// -----------------------------------------------------------------------------

export interface GrpcWebOptions {
  /** A full node, e.g. `https://fullnode.testnet.sui.io:443`. */
  readonly baseUrl: string
}

export class GrpcWeb extends Context.Service<GrpcWeb, {
  /** One request, one response. */
  unary(method: string, request: ProtobufMessage.Message): Effect.Effect<ProtobufMessage.Message, GrpcError>
  /** One request, a server stream of responses (List*, Subscribe*). */
  serverStream(method: string, request: ProtobufMessage.Message): Stream.Stream<ProtobufMessage.Message, GrpcError>
}>()("@effect-sdks/sui/GrpcWeb") {
  static readonly layer = (options: GrpcWebOptions) =>
    Layer.effect(
      GrpcWeb,
      Effect.gen(function*() {
        const http = yield* HttpClient.HttpClient

        const call = (path: string, request: ProtobufMessage.Message) => {
          const m = methodDescriptor(path)
          const encoded = Result.getOrThrow(ProtobufMessage.encode(m.input)(request))
          const fail = (message: string, code: GrpcCode = "UNAVAILABLE") =>
            new GrpcError({ method: path, code, message })
          const decode = (bytes: Uint8Array) =>
            Result.match(ProtobufMessage.decode(m.output)(bytes), {
              onSuccess: Effect.succeed,
              onFailure: (e) => Effect.fail(fail(`malformed response: ${e.message}`, "DATA_LOSS"))
            })

          const responses = HttpClientRequest.post(`${options.baseUrl}/${path}`).pipe(
            HttpClientRequest.setHeaders({ "x-grpc-web": "1", accept: "application/grpc-web+proto" }),
            HttpClientRequest.bodyUint8Array(frame(encoded), "application/grpc-web+proto"),
            http.execute,
            Effect.mapError((e) => fail(e.message)),
            Effect.flatMap((res) => {
              // Trailers-only responses carry the status in the headers.
              const err = statusOf(path, res.headers as Record<string, string>)
              if (err) return Effect.fail(err)
              if (res.status !== 200) return Effect.fail(fail(`HTTP ${res.status}`, res.status >= 500 ? "UNAVAILABLE" : "UNKNOWN"))
              return Effect.succeed(res)
            }),
            Effect.map((res: HttpClientResponse.HttpClientResponse) =>
              res.stream.pipe(Stream.mapError((e) => fail(e.message)), frames(path), Stream.mapEffect(decode))
            ),
            Stream.unwrap
          )
          return responses
        }

        return GrpcWeb.of({
          unary: (path, request) =>
            call(path, request).pipe(
              Stream.runHead,
              Effect.flatMap((o) =>
                o._tag === "Some" ? Effect.succeed(o.value) : Effect.fail(new GrpcError({ method: path, code: "INTERNAL", message: "no response message" }))
              ),
              Effect.withSpan(`grpc ${path}`, { attributes: { "rpc.system": "grpc", "rpc.method": path } })
            ),
          serverStream: (path, request) => call(path, request).pipe(Stream.withSpan(`grpc ${path}`))
        })
      })
    )
}
