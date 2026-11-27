/**
 * A Walrus publisher (§4.10): an HTTP daemon that stores a blob with its own
 * wallet and answers with the result. For apps that trust a gateway with
 * availability and payment; it ships no WASM and no quorum code. Nothing is
 * signed or paid by the caller, and nothing the publisher reports is checked
 * (read the blob back, e.g. with `Read.blob` or `Aggregator.verified`, if it
 * matters).
 *
 *   Publisher.layer({ url: Publisher.TESTNET_URL }).pipe(Layer.provide(FetchHttpClient.layer))
 *   const result = yield* Publisher.store(bytes, { epochs: 5 })
 *
 * Route: `PUT /v1/blobs` (`crates/walrus-service/src/client/daemon/routes.rs`,
 * `put_blob`, `PublisherQuery`); answer: `BlobStoreResult`
 * (`crates/walrus-sdk/src/node_client/responses.rs`), camelCase JSON.
 */
import * as Address from "@unconfirmed/sui/Address"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as BlobId from "./BlobId.ts"
import { GatewayError } from "./Errors.ts"
import { type GatewayOptions, makeCall } from "./internal/gateway.ts"

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

/** A Sui event id, as the publisher reports it. */
export interface EventId {
  readonly txDigest: string
  readonly eventSeq: string
}

/** The `Blob` object the publisher created (`walrus_sui::types::move_structs::Blob`). */
export interface BlobObject {
  readonly id: Address.Address
  readonly registeredEpoch: number
  readonly blobId: BlobId.BlobId
  readonly size: number
  /** `"RS2"`. */
  readonly encodingType: string
  readonly certifiedEpoch: number | undefined
  readonly storage: {
    readonly id: Address.Address
    readonly startEpoch: number
    readonly endEpoch: number
    readonly storageSize: number
  }
  readonly deletable: boolean
}

export type StoreResult =
  | {
    readonly _tag: "NewlyCreated"
    readonly blobObject: BlobObject
    /** How storage was obtained, e.g. `{ registerFromScratch: { encodedLength, epochsAhead } }`; passed through as is. */
    readonly resourceOperation: unknown
    /** WAL paid, in FROST. */
    readonly cost: number
    readonly sharedBlobObject: Address.Address | undefined
  }
  | {
    readonly _tag: "AlreadyCertified"
    readonly blobId: BlobId.BlobId
    readonly endEpoch: number
    /** The certification event, or (`object`) the publisher's own `Blob` registration: exactly one is set. */
    readonly event: EventId | undefined
    readonly object: Address.Address | undefined
  }
  | {
    readonly _tag: "MarkedInvalid"
    readonly blobId: BlobId.BlobId
    readonly event: EventId
  }

/** The blob id of any result. */
export const blobIdOf = (result: StoreResult): BlobId.BlobId =>
  result._tag === "NewlyCreated" ? result.blobObject.blobId : result.blobId

const U64 = /* @__PURE__ */ Schema.Union([Schema.Number, Schema.String])
const Id = /* @__PURE__ */ Schema.String
const EventJson = /* @__PURE__ */ Schema.Struct({ txDigest: Schema.String, eventSeq: U64 })
const StoreResultJson = /* @__PURE__ */ Schema.Union([
  /* @__PURE__ */ Schema.Struct({
    newlyCreated: Schema.Struct({
      blobObject: Schema.Struct({
        id: Id,
        registeredEpoch: Schema.Number,
        blobId: Schema.String,
        size: Schema.Number,
        encodingType: Schema.Union([Schema.String, Schema.Number]),
        certifiedEpoch: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        storage: Schema.Struct({ id: Id, startEpoch: Schema.Number, endEpoch: Schema.Number, storageSize: Schema.Number }),
        deletable: Schema.Boolean
      }),
      resourceOperation: Schema.optionalKey(Schema.Unknown),
      cost: Schema.Number,
      sharedBlobObject: Schema.optionalKey(Schema.NullOr(Id))
    })
  }),
  /* @__PURE__ */ Schema.Struct({
    alreadyCertified: Schema.Struct({
      blobId: Schema.String,
      endEpoch: Schema.Number,
      event: Schema.optionalKey(EventJson),
      object: Schema.optionalKey(Id)
    })
  }),
  /* @__PURE__ */ Schema.Struct({
    markedInvalid: Schema.Struct({ blobId: Schema.String, event: EventJson })
  }),
  /* @__PURE__ */ Schema.Struct({
    error: Schema.Struct({
      blobId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      failurePhase: Schema.optionalKey(Schema.String),
      errorMsg: Schema.String
    })
  })
])
const decodeStoreResultJson = /* @__PURE__ */ Schema.decodeUnknownResult(StoreResultJson)

const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/

/** A `PUT /v1/blobs` answer as a `StoreResult`, or why it is not one (including the daemon's own `error` variant). */
export const parseStoreResult = (json: unknown): Result.Result<StoreResult, string> => {
  const decoded = decodeStoreResultJson(json)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure.message)
  const value = decoded.success
  const blobId = (s: string) => Result.getOrUndefined(BlobId.fromString(s))
  const address = (s: string) => (ADDRESS.test(s) ? Address.normalize(s) : undefined)
  const event = (e: typeof EventJson.Type): EventId => ({ txDigest: e.txDigest, eventSeq: String(e.eventSeq) })

  if ("newlyCreated" in value) {
    const { blobObject: b, resourceOperation, cost, sharedBlobObject } = value.newlyCreated
    const id = blobId(b.blobId)
    const objectId = address(b.id)
    const storageId = address(b.storage.id)
    const shared = sharedBlobObject == null ? undefined : address(sharedBlobObject)
    if (id === undefined) return Result.fail(`invalid blob id ${b.blobId}`)
    if (objectId === undefined || storageId === undefined || (sharedBlobObject != null && shared === undefined)) {
      return Result.fail("invalid object id")
    }
    return Result.succeed({
      _tag: "NewlyCreated",
      blobObject: {
        id: objectId,
        registeredEpoch: b.registeredEpoch,
        blobId: id,
        size: b.size,
        encodingType: String(b.encodingType),
        certifiedEpoch: b.certifiedEpoch ?? undefined,
        storage: { ...b.storage, id: storageId },
        deletable: b.deletable
      },
      resourceOperation,
      cost,
      sharedBlobObject: shared
    })
  }
  if ("alreadyCertified" in value) {
    const a = value.alreadyCertified
    const id = blobId(a.blobId)
    if (id === undefined) return Result.fail(`invalid blob id ${a.blobId}`)
    const object = a.object === undefined ? undefined : address(a.object)
    if (a.object !== undefined && object === undefined) return Result.fail(`invalid object id ${a.object}`)
    return Result.succeed({
      _tag: "AlreadyCertified",
      blobId: id,
      endEpoch: a.endEpoch,
      event: a.event === undefined ? undefined : event(a.event),
      object
    })
  }
  if ("markedInvalid" in value) {
    const id = blobId(value.markedInvalid.blobId)
    if (id === undefined) return Result.fail(`invalid blob id ${value.markedInvalid.blobId}`)
    return Result.succeed({ _tag: "MarkedInvalid", blobId: id, event: event(value.markedInvalid.event) })
  }
  const e = value.error
  return Result.fail(e.failurePhase === undefined ? e.errorMsg : `${e.errorMsg} (phase ${e.failurePhase})`)
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface StoreOptions {
  /** Epochs ahead of the current one to store the blob for. Default: the publisher's (1). */
  readonly epochs?: number
  /** Store a permanent blob. Default: deletable (publishers since 1.35). */
  readonly permanent?: boolean
  /** Send the created `Blob` object to this address instead of keeping it in the publisher's wallet. */
  readonly sendObjectTo?: Address.Address
}

export interface PublisherService {
  /** The base URL, without a trailing slash. */
  readonly url: string
  /** `PUT /v1/blobs`. */
  readonly store: (bytes: Uint8Array, options?: StoreOptions) => Effect.Effect<StoreResult, GatewayError>
}

export class Publisher extends Context.Service<Publisher, PublisherService>()("@unconfirmed/walrus/Publisher") {}

export interface PublisherOptions extends GatewayOptions {
  /** Default 5 minutes: the publisher encodes, registers, uploads and certifies before it answers. */
  readonly requestTimeout?: Duration.Input
}

export const TESTNET_URL = "https://publisher.walrus-testnet.walrus.space"

/** The `PUT` path and query (the daemon rejects unknown query parameters). */
export const storePath = (options: StoreOptions = {}): string => {
  const query = new URLSearchParams()
  if (options.epochs !== undefined) query.set("epochs", String(options.epochs))
  if (options.permanent === true) query.set("permanent", "true")
  if (options.sendObjectTo !== undefined) query.set("send_object_to", Address.normalize(options.sendObjectTo))
  const q = query.toString()
  return q === "" ? "/v1/blobs" : `/v1/blobs?${q}`
}

export const layer = (options: PublisherOptions): Layer.Layer<Publisher, never, HttpClient.HttpClient> =>
  Layer.effect(
    Publisher,
    Effect.map(Effect.service(HttpClient.HttpClient), (http) => {
      const call = makeCall(http, options, Duration.minutes(5), "Publisher")
      const store = (bytes: Uint8Array, o?: StoreOptions) =>
        Effect.flatMap(
          call(
            "store",
            HttpClientRequest.put(storePath(o)).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream")
            )
          ),
          ({ status, body }) => {
            let json: unknown
            try {
              json = JSON.parse(new TextDecoder().decode(body))
            } catch {
              return Effect.fail(new GatewayError({ status, message: "store: response is not JSON" }))
            }
            const parsed = parseStoreResult(json)
            return Result.isSuccess(parsed)
              ? Effect.succeed(parsed.success)
              : Effect.fail(new GatewayError({ status, message: `store: ${parsed.failure}` }))
          }
        )
      return Publisher.of({ url: options.url.replace(/\/+$/, ""), store })
    })
  )

/** `PUT /v1/blobs` through the `Publisher` in context. */
export const store = (bytes: Uint8Array, options?: StoreOptions): Effect.Effect<StoreResult, GatewayError, Publisher> =>
  Effect.flatMap(Effect.service(Publisher), (p) => p.store(bytes, options))
