/**
 * Parity with `@mysten/walrus` 2.0.1 `encodeQuilt` / `encodeQuiltPatchId`
 * (`dist/utils/quilts.mjs`, §6.2): the quilt bytes, the index (start and end
 * columns, identifiers, tags) and patch ids, for random entry sets; and
 * Mysten's `QuiltIndexV1` / `QuiltPatchBlobHeader` parse what we write.
 */
import { describe, expect, test } from "bun:test"
import * as Result from "effect/Result"
import * as BlobId from "../src/BlobId.ts"
import * as Quilt from "../src/Quilt.ts"
import { rng } from "./oracle.ts"

const quiltsModule = "../../../node_modules/@mysten/walrus/dist/utils/quilts.mjs"
const bcsModule = "../../../node_modules/@mysten/walrus/dist/utils/bcs.mjs"

interface MystenQuiltBlob {
  contents: Uint8Array
  identifier: string
  tags?: Record<string, string>
}
const mysten = (await import(quiltsModule)) as {
  encodeQuilt: (o: { blobs: Array<MystenQuiltBlob>; numShards: number; encodingType?: string }) => {
    quilt: Uint8Array
    index: { patches: Array<{ startIndex: number; endIndex: number; identifier: string; tags: Record<string, string> }> }
  }
  encodeQuiltPatchId: (id: { quiltId: string; patchId: { version: number; startIndex: number; endIndex: number } }) => string
  parseQuiltPatchId: (id: string) => { quiltId: string; patchId: { version: number; startIndex: number; endIndex: number } }
}
const mystenBcs = (await import(bcsModule)) as {
  QuiltIndexV1: { parse: (b: Uint8Array) => { patches: Array<{ endIndex: number; identifier: string; tags: Record<string, string> }> } }
}

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success: ${JSON.stringify(r.failure)}`)
  return r.success
}

const randomEntries = (next: (max: number) => number, count: number, maxSize: number): Array<Quilt.QuiltEntry> => {
  const ids = new Set<string>()
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./ é"
  while (ids.size < count) {
    let id = ""
    const len = 1 + next(20)
    for (let i = 0; i < len; i++) id += alphabet[next(alphabet.length)]
    id = id.replace(/\s+$/, "")
    if (id.length > 0) ids.add(id)
  }
  return [...ids].map((identifier) => {
    const contents = new Uint8Array(next(maxSize + 1)).map(() => next(256))
    const tagCount = next(4)
    const tags: Record<string, string> = {}
    for (let t = 0; t < tagCount; t++) tags[`k${"x".repeat(next(5))}${next(100)}`] = `v${next(1000)}`
    return tagCount > 0 ? { identifier, contents, tags } : { identifier, contents }
  })
}

const compare = (entries: ReadonlyArray<Quilt.QuiltEntry>, n: number) => {
  const ours = ok(Quilt.encode(entries, n))
  const theirs = mysten.encodeQuilt({ blobs: entries.map((e) => ({ ...e })), numShards: n })
  expect(ours.quilt.length).toBe(theirs.quilt.length)
  expect(Buffer.from(ours.quilt).equals(Buffer.from(theirs.quilt))).toBe(true)
  expect(ours.patches.map((p) => ({ ...p, tags: { ...p.tags } }))).toEqual(
    theirs.index.patches.map((p) => ({ identifier: p.identifier, startIndex: p.startIndex, endIndex: p.endIndex, tags: p.tags }))
  )
  return ours
}

describe("Quilt.encode parity", () => {
  test("random entry sets at n = 4, 7, 10, 100 and 1000", () => {
    const next = rng(9)
    for (const n of [4, 7, 10, 100, 1000]) {
      for (let round = 0; round < 6; round++) {
        const max = Math.min(64, n - Math.floor((n - 1) / 3) - 1)
        compare(randomEntries(next, 1 + next(Math.max(1, Math.min(max, 12))), [0, 10, 300, 5000][round % 4]!), n)
      }
    }
  })

  test("one entry, empty contents, tags whose BCS order differs from string order", () => {
    compare([{ identifier: "only", contents: new Uint8Array(0) }], 10)
    // BCS map order sorts by the key's BCS bytes (length prefix first): "b" before "aa".
    const q = compare([{ identifier: "t", contents: new Uint8Array([1, 2, 3]), tags: { aa: "1", b: "2", c: "3", ab: "4" } }], 10)
    expect(Object.keys(q.patches[0]!.tags)).toEqual(["b", "c", "aa", "ab"])
  })

  test("an index spanning several columns", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      identifier: `${String(i).padStart(3, "0")}-${"x".repeat(600)}`,
      contents: new Uint8Array(4).fill(i)
    }))
    const ours = compare(entries, 10)
    expect(ours.patches[0]!.startIndex).toBeGreaterThan(1)
  })

  test("Mysten parses our index", () => {
    const entries = randomEntries(rng(3), 5, 200)
    const { quilt, patches } = ok(Quilt.encode(entries, 10))
    const l = ok(Quilt.layout(quilt.length, 10))
    const columns = Quilt.columnsOf(quilt, l, 0, ok(Quilt.indexColumns(Quilt.columnsOf(quilt, l, 0, 1), l)))
    const size = new DataView(columns.buffer).getUint32(1, true)
    const parsed = mystenBcs.QuiltIndexV1.parse(columns.subarray(5, 5 + size))
    expect(parsed.patches.map((p) => p.endIndex)).toEqual(patches.map((p) => p.endIndex))
    expect(parsed.patches.map((p) => p.identifier)).toEqual(patches.map((p) => p.identifier))
  })
})

describe("patch ids", () => {
  test("equal Mysten's and round-trip through both parsers", () => {
    const next = rng(5)
    for (let i = 0; i < 50; i++) {
      const quiltId = ok(BlobId.fromBytes(new Uint8Array(32).map(() => next(256))))
      const startIndex = next(65536)
      const endIndex = next(65536)
      const ours = Quilt.patchId(quiltId, { startIndex, endIndex })
      expect(ours).toBe(mysten.encodeQuiltPatchId({ quiltId, patchId: { version: 1, startIndex, endIndex } }))
      expect(mysten.parseQuiltPatchId(ours)).toEqual({ quiltId, patchId: { version: 1, startIndex, endIndex } })
      expect(ok(Quilt.parseId(ours))).toEqual({ _tag: "Patch", quiltId, startIndex, endIndex })
    }
  })
})
