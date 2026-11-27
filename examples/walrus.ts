/**
 * README examples (Walrus), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Read from "@unconfirmed/walrus/Read"
import * as Walrus from "@unconfirmed/walrus/Walrus"
import * as Write from "@unconfirmed/walrus/Write"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import * as Aggregator from "@unconfirmed/walrus/Aggregator"
import type { BlobId } from "@unconfirmed/walrus/BlobId"
import * as Publisher from "@unconfirmed/walrus/Publisher"
import * as Quilt from "@unconfirmed/walrus/Quilt"
import * as QuiltRead from "@unconfirmed/walrus/QuiltRead"
import * as System from "@unconfirmed/walrus/System"
import * as UploadRelay from "@unconfirmed/walrus/UploadRelay"
import { baseUrl, signer } from "./shared.ts"

declare const blobId: BlobId
declare const entries: ReadonlyArray<Quilt.QuiltEntry>

export const nodes = Effect.gen(function*() {
  // #region readme
  // System, committees, storage nodes and the encoder for one network; needs an HttpClient and a Sui client.
  const layer = Walrus.layer({ network: "testnet" }).pipe(          // or { config: { systemObjectId, stakingObjectId } }
    Layer.provideMerge(SuiGrpc.layer({ baseUrl: "https://fullnode.testnet.sui.io:443" })),
    Layer.provideMerge(FetchHttpClient.layer)
  )

  const bytes = yield* Read.blob(blobId)                            // straight from the storage nodes, verified
  const status = yield* Read.status(blobId)                         // { _tag: "Permanent", endEpoch, isCertified, ... }, f + 1 shards agreeing

  // Write through the nodes: encode, register, upload, certify (two transactions, signed by `signer`).
  const certified = yield* Write.run(bytes, { epochs: 5, deletable: true, executor: Write.viaTx(signer) })
  // { _tag: "Certified", blobId, blobObjectId, certifiedEpoch, endEpoch, deletable, digest }
  // #endregion
})

export const relay = (bytes: Uint8Array) =>
  Effect.gen(function*() {
    // #region readme
    const layer = Layer.mergeAll(
      Walrus.layer({ network: "testnet" }),
      UploadRelay.layer({ host: UploadRelay.TESTNET_HOST, maxTip: 1_000n })   // required; `0n` accepts only relays that want no tip
    ).pipe(Layer.provideMerge(SuiGrpc.layer({ baseUrl })), Layer.provideMerge(FetchHttpClient.layer))
    yield* Write.run(bytes, { epochs: 5, deletable: true, executor: Write.viaTx(signer), via: "relay" })
    // #endregion
  })

export const gatewaysExample = Effect.gen(function*() {
  // #region readme
  const gateways = Layer.mergeAll(
    Aggregator.layer({ url: Aggregator.TESTNET_URL }),
    Publisher.layer({ url: Publisher.TESTNET_URL })            // `headers` for a publisher behind JWT auth
  ).pipe(Layer.provide(FetchHttpClient.layer))
  const bytes = yield* Aggregator.blob(blobId)                 // also byObjectId, patch, byIdentifier
  const result = yield* Publisher.store(bytes, { epochs: 5 })  // NewlyCreated | AlreadyCertified | MarkedInvalid
  const checked = yield* Aggregator.verified(blobId)           // re-derives the id locally: needs Encoder and System
  // #endregion
})

export const quilts = (bytes: Uint8Array) =>
  Effect.gen(function*() {
    // #region readme
    const { nShards } = yield* Effect.flatMap(Effect.service(System.System), (s) => s.state)
    const { quilt, patches } = yield* Effect.fromResult(Quilt.encode(entries, nShards))   // a Result; entries: { identifier, contents, tags? }[]; byte-identical to @mysten/walrus
    const certified = yield* Write.run(quilt, { epochs: 5, deletable: true, attributes: Quilt.ATTRIBUTE, executor: Write.viaTx(signer) })
    const file = yield* QuiltRead.patch(Quilt.patchId(certified.blobId, patches[0]!))   // or QuiltRead.byIdentifier(blobId, "hello.txt")
    // #endregion
    return bytes
  })
