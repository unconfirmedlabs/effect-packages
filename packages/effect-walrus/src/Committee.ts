/**
 * Storage-node committees from the staking object (C3, C4, C6).
 *
 * `StakingInnerV1` lists each committee as a `VecMap<ID, vector<u16>>` (node
 * id -> shards) sorted by node id; a node's name, address and keys are in its
 * `StakingPool` object (object id = node id). Loading is three batched rounds:
 * the staking object, its inner field, then every pool of the current and
 * previous committees.
 */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Objects from "@unconfirmed/effect-sui/Objects"
import type { RpcError } from "@unconfirmed/effect-sui/RpcError"
import { WalrusConfig } from "./Config.ts"
import { BehindCurrentEpoch, CommitteeMismatch, type UnsupportedSystemVersion } from "./Errors.ts"
import type * as committee from "./generated/walrus/committee.ts"
import * as staking_inner from "./generated/walrus/staking_inner.ts"
import * as staking_pool from "./generated/walrus/staking_pool.ts"
import { readVersioned, type SystemState } from "./System.ts"

export interface StorageNode {
  /** Position in the committee (sorted by node id): the signer index in certificates (C5). */
  readonly index: number
  readonly nodeId: Address.Address
  readonly name: string
  /** `${scheme}://${network_address}`. */
  readonly url: string
  /** 96 bytes, uncompressed G1 (M5). */
  readonly publicKey: Uint8Array
  readonly shards: ReadonlyArray<number>
}

export interface Committee {
  readonly epoch: number
  readonly nShards: number
  readonly nodes: ReadonlyArray<StorageNode>
  /** Throws `RangeError` outside `0 .. nShards - 1`. */
  readonly nodeOfShard: (shard: number) => StorageNode
}

export interface ActiveCommittees {
  readonly current: Committee
  /** `undefined` when the staking state has no previous committee (the first epoch). */
  readonly previous: Committee | undefined
  /** `epoch_state` is `EpochChangeSync`: shards are still moving to the current committee. */
  readonly transitioning: boolean
}

export type CommitteeError = RpcError | Objects.ObjectNotFound | Objects.ObjectDecodeError | UnsupportedSystemVersion

export class Committees extends Context.Service<Committees, {
  readonly get: Effect.Effect<ActiveCommittees, CommitteeError>
  readonly refresh: Effect.Effect<ActiveCommittees, CommitteeError>
}>()("@unconfirmed/effect-walrus/Committees") {}

export interface CommitteesOptions {
  /** Default `"https"`. */
  readonly scheme?: "https" | "http"
  /** How long a loaded committee is reused. Default 1 minute. */
  readonly ttl?: Duration.Input
}

// -----------------------------------------------------------------------------
// Building
// -----------------------------------------------------------------------------

type Pool = typeof staking_pool.StakingPool.Type

/** Build a committee from its on-chain map and the nodes' pools. Fails with a reason when the map is not a partition of the shards. */
export const make = (
  epoch: number,
  nShards: number,
  map: committee.Committee,
  pools: ReadonlyMap<string, Pool>,
  scheme: "https" | "http" = "https"
): Result.Result<Committee, string> => {
  const owners: Array<StorageNode | undefined> = new Array(nShards).fill(undefined)
  const nodes: Array<StorageNode> = []
  for (const [index, { key, value }] of map[0].contents.entries()) {
    const pool = pools.get(key)
    if (pool === undefined) return Result.fail(`no staking pool for node ${key}`)
    const node: StorageNode = {
      index,
      nodeId: key,
      name: pool.node_info.name,
      url: `${scheme}://${pool.node_info.network_address}`,
      publicKey: pool.node_info.public_key.bytes,
      shards: value
    }
    for (const shard of value) {
      if (shard >= nShards) return Result.fail(`node ${key} holds shard ${shard} of ${nShards}`)
      if (owners[shard] !== undefined) return Result.fail(`shard ${shard} is assigned twice`)
      owners[shard] = node
    }
    nodes.push(node)
  }
  const missing = owners.findIndex((o) => o === undefined)
  if (nodes.length > 0 && missing >= 0) return Result.fail(`shard ${missing} is not assigned`)
  return Result.succeed({
    epoch,
    nShards,
    nodes,
    nodeOfShard: (shard) => {
      const node = owners[shard]
      if (node === undefined) throw new RangeError(`no node holds shard ${shard} of ${nShards}`)
      return node
    }
  })
}

/** Read the active committees once (no cache). */
export const load = (options: { readonly scheme?: "https" | "http" } = {}): Effect.Effect<
  ActiveCommittees,
  CommitteeError,
  WalrusConfig | Objects.Objects
> =>
  Effect.gen(function*() {
    const config = yield* Effect.service(WalrusConfig)
    const objects = yield* Effect.service(Objects.Objects)
    const stakingId = Address.normalize(config.stakingObjectId)
    const { inner } = yield* readVersioned({
      objectId: stakingId,
      outer: { module: "staking", name: "Staking" },
      inner: { module: "staking_inner", name: "StakingInnerV1", schema: staking_inner.StakingInnerV1 }
    })
    const ids = [...new Set([...inner.committee[0].contents, ...inner.previous_committee[0].contents].map((e) => e.key))]
    const decodePool = Objects.decode(staking_pool.StakingPool)
    const pools = new Map(
      yield* Effect.forEach(ids, (id) => Effect.map(Effect.flatMap(objects.get(id), decodePool), (p) => [id, p] as const), {
        concurrency: "unbounded"
      })
    )
    const build = (epoch: number, map: committee.Committee) =>
      Result.match(make(epoch, inner.n_shards, map, pools, options.scheme), {
        onSuccess: Effect.succeed,
        onFailure: (issue) =>
          Effect.fail(new Objects.ObjectDecodeError({ objectId: stakingId, type: "StakingInnerV1", issue }))
      })
    const current = yield* build(inner.epoch, inner.committee)
    const previous = inner.previous_committee[0].contents.length === 0 ? undefined : yield* build(inner.epoch - 1, inner.previous_committee)
    return { current, previous, transitioning: inner.epoch_state._tag === "EpochChangeSync" }
  })

export const layer = (options: CommitteesOptions = {}): Layer.Layer<Committees, never, WalrusConfig | Objects.Objects> =>
  Layer.effect(
    Committees,
    Effect.gen(function*() {
      const context = yield* Effect.context<WalrusConfig | Objects.Objects>()
      const ttl = Duration.fromInputUnsafe(options.ttl ?? Duration.minutes(1))
      const [get, invalidate] = yield* Effect.cachedInvalidateWithTTL(
        Effect.provideContext(load(options), context),
        (exit) => Exit.isSuccess(exit) ? ttl : Duration.zero
      )
      return Committees.of({ get, refresh: Effect.andThen(invalidate, get) })
    })
  )

/** Fixed committees, for tests. */
export const layerFromCommittees = (committees: ActiveCommittees): Layer.Layer<Committees> =>
  Layer.succeed(Committees, Committees.of({ get: Effect.succeed(committees), refresh: Effect.succeed(committees) }))

// -----------------------------------------------------------------------------
// Pure checks
// -----------------------------------------------------------------------------

/**
 * The committee to read a blob from (C6): the previous one during
 * `EpochChangeSync` for a blob certified before the current epoch, otherwise
 * the current one. A certified epoch above ours means we are behind.
 */
export const readCommittee = (c: ActiveCommittees, certifiedEpoch: number | undefined): Result.Result<Committee, BehindCurrentEpoch> => {
  if (certifiedEpoch === undefined) return Result.succeed(c.current)
  if (certifiedEpoch > c.current.epoch) {
    return Result.fail(new BehindCurrentEpoch({ clientEpoch: c.current.epoch, certifiedEpoch }))
  }
  if (c.transitioning && certifiedEpoch < c.current.epoch && c.previous !== undefined) return Result.succeed(c.previous)
  return Result.succeed(c.current)
}

/** C5, checked rather than assumed: same epoch, same node ids in the same order, same weights. */
export const checkAgainstSystem = (committee: Committee, system: SystemState): Result.Result<void, CommitteeMismatch> => {
  const fail = (reason: string) =>
    Result.fail(new CommitteeMismatch({ stakingEpoch: committee.epoch, systemEpoch: system.epoch, reason }))
  if (committee.epoch !== system.epoch) return fail("different epochs")
  if (committee.nShards !== system.nShards) return fail(`${committee.nShards} shards in staking, ${system.nShards} in the system`)
  if (committee.nodes.length !== system.members.length) {
    return fail(`${committee.nodes.length} nodes in staking, ${system.members.length} members in the system`)
  }
  for (const [i, node] of committee.nodes.entries()) {
    const member = system.members[i]!
    if (member.nodeId !== node.nodeId) return fail(`member ${i} is ${member.nodeId} in the system, ${node.nodeId} in staking`)
    if (member.weight !== node.shards.length) {
      return fail(`member ${i} (${node.nodeId}) weighs ${member.weight} in the system, ${node.shards.length} shards in staking`)
    }
  }
  return Result.succeed(undefined)
}
