/**
 * The read path against an in-memory network of fake storage nodes (`n = 10`,
 * real WASM): happy path, the `n − 2f` boundary, blame of a lying sliver, a
 * wrongly encoded blob, 404 / 451 quorums, mixed failures, lying metadata,
 * the previous committee during `EpochChangeSync`, `maxSize`, committee
 * refresh, `status` agreement, and (under `TestClock`) a hung node and the
 * default retry schedule.
 */
import { describe, expect, test } from "bun:test"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Objects from "@unconfirmed/effect-sui/Objects"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Random from "effect/Random"
import * as Schedule from "effect/Schedule"
import { TestClock } from "effect/testing"
import * as BlobId from "../src/BlobId.ts"
import * as Committee from "../src/Committee.ts"
import * as Encoder from "../src/Encoder.ts"
import * as Encoding from "../src/Encoding.ts"
import * as Merkle from "../src/Merkle.ts"
import * as Messages from "../src/Messages.ts"
import * as Read from "../src/Read.ts"
import { fakeNode, type FakeNode, fakeNodes, nodeErrors, type Outcome, type Recorded, sliverKey } from "./support.ts"

const N = 10 // f = 3: metadata needs 1 shard, slivers n − 2f = 4, 404/451 quorum 2f + 1 = 7, status f + 1 = 4 of 7
const NEED = 4
const noRetry = Schedule.recurs(0)

// -----------------------------------------------------------------------------
// World
// -----------------------------------------------------------------------------

const withEncoder = <A, E>(f: (e: Encoder.EncoderService) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(Encoder.make(), f)))

const BLOB = new Uint8Array(1000).map((_, i) => (i * 7 + 3) & 0xff)
const encoded = await withEncoder((e) => e.encode(N, BLOB))

const verified = (enc: Encoder.EncodedBlob) => {
  const response = new Uint8Array(32 + enc.metadata.length)
  response.set(BlobId.toBytes(enc.blobId))
  response.set(enc.metadata, 32)
  const r = Messages.verifyMetadata(enc.blobId, response, N)
  if (r._tag === "Failure") throw new Error(r.failure.reason)
  return r.success
}

const hostOf = (prefix: string, i: number) => `https://${prefix}-${i}.test:9185`

/** A committee over `owners[i]` = the shards of node `i`. */
const committee = (epoch: number, owners: ReadonlyArray<ReadonlyArray<number>>, prefix = "node"): Committee.Committee => {
  const nodes = owners.map((shards, index): Committee.StorageNode => ({
    index,
    nodeId: Address.normalize(`0x${(index + 1).toString(16)}`),
    name: `${prefix}-${index}`,
    url: hostOf(prefix, index),
    publicKey: new Uint8Array(96),
    shards
  }))
  const owner = new Map(nodes.flatMap((n) => n.shards.map((s) => [s, n] as const)))
  return {
    epoch,
    nShards: N,
    nodes,
    nodeOfShard: (s) => {
      const n = owner.get(s)
      if (!n) throw new RangeError(`no node holds shard ${s}`)
      return n
    }
  }
}

const ONE_EACH = Array.from({ length: N }, (_, i) => [i])

interface Blob {
  readonly blobId: BlobId.BlobId
  readonly metadata: Uint8Array
  readonly primary: ReadonlyArray<Uint8Array>
  readonly secondary: ReadonlyArray<Uint8Array>
}

/** Fake nodes for `c`, each holding `blob`'s slivers of its shards (unless `seed` is false). */
const nodesFor = (
  c: Committee.Committee,
  blob: Blob | undefined,
  intercept?: (i: number, req: Recorded, node: FakeNode) => Outcome | undefined
) =>
  c.nodes.map((n, i) => {
    const node = fakeNode({
      url: n.url,
      nShards: N,
      shards: n.shards,
      epoch: c.epoch,
      ...(intercept && { intercept: (req, self) => intercept(i, req, self) })
    })
    if (blob) {
      // Certified in the committee's epoch: a failed read keeps its own error instead of becoming BlobNotFound.
      node.statuses.set(blob.blobId, permanent(c.epoch))
      node.metadata.set(blob.blobId, blob.metadata)
      for (const shard of n.shards) {
        const pair = Encoding.pairOfShard(shard, blob.blobId, N)
        node.slivers.set(sliverKey(blob.blobId, pair, "primary"), blob.primary[pair]!)
        node.slivers.set(sliverKey(blob.blobId, pair, "secondary"), blob.secondary[pair]!)
      }
    }
    return node
  })

/** Counts WASM calls by name. */
const countingEncoder = () => {
  const calls = { decode: 0, blobId: 0, sliverRoots: 0 }
  const layer = Layer.effect(
    Encoder.Encoder,
    Effect.map(Encoder.make(), (s) =>
      Encoder.Encoder.of({
        ...s,
        decode: (...a) => Effect.suspend(() => (calls.decode++, s.decode(...a))),
        blobId: (...a) => Effect.suspend(() => (calls.blobId++, s.blobId(...a))),
        sliverRoots: (...a) => Effect.suspend(() => (calls.sliverRoots++, s.sliverRoots(...a)))
      }))
  )
  return { calls, layer }
}

const active = (current: Committee.Committee, previous?: Committee.Committee, transitioning = false): Committee.ActiveCommittees => ({
  current,
  previous,
  transitioning
})

const servicesFor = (committees: Committee.ActiveCommittees | Layer.Layer<Committee.Committees>, nodes: ReadonlyArray<FakeNode>) => {
  const encoder = countingEncoder()
  const net = fakeNodes(nodes)
  const layer = Layer.mergeAll(
    "current" in committees ? Committee.layerFromCommittees(committees) : committees,
    net.layer,
    encoder.layer
  )
  return { layer, calls: encoder.calls, requests: net.requests }
}

const run = <A, E>(
  effect: Effect.Effect<A, E, Read.ReadServices>,
  committees: Committee.ActiveCommittees | Layer.Layer<Committee.Committees>,
  nodes: ReadonlyArray<FakeNode>
) => {
  const s = servicesFor(committees, nodes)
  return Effect.runPromiseExit(effect.pipe(Effect.provide(s.layer))).then((exit) => ({ exit, ...s }))
}

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`)
  return exit.value
}
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (!reason || reason._tag !== "Fail") throw new Error(`expected a typed failure, got ${Cause.pretty(exit.cause)}`)
  return reason.error
}

const isSliver = (req: Recorded) => /\/slivers\/\d+\/primary$/.test(req.path)
const isMetadata = (req: Recorded) => /\/metadata$/.test(req.path)
const sliverPair = (req: Recorded) => Number(/\/slivers\/(\d+)\//.exec(req.path)![1])

const unavailable: Outcome = { status: 503, body: "" }

/** The same sliver with one data byte flipped: the header still checks out. */
const corrupt = (bytes: Uint8Array) => {
  const out = bytes.slice()
  out[out.length - 5]! ^= 0xff
  return out
}

const permanent = (initialCertifiedEpoch: number | null, endEpoch = 50) => ({
  permanent: {
    endEpoch,
    isCertified: initialCertifiedEpoch !== null,
    statusEvent: { txDigest: "4Cs5bMDqzd6m4ZHN3C3QJzmWv5mbVzv7ZnPhR2F1ZT1b", eventSeq: "0" },
    deletableCounts: { count_deletable_total: 0, count_deletable_certified: 0 },
    initialCertifiedEpoch
  }
})

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Read.blob", () => {
  test("happy path: strict and skip return the blob; metadata verifies", async () => {
    const c = committee(1, ONE_EACH)
    const nodes = nodesFor(c, encoded)
    const strict = await run(Read.blob(encoded.blobId), active(c), nodes)
    expect(value(strict.exit)).toEqual(BLOB)
    expect(strict.calls).toEqual({ decode: 1, blobId: 1, sliverRoots: 0 })
    expect(strict.requests.filter(isSliver).length).toBe(NEED)

    const skip = await run(Read.blob(encoded.blobId, { consistency: "skip" }), active(c), nodes)
    expect(value(skip.exit)).toEqual(BLOB)
    expect(skip.calls).toEqual({ decode: 1, blobId: 0, sliverRoots: 0 })

    const md = await run(Read.metadata(encoded.blobId), active(c), nodes)
    expect(value(md.exit).unencodedLength).toBe(BLOB.length)
    expect(value(md.exit).bytes).toEqual(encoded.metadata)
  })

  test("exactly n − 2f shards answer", async () => {
    const c = committee(1, ONE_EACH)
    const kinds: Array<Outcome | undefined> = [
      unavailable,
      "network-error",
      { status: 404, body: "" },
      unavailable,
      "network-error",
      { status: 429, body: "" }
    ]
    const nodes = nodesFor(c, encoded, (i, req) => isSliver(req) ? kinds[i] : undefined)
    const { exit, requests } = await run(Read.blob(encoded.blobId, { retry: noRetry }), active(c), nodes)
    expect(value(exit)).toEqual(BLOB)
    expect(requests.filter(isSliver).length).toBeGreaterThanOrEqual(NEED)
  })

  test("a node sending corrupted slivers is blamed and replaced", async () => {
    // Node 0 holds 6 shards and corrupts every sliver; four honest nodes hold one each.
    const c = committee(1, [[0, 1, 2, 3, 4, 5], [6], [7], [8], [9]])
    const nodes = nodesFor(c, encoded, (i, req, self) => {
      if (i !== 0 || !isSliver(req)) return undefined
      const bytes = self.slivers.get(sliverKey(encoded.blobId, sliverPair(req), "primary"))!
      return { status: 200, contentType: "application/octet-stream", body: corrupt(bytes) }
    })
    const { exit, calls, requests } = await run(Read.blob(encoded.blobId).pipe(Random.withSeed("blame")), active(c), nodes)
    expect(value(exit)).toEqual(BLOB)
    expect(calls).toEqual({ decode: 2, blobId: 2, sliverRoots: 1 })
    // After the blame, node 0 is asked nothing more.
    const blamedAt = requests.findLastIndex((r) => r.origin === new URL(c.nodes[0]!.url).origin)
    const honestAfter = requests.slice(blamedAt + 1).filter(isSliver)
    expect(honestAfter.length).toBeGreaterThan(0)
  })

  test("a lying node keeps lying: three blame rounds, then NotEnoughSlivers", async () => {
    // Every node corrupts its slivers: each round blames the slivers it used.
    const c = committee(1, ONE_EACH)
    const nodes = nodesFor(c, encoded, (_, req, self) => {
      if (!isSliver(req)) return undefined
      const bytes = self.slivers.get(sliverKey(encoded.blobId, sliverPair(req), "primary"))!
      return { status: 200, contentType: "application/octet-stream", body: corrupt(bytes) }
    })
    const { exit, calls } = await run(Read.blob(encoded.blobId), active(c), nodes)
    const e = failure(exit)
    expect(e._tag).toBe("NotEnoughSlivers")
    if (e._tag !== "NotEnoughSlivers") return
    expect(e.required).toBe(NEED)
    expect(e.failures.every((f) => f.kind === "Malformed")).toBe(true)
    // Round 1 used 4 (or more: answers that arrive with the deciding one are kept), round 2 as many again,
    // round 3 is short: NotEnoughSlivers from the quorum after two decodes. More than 4 slivers in a round
    // take a second `sliverRoots` call.
    expect(calls.decode).toBe(2)
    expect(calls.sliverRoots).toBeGreaterThanOrEqual(2)
  })

  test("a wrongly encoded blob is InconsistentBlob, not a node's fault", async () => {
    // Replace primary sliver 0 by garbage and give the metadata its real root: every sliver matches its hash,
    // but they are not one codeword.
    const md = verified(encoded)
    const garbage = corrupt(encoded.primary[0]!)
    const { symbolSize } = Encoding.sliverBytes(BLOB.length, N)
    const [root] = await withEncoder((e) => e.sliverRoots(N, "primary", symbolSize, [garbage]))
    const hashes = md.hashes.map((h, i) => (i === 0 ? { ...h, primary: root! } : h))
    const metadata = Bcs.encodeSync(Messages.BlobMetadata)({
      _tag: "V1",
      encodingType: { _tag: "RS2" },
      unencodedLength: BigInt(BLOB.length),
      hashes: hashes.map((h) => ({ primaryHash: { _tag: "Digest", value: h.primary }, secondaryHash: { _tag: "Digest", value: h.secondary } }))
    })
    const leaves = hashes.map((h) => new Uint8Array([...h.primary, ...h.secondary]))
    const blobId = BlobId.derive(Encoding.RS2, BigInt(BLOB.length), Merkle.root(leaves))
    const bad: Blob = { blobId, metadata, primary: [garbage, ...encoded.primary.slice(1)], secondary: encoded.secondary }

    const c = committee(1, ONE_EACH)
    const { exit, calls } = await run(Read.blob(blobId), active(c), nodesFor(c, bad))
    expect(failure(exit)._tag).toBe("InconsistentBlob")
    expect(calls).toEqual({ decode: 1, blobId: 1, sliverRoots: 1 })

    // Skip trusts the slivers.
    const skip = await run(Read.blob(blobId, { consistency: "skip" }), active(c), nodesFor(c, bad))
    expect(Exit.isSuccess(skip.exit)).toBe(true)
  })

  test("a quorum of 404s is BlobNotFound (metadata or slivers)", async () => {
    const c = committee(1, ONE_EACH)
    const none = await run(Read.blob(encoded.blobId), active(c), nodesFor(c, undefined))
    expect(failure(none.exit)._tag).toBe("BlobNotFound")
    expect(failure(none.exit)).toEqual(expect.objectContaining({ blobId: encoded.blobId }))

    // Metadata everywhere, slivers lost on 7 nodes.
    const nodes = nodesFor(c, encoded, (i, req) => (isSliver(req) && i < 7 ? { status: 404, body: "" } : undefined))
    const lost = await run(Read.blob(encoded.blobId), active(c), nodes)
    expect(failure(lost.exit)._tag).toBe("BlobNotFound")
  })

  test("2f + 1 not-found weight ends the metadata search without waiting for the rest (TestClock)", async () => {
    const c = committee(1, ONE_EACH)
    const nodes = nodesFor(c, undefined, (i) => (i >= 8 ? "hang" : undefined)) // at most two of three lanes stuck
    const s = servicesFor(active(c), nodes)
    const exit = await Effect.runPromise(
      Effect.exit(Read.blob(encoded.blobId)).pipe(Effect.provide(Layer.merge(s.layer, TestClock.layer())))
    )
    expect(failure(exit)._tag).toBe("BlobNotFound")
  })

  test("a quorum of 451s is BlobBlocked", async () => {
    const c = committee(1, ONE_EACH)
    const nodes = nodesFor(c, encoded)
    for (const n of nodes.slice(0, 8)) n.blocked.add(encoded.blobId)
    const { exit } = await run(Read.blob(encoded.blobId), active(c), nodes)
    expect(failure(exit)._tag).toBe("BlobBlocked")
  })

  test("mixed failures: NotEnoughSlivers with every failing node", async () => {
    const c = committee(1, ONE_EACH)
    const outcomes: Array<Outcome | undefined> = [
      { status: 404, body: "" },
      { status: 404, body: "" },
      { status: 404, body: "" },
      unavailable,
      unavailable,
      "network-error",
      "network-error"
    ]
    const nodes = nodesFor(c, encoded, (i, req) => (isSliver(req) ? outcomes[i] : undefined))
    const { exit } = await run(Read.blob(encoded.blobId, { retry: noRetry }).pipe(Random.withSeed("mixed")), active(c), nodes)
    const e = failure(exit)
    expect(e._tag).toBe("NotEnoughSlivers")
    if (e._tag !== "NotEnoughSlivers") return
    expect(e.required).toBe(NEED)
    expect(e.weight).toBeLessThan(NEED)
    const byNode = new Map(e.failures.map((f) => [f.node, f]))
    for (let i = 0; i < 7; i++) {
      const f = byNode.get(hostOf("node", i))!
      expect(f.weight).toBe(1)
      expect(f.kind).toBe(i < 3 ? "NotFound" : "Unavailable")
    }
    expect(e.failures.length).toBe(7)
  })

  test("metadata from lying nodes is rejected and an honest node's is used", async () => {
    const c = committee(1, ONE_EACH)
    const other = await withEncoder((e) => e.encode(N, new Uint8Array([1, 2, 3])))
    const nodes = nodesFor(c, encoded, (i, req, self) => {
      if (i === 9 || !isMetadata(req)) return undefined
      if (i % 2 === 0) {
        // Another blob's metadata, under our id.
        return { status: 200, contentType: "application/octet-stream", body: new Uint8Array([...BlobId.toBytes(encoded.blobId), ...other.metadata]) }
      }
      const md = self.metadata.get(encoded.blobId)!
      const flipped = md.slice()
      flipped[flipped.length - 1]! ^= 1 // a flipped hash
      return { status: 200, contentType: "application/octet-stream", body: new Uint8Array([...BlobId.toBytes(encoded.blobId), ...flipped]) }
    })
    const { exit, requests } = await run(Read.blob(encoded.blobId), active(c), nodes)
    expect(value(exit)).toEqual(BLOB)
    expect(requests.filter(isMetadata).length).toBeGreaterThan(1)
  })

  test("maxSize refuses before any sliver is fetched", async () => {
    const c = committee(1, ONE_EACH)
    const { exit, requests } = await run(Read.blob(encoded.blobId, { maxSize: 999 }), active(c), nodesFor(c, encoded))
    expect(failure(exit)).toEqual(expect.objectContaining({ _tag: "BlobTooLarge", size: BLOB.length, max: 999 }))
    expect(requests.filter(isSliver).length).toBe(0)
    const ok = await run(Read.blob(encoded.blobId, { maxSize: 1000 }), active(c), nodesFor(c, encoded))
    expect(value(ok.exit)).toEqual(BLOB)
  })
})

describe("epoch change", () => {
  const previous = committee(4, ONE_EACH, "old")
  const current = committee(5, [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]], "new")

  test("EpochChangeSync: a blob certified earlier is read from the previous committee", async () => {
    const oldNodes = nodesFor(previous, encoded)
    const newNodes = nodesFor(current, undefined) // shards still moving: nothing yet
    for (const n of newNodes) n.statuses.set(encoded.blobId, permanent(3))
    const { exit, requests } = await run(Read.blob(encoded.blobId), active(current, previous, true), [...oldNodes, ...newNodes])
    expect(value(exit)).toEqual(BLOB)
    expect(requests.filter((r) => r.path.endsWith("/status")).every((r) => r.origin.includes("new-"))).toBe(true)
    expect(requests.filter(isSliver).every((r) => r.origin.includes("old-"))).toBe(true)
  })

  test("certifiedEpoch skips the status lookup", async () => {
    const nodes = [...nodesFor(previous, encoded), ...nodesFor(current, undefined)]
    const { exit, requests } = await run(Read.blob(encoded.blobId, { certifiedEpoch: 4 }), active(current, previous, true), nodes)
    expect(value(exit)).toEqual(BLOB)
    expect(requests.some((r) => r.path.endsWith("/status"))).toBe(false)
  })

  test("not certified during EpochChangeSync: BlobNotFound; marked invalid: InvalidBlob", async () => {
    const nodes = nodesFor(current, encoded)
    for (const n of nodes) n.statuses.set(encoded.blobId, "nonexistent")
    const missing = await run(Read.blob(encoded.blobId), active(current, previous, true), nodes)
    expect(failure(missing.exit)._tag).toBe("BlobNotFound")
    for (const n of nodes) n.statuses.set(encoded.blobId, { invalid: { event: { txDigest: "4Cs5bMDqzd6m4ZHN3C3QJzmWv5mbVzv7ZnPhR2F1ZT1b", eventSeq: "1" } } })
    const invalid = await run(Read.blob(encoded.blobId), active(current, previous, true), nodes)
    expect(failure(invalid.exit)._tag).toBe("InvalidBlob")
  })

  test("certified after our epoch: refresh once, then BehindCurrentEpoch", async () => {
    const { exit } = await run(Read.blob(encoded.blobId, { certifiedEpoch: 6 }), active(current), nodesFor(current, encoded))
    expect(failure(exit)).toEqual(expect.objectContaining({ _tag: "BehindCurrentEpoch", clientEpoch: 5, certifiedEpoch: 6 }))
  })

  test("a failed read refreshes the committees and retries when the epoch moved", async () => {
    let refreshes = 0
    const before = active(previous)
    const after = active(current)
    const committees = Layer.succeed(
      Committee.Committees,
      Committee.Committees.of({
        get: Effect.succeed(before),
        refresh: Effect.sync(() => (refreshes++, after))
      })
    )
    // The old committee is gone (unreachable); the new one has the blob.
    const { exit } = await run(Read.blob(encoded.blobId, { retry: noRetry }), committees, nodesFor(current, encoded))
    expect(value(exit)).toEqual(BLOB)
    expect(refreshes).toBe(1)

    // Unchanged after the refresh: the original error.
    refreshes = 0
    const stuck = Layer.succeed(
      Committee.Committees,
      Committee.Committees.of({ get: Effect.succeed(before), refresh: Effect.sync(() => (refreshes++, before)) })
    )
    const failed = await run(Read.blob(encoded.blobId, { retry: noRetry }), stuck, nodesFor(current, encoded))
    expect(failure(failed.exit)._tag).toBe("NoMetadata")
    expect(refreshes).toBe(1)
  })
})

describe("Read.status", () => {
  const c = committee(5, [[0, 1, 2], [3, 4], [5, 6], [7], [8], [9]])

  test("the latest status wins among those with f + 1 weight", async () => {
    // Weights 2, 2, 2, 2, 1, 1. Nodes 0-1 report an older end epoch, the rest a newer one. In completion
    // order the older status reaches f + 1 = 4 first, but the newer one has 4 too once 2f + 1 = 7 have
    // answered, and the later status (Status.order) wins.
    const pairs = committee(5, [[0, 1], [2, 3], [4, 5], [6, 7], [8], [9]])
    const nodes = nodesFor(pairs, undefined)
    nodes.forEach((n, i) => n.statuses.set(encoded.blobId, permanent(5, i < 2 ? 40 : 60)))
    const { exit } = await run(Read.status(encoded.blobId), active(pairs), nodes)
    expect(value(exit)).toEqual(expect.objectContaining({ _tag: "Permanent", endEpoch: 60 }))
  })

  test("split answers are retried, then StatusUnverified with every group (TestClock)", async () => {
    const nodes = nodesFor(c, undefined)
    // Weights 3, 2, 2, 1, 1, 1: no answer reaches f + 1 = 4.
    const answers = [permanent(5, 40), permanent(5, 41), permanent(5, 42), permanent(5, 43), "nonexistent", permanent(null)]
    nodes.forEach((n, i) => n.statuses.set(encoded.blobId, answers[i]))
    const s = servicesFor(active(c), nodes)
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.exit(Read.status(encoded.blobId)))
        for (let i = 0; i < 10; i++) yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.merge(s.layer, TestClock.layer())))
    )
    const e = failure(exit)
    expect(e._tag).toBe("StatusUnverified")
    if (e._tag !== "StatusUnverified") return
    expect(e.groups.map((g) => g.weight).sort()).toEqual([1, 1, 1, 2, 2, 3])
    // One agree call and two retries.
    expect(s.requests.filter((r) => r.path.endsWith("/status")).length).toBe(3 * nodes.length)
  })
})

describe("timing (TestClock)", () => {
  test("a hung node does not delay the result", async () => {
    const c = committee(1, ONE_EACH)
    const nodes = nodesFor(c, encoded, (i) => (i < 3 ? "hang" : undefined))
    const s = servicesFor(active(c), nodes)
    const bytes = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Read.blob(encoded.blobId))
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.merge(s.layer, TestClock.layer())))
    )
    expect(bytes).toEqual(BLOB)
  })

  test("sliver retries follow the default schedule: 200 ms, then 400 ms", async () => {
    const c = committee(1, [Array.from({ length: N }, (_, i) => i)])
    // Every sliver fails twice, then succeeds: the four first members retry together.
    const failures = new Map<string, number>()
    const nodes = nodesFor(c, encoded, (_, req) => {
      if (!isSliver(req)) return undefined
      const left = failures.get(req.path) ?? 2
      failures.set(req.path, left - 1)
      return left > 0 ? unavailable : undefined
    })
    const s = servicesFor(active(c), nodes)
    const metadataRequests = () => s.requests.filter(isSliver).length
    const seen = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Read.blob(encoded.blobId))
        const seen: Array<number> = []
        const at = function*(ms: number) {
          yield* TestClock.adjust(`${ms} millis`)
          // The fake HTTP answers go through real promises: let them settle.
          for (let i = 0; i < 20; i++) yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
          seen.push(metadataRequests())
        }
        yield* at(0)
        yield* at(199)
        yield* at(1)
        yield* at(399)
        yield* at(1)
        const bytes = yield* Fiber.join(fiber)
        expect(bytes).toEqual(BLOB)
        return seen
      }).pipe(Effect.provide(Layer.merge(s.layer, TestClock.layer())))
    )
    // At 600 ms the four first members succeed; members started after one of them failed are on their own clocks.
    expect(seen.slice(0, 4)).toEqual([NEED, NEED, 2 * NEED, 2 * NEED])
    expect(seen[4]).toBeGreaterThanOrEqual(3 * NEED)
  })
})


describe("failure paths", () => {
  test("a read that fails while the nodes call the blob Nonexistent is BlobNotFound (deleted meanwhile)", async () => {
    const c = committee(1, ONE_EACH)
    const nodes = nodesFor(c, encoded, (_, req) => (isSliver(req) ? unavailable : undefined))
    for (const n of nodes) n.statuses.set(encoded.blobId, "nonexistent")
    const { exit } = await run(Read.blob(encoded.blobId, { retry: noRetry }), active(c), nodes)
    expect(failure(exit)._tag).toBe("BlobNotFound")
    // Still certified: the read's own error.
    for (const n of nodes) n.statuses.set(encoded.blobId, permanent(1))
    const certified = await run(Read.blob(encoded.blobId, { retry: noRetry }), active(c), nodes)
    expect(failure(certified.exit)._tag).toBe("NotEnoughSlivers")
  })

  test("EpochChangeSync without an agreed status: read from the current committee", async () => {
    const previous = committee(4, ONE_EACH, "old")
    const current = committee(5, ONE_EACH, "new")
    const nodes = nodesFor(current, encoded, (_, req) => (req.path.endsWith("/status") ? unavailable : undefined))
    // The status agreement is retried (500 ms, then 1 s) before giving up on it: step a TestClock through that.
    const s = servicesFor(active(current, previous, true), nodes)
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.exit(Read.blob(encoded.blobId, { retry: noRetry })))
        // The fake HTTP answers go through real promises: let them settle between steps.
        while (fiber.pollUnsafe() === undefined) {
          yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
          yield* TestClock.adjust("100 millis")
        }
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.merge(s.layer, TestClock.layer())))
    )
    expect(value(exit)).toEqual(BLOB)
  })

  test("metadata: a failing node is not asked again, another one is", async () => {
    const c = committee(1, ONE_EACH)
    const nodes = nodesFor(c, encoded, (i, req) => (isMetadata(req) && i < 7 ? unavailable : undefined))
    const { exit, requests } = await run(Read.blob(encoded.blobId), active(c), nodes)
    expect(value(exit)).toEqual(BLOB)
    const perNode = new Map<string, number>()
    for (const r of requests.filter(isMetadata)) perNode.set(r.origin, (perNode.get(r.origin) ?? 0) + 1)
    expect(Math.max(...perNode.values())).toBe(1)
  })

  test("a shard the node no longer holds fails that shard alone, not the node's other shards", async () => {
    // Node 0 lists 5 shards but has moved shard 0; node 1 is down. The other 4 of node 0 are enough.
    const c = committee(1, [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]])
    const nodes = nodesFor(c, encoded, (i, req) => {
      if (!isSliver(req)) return undefined
      if (i === 1) return unavailable
      return sliverPair(req) === Encoding.pairOfShard(0, encoded.blobId, N) ? nodeErrors.shardNotAssigned(0, 1) : undefined
    })
    for (let round = 0; round < 5; round++) {
      const { exit } = await run(Read.blob(encoded.blobId, { retry: noRetry }).pipe(Random.withSeed(`moved-${round}`)), active(c), nodes)
      expect(value(exit)).toEqual(BLOB)
    }
  })

  test("a failed committee refresh keeps the read's own error", async () => {
    const c = committee(1, ONE_EACH)
    const committees = Layer.succeed(
      Committee.Committees,
      Committee.Committees.of({
        get: Effect.succeed(active(c)),
        refresh: Effect.fail(new Objects.ObjectNotFound({ objectId: Address.normalize("0x5") }))
      })
    )
    const nodes = nodesFor(c, undefined) // nobody has the metadata, nobody says not found either
    for (const n of nodes) n.statuses.set(encoded.blobId, permanent(1))
    const unreachable = nodes.map((n) => fakeNode({ url: n.url, nShards: N, intercept: () => unavailable }))
    const { exit } = await run(Read.blob(encoded.blobId, { retry: noRetry }), committees, unreachable)
    expect(failure(exit)._tag).toBe("NoMetadata")
  })
})
