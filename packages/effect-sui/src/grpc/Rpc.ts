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
): Rpc<I, O, Streaming> => make(path, input, output, streaming, chunks, undefined)

/**
 * A handle whose descriptors are pruned to what the SDK reads
 * (`scripts/grpc-lean.ts`). Response fields outside them decode as unknown
 * and are dropped. Every request is checked first: a field the pruned request
 * descriptor lacks would otherwise be dropped silently, and a read-mask path
 * outside `mask` (or no mask, which asks for the server's default fields)
 * would return fields the response descriptor cannot see. Either is a defect.
 */
export const lean = <I, O, Streaming extends boolean>(
  path: string,
  input: string,
  output: string,
  streaming: Streaming,
  chunks: () => ReadonlyArray<Chunk>,
  mask: ReadonlyArray<string> | undefined
): Rpc<I, O, Streaming> => make(path, input, output, streaming, chunks, { mask })

const fail = (path: string, message: string): never => {
  throw new Error(`${path}: ${message} (pruned handle; see packages/effect-sui/scripts/grpc-lean.ts)`)
}

/** Every key of `value` is a field (or real oneof) of `descriptor`, recursively. */
const checkFields = (path: string, descriptor: ProtobufDescriptor.MessageDescriptor, value: unknown, at: string): void => {
  if (typeof value !== "object" || value === null) return
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue
    const field = descriptor.fields.find((f) => f.name === key && (f.oneof === undefined || f.proto.proto3_optional === true))
    if (field) {
      checkValue(path, field, v, `${at}${key}`)
      continue
    }
    const oneof = descriptor.oneofs.find((o) => o.name === key)
    const member = oneof?.fields.find((f) => f.name === (v as { _tag?: string })._tag)
    if (member) checkValue(path, member, (v as { value: unknown }).value, `${at}${key}.${member.name}`)
    else fail(path, `request field ${at}${key} is not in the pruned descriptor`)
  }
}

const checkValue = (path: string, field: ProtobufDescriptor.FieldDescriptor, value: unknown, at: string): void => {
  if (field.type.kind !== "message") return
  const message = field.type.message
  if (field.kind === "list") (value as ReadonlyArray<unknown>).forEach((v) => checkFields(path, message, v, `${at}.`))
  else if (field.kind === "map") Object.values(value as object).forEach((v) => checkFields(path, message, v, `${at}.`))
  else checkFields(path, message, value, `${at}.`)
}

const checkMask = (path: string, allowed: ReadonlyArray<string>, request: unknown): void => {
  const paths = (request as { read_mask?: { paths?: ReadonlyArray<string> } }).read_mask?.paths
  if (paths === undefined) return fail(path, "a read mask is required")
  for (const p of paths) {
    if (!allowed.some((a) => p === a || p.startsWith(`${a}.`))) fail(path, `read-mask path "${p}" is not in the pruned descriptor`)
  }
}

const make = <I, O, Streaming extends boolean>(
  path: string,
  input: string,
  output: string,
  streaming: Streaming,
  chunks: () => ReadonlyArray<Chunk>,
  pruned: { readonly mask: ReadonlyArray<string> | undefined } | undefined
): Rpc<I, O, Streaming> => {
  let codec: Codec<I, O> | undefined
  return {
    path,
    streaming,
    codec: () => {
      if (codec) return codec
      const registry = registryOf(chunks())
      const inputDescriptor = registry.getMessage(input)!
      const encode = ProtobufMessage.encode(inputDescriptor)
      const decode = ProtobufMessage.decode(registry.getMessage(output)!, pruned && { readUnknownFields: false })
      return codec = {
        encode: (req) => {
          if (pruned) {
            if (pruned.mask) checkMask(path, pruned.mask, req)
            checkFields(path, inputDescriptor, req, "")
          }
          return Result.getOrThrow(encode(req as ProtobufMessage.Message))
        },
        decode: (bytes) => decode(bytes) as Result.Result<O, ProtobufMessage.ProtobufMessageError>
      }
    }
  }
}
