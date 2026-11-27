/**
 * Parity with `@mysten/walrus` 2.0.1 (§6.2): `Encoder.encode` against
 * `getWasmBindings().encodeBlob` (`walrus/dist/wasm.mjs`) byte for byte —
 * blob id, root hash, metadata bytes, every sliver buffer — and `blobId` /
 * `decode` against `computeMetadata` / `decodePrimarySlivers`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import { Encoder } from "../src/index.ts"
import { bytes, mystenBcs, rng } from "./oracle.ts"

const wasmModule = "../../../node_modules/@mysten/walrus/dist/wasm.mjs"
const { getWasmBindings } = (await import(wasmModule)) as {
  getWasmBindings: (url?: string) => Promise<{
    encodeBlob: (nShards: number, bytes: Uint8Array) => {
      primarySlivers: Array<Uint8Array>
      secondarySlivers: Array<Uint8Array>
      blobId: string
      metadata: { V1: { encoding_type: "RS2"; unencoded_length: number | bigint; hashes: Array<{ primary_hash: { Digest: Array<number> }; secondary_hash: { Digest: Array<number> } }> } }
      rootHash: Uint8Array
    }
    computeMetadata: (nShards: number, bytes: Uint8Array) => { blobId: string; rootHash: Uint8Array; unencodedLength: bigint }
    decodePrimarySlivers: (blobId: string, nShards: number, size: number, slivers: Array<Uint8Array>) => Uint8Array
  }>
}
const mysten = await getWasmBindings()

const scope = Effect.runSync(Scope.make())
const encoder = await Effect.runPromise(Encoder.make().pipe(Scope.provide(scope)))
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

describe("Encoder parity", () => {
  const next = rng(5)
  const cases: Array<readonly [number, number]> = []
  for (const n of [4, 5, 7, 10, 13, 100]) {
    for (const length of [0, 1, 2, 1000, 65_539, next(300_000)]) cases.push([n, length])
  }

  for (const [n, length] of cases) {
    test(`n = ${n}, ${length} bytes`, async () => {
      const blob = bytes(length, n * 1000 + length)
      const theirs = mysten.encodeBlob(n, blob)
      const ours = await run(encoder.encode(n, blob))

      expect(ours.blobId).toBe(theirs.blobId as typeof ours.blobId)
      expect(ours.rootHash).toEqual(theirs.rootHash)
      const v1 = theirs.metadata.V1
      expect(ours.metadata).toEqual(
        mystenBcs.BlobMetadata.serialize({
          V1: {
            encoding_type: v1.encoding_type,
            unencoded_length: BigInt(v1.unencoded_length),
            hashes: v1.hashes.map((h) => ({
              primary_hash: { Digest: new Uint8Array(h.primary_hash.Digest) },
              secondary_hash: { Digest: new Uint8Array(h.secondary_hash.Digest) }
            }))
          }
        }).toBytes()
      )
      expect(ours.primary).toEqual(theirs.primarySlivers)
      expect(ours.secondary).toEqual(theirs.secondarySlivers)

      const meta = mysten.computeMetadata(n, blob)
      expect(await run(encoder.blobId(n, blob))).toEqual({ blobId: meta.blobId as typeof ours.blobId, rootHash: meta.rootHash })

      const decoded = mysten.decodePrimarySlivers(theirs.blobId, n, length, theirs.primarySlivers)
      expect(await run(encoder.decode(n, length, ours.primary))).toEqual(decoded)
      expect(decoded).toEqual(blob)
    })
  }
})
