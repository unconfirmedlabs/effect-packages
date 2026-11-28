/**
 * GraphQL values -> domain values and GraphQL failures -> `RpcError`, shared by
 * the GraphQL implementations. Every invariant the domain types need (an
 * object has an owner, a status is SUCCESS or FAILURE, ...) is in a Schema,
 * so a response that breaks one is a `DecodeError` (-> `DATA_LOSS`) and the
 * conversions below are total.
 */
import * as Effect from "effect/Effect"
import * as GraphQLClientError from "effect/graphql/GraphQLClientError"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as Stream from "effect/Stream"
import * as Address from "@unconfirmed/sui/Address"
import type * as Events from "@unconfirmed/sui/Events"
import type * as Objects from "@unconfirmed/sui/Objects"
import { type RpcCode, RpcError } from "@unconfirmed/sui/RpcError"
import type { ObjectDigest } from "@unconfirmed/sui/TransactionData"
import type * as Transactions from "@unconfirmed/sui/Transactions"

// -----------------------------------------------------------------------------
// Scalars
// -----------------------------------------------------------------------------

/** `UInt53` (a JSON number) or `BigInt` (a JSON string of digits), decoded to `bigint`. */
export const U64 = Schema.Union([Schema.Int, Schema.String.check(Schema.isPattern(/^-?\d+$/))]).pipe(
  Schema.decodeTo(Schema.BigInt, {
    decode: SchemaGetter.BigInt(),
    encode: SchemaGetter.transform((b: bigint) => b.toString())
  })
)

/** `Base64` -> bytes. */
export const Bytes = Schema.Uint8ArrayFromBase64

const toBase64 = Schema.encodeSync(Schema.Uint8ArrayFromBase64)
export const base64 = (bytes: Uint8Array): string => toBase64(bytes)

const SuiAddress = Schema.Struct({ address: Schema.String })

// -----------------------------------------------------------------------------
// Objects
// -----------------------------------------------------------------------------

export const OWNER_FIELDS =
  "__typename ...on AddressOwner{address{address}} ...on ObjectOwner{address{address}} ...on Shared{initialSharedVersion} ...on ConsensusAddressOwner{startVersion address{address}}"

export const Owner = Schema.Union([
  Schema.Struct({ __typename: Schema.Literal("AddressOwner"), address: SuiAddress }),
  Schema.Struct({ __typename: Schema.Literal("ObjectOwner"), address: SuiAddress }),
  Schema.Struct({ __typename: Schema.Literal("Shared"), initialSharedVersion: U64 }),
  Schema.Struct({ __typename: Schema.Literal("Immutable") }),
  Schema.Struct({ __typename: Schema.Literal("ConsensusAddressOwner"), startVersion: U64, address: SuiAddress })
])

export const owner = (o: typeof Owner.Type): Objects.Owner => {
  switch (o.__typename) {
    case "AddressOwner":
      return { _tag: "AddressOwner", address: Address.normalize(o.address.address) }
    case "ObjectOwner":
      return { _tag: "ObjectOwner", address: Address.normalize(o.address.address) }
    case "Shared":
      return { _tag: "Shared", initialSharedVersion: o.initialSharedVersion }
    case "Immutable":
      return { _tag: "Immutable" }
    case "ConsensusAddressOwner":
      return {
        _tag: "ConsensusAddressOwner",
        startVersion: o.startVersion,
        address: Address.normalize(o.address.address)
      }
  }
}

/** Selection on `Object` for a `SuiObject`. */
export const OBJECT_FIELDS =
  `address version digest owner{${OWNER_FIELDS}} asMoveObject{contents{type{repr} bcs}} asMovePackage{address} previousTransaction{digest}`

const MoveContents = Schema.Struct({ type: Schema.Struct({ repr: Schema.String }), bcs: Bytes })
const PreviousTransaction = Schema.NullOr(Schema.Struct({ digest: Schema.String }))

export const ObjectNode = Schema.Struct({
  address: Schema.String,
  version: U64,
  digest: Schema.String,
  owner: Owner,
  asMoveObject: Schema.NullOr(Schema.Struct({ contents: MoveContents })),
  asMovePackage: Schema.NullOr(Schema.Struct({ address: Schema.String })),
  previousTransaction: PreviousTransaction
})

/** Selection on `MoveObject` (owned-object listings) for a `SuiObject`. */
export const MOVE_OBJECT_FIELDS = `address version digest owner{${OWNER_FIELDS}} contents{type{repr} bcs} previousTransaction{digest}`

export const MoveObjectNode = Schema.Struct({
  address: Schema.String,
  version: U64,
  digest: Schema.String,
  owner: Owner,
  contents: MoveContents,
  previousTransaction: PreviousTransaction
})

export const object = (o: typeof ObjectNode.Type): Objects.SuiObject => ({
  objectId: Address.normalize(o.address),
  version: o.version,
  digest: o.digest as ObjectDigest,
  owner: owner(o.owner),
  // Same as gRPC: a package's type is `package` and its contents are empty.
  type: o.asMoveObject?.contents.type.repr ?? "package",
  contents: o.asMoveObject?.contents.bcs ?? new Uint8Array(),
  previousTransaction: o.previousTransaction?.digest
})

export const moveObject = (o: typeof MoveObjectNode.Type): Objects.SuiObject => ({
  objectId: Address.normalize(o.address),
  version: o.version,
  digest: o.digest as ObjectDigest,
  owner: owner(o.owner),
  type: o.contents.type.repr,
  contents: o.contents.bcs,
  previousTransaction: o.previousTransaction?.digest
})

// -----------------------------------------------------------------------------
// Effects
// -----------------------------------------------------------------------------

/**
 * The largest `objectChanges` page the public services allow. The effects
 * selection reads the first page; when `pageInfo.hasNextPage` is set the
 * Transactions layer reads the rest by digest (see `TransactionsGraphQL.ts`).
 */
export const OBJECT_CHANGES_PAGE = 1024

const STATE_FIELDS = `version digest owner{${OWNER_FIELDS}} asMoveObject{contents{type{repr}}} asMovePackage{address}`

/** Selection on `ObjectChangeConnection` for one page of `ChangedObject`s. */
export const OBJECT_CHANGES_FIELDS = `pageInfo{hasNextPage endCursor} nodes{address idCreated idDeleted ` +
  `inputState{${STATE_FIELDS}} outputState{${STATE_FIELDS}}}`

/**
 * Selection on `TransactionEffects` for `Effects`, with the first `changesPage`
 * object changes. Nested under a list (checkpoint transactions) the page is
 * kept small, because the server bounds the product of nested page sizes.
 */
export const effectsFields = (changesPage: number) =>
  `digest status executionError{message abortCode module{name package{address}} function{name} instructionOffset sourceLineNumber identifier constant} ` +
  `gasEffects{gasSummary{computationCost storageCost storageRebate nonRefundableStorageFee}} ` +
  `objectChanges(first:${changesPage}){${OBJECT_CHANGES_FIELDS}}`

export const EFFECTS_FIELDS = effectsFields(OBJECT_CHANGES_PAGE)

const TypeOnly = Schema.Struct({
  asMoveObject: Schema.NullOr(Schema.Struct({ contents: Schema.NullOr(Schema.Struct({ type: Schema.Struct({ repr: Schema.String }) })) })),
  asMovePackage: Schema.NullOr(Schema.Struct({ address: Schema.String }))
})

const State = Schema.Struct({
  ...TypeOnly.fields,
  version: U64,
  digest: Schema.NullOr(Schema.String),
  owner: Schema.NullOr(Owner)
})

const ObjectChange = Schema.Struct({
  address: Schema.String,
  idCreated: Schema.NullOr(Schema.Boolean),
  idDeleted: Schema.NullOr(Schema.Boolean),
  inputState: Schema.NullOr(State),
  outputState: Schema.NullOr(State)
})

export const ObjectChangesPage = Schema.Struct({
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  nodes: Schema.Array(ObjectChange)
})
export type ObjectChange = typeof ObjectChange.Type

const GasSummary = Schema.Struct({
  computationCost: Schema.NullOr(U64),
  storageCost: Schema.NullOr(U64),
  storageRebate: Schema.NullOr(U64),
  nonRefundableStorageFee: Schema.NullOr(U64)
})

export const EffectsNode = Schema.Struct({
  digest: Schema.String,
  status: Schema.Literals(["SUCCESS", "FAILURE"]),
  executionError: Schema.NullOr(Schema.Struct({
    message: Schema.String,
    abortCode: Schema.NullOr(U64),
    module: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.String, package: Schema.NullOr(Schema.Struct({ address: Schema.String })) }))),
    function: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
    instructionOffset: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    sourceLineNumber: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    identifier: Schema.optionalKey(Schema.NullOr(Schema.String)),
    constant: Schema.optionalKey(Schema.NullOr(Schema.String))
  })),
  gasEffects: Schema.NullOr(Schema.Struct({ gasSummary: Schema.NullOr(GasSummary) })),
  objectChanges: Schema.NullOr(ObjectChangesPage)
})
export type EffectsNode = typeof EffectsNode.Type

const typeOf = (s: typeof State.Type | null): string | undefined =>
  s === null ? undefined : s.asMoveObject?.contents?.type.repr ?? (s.asMovePackage ? "package" : undefined)

// The GraphQL schema has no field for the failing command; it is only in the
// message ("... in 2nd command"). Same as @mysten/sui's GraphQL client.
const commandOf = (message: string): number | undefined => {
  const m = /in (\d+)\w* command/.exec(message)
  return m ? Number(m[1]) - 1 : undefined
}

const status = (e: typeof EffectsNode.Type): Transactions.Status => {
  if (e.status === "SUCCESS") return { _tag: "Success" }
  const x = e.executionError
  const description = x?.message ?? "unknown execution failure"
  const pkg = x?.module?.package?.address
  return {
    _tag: "Failure",
    description,
    command: commandOf(description),
    abortCode: x?.abortCode ?? undefined,
    ...(x?.module && pkg !== undefined && {
      location: {
        package: Address.normalize(pkg),
        module: x.module.name,
        function: x.function?.name ?? undefined,
        instruction: x.instructionOffset ?? undefined
      }
    }),
    ...(x && (x.identifier != null || x.sourceLineNumber != null) && {
      cleverError: {
        errorCode: undefined,
        lineNumber: x.sourceLineNumber == null ? undefined : BigInt(x.sourceLineNumber),
        constantName: x.identifier ?? undefined,
        constantType: undefined,
        rendered: x.constant ?? undefined
      }
    })
  }
}

const changed = (c: typeof ObjectChange.Type): Transactions.ChangedObject => {
  const out = c.outputState
  const input = c.inputState
  return {
    objectId: Address.normalize(c.address),
    type: typeOf(out) ?? typeOf(c.inputState),
    operation: c.idCreated ? "Created" : c.idDeleted ? "Deleted" : "None",
    version: out?.version,
    digest: (out?.digest ?? undefined) as ObjectDigest | undefined,
    owner: out?.owner ? owner(out.owner) : undefined,
    inputVersion: input?.version,
    inputDigest: (input?.digest ?? undefined) as ObjectDigest | undefined,
    inputOwner: input?.owner ? owner(input.owner) : undefined
  }
}

/** `changes` defaults to the first page in `e`; pass every page when there are more. */
export const effects = (
  e: typeof EffectsNode.Type,
  changes: ReadonlyArray<ObjectChange> = e.objectChanges?.nodes ?? []
): Transactions.Effects => {
  const g = e.gasEffects?.gasSummary
  return {
    digest: e.digest,
    status: status(e),
    gasUsed: {
      computationCost: g?.computationCost ?? 0n,
      storageCost: g?.storageCost ?? 0n,
      storageRebate: g?.storageRebate ?? 0n,
      nonRefundableStorageFee: g?.nonRefundableStorageFee ?? 0n
    },
    changedObjects: changes.map(changed)
  }
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

/** Selection on `Event` for an `Event`, without its position (nested under a transaction). */
export const EVENT_CONTENT_FIELDS = "sequenceNumber sender{address} transactionModule{package{address} name} contents{type{repr} bcs}"

/** Selection on `Event` for an `Event` read on its own (with its transaction and checkpoint). */
export const EVENT_FIELDS = `${EVENT_CONTENT_FIELDS} transaction{digest effects{checkpoint{sequenceNumber}}}`

export const EventContentNode = Schema.Struct({
  sequenceNumber: Schema.Int,
  sender: Schema.NullOr(SuiAddress),
  transactionModule: Schema.NullOr(Schema.Struct({ package: Schema.NullOr(SuiAddress), name: Schema.String })),
  contents: MoveContents
})
export type EventContentNode = typeof EventContentNode.Type

export const EventNode = Schema.Struct({
  ...EventContentNode.fields,
  transaction: Schema.Struct({
    digest: Schema.String,
    effects: Schema.NullOr(Schema.Struct({ checkpoint: Schema.NullOr(Schema.Struct({ sequenceNumber: U64 })) }))
  })
})
export type EventNode = typeof EventNode.Type

/** An event from its contents and its position. A system transaction's events have no sender over GraphQL: `0x0`, as over gRPC. */
export const event = (
  e: EventContentNode,
  at: { readonly checkpoint: bigint; readonly transactionDigest: string; readonly transactionIndex: bigint }
): Events.Event => ({
  type: e.contents.type.repr,
  sender: Address.normalize(e.sender?.address ?? "0x0"),
  packageId: Address.normalize(e.transactionModule?.package?.address ?? "0x0"),
  module: e.transactionModule?.name ?? "",
  contents: e.contents.bcs,
  transactionDigest: at.transactionDigest,
  checkpoint: at.checkpoint,
  transactionIndex: at.transactionIndex,
  eventIndex: e.sequenceNumber
})

/** Sui's event cursors end with `checkpoint: u64 LE, transaction index: u64 LE, event index: u32 LE`. */
export const eventCursorPosition = (
  cursor: string
): { readonly checkpoint: bigint; readonly transactionIndex: bigint; readonly eventIndex: number } | undefined => {
  try {
    const bytes = Uint8Array.from(atob(cursor), (c) => c.charCodeAt(0))
    if (bytes.length < 20) return undefined
    const view = new DataView(bytes.buffer, bytes.length - 20, 20)
    return { checkpoint: view.getBigUint64(0, true), transactionIndex: view.getBigUint64(8, true), eventIndex: view.getUint32(16, true) }
  } catch {
    return undefined
  }
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Sui's `extensions.code` values -> gRPC codes. */
const GRAPHQL_CODES: Record<string, RpcCode> = {
  BAD_USER_INPUT: "INVALID_ARGUMENT",
  BAD_REQUEST: "INVALID_ARGUMENT",
  GRAPHQL_VALIDATION_FAILED: "INVALID_ARGUMENT",
  GRAPHQL_PARSE_FAILED: "INVALID_ARGUMENT",
  FEATURE_UNAVAILABLE: "UNIMPLEMENTED",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "PERMISSION_DENIED",
  REQUEST_TIMEOUT: "DEADLINE_EXCEEDED",
  GATEWAY_TIMEOUT: "DEADLINE_EXCEEDED",
  TOO_MANY_REQUESTS: "RESOURCE_EXHAUSTED",
  RATE_LIMITED: "RESOURCE_EXHAUSTED",
  RESOURCE_EXHAUSTED: "RESOURCE_EXHAUSTED",
  INTERNAL_SERVER_ERROR: "INTERNAL",
  UNAVAILABLE: "UNAVAILABLE"
}

/** HTTP status -> gRPC code, for responses with no more specific information. */
export const httpCode = (status: number): RpcCode => {
  if (status === 429) return "RESOURCE_EXHAUSTED"
  if (status === 408 || status === 504) return "DEADLINE_EXCEEDED"
  if (status === 401) return "UNAUTHENTICATED"
  if (status === 403) return "PERMISSION_DENIED"
  if (status === 404 || status === 405) return "UNIMPLEMENTED"
  // Too large: sending it again won't help.
  if (status === 413) return "INVALID_ARGUMENT"
  if (status >= 500) return "UNAVAILABLE"
  if (status >= 400) return "INVALID_ARGUMENT"
  return "UNKNOWN"
}

const codeOfGraphQLError = (e: GraphQLClientError.GraphQLError): RpcCode => {
  const code = e.extensions?.["code"]
  // Sui reports its per-query limits (rich queries, output nodes, page size) as
  // RESOURCE_EXHAUSTED at HTTP 200: the same query fails again, so not retryable.
  if (code === "RESOURCE_EXHAUSTED" && /^(Exceeded|Page size|Estimated)/.test(e.message)) return "INVALID_ARGUMENT"
  if (typeof code === "string" && code in GRAPHQL_CODES) return GRAPHQL_CODES[code]!
  // Scalar coercion failures (`Failed to parse "SuiAddress": ...`) carry no code.
  if (e.message.startsWith("Failed to parse")) return "INVALID_ARGUMENT"
  // E.g. a subscription sent to the query endpoint.
  if (/\bnot supported\b/i.test(e.message)) return "UNIMPLEMENTED"
  return "UNKNOWN"
}

/** The one place a `GraphQLClientError` becomes an `RpcError`. */
export const rpcCode = (error: GraphQLClientError.GraphQLClientError): RpcCode => {
  const reason = error.reason
  switch (reason._tag) {
    case "TransportError":
      // No status: the request never got a response (DNS, TLS, reset, abort).
      return reason.status === undefined ? "UNAVAILABLE" : httpCode(reason.status)
    case "ResponseError": {
      // A 429 or 5xx response is a failure of the service, whatever the body
      // says (e.g. INTERNAL_SERVER_ERROR from an overloaded replica), so it
      // keeps the HTTP code and stays retryable.
      if (reason.status !== undefined && (reason.status === 429 || reason.status >= 500)) return httpCode(reason.status)
      const code = codeOfGraphQLError(reason.errors[0])
      // An `extensions.code` we don't know is not guessed at: the HTTP status
      // decides if it is a 4xx, otherwise it is UNKNOWN (not retryable).
      return code === "UNKNOWN" && reason.status !== undefined && reason.status >= 400 ? httpCode(reason.status) : code
    }
    case "EncodeError":
      return "INVALID_ARGUMENT"
    case "DecodeError":
      return "DATA_LOSS"
    case "PaginationError":
      return "INTERNAL"
  }
}

export const toRpcError = (error: GraphQLClientError.GraphQLClientError): RpcError =>
  new RpcError({ method: error.operation, code: rpcCode(error), message: error.reason.message })

type ClientError = GraphQLClientError.GraphQLClientError

const mapClientError = <E>(e: E): Exclude<E, ClientError> | RpcError =>
  GraphQLClientError.isGraphQLClientError(e) ? toRpcError(e) : (e as Exclude<E, ClientError>)

/** Run a client call, its `GraphQLClientError`s becoming `RpcError`s. */
export const call = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, ClientError> | RpcError, R> =>
  Effect.mapError(effect, mapClientError)

export const callStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>
): Stream.Stream<A, Exclude<E, ClientError> | RpcError, R> => Stream.mapError(stream, mapClientError)
