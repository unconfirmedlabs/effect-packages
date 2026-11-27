/**
 * Method handles for the generated gRPC surface.
 *
 * A handle carries its request/response types and a thunk listing the
 * descriptor chunks (one per top-level message or enum) its messages reach.
 * Its codec is built from just those chunks on first use. Because the chunks
 * are separate module-level constants, a bundler keeps exactly the
 * descriptors of the RPCs a program calls, each shared message once.
 */
import * as Result from "effect/Result"
import * as ProtobufDescriptor from "effect/protobuf/ProtobufDescriptor"
import * as ProtobufMessage from "effect/protobuf/ProtobufMessage"

export interface File {
  readonly name: string
  readonly package: string
  readonly syntax: string
  readonly dependency: ReadonlyArray<string>
}

export interface Chunk {
  readonly file: File
  readonly kind: "message" | "enum"
  readonly proto: object
}

export const file = (f: File): File => f
export const chunk = (file: File, kind: Chunk["kind"], proto: object): Chunk => ({ file, kind, proto })

export interface Codec<I, O> {
  readonly encode: (request: I) => Uint8Array
  readonly decode: (bytes: Uint8Array) => Result.Result<O, ProtobufMessage.ProtobufMessageError>
}

export interface Rpc<I, O, Streaming extends boolean> {
  readonly path: string
  readonly streaming: Streaming
  readonly codec: () => Codec<I, O>
  /** Phantom: request and response types. */
  readonly "~types"?: readonly [I, O]
}

const registryOf = (chunks: ReadonlyArray<Chunk>) => {
  const files = new Map<File, { message_type: Array<object>; enum_type: Array<object> }>()
  for (const c of chunks) {
    let entry = files.get(c.file)
    if (!entry) files.set(c.file, entry = { message_type: [], enum_type: [] })
    ;(c.kind === "message" ? entry.message_type : entry.enum_type).push(c.proto)
  }
  const present = new Set([...files.keys()].map((f) => f.name))
  return Result.getOrThrow(
    ProtobufDescriptor.make(
      [...files].map(([f, e]) => ({
        name: f.name,
        package: f.package,
        syntax: f.syntax,
        dependency: f.dependency.filter((d) => present.has(d)),
        ...e
      })) as any
    )
  )
}

export const rpc = <I, O, Streaming extends boolean>(
  path: string,
  input: string,
  output: string,
  streaming: Streaming,
  chunks: () => ReadonlyArray<Chunk>
): Rpc<I, O, Streaming> => {
  let codec: Codec<I, O> | undefined
  return {
    path,
    streaming,
    codec: () => {
      if (codec) return codec
      const registry = registryOf(chunks())
      const encode = ProtobufMessage.encode(registry.getMessage(input)!)
      const decode = ProtobufMessage.decode(registry.getMessage(output)!)
      return codec = {
        encode: (req) => Result.getOrThrow(encode(req as ProtobufMessage.Message)),
        decode: (bytes) => decode(bytes) as Result.Result<O, ProtobufMessage.ProtobufMessageError>
      }
    }
  }
}
