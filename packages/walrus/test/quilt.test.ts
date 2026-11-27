/**
 * Quilts: layout edge cases and decoding (pure), patch ids, and reads against
 * an in-memory network of fake storage nodes (`n = 10`, real WASM): one patch
 * from verified secondary slivers, by identifier, the index, a corrupted or
 * missing column falling back to the full blob, `verify: false`,
 * `from: "blob"`, and the read committee during an epoch change.
 */
import { describe, expect, test } from "bun:test"
import * as Address from "@unconfirmed/sui/Address"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as BlobId from "../src/BlobId.ts"
import * as Committee from "../src/Committee.ts"
import * as Encoder from "../src/Encoder.ts"
import * as Encoding from "../src/Encoding.ts"
import * as Quilt from "../src/Quilt.ts"
import * as QuiltRead from "../src/QuiltRead.ts"
import type * as Read from "../src/Read.ts"
import { fakeNode, type FakeNode, fakeNodes, type Outcome, type Recorded, sliverKey } from "./support.ts"

const N = 10 // rows n − 2f = 4, columns n − f = 7: at most 6 entries
const COLUMNS = 7

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success: ${JSON.stringify(r.failure)}`)
  return r.success
}
const reason = <A>(r: Result.Result<A, { readonly reason: string }>): string => {
  if (Result.isSuccess(r)) throw new Error("expected a failure")
  return r.failure.reason
}

const bytes = (length: number, seed: number) => new Uint8Array(length).map((_, i) => (i * 31 + seed * 17 + 5) & 0xff)

const ENTRIES: ReadonlyArray<Quilt.QuiltEntry> = [
  { identifier: "readme.md", contents: bytes(300, 1), tags: { type: "text/markdown" } },
  { identifier: "a.bin", contents: bytes(1000, 2) },
  { identifier: "z/empty", contents: new Uint8Array(0), tags: { kind: "empty", b: "2" } }
]

// -----------------------------------------------------------------------------
// Pure
// -----------------------------------------------------------------------------

describe("Quilt.encode / decode", () => {
  test("round trip: sorted by identifier, contiguous column runs, tags kept", () => {
    const { quilt, patches } = ok(Quilt.encode(ENTRIES, N))
    expect(patches.map((p) => p.identifier)).toEqual(["a.bin", "readme.md", "z/empty"])
    expect(patches[0]!.startIndex).toBe(1)
    for (let i = 1; i < patches.length; i++) expect(patches[i]!.startIndex).toBe(patches[i - 1]!.endIndex)
    const l = ok(Quilt.layout(quilt.length, N))
    expect(quilt.length).toBe(l.rows * l.columns * l.symbolSize)
    const files = ok(Quilt.decode(quilt, N))
    expect(files).toEqual(
      patches.map((p) => {
        const e = ENTRIES.find((x) => x.identifier === p.identifier)!
        return { ...p, contents: e.contents, tags: e.tags ?? {} }
      })
    )
  })

  test("one entry; the most entries that fit (columns − 1); one too many", () => {
    const one = ok(Quilt.encode([{ identifier: "x", contents: bytes(5, 1) }], N))
    // At the smallest symbol size a column is 8 bytes: the 13-byte index and the 15-byte patch take two each.
    expect(one.patches).toEqual([{ identifier: "x", startIndex: 2, endIndex: 4, tags: {} }])
    const max = Array.from({ length: COLUMNS - 1 }, (_, i) => ({ identifier: `f${i}`, contents: bytes(i * 50, i) }))
    const full = ok(Quilt.encode(max, N))
    expect(full.patches.at(-1)!.endIndex).toBe(COLUMNS)
    expect(ok(Quilt.decode(full.quilt, N)).map((f) => f.contents)).toEqual(max.map((e) => e.contents))
    expect(reason(Quilt.encode([...max, { identifier: "g", contents: new Uint8Array(1) }], N))).toContain("at most 6")
    expect(reason(Quilt.encode([], N))).toContain("at least one")
  })

  test("an index over several columns; the symbol size grows to keep it within 10", () => {
    // n = 100: 34 rows, 67 columns. Long identifiers make the index large.
    const entries = Array.from({ length: 20 }, (_, i) => ({ identifier: `${String(i).padStart(2, "0")}${"i".repeat(1000)}`, contents: bytes(10, i) }))
    const { quilt, patches } = ok(Quilt.encode(entries, 100))
    expect(patches[0]!.startIndex).toBeGreaterThan(1)
    expect(ok(Quilt.decode(quilt, 100)).map((f) => f.identifier)).toEqual(entries.map((e) => e.identifier))
    // n = 4: 2 rows, 3 columns. Two 30 kB identifiers: the index cannot use more than one column here.
    const big = Array.from({ length: 2 }, (_, i) => ({ identifier: `${i}${"j".repeat(30000)}`, contents: new Uint8Array(0) }))
    const small = ok(Quilt.encode(big, 4))
    expect(small.patches.map((p) => [p.startIndex, p.endIndex])).toEqual([[1, 2], [2, 3]])
    expect(ok(Quilt.decode(small.quilt, 4)).map((f) => f.identifier)).toEqual(big.map((e) => e.identifier))
  })

  test("identifiers: duplicates, empty, trailing whitespace, control characters, too long", () => {
    const e = (identifier: string) => ({ identifier, contents: new Uint8Array(1) })
    expect(reason(Quilt.encode([e("a"), e("b"), e("a")], N))).toContain("duplicate")
    expect(reason(Quilt.encode([e("")], N))).toContain("empty")
    expect(reason(Quilt.encode([e("a ")], N))).toContain("trailing whitespace")
    expect(reason(Quilt.encode([e("a ")], N))).toContain("trailing whitespace")
    expect(reason(Quilt.encode([e("a\u0001b")], N))).toContain("control")
    expect(reason(Quilt.encode([e("a\u0085b")], N))).toContain("control")
    expect(reason(Quilt.encode([e("x".repeat(65533))], N))).toContain("BCS bytes")
    expect(Result.isSuccess(Quilt.encode([e(" leading and inner spaces ok")], N))).toBe(true)
  })

  test("too large for the shard count", () => {
    expect(reason(Quilt.encode([{ identifier: "big", contents: new Uint8Array(Encoding.maxBlobSize(N)) }], N))).toContain("symbol size")
  })

  test("decodePatch and decodeIndex reject malformed data", () => {
    const { quilt, patches } = ok(Quilt.encode(ENTRIES, N))
    const l = ok(Quilt.layout(quilt.length, N))
    const p = patches[1]!
    const cols = Quilt.columnsOf(quilt, l, p.startIndex, p.endIndex)
    expect(ok(Quilt.decodePatch(cols)).identifier).toBe("readme.md")
    const badVersion = cols.slice()
    badVersion[0] = 2
    expect(reason(Quilt.decodePatch(badVersion))).toContain("version")
    const overrun = cols.slice()
    new DataView(overrun.buffer).setUint32(1, cols.length, true)
    expect(reason(Quilt.decodePatch(overrun))).toContain("claims")
    expect(reason(Quilt.decodePatch(cols.subarray(0, 3)))).toContain("header")

    const first = Quilt.columnsOf(quilt, l, 0, 1)
    const v2 = first.slice()
    v2[0] = 2
    expect(reason(Quilt.indexColumns(v2, l))).toContain("version")
    const huge = first.slice()
    new DataView(huge.buffer).setUint32(1, 1e9, true)
    expect(reason(Quilt.indexColumns(huge, l))).toContain("exceeds")
    const outOfRange = first.slice()
    // The first patch's end_index is the u16 right after the vector length (one byte here).
    new DataView(outOfRange.buffer).setUint16(6, 99, true)
    expect(reason(Quilt.decodeIndex(outOfRange, l))).toContain("columns")
  })

  test("columnsOf reads past the end of a short blob as zeros", () => {
    const l = ok(Quilt.layout(100, N))
    const cols = Quilt.columnsOf(new Uint8Array(10).fill(7), l, 0, 1)
    expect(cols.length).toBe(l.columnSize)
    expect(cols[0]).toBe(7)
    expect(cols.subarray(l.symbolSize).every((b) => b === 0)).toBe(true)
  })
})

describe("Quilt ids", () => {
  const quiltId = ok(BlobId.fromBytes(new Uint8Array(32).map((_, i) => i * 7)))

  test("patch id round trip; a blob id parses as a blob", () => {
    const id = Quilt.patchId(quiltId, { startIndex: 3, endIndex: 513 })
    expect(id.length).toBe(50)
    expect(ok(Quilt.parseId(id))).toEqual({ _tag: "Patch", quiltId, startIndex: 3, endIndex: 513 })
    expect(ok(Quilt.parseId(quiltId))).toEqual({ _tag: "Blob", blobId: quiltId })
  })

  test("rejects other lengths, versions, alphabets and padding", () => {
    const id = Quilt.patchId(quiltId, { startIndex: 1, endIndex: 2 })
    expect(reason(Quilt.parseId(id.slice(0, 48)))).toContain("bytes")
    expect(reason(Quilt.parseId(`${id}=`))).toContain("base64")
    expect(reason(Quilt.parseId(id.replace(/^./, "+")))).toContain("base64")
    const raw = Buffer.from(id, "base64url")
    raw[32] = 2
    expect(reason(Quilt.parseId(raw.toString("base64url")))).toContain("version")
    expect(reason(Quilt.parseId(""))).toContain("bytes")
  })
})

// -----------------------------------------------------------------------------
// Reads over fake nodes
// -----------------------------------------------------------------------------

const withEncoder = <A, E>(f: (e: Encoder.EncoderService) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(Encoder.make(), f)))

const { quilt: QUILT, patches: PATCHES } = ok(Quilt.encode(ENTRIES, N))
const encoded = await withEncoder((e) => e.encode(N, QUILT))
const QUILT_ID = encoded.blobId
const LAYOUT = ok(Quilt.layout(QUILT.length, N))

const committee = (epoch: number, owners: ReadonlyArray<ReadonlyArray<number>>, prefix = "node"): Committee.Committee => {
  const nodes = owners.map((shards, index): Committee.StorageNode => ({
    index,
    nodeId: Address.normalize(`0x${(index + 1).toString(16)}`),
    name: `${prefix}-${index}`,
    url: `https://${prefix}-${index}.test:9185`,
    publicKey: new Uint8Array(96),
    shards
  }))
  const owner = new Map(nodes.flatMap((n) => n.shards.map((s) => [s, n] as const)))
  return { epoch, nShards: N, nodes, nodeOfShard: (s) => owner.get(s)! }
}
const ONE_EACH = Array.from({ length: N }, (_, i) => [i])

const nodesFor = (c: Committee.Committee, seed: boolean, intercept?: (req: Recorded) => Outcome | undefined) =>
  c.nodes.map((n) => {
    const node = fakeNode({ url: n.url, nShards: N, shards: n.shards, epoch: c.epoch, ...(intercept && { intercept }) })
    if (seed) {
      node.metadata.set(QUILT_ID, encoded.metadata)
      for (const shard of n.shards) {
        const pair = Encoding.pairOfShard(shard, QUILT_ID, N)
        node.slivers.set(sliverKey(QUILT_ID, pair, "primary"), encoded.primary[pair]!)
        node.slivers.set(sliverKey(QUILT_ID, pair, "secondary"), encoded.secondary[pair]!)
      }
    }
    return node
  })

const run = async <A, E>(effect: Effect.Effect<A, E, Read.ReadServices>, active: Committee.ActiveCommittees, nodes: ReadonlyArray<FakeNode>) => {
  const calls = { decode: 0, blobId: 0, sliverRoots: 0 }
  const encoder = Layer.effect(
    Encoder.Encoder,
    Effect.map(Encoder.make(), (s) =>
      Encoder.Encoder.of({
        ...s,
        decode: (...a) => Effect.suspend(() => (calls.decode++, s.decode(...a))),
        blobId: (...a) => Effect.suspend(() => (calls.blobId++, s.blobId(...a))),
        sliverRoots: (...a) => Effect.suspend(() => (calls.sliverRoots++, s.sliverRoots(...a)))
      }))
  )
  const net = fakeNodes(nodes)
  const layer = Layer.mergeAll(Committee.layerFromCommittees(active), net.layer, encoder)
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(layer)))
  return { exit, calls, requests: net.requests }
}
const current = (c: Committee.Committee): Committee.ActiveCommittees => ({ current: c, previous: undefined, transitioning: false })

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`)
  return exit.value
}
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const r = exit.cause.reasons.find((x) => x._tag === "Fail")
  if (!r || r._tag !== "Fail") throw new Error(`expected a typed failure, got ${Cause.pretty(exit.cause)}`)
  return r.error
}

const secondaryPair = (req: Recorded) => {
  const m = /\/slivers\/(\d+)\/secondary$/.exec(req.path)
  return m ? Number(m[1]) : undefined
}
const isSecondary = (req: Recorded) => secondaryPair(req) !== undefined
const isPrimary = (req: Recorded) => /\/slivers\/\d+\/primary$/.test(req.path)
const columnOf = (req: Recorded) => N - 1 - secondaryPair(req)!

/** One symbol byte flipped, three quarters into the column (inside the readme's contents); the header still checks out. */
const corrupt = (b: Uint8Array) => {
  const out = b.slice()
  const dataLength = out.length - 4 - (out.length - 4 > 129 ? 2 : 1)
  out[out.length - 4 - Math.floor(dataLength / 4)]! ^= 0xff
  return out
}

const fileOf = (identifier: string): Quilt.QuiltFile => {
  const e = ENTRIES.find((x) => x.identifier === identifier)!
  return { identifier, tags: e.tags ?? {}, contents: e.contents }
}
const readme = PATCHES.find((p) => p.identifier === "readme.md")!
const README_ID = Quilt.patchId(QUILT_ID, readme)
const noRetry = Schedule.recurs(0)

describe("QuiltRead", () => {
  const c = committee(1, ONE_EACH)

  test("patch: only that patch's columns, verified with one sliverRoots call, no decode", async () => {
    const { exit, calls, requests } = await run(QuiltRead.patch(README_ID), current(c), nodesFor(c, true))
    expect(value(exit)).toEqual(fileOf("readme.md"))
    expect(calls).toEqual({ decode: 0, blobId: 0, sliverRoots: 1 })
    const columns = requests.filter(isSecondary).map(columnOf).sort()
    expect(columns).toEqual(Array.from({ length: readme.endIndex - readme.startIndex }, (_, i) => readme.startIndex + i))
    expect(requests.some(isPrimary)).toBe(false)
  })

  test("each column comes from the node holding its shard", async () => {
    const { exit, requests } = await run(QuiltRead.patch(README_ID), current(c), nodesFor(c, true))
    value(exit)
    for (const req of requests.filter(isSecondary)) {
      const shard = Encoding.shardOfPair(secondaryPair(req)!, QUILT_ID, N)
      expect(req.origin).toBe(new URL(c.nodeOfShard(shard).url).origin)
    }
  })

  test("index: every patch with its id; byIdentifier reads the index then the patch", async () => {
    const idx = await run(QuiltRead.index(QUILT_ID), current(c), nodesFor(c, true))
    expect(value(idx.exit)).toEqual(PATCHES.map((p) => ({ ...p, id: Quilt.patchId(QUILT_ID, p) })))
    expect(idx.calls.sliverRoots).toBe(1)
    expect(idx.requests.filter(isSecondary).map(columnOf)).toEqual([0])

    // The index and the patch columns are verified together: one WASM call.
    const by = await run(QuiltRead.byIdentifier(QUILT_ID, "z/empty"), current(c), nodesFor(c, true))
    expect(value(by.exit)).toEqual(fileOf("z/empty"))
    expect(by.calls).toEqual({ decode: 0, blobId: 0, sliverRoots: 1 })
  })

  test("byIdentifier: a corrupted index or patch column is caught by the joint check and falls back", async () => {
    for (const column of [0, readme.startIndex]) {
      const target = Encoding.pairOfSecondary(column, N)
      const nodes = nodesFor(c, true, (req) =>
        secondaryPair(req) === target
          ? { status: 200, contentType: "application/octet-stream", body: corrupt(encoded.secondary[target]!) }
          : undefined)
      const { exit, calls } = await run(QuiltRead.byIdentifier(QUILT_ID, "readme.md"), current(c), nodes)
      expect(value(exit)).toEqual(fileOf("readme.md"))
      expect(calls.decode).toBe(1) // the verified full read
    }
  })

  test("a corrupted column fails the Merkle check: falls back to a verified full read", async () => {
    const target = Encoding.pairOfSecondary(readme.startIndex, N)
    const nodes = nodesFor(c, true, (req) =>
      secondaryPair(req) === target
        ? { status: 200, contentType: "application/octet-stream", body: corrupt(encoded.secondary[target]!) }
        : undefined)
    const { exit, calls, requests } = await run(QuiltRead.patch(README_ID), current(c), nodes)
    expect(value(exit)).toEqual(fileOf("readme.md"))
    expect(calls).toEqual({ decode: 1, blobId: 1, sliverRoots: 1 })
    expect(requests.some(isPrimary)).toBe(true)
  })

  test("verify: false returns the corrupted column as served (what @mysten/walrus does)", async () => {
    const target = Encoding.pairOfSecondary(readme.startIndex, N)
    const nodes = nodesFor(c, true, (req) =>
      secondaryPair(req) === target
        ? { status: 200, contentType: "application/octet-stream", body: corrupt(encoded.secondary[target]!) }
        : undefined)
    const { exit, calls } = await run(QuiltRead.patch(README_ID, { verify: false }), current(c), nodes)
    const file = value(exit)
    expect(calls).toEqual({ decode: 0, blobId: 0, sliverRoots: 0 })
    expect(file.identifier).toBe("readme.md")
    expect(file.contents).not.toEqual(fileOf("readme.md").contents)
  })

  test("a column whose node fails or sends a malformed sliver falls back", async () => {
    const target = Encoding.pairOfSecondary(readme.startIndex, N)
    for (const outcome of [{ status: 503, body: "" }, { status: 200, contentType: "application/octet-stream", body: new Uint8Array(3) }] as const) {
      const nodes = nodesFor(c, true, (req) => (secondaryPair(req) === target ? outcome : undefined))
      const { exit, calls } = await run(QuiltRead.patch(README_ID, { retry: noRetry }), current(c), nodes)
      expect(value(exit)).toEqual(fileOf("readme.md"))
      expect(calls.decode).toBe(1)
    }
  })

  test("from: blob reads the whole quilt, no secondary slivers", async () => {
    const { exit, calls, requests } = await run(QuiltRead.byIdentifier(QUILT_ID, "a.bin", { from: "blob" }), current(c), nodesFor(c, true))
    expect(value(exit)).toEqual(fileOf("a.bin"))
    expect(requests.some(isSecondary)).toBe(false)
    expect(calls).toEqual({ decode: 1, blobId: 1, sliverRoots: 0 })
  })

  test("QuiltError: unknown identifier, a blob id as a patch id, columns out of range", async () => {
    const unknown = await run(QuiltRead.byIdentifier(QUILT_ID, "nope"), current(c), nodesFor(c, true))
    expect(failure(unknown.exit)).toMatchObject({ _tag: "QuiltError" })
    const blob = await run(QuiltRead.patch(QUILT_ID), current(c), nodesFor(c, true))
    expect(failure(blob.exit)).toMatchObject({ _tag: "QuiltError", reason: expect.stringContaining("blob id") })
    const out = await run(QuiltRead.patch(Quilt.patchId(QUILT_ID, { startIndex: 5, endIndex: COLUMNS + 1 })), current(c), nodesFor(c, true))
    expect(failure(out.exit)).toMatchObject({ _tag: "QuiltError" })
  })

  test("a missing quilt is BlobNotFound; maxSize applies to slivers reads", async () => {
    const missing = await run(QuiltRead.index(QUILT_ID), current(c), nodesFor(c, false))
    expect(failure(missing.exit)).toMatchObject({ _tag: "BlobNotFound" })
    const small = await run(QuiltRead.patch(README_ID, { maxSize: 10 }), current(c), nodesFor(c, true))
    expect(failure(small.exit)).toMatchObject({ _tag: "BlobTooLarge", max: 10 })
  })

  test("EpochChangeSync: columns come from the read committee (previous), not the active one", async () => {
    const previous = committee(4, ONE_EACH, "old")
    const next = committee(5, [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]], "new")
    const nodes = [...nodesFor(previous, true), ...nodesFor(next, false)]
    const { exit, requests } = await run(
      QuiltRead.patch(README_ID, { certifiedEpoch: 4 }),
      { current: next, previous, transitioning: true },
      nodes
    )
    expect(value(exit)).toEqual(fileOf("readme.md"))
    expect(requests.filter(isSecondary).every((r) => r.origin.includes("old-"))).toBe(true)
  })

  test("the layout of the test quilt is what the reads assume", () => {
    expect(LAYOUT.columns).toBe(COLUMNS)
    expect(LAYOUT.columnSize).toBeGreaterThan(100)
    expect(readme.endIndex - readme.startIndex).toBeGreaterThanOrEqual(1)
  })
})
