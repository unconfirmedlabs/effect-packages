/**
 * A Walrus aggregator (§4.10): an HTTP daemon that reads blobs from the
 * storage nodes and serves the bytes. For apps that trust a gateway; it ships
 * no WASM and no quorum code. `verified` checks the bytes against the blob id
 * locally, which needs the `Encoder` (WASM) and the shard count (`System`).
 *
 *   Aggregator.layer({ url: Aggregator.TESTNET_URL }).pipe(Layer.provide(FetchHttpClient.layer))
 *   const bytes = yield* Aggregator.blob(blobId)
 *
 * Routes: `crates/walrus-service/src/client/daemon/routes.rs` (`BLOB_GET_ENDPOINT`
 * and the three after it). Every outcome is a typed `GatewayError`: an
 * unknown blob is `GatewayError { status: 404 }`, no answer has no `status`.
 */
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type { BlobId } from "./BlobId.ts"
import { Encoder } from "./Encoder.ts"
import { type EncoderError, type GatewayError, InconsistentBlob } from "./Errors.ts"
import { type GatewayOptions, makeCall } from "./internal/gateway.ts"
import { System, type SystemError } from "./System.ts"

export interface AggregatorService {
  /** The base URL, without a trailing slash. */
  readonly url: string
  /** `GET /v1/blobs/{blobId}`. */
  readonly blob: (blobId: BlobId) => Effect.Effect<Uint8Array, GatewayError>
  /** `GET /v1/blobs/by-object-id/{objectId}`: the blob a `Blob` object holds. */
  readonly byObjectId: (objectId: Address.Address) => Effect.Effect<Uint8Array, GatewayError>
  /** `GET /v1/blobs/by-quilt-patch-id/{patchId}`: one file of a quilt. */
  readonly patch: (patchId: string) => Effect.Effect<Uint8Array, GatewayError>
  /** `GET /v1/blobs/by-quilt-id/{quiltId}/{identifier}`: one file of a quilt, by name. */
  readonly byIdentifier: (quiltId: BlobId, identifier: string) => Effect.Effect<Uint8Array, GatewayError>
}

export class Aggregator extends Context.Service<Aggregator, AggregatorService>()("@unconfirmed/effect-walrus/Aggregator") {}

export interface AggregatorOptions extends GatewayOptions {
  /** Default 60 seconds: the aggregator reads the blob from the nodes before it answers. */
  readonly requestTimeout?: Duration.Input
}

export const TESTNET_URL = "https://aggregator.walrus-testnet.walrus.space"
export const MAINNET_URL = "https://aggregator.walrus-mainnet.walrus.space"

const OCTETS = "application/octet-stream"

export const layer = (options: AggregatorOptions): Layer.Layer<Aggregator, never, HttpClient.HttpClient> =>
  Layer.effect(
    Aggregator,
    Effect.map(Effect.service(HttpClient.HttpClient), (http) => {
      const call = makeCall(http, options, Duration.seconds(60), "Aggregator")
      const get = (operation: string, path: string) =>
        Effect.map(call(operation, HttpClientRequest.accept(HttpClientRequest.get(path), OCTETS)), (r) => r.body)
      const segment = encodeURIComponent
      return Aggregator.of({
        url: options.url.replace(/\/+$/, ""),
        blob: (blobId) => get("blob", `/v1/blobs/${segment(blobId)}`),
        byObjectId: (objectId) => get("byObjectId", `/v1/blobs/by-object-id/${Address.normalize(objectId)}`),
        patch: (patchId) => get("patch", `/v1/blobs/by-quilt-patch-id/${segment(patchId)}`),
        byIdentifier: (quiltId, identifier) =>
          get("byIdentifier", `/v1/blobs/by-quilt-id/${segment(quiltId)}/${segment(identifier)}`)
      })
    })
  )

/** `GET /v1/blobs/{blobId}` through the `Aggregator` in context. */
export const blob = (blobId: BlobId): Effect.Effect<Uint8Array, GatewayError, Aggregator> =>
  Effect.flatMap(Effect.service(Aggregator), (a) => a.blob(blobId))

/** `GET /v1/blobs/by-object-id/{objectId}` through the `Aggregator` in context. */
export const byObjectId = (objectId: Address.Address): Effect.Effect<Uint8Array, GatewayError, Aggregator> =>
  Effect.flatMap(Effect.service(Aggregator), (a) => a.byObjectId(objectId))

/** `GET /v1/blobs/by-quilt-patch-id/{patchId}` through the `Aggregator` in context. */
export const patch = (patchId: string): Effect.Effect<Uint8Array, GatewayError, Aggregator> =>
  Effect.flatMap(Effect.service(Aggregator), (a) => a.patch(patchId))

/** `GET /v1/blobs/by-quilt-id/{quiltId}/{identifier}` through the `Aggregator` in context. */
export const byIdentifier = (quiltId: BlobId, identifier: string): Effect.Effect<Uint8Array, GatewayError, Aggregator> =>
  Effect.flatMap(Effect.service(Aggregator), (a) => a.byIdentifier(quiltId, identifier))

/**
 * The aggregator's bytes for `blobId`, checked locally: the blob id is derived
 * again from the bytes (`Encoder.blobId` with the system's shard count) and
 * must equal the one asked for, else `InconsistentBlob`. Costs one WASM call
 * (about 2.5 s at `n = 1000`, W5) and no storage-node traffic.
 */
export const verified = (
  blobId: BlobId
): Effect.Effect<Uint8Array, GatewayError | InconsistentBlob | EncoderError | SystemError, Aggregator | Encoder | System> =>
  Effect.gen(function*() {
    const bytes = yield* blob(blobId)
    const state = yield* (yield* Effect.service(System)).state
    const derived = yield* (yield* Effect.service(Encoder)).blobId(state.nShards, bytes)
    if (derived.blobId !== blobId) return yield* new InconsistentBlob({ blobId })
    return bytes
  })
