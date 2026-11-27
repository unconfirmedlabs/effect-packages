/**
 * Parity of our WASM (`@unconfirmed/walrus-wasm`) with `@mysten/walrus` 2.0.1
 * and `@mysten/walrus-wasm` 0.3.1 (§6.2): `Encoder.encode` against
 * `getWasmBindings().encodeBlob` (`walrus/dist/wasm.mjs`) byte for byte —
 * blob id, root hash, metadata bytes, every sliver buffer — and `blobId` /
 * `decode` against `computeMetadata` / `decodePrimarySlivers`, decoding from
 * systematic and from repair slivers. `sliverRoots` (direct per-sliver roots)
 * against the crafted-blob method (W6) run on Mysten's encoder.
 */
import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import { Encoder, Encoding, Messages } from "../src/index.ts"
import { bytes, mystenBcs, rng, wasmEncode } from "./oracle.ts"

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

/** Pick `k` distinct indices in `[0, max)`. */
const pick = (next: (max: number) => number, k: number, max: number): Array<number> => {
  const out = new Set<number>()
  while (out.size < k) out.add(next(max))
  return [...out]
}

describe("decode parity from any n - 2f slivers (systematic and repair)", () => {
  const next = rng(17)
  for (const [n, length] of [[10, 5000], [13, 77_777], [100, 300_001]] as const) {
    test(`n = ${n}, ${length} bytes`, async () => {
      const blob = bytes(length, n + length)
      const theirs = mysten.encodeBlob(n, blob)
      const need = Encoding.sourceSymbols(n).primary
      for (const chosen of [
        Array.from({ length: need }, (_, i) => i), // systematic
        Array.from({ length: need }, (_, i) => n - 1 - i), // repair only
        pick(next, need, n) // mixed
      ]) {
        const slivers = chosen.map((p) => theirs.primarySlivers[p]!)
        const expected = mysten.decodePrimarySlivers(theirs.blobId, n, length, slivers)
        expect(await run(encoder.decode(n, length, slivers))).toEqual(expected)
        expect(expected).toEqual(blob)
      }
    })
  }
})

/**
 * The crafted-blob method (W6), as `Encoder.sliverRoots` did it on
 * `@mysten/walrus-wasm`: encode a blob of exactly `rows × columns ×
 * symbolSize` bytes whose first rows (primary) or columns (secondary) are the
 * slivers, and read their hashes from the metadata.
 */
const craftedRoots = (n: number, axis: "primary" | "secondary", symbolSize: number, slivers: ReadonlyArray<Uint8Array>) => {
  const { primary: rows, secondary: columns } = Encoding.sourceSymbols(n)
  const out: Array<Uint8Array> = []
  const limit = axis === "primary" ? rows : columns
  for (let at = 0; at < slivers.length; at += limit) {
    const batch = slivers.slice(at, at + limit).map((s) => Result.getOrThrow(Messages.parseSliver(s)).data)
    const blob = new Uint8Array(rows * columns * symbolSize)
    const rowBytes = columns * symbolSize
    if (axis === "primary") batch.forEach((d, r) => blob.set(d, r * rowBytes))
    else {
      batch.forEach((d, c) => {
        for (let r = 0; r < rows; r++) blob.set(d.subarray(r * symbolSize, (r + 1) * symbolSize), r * rowBytes + c * symbolSize)
      })
    }
    const hashes = wasmEncode(n, blob).metadata.metadata.V1.hashes
    batch.forEach((_, i) =>
      out.push(new Uint8Array(axis === "primary" ? hashes[i]!.primary_hash.Digest : hashes[n - 1 - i]!.secondary_hash.Digest))
    )
  }
  return out
}

describe("sliverRoots parity with the crafted-blob method", () => {
  const next = rng(23)
  for (const [n, length] of [[4, 10], [10, 1], [10, 2000], [13, 100_000], [100, 1_000_000]] as const) {
    test(`n = ${n}, ${length} bytes`, async () => {
      const blob = bytes(length, 7 * n + length)
      const theirs = mysten.encodeBlob(n, blob)
      const { symbolSize } = Encoding.sliverBytes(length, n)
      const flip = (s: Uint8Array) => {
        const copy = s.slice()
        const { data } = Result.getOrThrow(Messages.parseSliver(copy))
        data[next(data.length)]! ^= 0xa5
        return copy
      }
      for (const axis of ["primary", "secondary"] as const) {
        const all = axis === "primary" ? theirs.primarySlivers : theirs.secondarySlivers
        // systematic and repair pairs mixed, some corrupted
        const slivers = pick(next, Math.min(n, 12), n).map((p, i) => (i % 3 === 2 ? flip(all[p]!) : all[p]!))
        const ours = await run(encoder.sliverRoots(n, axis, symbolSize, slivers))
        expect(ours).toEqual(craftedRoots(n, axis, symbolSize, slivers))
      }
    })
  }
})

describe("n = 1000 (slow)", () => {
  test("encode, blobId, sliverRoots and decode from repair slivers match Mysten", async () => {
    const n = 1000
    const blob = bytes(200_000, 99)
    const theirs = mysten.encodeBlob(n, blob)
    const ours = await run(encoder.encode(n, blob))
    expect(ours.blobId).toBe(theirs.blobId as typeof ours.blobId)
    expect(ours.primary).toEqual(theirs.primarySlivers)
    expect(ours.secondary).toEqual(theirs.secondarySlivers)
    expect((await run(encoder.blobId(n, blob))).blobId).toBe(ours.blobId)
    const { symbolSize } = Encoding.sliverBytes(blob.length, n)
    const chosen = [0, 1, 500, 998, 999]
    const slivers = chosen.map((p) => theirs.secondarySlivers[p]!)
    expect(await run(encoder.sliverRoots(n, "secondary", symbolSize, slivers))).toEqual(
      craftedRoots(n, "secondary", symbolSize, slivers)
    )
    const need = Encoding.sourceSymbols(n).primary
    const repair = theirs.primarySlivers.slice(n - need)
    expect(await run(encoder.decode(n, blob.length, repair))).toEqual(blob)
  }, 120_000)
})
