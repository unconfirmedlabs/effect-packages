/**
 * Test support for anything that talks to storage nodes.
 *
 * - `scripted(route)`: an `HttpClient` that records every request and answers
 *   with whatever `route` returns (a reply, a transport error, or a hang).
 * - `fakeNode(...)` + `network(nodes)`: an in-memory network of storage nodes
 *   that implement the REST API (§1.3) with the bodies real nodes send, so
 *   read and write flows can run end to end against `StorageNode.layer`.
 * - `recorded` / `synthesized`: the fixture bodies under `fixtures/storage-node/`.
 * - `live`, `committeeNodes`, `recentCertified`: testnet helpers for `SUI_LIVE=1`
 *   tests (a stop-gap prefix parse until `Committee` lands).
 *
 * Everything here is synchronous apart from `"hang"`, which never answers
 * (drive it with `TestClock` to exercise timeouts).
 */
import * as Address from "@unconfirmed/sui/Address"
import * as DynamicFields from "@unconfirmed/sui/DynamicFields"
import * as Events from "@unconfirmed/sui/Events"
import * as Objects from "@unconfirmed/sui/Objects"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as BlobIdModule from "../src/BlobId.ts"
import type { BlobId } from "../src/BlobId.ts"
import * as Encoding from "../src/Encoding.ts"
import * as Messages from "../src/Messages.ts"
import * as StorageNode from "../src/StorageNode.ts"

// -----------------------------------------------------------------------------
// Scripted HttpClient
// -----------------------------------------------------------------------------

export interface Recorded {
  readonly method: string
  readonly url: string
  /** The URL's origin, i.e. the node a request went to. */
  readonly origin: string
  readonly path: string
  readonly headers: Record<string, string>
  /** The raw body of a `PUT`, `undefined` otherwise. */
  readonly body: Uint8Array | undefined
}

export interface Reply {
  readonly status?: number
  /** A string or bytes as is; anything else as JSON. */
  readonly body?: unknown
  readonly contentType?: string
}

/** What a route answers: a reply, a transport failure, or no answer at all. */
export type Outcome = Reply | "network-error" | "hang"

const toBody = (body: unknown): string | Uint8Array =>
  body === undefined ? "" : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)

/** Answers each request with `route(request)` and records it. */
export const scripted = (route: (req: Recorded) => Outcome) => {
  const requests: Array<Recorded> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const body = request.body._tag === "Uint8Array" ? request.body.body : undefined
      const recorded: Recorded = {
        method: request.method,
        url: url.toString(),
        origin: url.origin,
        path: url.pathname + url.search,
        headers: { ...request.headers },
        body
      }
      requests.push(recorded)
      const outcome = route(recorded)
      if (outcome === "hang") return Effect.never
      if (outcome === "network-error") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "connection refused" })
          })
        )
      }
      const headers: Record<string, string> = outcome.contentType ? { "content-type": outcome.contentType } : {}
      const payload = toBody(outcome.body)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(typeof payload === "string" ? payload : payload.slice().buffer, { status: outcome.status ?? 200, headers })
        )
      )
    })
  )
  return { layer, requests }
}

/** `StorageNode.layer` over a scripted client. */
export const scriptedNodes = (route: (req: Recorded) => Outcome, options?: StorageNode.StorageNodesOptions) => {
  const http = scripted(route)
  return { layer: StorageNode.layer(options).pipe(Layer.provide(http.layer)), requests: http.requests }
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

export interface FixtureResponse {
  readonly method: string
  readonly path?: string
  readonly status: number
  readonly contentType: string | null
  readonly body?: string
  readonly bodyFile?: string
}

const fixtures = new URL("./fixtures/storage-node/", import.meta.url)

/** Recorded from a testnet node (see `recorded.json`'s `source`). */
export const recorded = (await Bun.file(new URL("recorded.json", fixtures)).json()) as {
  readonly node: string
  readonly epoch: number
  readonly nShards: number
  readonly nodeShards: ReadonlyArray<number>
  readonly randomBlobId: BlobId
  readonly permanent: { readonly blobId: BlobId; readonly objectId: string }
  readonly deletable: { readonly blobId: BlobId; readonly objectId: string }
  readonly shard: number
  readonly pair: number
  readonly pairNotAssigned: number
  readonly responses: Readonly<Record<string, FixtureResponse>>
}

/** Bodies that cannot be recorded with reads only (see `synthesized.json`'s `source`). */
export const synthesized = (await Bun.file(new URL("synthesized.json", fixtures)).json()) as {
  readonly responses: Readonly<Record<string, FixtureResponse>>
}

/** A fixture as a scripted reply. */
export const replyOf = async (r: FixtureResponse): Promise<Reply> => ({
  status: r.status,
  ...(r.contentType && { contentType: r.contentType }),
  body: r.bodyFile ? new Uint8Array(await Bun.file(new URL(r.bodyFile, fixtures)).arrayBuffer()) : r.body
})

// -----------------------------------------------------------------------------
// Fake storage nodes
// -----------------------------------------------------------------------------

const errorBody = (status: number, code: string, reason: string, message: string, domain = "storage.walrus.space") => ({
  status,
  contentType: "application/json",
  body: { error: { status: code, code: status, message, details: [{ "@type": "ErrorInfo", reason, domain, metadata: {} }] } }
})
const ok = (data: unknown, code = 200): Reply => ({ status: code, contentType: "application/json", body: { success: { code, data } } })

/** The node's own errors, word for word (recorded or from `crates/walrus-service/src/node/errors.rs`). */
export const nodeErrors = {
  notRegistered: () =>
    errorBody(400, "FAILED_PRECONDITION", "NOT_REGISTERED", "the blob has not been registered or has already expired"),
  metadataNotFound: () => errorBody(404, "NOT_FOUND", "METADATA_NOT_FOUND", "the requested metadata is unavailable"),
  missingMetadata: () => errorBody(400, "FAILED_PRECONDITION", "METADATA_NOT_FOUND", "blob metadata is required but missing"),
  sliverNotFound: () => errorBody(404, "NOT_FOUND", "SLIVER_NOT_FOUND", "the requested sliver is unavailable"),
  shardNotAssigned: (shard: number, epoch: number) =>
    errorBody(400, "FAILED_PRECONDITION", "SHARD_NOT_ASSIGNED", `shard ${shard} is not assigned to this node in epoch ${epoch}`),
  forbidden: () => errorBody(451, "UNAVAILABLE_FOR_LEGAL_REASONS", "FORBIDDEN_BLOB", "the requested sliver is forbidden"),
  metadataForbidden: () => errorBody(451, "UNAVAILABLE_FOR_LEGAL_REASONS", "FORBIDDEN_BLOB", "the requested metadata is blocked"),
  missingSlivers: () => errorBody(400, "FAILED_PRECONDITION", "MISSING_SLIVERS", "the required slivers are not all stored"),
  unavailable: () => errorBody(503, "UNAVAILABLE", "UNAVAILABLE", "the service is currently unavailable", "global")
} satisfies Record<string, (...args: Array<any>) => Reply>

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

export interface FakeNodeOptions {
  /** Base URL, e.g. `https://node-3.test:9185`. */
  readonly url: string
  readonly nShards: number
  /** The shards this node holds; slivers of other shards are `SHARD_NOT_ASSIGNED`. Default: all. */
  readonly shards?: ReadonlyArray<number>
  readonly epoch?: number
  /** Signs confirmations (BLS min-pk over the message bytes). Without it, confirmations are `503`. */
  readonly sign?: (message: Uint8Array) => Uint8Array
  /**
   * Called first for every request to this node; return an outcome to override
   * the normal answer (fail, hang, lie), or `undefined` to answer normally.
   */
  readonly intercept?: (req: Recorded, node: FakeNode) => Outcome | undefined
}

/**
 * A storage node in memory. Its state is public so tests can seed it
 * (`registered`, `metadata`, `slivers`, `statuses`, `blocked`) and inspect it
 * after a run.
 */
export interface FakeNode {
  readonly url: string
  readonly nShards: number
  readonly shards: ReadonlySet<number>
  epoch: number
  readonly registered: Set<BlobId>
  readonly blocked: Set<BlobId>
  /** BCS `BlobMetadata` (no id), as `PUT` sends it. */
  readonly metadata: Map<BlobId, Uint8Array>
  /** BCS `SliverData`, keyed by `sliverKey`. */
  readonly slivers: Map<string, Uint8Array>
  /** The status JSON as the node sends it (S1); default `"nonexistent"`. */
  readonly statuses: Map<BlobId, unknown>
  readonly requests: Array<Recorded>
  readonly answer: (req: Recorded) => Outcome
}

export const sliverKey = (blobId: BlobId, pairIndex: number, axis: StorageNode.Axis) => `${blobId}/${pairIndex}/${axis}`

/** A fake node implementing N1–N7. */
export const fakeNode = (options: FakeNodeOptions): FakeNode => {
  const shards = new Set(options.shards ?? Array.from({ length: options.nShards }, (_, i) => i))
  const node: FakeNode = {
    url: options.url.replace(/\/+$/, ""),
    nShards: options.nShards,
    shards,
    epoch: options.epoch ?? 1,
    registered: new Set(),
    blocked: new Set(),
    metadata: new Map(),
    slivers: new Map(),
    statuses: new Map(),
    requests: [],
    answer: (req) => {
      node.requests.push(req)
      return options.intercept?.(req, node) ?? route(req)
    }
  }

  const parseId = (s: string) => BlobIdModule.fromString(s)

  const route = (req: Recorded): Outcome => {
    const path = req.path.split("?")[0]!
    const m = /^\/v1\/blobs\/([^/]+)(\/.*)?$/.exec(path)
    if (!m) return { status: 404, body: "" }
    const id = parseId(m[1]!)
    if (id._tag === "Failure") {
      return { status: 400, contentType: "text/plain; charset=utf-8", body: `Invalid URL: Cannot parse \`blob_id\` with value \`${m[1]}\`: failed to parse a blob ID` }
    }
    const blobId = id.success
    const rest = m[2] ?? ""
    const get = req.method === "GET"
    const put = req.method === "PUT"

    if (get && rest === "/status") return ok(node.statuses.get(blobId) ?? "nonexistent")
    if (rest === "/metadata") {
      if (get) {
        if (node.blocked.has(blobId)) return nodeErrors.metadataForbidden()
        const md = node.metadata.get(blobId)
        if (!md) return nodeErrors.metadataNotFound()
        const out = new Uint8Array(32 + md.length)
        out.set(BlobIdModule.toBytes(blobId))
        out.set(md, 32)
        return { status: 200, contentType: "application/octet-stream", body: out }
      }
      if (put) {
        if (!node.registered.has(blobId)) return nodeErrors.notRegistered()
        if (node.metadata.has(blobId)) return ok("metadata already stored", 200)
        node.metadata.set(blobId, req.body ?? new Uint8Array(0))
        return ok("metadata successfully stored", 201)
      }
    }
    if (get && rest === "/metadata/status") return ok(node.metadata.has(blobId) ? "stored" : "nonexistent")

    const s = /^\/slivers\/(\d+)\/(primary|secondary)(\/status)?$/.exec(rest)
    if (s) {
      const pair = Number(s[1])
      const axis = s[2] as StorageNode.Axis
      if (pair >= node.nShards) {
        return errorBody(400, "INVALID_ARGUMENT", "INDEX_OUT_OF_RANGE", `the requested sliver index is out of range: requires 0 <= index (${pair}) < ${node.nShards}`)
      }
      const shard = Encoding.shardOfPair(pair, blobId, node.nShards)
      if (!node.shards.has(shard)) return nodeErrors.shardNotAssigned(shard, node.epoch)
      const key = sliverKey(blobId, pair, axis)
      if (get && s[3]) return ok(node.slivers.has(key) ? "stored" : "nonexistent")
      if (get) {
        if (node.blocked.has(blobId)) return nodeErrors.forbidden()
        const sliver = node.slivers.get(key)
        return sliver ? { status: 200, contentType: "application/octet-stream", body: sliver } : nodeErrors.sliverNotFound()
      }
      if (put && !s[3]) {
        if (!node.registered.has(blobId)) return nodeErrors.notRegistered()
        if (!node.metadata.has(blobId)) return nodeErrors.missingMetadata()
        if (node.slivers.has(key)) return ok("sliver already stored", 200)
        node.slivers.set(key, req.body ?? new Uint8Array(0))
        return ok("sliver stored successfully", 201)
      }
    }

    const c = /^\/confirmation\/(permanent|deletable\/(0x[0-9a-f]{64}))$/.exec(rest)
    if (get && c) {
      if (!node.registered.has(blobId)) return nodeErrors.notRegistered()
      for (const shard of node.shards) {
        const pair = Encoding.pairOfShard(shard, blobId, node.nShards)
        if (!node.slivers.has(sliverKey(blobId, pair, "primary")) || !node.slivers.has(sliverKey(blobId, pair, "secondary"))) {
          return nodeErrors.missingSlivers()
        }
      }
      if (!options.sign) return nodeErrors.unavailable()
      const persistence: Messages.Persistence = c[2] ? { _tag: "Deletable", objectId: c[2] as any } : { _tag: "Permanent" }
      const message = Messages.confirmationMessage(node.epoch, blobId, persistence)
      return ok({ signed: { serializedMessage: toBase64(message), signature: toBase64(options.sign(message)) } })
    }
    return { status: 404, body: "" }
  }
  return node
}

/** An `HttpClient` routing each request to the fake node with its origin; unknown hosts are transport errors. */
export const network = (nodes: ReadonlyArray<FakeNode>) => {
  const byOrigin = new Map(nodes.map((n) => [new URL(n.url).origin, n]))
  return scripted((req) => byOrigin.get(req.origin)?.answer(req) ?? "network-error")
}

/** `StorageNode.layer` over a fake network. */
export const fakeNodes = (nodes: ReadonlyArray<FakeNode>, options?: StorageNode.StorageNodesOptions) => {
  const http = network(nodes)
  return { layer: StorageNode.layer(options).pipe(Layer.provide(http.layer)), requests: http.requests }
}

// -----------------------------------------------------------------------------
// Live testnet (SUI_LIVE=1)
// -----------------------------------------------------------------------------

export const live = process.env.SUI_LIVE === "1"
export const TESTNET_STAKING = Address.normalize("0xbe46180321c30aab2f8b3501e24048377287fa708018a5b7c2792b35fe339ee3")
export const TESTNET_TYPE_ORIGIN = "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66"
export const TESTNET_FULLNODE = process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443"

export interface LiveNode {
  readonly nodeId: string
  readonly name: string
  readonly url: string
  readonly shards: ReadonlyArray<number>
}

class Reader {
  pos = 0
  constructor(readonly bytes: Uint8Array) {}
  skip(n: number) {
    this.pos += n
  }
  u8() {
    return this.bytes[this.pos++]!
  }
  u16() {
    const v = this.bytes[this.pos]! | (this.bytes[this.pos + 1]! << 8)
    this.pos += 2
    return v
  }
  u64() {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8).getBigUint64(0, true)
    this.pos += 8
    return v
  }
  uleb() {
    let v = 0
    let shift = 0
    for (;;) {
      const b = this.u8()
      v += (b & 0x7f) * 2 ** shift
      if ((b & 0x80) === 0) return v
      shift += 7
    }
  }
  address() {
    const hex = Array.from(this.bytes.subarray(this.pos, this.pos + 32), (b) => b.toString(16).padStart(2, "0")).join("")
    this.pos += 32
    return `0x${hex}`
  }
  string() {
    const n = this.uleb()
    const s = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + n))
    this.pos += n
    return s
  }
  committee() {
    const out: Array<{ nodeId: string; shards: Array<number> }> = []
    const n = this.uleb()
    for (let i = 0; i < n; i++) {
      const nodeId = this.address()
      const m = this.uleb()
      const shards: Array<number> = []
      for (let j = 0; j < m; j++) shards.push(this.u16())
      out.push({ nodeId, shards })
    }
    return out
  }
}

const u64le = (v: bigint) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, v, true)
  return out
}

/** The current committee with each node's URL, from the staking object. */
export const committeeNodes: Effect.Effect<ReadonlyArray<LiveNode>, unknown, Objects.Objects> = Effect.gen(function*() {
  const objects = yield* Objects.Objects
  const staking = yield* objects.get(TESTNET_STAKING)
  const version = new Reader(staking.contents)
  version.skip(32)
  const inner = yield* objects.get(DynamicFields.deriveId(TESTNET_STAKING, "u64", u64le(version.u64())))
  // Field<u64, StakingInnerV1>: id, name, then n_shards, epoch_duration, first_epoch_start,
  // pools (ObjectTable: id, size), epoch, active_set (ExtendedField: id), next_committee: Option<Committee>, committee.
  const r = new Reader(inner.contents)
  r.skip(32 + 8 + 2 + 8 + 8 + 40 + 4 + 32)
  if (r.u8() === 1) r.committee()
  const committee = r.committee()
  return yield* Effect.forEach(committee, ({ nodeId, shards }) =>
    Effect.map(objects.get(Address.normalize(nodeId)), (pool) => {
      // StakingPool: id, state (PoolState: Active | Withdrawing(u32) | Withdrawn), voting_params (3 × u64),
      // node_info { name, node_id, network_address, … }.
      const p = new Reader(pool.contents)
      p.skip(32)
      if (p.uleb() === 1) p.skip(4)
      p.skip(24)
      const name = p.string()
      p.skip(32)
      return { nodeId, name, url: `https://${p.string()}`, shards }
    }), { concurrency: "unbounded" })
})

export const suiLayer = SuiGrpc.layer({ url: TESTNET_FULLNODE }).pipe(Layer.provide(FetchHttpClient.layer))

/** The newest `BlobCertified` events (blob id, end epoch, deletable, object id), newest first. */
/**
 * A failed read in one line, with the kinds and weights of its failures: what a live test prints for a
 * candidate it skips, so that the next flaky run says why.
 */
export const describeReadFailure = (e: { readonly _tag: string }): string => {
  const failures = (e as { readonly failures?: ReadonlyArray<{ readonly kind: string; readonly weight: number }> }).failures
  if (!failures) return e._tag
  const byKind = new Map<string, number>()
  for (const f of failures) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + f.weight)
  const weight = (e as { readonly weight?: number }).weight
  return `${e._tag}${weight === undefined ? "" : ` (weight ${weight})`}: ${[...byKind].map(([k, w]) => `${k} ${w}`).join(", ")}`
}

/**
 * Candidates for a live read: newest certified first, permanent only (testnet bots delete most deletable
 * blobs seconds after certifying them, review WAL-4), not extensions, and lasting a while.
 */
export const readableCandidates = (currentEpoch: number, count = 200) =>
  Effect.map(recentCertified(count), (all) => all.filter((c) => !c.isExtension && !c.deletable && c.endEpoch >= currentEpoch + 2))

export const recentCertified = (count: number) =>
  Effect.flatMap(Effect.service(Events.Events), (events) =>
    events.list({ filter: Events.eventType(`${TESTNET_TYPE_ORIGIN}::events::BlobCertified`), descending: true }).pipe(
      Stream.take(count),
      Stream.map((e) => {
        // BlobCertified { epoch: u32, blob_id: u256, end_epoch: u32, deletable: bool, object_id: ID, is_extension: bool }
        // The u256 is little-endian, so its BCS bytes are the blob id's bytes (E6).
        const r = new Reader(e.contents)
        r.skip(4)
        const blobId = BlobIdModule.fromU256(BigInt(`0x${r.address().slice(2).match(/../g)!.reverse().join("")}`))
        const endEpoch = new DataView(e.contents.buffer, e.contents.byteOffset + r.pos, 4).getUint32(0, true)
        r.skip(4)
        const deletable = r.u8() === 1
        const objectId = Address.normalize(r.address())
        return { blobId, endEpoch, deletable, objectId, isExtension: r.u8() === 1 }
      }),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk))
    ))
