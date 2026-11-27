/**
 * The read path (§4.5): verified metadata, primary slivers through `Quorum`,
 * WASM decode, a strict blob-id check, and per-sliver blame only when that
 * check fails.
 *
 *   const bytes = yield* Read.blob(blobId)
 *
 * Every node answer is checked before use: metadata against the blob id
 * (`Messages.verifyMetadata`), sliver headers against the metadata
 * (`Messages.checkSliver`). With `consistency: "strict"` (the default) the
 * decoded bytes must hash to the blob id; if they do not, each sliver used is
 * checked against the metadata's primary hashes (W6), the nodes that sent bad
 * ones are blamed and replaced, and only a blob whose slivers all match is
 * `InconsistentBlob` (the writer encoded it wrongly).
 *
 * `Quorum`'s errors never escape: they become the Schema errors of `Errors.ts`.
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Quorum from "@unconfirmed/quorum/Quorum"
import * as Bft from "./Bft.ts"
import type { BlobId } from "./BlobId.ts"
import {
  type ActiveCommittees,
  type Committee,
  type CommitteeError,
  Committees,
  readCommittee,
  type StorageNode as CommitteeNode
} from "./Committee.ts"
import { Encoder, type EncoderService } from "./Encoder.ts"
import * as Encoding from "./Encoding.ts"
import {
  BehindCurrentEpoch,
  BlobBlocked,
  BlobNotFound,
  BlobTooLarge,
  type EncoderError,
  type Failure,
  InconsistentBlob,
  InvalidBlob,
  NoMetadata,
  NotEnoughSlivers,
  StatusUnverified
} from "./Errors.ts"
import * as Messages from "./Messages.ts"
import * as Status from "./Status.ts"
import type { BlobStatus } from "./Status.ts"
import { NodeError, StorageNodes } from "./StorageNode.ts"
import * as StorageNode from "./StorageNode.ts"

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

export interface ReadOptions {
  /**
   * `"strict"` (default): re-derive the blob id from the decoded bytes, so the result is the blob that was
   * written or a typed error. `"skip"`: no check after decoding. Slivers are then only header-checked, so
   * this trusts every node that served one: any one of them can change the bytes returned. It saves one
   * WASM call (`Encoder.blobId`); use it only when the bytes are verified another way.
   */
  readonly consistency?: "strict" | "skip"
  /** Refuse blobs whose (verified) metadata claims more than this many bytes. Default 1 GiB. */
  readonly maxSize?: number
  /** Skip the status lookup during an epoch change when the caller already knows it. */
  readonly certifiedEpoch?: number
  /**
   * Per node; default exponential 200 ms .. 5 s, 4 retries. Reads prefer another node to a retry: metadata
   * requests retry only `RateLimited`, sliver requests every `StorageNode.retryable` error but `Timeout`.
   */
  readonly retry?: Schedule.Schedule<unknown, NodeError>
}

export type ReadServices = Committees | StorageNodes | Encoder

export type StatusError = StatusUnverified | CommitteeError

export type ReadError =
  | BlobNotFound
  | BlobBlocked
  | InvalidBlob
  | InconsistentBlob
  | NotEnoughSlivers
  | NoMetadata
  | BlobTooLarge
  | BehindCurrentEpoch
  | StatusError
  | EncoderError

/** 1 GiB. */
export const DEFAULT_MAX_SIZE = 1024 * 1024 * 1024

/** Sliver bytes in flight at once while reading (the Rust client's budget). */
const IN_FLIGHT_BYTES = 12_500_000
/** Metadata requests in flight at first; each node that fails for good adds one. */
const METADATA_LANES = 3
/** Blame rounds before giving up with `NotEnoughSlivers`. */
const MAX_BLAME_ROUNDS = 3
/** Whole-read retries after a committee change (the Rust client's `committee_change_backoff` count). */
const MAX_COMMITTEE_RETRIES = 2

/** Exponential from 200 ms, each delay capped at 5 s, 4 retries. */
export const defaultRetry = (): Schedule.Schedule<unknown, NodeError> =>
  Schedule.max([
    Schedule.exponential("200 millis").pipe(
      Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(5))))
    ),
    Schedule.recurs(4)
  ])

/** Whole `agree` calls for `status`: answers converge as nodes process the same events. */
const agreementRetry = (rounds: number) =>
  Schedule.max([
    Schedule.exponential("500 millis"),
    Schedule.recurs(rounds)
  ])

/**
 * Read a blob: verified metadata, `n − 2f` checked primary slivers, decode,
 * and (strict) the blob id of the result. Retries the whole read (at most
 * twice) when it fails in a way an epoch change explains and a refreshed
 * committee differs.
 */
export const blob = (blobId: BlobId, options: ReadOptions = {}): Effect.Effect<Uint8Array, ReadError, ReadServices> =>
  Effect.gen(function*() {
    const nodes = yield* Effect.service(StorageNodes)
    const encoder = yield* Effect.service(Encoder)
    const retry = options.retry ?? defaultRetry()
    const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE
    return yield* withCommitteeRetry((active) =>
      Effect.gen(function*() {
        const committee = yield* chooseCommittee(nodes, blobId, active, options.certifiedEpoch, retry)
        const metadata = yield* fetchMetadata(nodes, committee, blobId, retry)
        if (metadata.unencodedLength > maxSize) {
          return yield* new BlobTooLarge({ size: metadata.unencodedLength, max: maxSize })
        }
        return yield* readSlivers(nodes, encoder, committee, metadata, options.consistency ?? "strict", retry)
      })
    ).pipe(checkAbsent(nodes, blobId, retry))
  })

/**
 * After a read ends in `NotEnoughSlivers` or `NoMetadata`, ask for the status once: a blob the nodes call
 * `Nonexistent` (deleted, or never certified) is `BlobNotFound`, as the Rust client reports it. Paid only
 * on that failure path; any other answer, or none, keeps the original error.
 */
const checkAbsent = (nodes: Nodes, blobId: BlobId, retry: Schedule.Schedule<unknown, NodeError>) =>
<A, R>(read: Effect.Effect<A, ReadError, R>): Effect.Effect<A, ReadError, R | Committees> =>
  Effect.catchIf(
    read,
    (e): e is NotEnoughSlivers | NoMetadata => e._tag === "NotEnoughSlivers" || e._tag === "NoMetadata",
    (e) =>
      Effect.gen(function*() {
        const committees = yield* Effect.service(Committees)
        const status = yield* Effect.result(
          Effect.flatMap(committees.get, ({ current }) => agreeStatus(nodes, current, blobId, coarseKey, retry, 0))
        )
        return yield* Effect.fail(
          Result.isSuccess(status) && status.success._tag === "Nonexistent" ? new BlobNotFound({ blobId }) : e
        )
      })
  )

/** The blob's metadata, verified against its id, from the read committee. */
export const metadata = (
  blobId: BlobId,
  options: Pick<ReadOptions, "certifiedEpoch" | "retry"> = {}
): Effect.Effect<Messages.VerifiedMetadata, ReadError, Committees | StorageNodes> =>
  Effect.map(locate(blobId, options), (located) => located.metadata)

/**
 * The read committee (C6) and the metadata verified from it: what a partial
 * read (`QuiltRead`) needs to fetch and check single slivers itself.
 */
export const locate = (
  blobId: BlobId,
  options: Pick<ReadOptions, "certifiedEpoch" | "retry"> = {}
): Effect.Effect<{ readonly committee: Committee; readonly metadata: Messages.VerifiedMetadata }, ReadError, Committees | StorageNodes> =>
  Effect.gen(function*() {
    const nodes = yield* Effect.service(StorageNodes)
    const retry = options.retry ?? defaultRetry()
    return yield* withCommitteeRetry((active) =>
      Effect.flatMap(
        chooseCommittee(nodes, blobId, active, options.certifiedEpoch, retry),
        (committee) => Effect.map(fetchMetadata(nodes, committee, blobId, retry), (metadata) => ({ committee, metadata }))
      )
    ).pipe(checkAbsent(nodes, blobId, retry))
  })

/**
 * The blob's status as `f + 1` shards of the current committee report it,
 * after `2f + 1` have answered; the latest status (`Status.order`) wins among
 * those with enough weight. Split answers are retried a few times, then
 * `StatusUnverified` with every group.
 */
export const status = (
  blobId: BlobId,
  options: { readonly retry?: Schedule.Schedule<unknown, NodeError> } = {}
): Effect.Effect<BlobStatus, StatusError, Committees | StorageNodes> =>
  Effect.gen(function*() {
    const nodes = yield* Effect.service(StorageNodes)
    const { current } = yield* (yield* Effect.service(Committees)).get
    return yield* agreeStatus(nodes, current, blobId, Status.canonical, options.retry ?? defaultRetry())
  })

// -----------------------------------------------------------------------------
// Committee
// -----------------------------------------------------------------------------

type Nodes = StorageNodes["Service"]

const isEpochError = (e: ReadError): boolean =>
  e._tag === "NoMetadata" || e._tag === "NotEnoughSlivers" || e._tag === "BehindCurrentEpoch"

const changed = (a: ActiveCommittees, b: ActiveCommittees): boolean =>
  a.current.epoch !== b.current.epoch || a.transitioning !== b.transitioning

/**
 * Step 6: on `NoMetadata`, `NotEnoughSlivers` or `BehindCurrentEpoch`, refresh
 * the committees and, if the epoch or its state changed, read again.
 */
const withCommitteeRetry = <A, R>(
  read: (active: ActiveCommittees) => Effect.Effect<A, ReadError, R>
): Effect.Effect<A, ReadError, R | Committees> =>
  Effect.gen(function*() {
    const committees = yield* Effect.service(Committees)
    let active = yield* committees.get
    for (let attempt = 0;; attempt++) {
      const result = yield* Effect.result(read(active))
      if (Result.isSuccess(result)) return result.success
      const error = result.failure
      if (attempt >= MAX_COMMITTEE_RETRIES || !isEpochError(error)) return yield* Effect.fail(error)
      // A failed refresh keeps the read's own error: it says more than the refresh's `RpcError`.
      const refreshed = yield* Effect.result(committees.refresh)
      if (Result.isFailure(refreshed)) return yield* Effect.fail(error)
      const fresh = refreshed.success
      if (!changed(active, fresh)) return yield* Effect.fail(error)
      active = fresh
    }
  })

/** The `read` key: all the read path needs, so it agrees sooner than the full status. */
const coarseKey = (s: BlobStatus): string => `${s._tag}:${Status.certifiedEpoch(s) ?? "-"}`

/**
 * Step 1 (C6): the current committee, unless a certified epoch is known or the
 * committees are transitioning (then the status supplies it). When no status
 * gathers enough agreement during a transition, the current committee is used
 * (the Rust client's `continue_on_no_valid_status_received`); a miss there is
 * an epoch error, which `withCommitteeRetry` handles.
 */
const chooseCommittee = (
  nodes: Nodes,
  blobId: BlobId,
  active: ActiveCommittees,
  certifiedEpoch: number | undefined,
  retry: Schedule.Schedule<unknown, NodeError>
): Effect.Effect<Committee, ReadError> =>
  Effect.gen(function*() {
    if (certifiedEpoch !== undefined) return yield* Effect.fromResult(readCommittee(active, certifiedEpoch))
    if (!active.transitioning) return active.current
    const agreed = yield* Effect.result(agreeStatus(nodes, active.current, blobId, coarseKey, retry))
    if (Result.isFailure(agreed)) return active.current
    const s = agreed.success
    if (s._tag === "Invalid") return yield* new InvalidBlob({ blobId })
    const epoch = Status.certifiedEpoch(s)
    if (epoch === undefined) return yield* new BlobNotFound({ blobId })
    return yield* Effect.fromResult(readCommittee(active, epoch))
  })

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

const baseUrl = (node: { readonly url: string }) => node.url.replace(/\/+$/, "")

const agreeStatus = (
  nodes: Nodes,
  committee: Committee,
  blobId: BlobId,
  key: (s: BlobStatus) => string,
  retry: Schedule.Schedule<unknown, NodeError>,
  /** Whole `agree` calls after the first; default 2. */
  rounds = 2
): Effect.Effect<BlobStatus, StatusUnverified> => {
  const n = committee.nShards
  const once = Quorum.agree(committee.nodes, {
    weight: (node) => node.shards.length,
    run: (node) => nodes.status(node, blobId),
    key,
    threshold: Bft.validity(n),
    quorum: Bft.quorum(n),
    prefer: (a, b) => Status.order(a.successes[0]!.value, b.successes[0]!.value),
    schedule: retry,
    while: StorageNode.retryable
  })
  return (rounds > 0 ? Effect.retry(once, { schedule: agreementRetry(rounds) }) : once).pipe(
    Effect.map((agreed) => agreed.winner.successes[0]!.value),
    Effect.catchTag("AgreementFailed", (e) =>
      Effect.fail(
        new StatusUnverified({
          blobId,
          groups: e.groups.map((g) => ({ status: g.successes[0]!.value, weight: g.weight }))
        })
      ))
  )
}

// -----------------------------------------------------------------------------
// Failures
// -----------------------------------------------------------------------------

/** One entry per node and kind, weights summed: never the raw quorum objects. */
const summarize = (failures: Iterable<{ readonly weight: number; readonly error: NodeError }>): Array<Failure> => {
  const byNode = new Map<string, { node: string; weight: number; kind: string; message: string }>()
  for (const { error, weight } of failures) {
    const k = `${error.node}\u0000${error.kind}`
    const entry = byNode.get(k)
    if (entry) entry.weight += weight
    else byNode.set(k, { node: error.node, weight, kind: error.kind, message: error.message })
  }
  return [...byNode.values()]
}

/**
 * `node_client.rs:2386-2456`: when not-found and blocked answers together
 * weigh at least `2f + 1`, the blob is missing (or blocked, whichever weighs
 * more; a tie counts as blocked). Otherwise `fallback`.
 */
const classify = <E>(
  blobId: BlobId,
  n: number,
  failures: ReadonlyArray<{ readonly weight: number; readonly error: NodeError }>,
  fallback: () => E
): BlobNotFound | BlobBlocked | E => {
  const notFound = Quorum.failedWeight(failures as ReadonlyArray<Quorum.Failure<unknown, NodeError>>, (e) => e.kind === "NotFound")
  const blocked = Quorum.failedWeight(failures as ReadonlyArray<Quorum.Failure<unknown, NodeError>>, (e) => e.kind === "Blocked")
  if (notFound + blocked >= Bft.quorum(n)) return notFound > blocked ? new BlobNotFound({ blobId }) : new BlobBlocked({ blobId })
  return fallback()
}

const malformed = (node: string, message: string) => new NodeError({ node, kind: "Malformed", message })

// -----------------------------------------------------------------------------
// Metadata
// -----------------------------------------------------------------------------

/**
 * An upper bound on BCS `BlobMetadataWithId` at `n` shards: id (32), tags and length (≤ 16), and per
 * shard two Merkle roots of 33 bytes (66,044 bytes at `n = 1000`).
 */
const metadataBytes = (n: number): number => 32 + 16 + 66 * n + 16

/** Not-found and blocked answers: a node judging the blob, not failing to serve it. */
const absent = (e: NodeError): boolean => e.kind === "NotFound" || e.kind === "Blocked"

/**
 * Step 2: the first node whose metadata verifies against the blob id, three
 * nodes at a time. Not-found and blocked answers are final; once they weigh
 * `2f + 1` the read gives up there (`node_client.rs:2386-2456`, `Quorum`'s
 * `giveUp`) instead of waiting for every other node to fail, which with
 * threshold 1 is what `Quorum.run` alone would do.
 */
const fetchMetadata = (
  nodes: Nodes,
  committee: Committee,
  blobId: BlobId,
  retry: Schedule.Schedule<unknown, NodeError>
): Effect.Effect<Messages.VerifiedMetadata, BlobNotFound | BlobBlocked | NoMetadata> =>
  Effect.gen(function*() {
    const n = committee.nShards
    const verify = (node: CommitteeNode, bytes: Uint8Array) =>
      Effect.flatMap(
        Effect.try({
          try: () => Messages.verifyMetadata(blobId, bytes, n),
          catch: (e) => malformed(baseUrl(node), `metadata: ${String(e)}`)
        }),
        (r) => Result.isSuccess(r) ? Effect.succeed(r.success) : Effect.fail(malformed(baseUrl(node), `metadata: ${r.failure.reason}`))
      )
    // Three lanes, plus one more for every node that fails for good: a present blob costs about three
    // metadata downloads, an absent one does not wait for 2f + 1 not-found answers three at a time.
    // Another node is asked rather than the same one again (only `RateLimited` is retried), so a hung
    // node costs one timeout, not five.
    const maxBytes = metadataBytes(n)
    return yield* Quorum.run(committee.nodes, {
      weight: (node) => node.shards.length,
      run: (node) => Effect.flatMap(nodes.metadata(node, blobId, { maxBytes }), (bytes) => verify(node, bytes)),
      schedule: retry,
      while: (e) => e.kind === "RateLimited",
      concurrency: (p) => METADATA_LANES + p.failed,
      threshold: 1,
      order: "shuffle",
      giveUp: { when: absent, weight: Bft.quorum(n) }
    }).pipe(
      Effect.map((reached) => reached.successes[0]!.value),
      Effect.catchTag("QuorumFailed", (e) =>
        Effect.fail(classify(blobId, n, e.failures, () => new NoMetadata({ blobId, failures: summarize(e.failures) }))))
    )
  })

// -----------------------------------------------------------------------------
// Slivers
// -----------------------------------------------------------------------------

interface Fetched {
  readonly shard: number
  readonly pair: number
  /** The node's base URL. */
  readonly node: string
  readonly bytes: Uint8Array
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Failures about one shard of a node, not the node: they do not fail its other shards. */
const SHARD_LEVEL: ReadonlySet<NodeError["kind"]> = /* @__PURE__ */ new Set<NodeError["kind"]>(["ShardNotAssigned", "NotFound"])

/**
 * Step 3: primary slivers for the shards not yet `held`, one shard per member,
 * until `need` are held. `failedNodes` is shared across a read: a node that
 * failed for good (or was blamed) fails its other shards at once with the same
 * error, so not-found weight is still counted per shard.
 */
const fetchSlivers = (
  nodes: Nodes,
  committee: Committee,
  metadata: Messages.VerifiedMetadata,
  held: ReadonlyArray<Fetched>,
  failedNodes: Map<string, NodeError>,
  retry: Schedule.Schedule<unknown, NodeError>
): Effect.Effect<ReadonlyArray<Fetched>, BlobNotFound | BlobBlocked | NotEnoughSlivers> => {
  const n = committee.nShards
  const { blobId } = metadata
  const need = Encoding.sourceSymbols(n).primary
  const sizes = Encoding.sliverBytes(metadata.unencodedLength, n)
  const symbols = Encoding.sourceSymbols(n).secondary
  const heldShards = new Set(held.map((f) => f.shard))
  const members: Array<number> = []
  for (let shard = 0; shard < n; shard++) if (!heldShards.has(shard)) members.push(shard)
  const concurrency = Math.min(need, Math.max(1, Math.floor(IN_FLIGHT_BYTES / sizes.primary)))
  const maxBytes = Encoding.bcsSliverBytes(metadata.unencodedLength, n).primary

  const member = (shard: number): Effect.Effect<Fetched, NodeError> =>
    Effect.suspend(() => {
      const node = committee.nodeOfShard(shard)
      const url = baseUrl(node)
      const pair = Encoding.pairOfShard(shard, blobId, n)
      const once = Effect.suspend(() => {
        const prior = failedNodes.get(url)
        if (prior) return Effect.fail(prior)
        return Effect.flatMap(nodes.sliver(node, blobId, pair, "primary", { maxBytes }), (bytes) => {
          const checked = Messages.checkSliver(bytes, { index: pair, symbolSize: sizes.symbolSize, symbols })
          return Result.isSuccess(checked)
            ? Effect.succeed<Fetched>({ shard, pair, node: url, bytes })
            : Effect.fail(malformed(url, `sliver ${pair}: ${checked.failure.reason}`))
        })
      })
      // A timed-out node is not asked again for this sliver (other shards can stand in), and only a
      // node-level failure fails the node's other shards: a shard it no longer holds, or a sliver it
      // does not have, fails that shard alone.
      return Effect.retry(once, {
        schedule: retry,
        while: (e) => StorageNode.retryable(e) && e.kind !== "Timeout" && !failedNodes.has(url)
      }).pipe(
        Effect.tapError((e) =>
          Effect.sync(() => {
            if (!failedNodes.has(url) && !SHARD_LEVEL.has(e.kind)) failedNodes.set(url, e)
          })
        )
      )
    })

  return Quorum.run(members, {
    weight: () => 1,
    run: member,
    threshold: need - held.length,
    order: "shuffle",
    concurrency
  }).pipe(
    Effect.map((reached) => reached.successes.map((s) => s.value)),
    Effect.catchTag("QuorumFailed", (e) =>
      Effect.fail(classify(blobId, n, e.failures, () =>
        new NotEnoughSlivers({
          blobId,
          weight: held.length + e.weight,
          required: need,
          failures: summarize(e.failures)
        }))))
  )
}

/**
 * A pause between two blocking WASM calls, so that a strict read stalls the thread for one call at a time
 * and timers and I/O run in between. `Effect.yieldNow` is not enough on Bun (it does not let a timer fire);
 * a real `setTimeout(0)` is, and unlike `Effect.sleep` it does not wait for a `TestClock`.
 */
export const wasmBreak: Effect.Effect<void> = /* @__PURE__ */ Effect.callback<void>((resume) => {
  const timer = setTimeout(() => resume(Effect.void), 0)
  return Effect.sync(() => clearTimeout(timer))
})

/** Merkle roots of primary slivers, at most `n − 2f` per WASM call. */
const primaryRoots = (encoder: EncoderService, n: number, symbolSize: number, slivers: ReadonlyArray<Uint8Array>) =>
  Effect.gen(function*() {
    const batch = Encoding.sourceSymbols(n).primary
    const roots: Array<Uint8Array> = []
    for (let i = 0; i < slivers.length; i += batch) {
      if (i > 0) yield* wasmBreak
      roots.push(...(yield* encoder.sliverRoots(n, "primary", symbolSize, slivers.slice(i, i + batch))))
    }
    return roots
  })

/** Steps 3–5: fetch, decode, check, and blame on mismatch. */
const readSlivers = (
  nodes: Nodes,
  encoder: EncoderService,
  committee: Committee,
  metadata: Messages.VerifiedMetadata,
  consistency: "strict" | "skip",
  retry: Schedule.Schedule<unknown, NodeError>
): Effect.Effect<Uint8Array, BlobNotFound | BlobBlocked | NotEnoughSlivers | InconsistentBlob | EncoderError> =>
  Effect.gen(function*() {
    const n = committee.nShards
    const { blobId, unencodedLength } = metadata
    const need = Encoding.sourceSymbols(n).primary
    const { symbolSize } = Encoding.sliverBytes(unencodedLength, n)
    const failedNodes = new Map<string, NodeError>()
    const verified = new Set<number>()
    const blamed: Array<{ weight: number; error: NodeError }> = []
    let held: Array<Fetched> = []
    for (let round = 1;; round++) {
      held = [...held, ...(yield* fetchSlivers(nodes, committee, metadata, held, failedNodes, retry))]
      const bytes = yield* encoder.decode(n, unencodedLength, held.map((f) => f.bytes))
      if (consistency === "skip") return bytes
      // Each WASM call blocks the thread for seconds at n = 1000: let timers and other fibers run between them.
      yield* wasmBreak
      if ((yield* encoder.blobId(n, bytes)).blobId === blobId) return bytes

      yield* wasmBreak
      const unchecked = held.filter((f) => !verified.has(f.shard))
      const roots = yield* primaryRoots(encoder, n, symbolSize, unchecked.map((f) => f.bytes))
      const bad = new Set<Fetched>()
      unchecked.forEach((f, i) => {
        if (sameBytes(roots[i]!, metadata.hashes[f.pair]!.primary)) verified.add(f.shard)
        else bad.add(f)
      })
      if (bad.size === 0) return yield* new InconsistentBlob({ blobId })
      for (const f of bad) {
        const error = malformed(f.node, `sliver ${f.pair}: does not match the metadata`)
        if (!failedNodes.has(f.node)) failedNodes.set(f.node, error)
        blamed.push({ weight: 1, error })
      }
      held = held.filter((f) => !bad.has(f))
      if (round >= MAX_BLAME_ROUNDS) {
        return yield* new NotEnoughSlivers({ blobId, weight: held.length, required: need, failures: summarize(blamed) })
      }
    }
  })
