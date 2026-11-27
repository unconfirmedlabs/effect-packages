/**
 * The write path (§4.7) end to end against an in-memory world: fake storage
 * nodes (`test/support.ts`) that sign confirmations with `@noble/curves` BLS
 * keys, a fake chain behind a fake `Executor` that applies `register_blob` and
 * `certify_blob` as the contracts do (including the shard-weighted quorum and
 * epoch checks of M4 and T2), and the real WASM encoder at `n = 10`.
 */
import { bls12_381 } from "@noble/curves/bls12-381.js"
import { describe, expect, test } from "bun:test"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Ptb from "@unconfirmed/sui/Ptb"
import type * as T from "@unconfirmed/sui/TransactionData"
import type * as Transactions from "@unconfirmed/sui/Transactions"
import * as Bft from "../src/Bft.ts"
import * as BlobId from "../src/BlobId.ts"
import * as Committee from "../src/Committee.ts"
import * as Encoder from "../src/Encoder.ts"
import * as Encoding from "../src/Encoding.ts"
import * as blob from "../src/generated/walrus/blob.ts"
import * as Messages from "../src/Messages.ts"
import * as StorageNode from "../src/StorageNode.ts"
import * as System from "../src/System.ts"
import * as Write from "../src/Write.ts"
import { type FakeNode, fakeNode, fakeNodes, nodeErrors, type Outcome, type Recorded, sliverKey } from "./support.ts"

const N = 10
const TYPE_ORIGIN = Address.normalize("0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66")
const BLOB_TYPE = `${TYPE_ORIGIN}::blob::Blob`
const OWNER = Address.normalize("0xa11ce")
const sigs = bls12_381.longSignatures
const keys = Array.from({ length: 12 }, (_, i) => sigs.keygen(new Uint8Array(48).fill(i + 1)))
const signWith = (i: number) => (message: Uint8Array) => sigs.Signature.toBytes(sigs.sign(sigs.hash(message), keys[i]!.secretKey))

// -----------------------------------------------------------------------------
// The world
// -----------------------------------------------------------------------------

class Aborted extends Schema.TaggedError<Aborted>()("Aborted", { reason: Schema.String }) {}

interface NodeSpec {
  readonly shards: ReadonlyArray<number>
  /** Default: sign the message with the node's key. */
  readonly sign?: (message: Uint8Array) => Uint8Array
  readonly intercept?: (req: Recorded, node: FakeNode) => Outcome | undefined
  /** Delay before each confirmation answer (for `TestClock` timing tests). */
  readonly confirmDelay?: Duration.Input
}

type OnChainBlob = blob.Blob
const encodeBlob = Bcs.encodeSync(blob.Blob)

const makeWorld = (specs: ReadonlyArray<NodeSpec>, options: { readonly epoch?: number; readonly putDelay?: Duration.Input } = {}) => {
  let epoch = options.epoch ?? 5
  const fakes = specs.map((spec, i) =>
    fakeNode({
      url: `https://node-${i}.test:9185`,
      nShards: N,
      shards: spec.shards,
      epoch,
      sign: spec.sign ?? signWith(i),
      ...(spec.intercept && { intercept: spec.intercept })
    })
  )
  const nodes: Array<Committee.StorageNode> = specs.map((spec, i) => ({
    index: i,
    nodeId: Address.normalize(`0x${(i + 1).toString(16)}`),
    name: `node-${i}`,
    url: fakes[i]!.url,
    publicKey: keys[i]!.publicKey.toBytes(false),
    shards: spec.shards
  }))
  const committee = (): Committee.Committee => ({
    epoch,
    nShards: N,
    nodes,
    nodeOfShard: (s) => nodes.find((n) => n.shards.includes(s))!
  })
  const state = (): System.SystemState => ({
    systemObjectId: Address.normalize("0x5a5"),
    initialSharedVersion: 1n,
    epoch,
    nShards: N,
    packageId: Address.normalize("0xfeed"),
    typeOrigin: TYPE_ORIGIN,
    storagePrice: 10n,
    writePrice: 20n,
    members: nodes.map((n) => ({ nodeId: n.nodeId, weight: n.shards.length, publicKey: n.publicKey }))
  })

  // Chain: Blob objects by id.
  const chain = new Map<string, { owner: Address.Address; blob: OnChainBlob }>()
  const executed: Array<string> = []
  let nextId = 0x1000

  const suiObject = (id: string): Objects.SuiObject => {
    const entry = chain.get(id)!
    return {
      objectId: id as Address.Address,
      version: 1n,
      digest: "" as T.ObjectDigest,
      owner: { _tag: "AddressOwner", address: entry.owner },
      type: BLOB_TYPE,
      contents: encodeBlob(entry.blob),
      previousTransaction: undefined
    }
  }
  const objects = Layer.succeed(
    Objects.Objects,
    Objects.Objects.of({
      get: (id) =>
        Effect.suspend(() =>
          chain.has(id) ? Effect.succeed(suiObject(id)) : Effect.fail(new Objects.ObjectNotFound({ objectId: id }))
        ),
      listOwned: (owner, o) =>
        Stream.suspend(() =>
          Stream.fromIterable(
            [...chain.entries()].filter(([, e]) => e.owner === owner && (o?.type === undefined || o.type === BLOB_TYPE)).map(([id]) =>
              suiObject(id)
            )
          )
        )
    })
  )

  const pure = (draft: Ptb.Draft, a: T.Argument | undefined) => {
    if (a?._tag !== "Input") throw new Error("not an input")
    const input = draft.inputs[a.value]!
    if (input._tag !== "Pure") throw new Error("not pure")
    return input.bytes
  }
  const objectId = (draft: Ptb.Draft, a: T.Argument | undefined) => {
    if (a?._tag !== "Input") throw new Error("not an input")
    const input = draft.inputs[a.value] as { readonly objectId: string }
    return Address.normalize(input.objectId)
  }

  const apply = (draft: Ptb.Draft): Transactions.ChangedObject[] | Aborted => {
    const calls = draft.commands.filter((c): c is Extract<T.Command, { _tag: "MoveCall" }> => c._tag === "MoveCall")
    const created: Array<Transactions.ChangedObject> = []
    const reserve = calls.find((c) => c.function === "reserve_space")
    const register = calls.find((c) => c.function === "register_blob")
    if (register) {
      const epochs = Bcs.decodeSync(Bcs.u32)(pure(draft, reserve!.arguments[2]))
      const transfer = draft.commands.find((c) => c._tag === "TransferObjects") as Extract<T.Command, { _tag: "TransferObjects" }>
      const owner = Bcs.decodeSync(Bcs.Address)(pure(draft, transfer.address))
      const id = Address.normalize(`0x${(nextId++).toString(16)}`)
      const blobId = Bcs.decodeSync(Bcs.u256)(pure(draft, register.arguments[2]))
      chain.set(id, {
        owner,
        blob: {
          id,
          registered_epoch: epoch,
          blob_id: blobId,
          size: Bcs.decodeSync(Bcs.u64)(pure(draft, register.arguments[4])),
          encoding_type: 1,
          certified_epoch: Option.none(),
          storage: { id: Address.normalize(`0x${(nextId++).toString(16)}`), start_epoch: epoch, end_epoch: epoch + epochs, storage_size: 1n },
          deletable: Bcs.decodeSync(Bcs.bool)(pure(draft, register.arguments[6]))
        }
      })
      for (const f of fakes) f.registered.add(BlobId.fromU256(blobId))
      created.push({
        objectId: id,
        type: BLOB_TYPE,
        operation: "Created",
        version: 1n,
        digest: undefined,
        owner: undefined,
        inputVersion: undefined,
        inputDigest: undefined,
        inputOwner: undefined
      })
    }
    const certify = calls.find((c) => c.function === "certify_blob")
    if (certify) {
      const id = objectId(draft, certify.arguments[1])
      const entry = chain.get(id)
      if (!entry) return new Aborted({ reason: "no such blob" })
      const signature = Bcs.decodeSync(Bcs.byteVector)(pure(draft, certify.arguments[2]))
      const bitmap = Bcs.decodeSync(Bcs.byteVector)(pure(draft, certify.arguments[3]))
      const message = Bcs.decodeSync(Bcs.byteVector)(pure(draft, certify.arguments[4]))
      // M4 and T2: the chain's checks.
      if (Option.isSome(entry.blob.certified_epoch)) return new Aborted({ reason: "already certified" })
      if (new DataView(message.buffer, message.byteOffset + 3, 4).getUint32(0, true) !== epoch) return new Aborted({ reason: "wrong epoch" })
      const signers = nodes.filter((n) => (bitmap[n.index >> 3]! >> (n.index & 7)) & 1)
      const weight = signers.reduce((w, n) => w + n.shards.length, 0)
      if (3 * weight < 2 * N + 1) return new Aborted({ reason: `weight ${weight} below quorum` })
      const aggregateKey = sigs.aggregatePublicKeys(signers.map((n) => n.publicKey))
      if (!sigs.verify(sigs.Signature.fromBytes(signature), sigs.hash(message), aggregateKey)) return new Aborted({ reason: "bad signature" })
      chain.set(id, { ...entry, blob: { ...entry.blob, certified_epoch: Option.some(epoch) } })
    }
    return created
  }

  const executor: Write.Executor<Aborted, never> = {
    sender: OWNER,
    execute: (recipe) =>
      Effect.gen(function*() {
        const { draft } = yield* Ptb.build(recipe)
        const names = draft.commands.flatMap((c) => c._tag === "MoveCall" ? [c.function] : [])
        executed.push(names.includes("register_blob") ? "register" : names.includes("certify_blob") ? "certify" : names.join(","))
        const result = apply(draft)
        if (result instanceof Aborted) return yield* result
        const effects: Transactions.Effects = {
          digest: `tx${executed.length}`,
          status: { _tag: "Success" },
          gasUsed: { computationCost: 0n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n },
          changedObjects: result
        }
        return effects
      })
  }

  const system = Layer.succeed(
    System.System,
    System.System.of({
      state: Effect.sync(state),
      refresh: Effect.sync(state),
      walType: Effect.succeed(`${TYPE_ORIGIN}::wal::WAL`)
    })
  )
  const committees = Layer.succeed(
    Committee.Committees,
    Committee.Committees.of({
      get: Effect.sync(() => ({ current: committee(), previous: undefined, transitioning: false })),
      refresh: Effect.sync(() => ({ current: committee(), previous: undefined, transitioning: false }))
    })
  )

  // Storage nodes, with optional delays and an in-flight counter for sliver PUTs.
  const http = fakeNodes(fakes)
  let inFlight = 0
  let maxInFlight = 0
  const storage = Layer.effect(
    StorageNode.StorageNodes,
    Effect.gen(function*() {
      const s = yield* StorageNode.StorageNodes
      const delayOf = (url: string) => specs[fakes.findIndex((f) => f.url === url)]?.confirmDelay ?? 0
      return StorageNode.StorageNodes.of({
        ...s,
        putSliver: (node, ...rest) =>
          Effect.gen(function*() {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            if (options.putDelay !== undefined) yield* Effect.sleep(options.putDelay)
            return yield* s.putSliver(node, ...rest)
          }).pipe(Effect.ensuring(Effect.sync(() => inFlight--))),
        confirmation: (node, ...rest) => Effect.delay(s.confirmation(node, ...rest), delayOf(node.url))
      })
    })
  ).pipe(Layer.provide(http.layer))

  const layer = Layer.mergeAll(system, committees, storage, objects, Encoder.layer())

  return {
    fakes,
    nodes,
    chain,
    executed,
    executor,
    layer,
    get maxInFlight() {
      return maxInFlight
    },
    /** Move every party to `epoch` (the nodes then sign for it). */
    setEpoch: (e: number) => {
      epoch = e
      for (const f of fakes) f.epoch = e
    },
    run: <A, E>(effect: Effect.Effect<A, E, Write.WriteServices>) => Effect.runPromise(Effect.exit(Effect.provide(effect, layer)))
  }
}

type World = ReturnType<typeof makeWorld>

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)
const BLOB = bytes(1000)

const opts = <E2 = never>(world: World, extra: Partial<Write.WriteOptions<Aborted, never, E2>> = {}): Write.WriteOptions<Aborted, never, E2> => ({
  epochs: 2,
  deletable: true,
  executor: world.executor,
  linger: 0,
  ...extra
})

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected success, got ${String(exit.cause)}`)
}
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isFailure(exit)) {
    const e = exit.cause.reasons.find((r) => r._tag === "Fail")
    if (e && e._tag === "Fail") return e.error
  }
  throw new Error(`expected a typed failure, got ${Exit.isSuccess(exit) ? "success" : String(exit.cause)}`)
}

/** One node per shard group; `heavy` = [0..3] and [4..6] (7 shards in 2 nodes), then 3 single-shard nodes. */
const HEAVY_AND_LIGHT = [[0, 1, 2, 3], [4, 5, 6], [7], [8], [9]]
const rejecting = (): NonNullable<NodeSpec["intercept"]> => (req) => req.method === "PUT" && req.path.endsWith("/metadata") ? nodeErrors.missingSlivers() : undefined

// -----------------------------------------------------------------------------
// Upload and certificate
// -----------------------------------------------------------------------------

describe("upload", () => {
  test("a full write: every node stores its slivers, the certificate verifies on chain", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    const steps: Array<Write.Step> = []
    const certified = value(await world.run(Write.run(BLOB, opts(world, { onStep: (s) => Effect.sync(() => steps.push(s)) }))))
    expect(steps.map((s) => s._tag)).toEqual(["Encoded", "Registered", "Uploaded", "Certified"])
    expect(world.executed).toEqual(["register", "certify"])
    expect(certified.certifiedEpoch).toBe(5)
    expect(certified.endEpoch).toBe(7)
    const onChain = world.chain.get(certified.blobObjectId)!
    expect(Option.getOrUndefined(onChain.blob.certified_epoch)).toBe(5)
    expect(onChain.owner).toBe(OWNER)
    // Every shard's pair, both axes, is on its node.
    for (const f of world.fakes) {
      for (const shard of f.shards) {
        const pair = Encoding.pairOfShard(shard, certified.blobId, N)
        expect(f.slivers.has(sliverKey(certified.blobId, pair, "primary"))).toBe(true)
        expect(f.slivers.has(sliverKey(certified.blobId, pair, "secondary"))).toBe(true)
      }
    }
    // The saved steps are plain JSON and round-trip.
    const json = JSON.parse(JSON.stringify(steps.map((s) => Schema.encodeSync(Write.Step)(s))))
    expect(json.map((j: unknown) => Schema.decodeUnknownSync(Write.Step)(j))).toEqual(steps)
  })

  test("certificate at exactly n − f weight from two heavy nodes (the node count is irrelevant, item 5)", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards, i) => ({ shards, ...(i >= 2 && { intercept: rejecting() }) })))
    const steps: Array<Write.Step> = []
    value(await world.run(Write.run(BLOB, opts(world, { onStep: (s) => Effect.sync(() => steps.push(s)) }))))
    const uploaded = steps.find((s) => s._tag === "Uploaded")!
    expect(uploaded._tag === "Uploaded" && uploaded.certificate.signers).toEqual([0, 1])
    expect(world.executed).toEqual(["register", "certify"]) // the fake chain accepted weight 7 of 10
  })

  test("four of five nodes but six shards are not enough: NotEnoughConfirmations with every failure", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards, i) => ({ shards, ...(i === 0 && { intercept: rejecting() }) })))
    const e = failure(await world.run(Write.run(BLOB, opts(world))))
    expect(e._tag).toBe("NotEnoughConfirmations")
    if (e._tag !== "NotEnoughConfirmations") throw e
    expect(e.required).toBe(Bft.minCorrect(N))
    expect(e.failures).toEqual([{ node: world.nodes[0]!.url, weight: 4, kind: "Rejected", message: expect.any(String) }])
    expect(world.executed).toEqual(["register"])
  })

  test("fails fast once more than f weight failed, without waiting for a hung node", async () => {
    const world = makeWorld([
      { shards: [0, 1, 2, 3], intercept: rejecting() },
      { shards: [4, 5, 6], intercept: () => "hang" },
      { shards: [7, 8, 9] }
    ])
    const e = failure(await world.run(Write.run(BLOB, opts(world))))
    expect(e._tag).toBe("NotEnoughConfirmations")
  })

  test("NotRegistered is retried until the node sees the registration", async () => {
    let refusals = 2
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards, i) => ({
      shards,
      ...(i === 0 && {
        intercept: (req: Recorded) => req.method === "PUT" && req.path.endsWith("/metadata") && refusals-- > 0 ? nodeErrors.notRegistered() : undefined
      })
    })))
    const steps: Array<Write.Step> = []
    value(await world.run(Write.run(BLOB, opts(world, { retry: Schedule.recurs(3), onStep: (s) => Effect.sync(() => steps.push(s)) }))))
    expect(refusals).toBe(-1)
    const metadataPuts = world.fakes[0]!.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/metadata"))
    expect(metadataPuts.length).toBe(3)
    const uploaded = steps.find((s) => s._tag === "Uploaded")
    expect(uploaded?._tag === "Uploaded" && uploaded.certificate.signers).toContain(0)
  })

  const lyingCase = (name: string, sign: (i: number) => (m: Uint8Array) => Uint8Array, message: RegExp, intercept?: NodeSpec["intercept"]) =>
    test(name, async () => {
      // Node 0 is needed for the quorum (the others hold 6 shards), so its failure is visible.
      const world = makeWorld(HEAVY_AND_LIGHT.map((shards, i) => ({ shards, ...(i === 0 && { sign: sign(0), ...(intercept && { intercept }) }) })))
      const e = failure(await world.run(Write.run(BLOB, opts(world))))
      if (e._tag !== "NotEnoughConfirmations") throw e
      expect(e.failures.length).toBe(1)
      expect(e.failures[0]!.kind).toBe("InvalidSignature")
      expect(e.failures[0]!.message).toMatch(message)
    })

  lyingCase("a node signing with another key is InvalidSignature", () => signWith(11), /does not verify/)
  lyingCase("a node returning garbage as its signature is InvalidSignature", () => () => new Uint8Array(96).fill(1), /malformed/)
  lyingCase(
    "a node confirming another message is InvalidSignature",
    () => () => new Uint8Array(96),
    /differs/,
    (req, node) => {
      if (!req.path.includes("/confirmation/")) return undefined
      const message = Messages.confirmationMessage(node.epoch, BlobId.fromU256(42n), { _tag: "Permanent" })
      return {
        status: 200,
        contentType: "application/json",
        body: { success: { code: 200, data: { signed: { serializedMessage: Buffer.from(message).toString("base64"), signature: Buffer.from(signWith(0)(message)).toString("base64") } } } }
      }
    }
  )
  lyingCase(
    "a node confirming for an older epoch is InvalidSignature",
    () => () => new Uint8Array(96),
    /epoch 4, expected 5/,
    (req) => {
      if (!req.path.includes("/confirmation/")) return undefined
      const id = BlobId.fromString(req.path.split("/")[3]!)
      if (id._tag !== "Success") return undefined
      const objectId = req.path.split("/").at(-1)! as Address.Address
      const message = Messages.confirmationMessage(4, id.success, { _tag: "Deletable", objectId })
      return {
        status: 200,
        contentType: "application/json",
        body: { success: { code: 200, data: { signed: { serializedMessage: Buffer.from(message).toString("base64"), signature: Buffer.from(signWith(0)(message)).toString("base64") } } } }
      }
    }
  )

  test("the global semaphore bounds sliver PUTs in flight", async () => {
    const world = makeWorld([{ shards: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }], { putDelay: "2 millis" })
    const sliver = Encoding.bcsSliverBytes(BLOB.length, N).primary
    value(await world.run(Write.run(BLOB, opts(world, { maxInFlightBytes: 2 * sliver }))))
    expect(world.maxInFlight).toBe(2)

    const unbounded = makeWorld([{ shards: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }], { putDelay: "2 millis" })
    value(await unbounded.run(Write.run(BLOB, opts(unbounded))))
    expect(unbounded.maxInFlight).toBe(Write.PER_NODE_CONCURRENCY) // 20 slivers, 10 per node at once
  })

  test("after alreadyStored metadata, stored slivers of 5,560 bytes or more are not sent again", async () => {
    const big = bytes(30_000, 7)
    const world = makeWorld([{ shards: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }])
    const run = <A, E>(e: Effect.Effect<A, E, Write.WriteServices>) => world.run(e)
    const { encoded, step } = value(await run(Write.encode(big)))
    expect(encoded.primary[0]!.length).toBeGreaterThanOrEqual(Write.STATUS_CHECK_MIN_BYTES)
    const registered = value(await run(Write.register(step, opts(world))))
    // The node already holds the metadata and pairs 0..4 (an earlier, interrupted upload).
    const node = world.fakes[0]!
    node.metadata.set(step.blobId, encoded.metadata)
    for (let p = 0; p < 5; p++) {
      node.slivers.set(sliverKey(step.blobId, p, "primary"), encoded.primary[p]!)
      node.slivers.set(sliverKey(step.blobId, p, "secondary"), encoded.secondary[p]!)
    }
    value(await run(Write.upload(encoded, registered, { linger: 0 })))
    // Primary slivers (7 symbols) are over the limit and checked first; secondary ones (4 symbols) are just sent again.
    expect(encoded.secondary[0]!.length).toBeLessThan(Write.STATUS_CHECK_MIN_BYTES)
    const puts = node.requests.filter((r) => r.method === "PUT" && r.path.includes("/slivers/")).map((r) => r.path.split("/").slice(5, 7).join("/"))
    expect(puts.filter((p) => p.endsWith("primary")).sort()).toEqual(["5/primary", "6/primary", "7/primary", "8/primary", "9/primary"])
    expect(puts.filter((p) => p.endsWith("secondary")).length).toBe(10)
    expect(node.requests.filter((r) => r.path.endsWith("/status")).length).toBe(10)
  })

  test("small slivers are re-sent without a status check", async () => {
    const world = makeWorld([{ shards: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }])
    const { encoded, step } = value(await world.run(Write.encode(BLOB)))
    const registered = value(await world.run(Write.register(step, opts(world))))
    world.fakes[0]!.metadata.set(step.blobId, encoded.metadata)
    value(await world.run(Write.upload(encoded, registered, { linger: 0 })))
    expect(world.fakes[0]!.requests.filter((r) => r.path.endsWith("/status")).length).toBe(0)
  })

  test("a committee that disagrees with the system object is CommitteeMismatch", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    const { encoded, step } = value(await world.run(Write.encode(BLOB)))
    const registered = value(await world.run(Write.register(step, opts(world))))
    // Swap two nodes' order in the committee only.
    const nodes = [...world.nodes]
    ;[nodes[0], nodes[1]] = [nodes[1]!, nodes[0]!]
    const committee = { epoch: 5, nShards: N, nodes, nodeOfShard: () => nodes[0]! }
    const swapped = Committee.layerFromCommittees({ current: committee, previous: undefined, transitioning: false })
    const exit = await Effect.runPromise(Effect.exit(Write.upload(encoded, registered).pipe(Effect.provide(Layer.merge(world.layer, swapped)))))
    expect(failure(exit)._tag).toBe("CommitteeMismatch")
  })
})

// -----------------------------------------------------------------------------
// Linger (TestClock)
// -----------------------------------------------------------------------------

describe("linger", () => {
  const timedUpload = async (world: World, linger?: Write.Linger) => {
    const { encoded, step } = value(await world.run(Write.encode(BLOB)))
    const registered = value(await world.run(Write.register(step, opts(world))))
    return Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          Effect.flatMap(Write.upload(encoded, registered, linger === undefined ? {} : { linger }), (u) => Effect.map(Clock.currentTimeMillis, (at) => ({ u, at })))
        )
        // Small steps with a real macrotask in between: the fake HTTP answers go through real promises.
        for (let t = 0; t < 5000 && fiber.pollUnsafe() === undefined; t += 50) {
          yield* TestClock.adjust("50 millis")
          yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
        }
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.merge(world.layer, TestClock.layer())))
    )
  }

  test("the default window is 0.5 × elapsed + 500 ms and collects late confirmations", async () => {
    // Threshold (7 shards) at t = 1 s; window 1 s; node 2 at 1.8 s is in, node 3 at 2.5 s is out.
    const world = makeWorld([
      { shards: [0, 1, 2, 3], confirmDelay: "1 second" },
      { shards: [4, 5, 6], confirmDelay: "1 second" },
      { shards: [7], confirmDelay: "1800 millis" },
      { shards: [8, 9], confirmDelay: "2500 millis" }
    ])
    const { at, u } = await timedUpload(world)
    expect(at).toBe(2000) // 1.5 t + 500 ms
    expect(u.certificate.signers).toEqual([0, 1, 2])
  })

  test("linger 0 returns at the threshold", async () => {
    const world = makeWorld([
      { shards: [0, 1, 2, 3], confirmDelay: "1 second" },
      { shards: [4, 5, 6], confirmDelay: "1 second" },
      { shards: [7, 8, 9], confirmDelay: "1200 millis" }
    ])
    const { at, u } = await timedUpload(world, 0)
    expect(at).toBe(1000)
    expect(u.certificate.signers).toEqual([0, 1])
  })
})

// -----------------------------------------------------------------------------
// Steps and resuming
// -----------------------------------------------------------------------------

class Crash extends Schema.TaggedError<Crash>()("Crash", {}) {}

/** Run until `at` is saved, then crash; return the saved step. */
const crashAfter = async (world: World, at: Write.Step["_tag"], blobBytes = BLOB) => {
  let saved: Write.Step | undefined
  const exit = await world.run(Write.run(blobBytes, opts<Crash>(world, {
    onStep: (s) => Effect.suspend(() => { saved = s; return s._tag === at ? Effect.fail(new Crash()) : Effect.void })
  })))
  expect(failure(exit)._tag).toBe("Crash")
  return saved!
}

describe("steps", () => {
  for (const at of ["Encoded", "Registered", "Uploaded", "Certified"] as const) {
    test(`resume from a saved ${at} step: one register and one certify in total`, async () => {
      const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
      const saved = await crashAfter(world, at)
      expect(saved._tag).toBe(at)
      const certified = value(await world.run(Write.run(BLOB, opts(world, { resume: saved }))))
      expect(world.executed).toEqual(["register", "certify"])
      expect(world.chain.size).toBe(1)
      expect(Option.getOrUndefined(world.chain.get(certified.blobObjectId)!.blob.certified_epoch)).toBe(5)
    })
  }

  test("register reuses an owned uncertified Blob (a crash before the step was saved, item 14)", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    const { step } = value(await world.run(Write.encode(BLOB)))
    const registered = value(await world.run(Write.register(step, opts(world))))
    const certified = value(await world.run(Write.run(BLOB, opts(world))))
    expect(certified.blobObjectId).toBe(registered.blobObjectId)
    expect(world.executed).toEqual(["register", "certify"])
  })

  test("register does not reuse a Blob that is certified, too short, or of the other persistence", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    const { step } = value(await world.run(Write.encode(BLOB)))
    value(await world.run(Write.register(step, opts(world, { epochs: 1 }))))
    value(await world.run(Write.register(step, opts(world, { deletable: false }))))
    value(await world.run(Write.register(step, opts(world, { epochs: 2 }))))
    expect(world.executed).toEqual(["register", "register", "register"])
    value(await world.run(Write.register(step, opts(world, { epochs: 2 }))))
    value(await world.run(Write.register(step, opts(world, { epochs: 1 }))))
    expect(world.executed.length).toBe(3)
  })

  test("a certificate from an older epoch goes back to upload (M4)", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    const saved = await crashAfter(world, "Uploaded")
    expect(saved._tag === "Uploaded" && saved.certificate.epoch).toBe(5)
    world.setEpoch(6)
    const steps: Array<Write.Step> = []
    const certified = value(await world.run(Write.run(BLOB, opts(world, { resume: saved, onStep: (s) => Effect.sync(() => steps.push(s)) }))))
    expect(steps.map((s) => s._tag)).toEqual(["Uploaded", "Certified"])
    expect(steps[0]!._tag === "Uploaded" && steps[0]!.certificate.epoch).toBe(6)
    expect(certified.certifiedEpoch).toBe(6)
    expect(world.executed).toEqual(["register", "certify"])
  })

  test("certify alone reports a stale certificate as CertificateStale", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    const saved = await crashAfter(world, "Uploaded")
    world.setEpoch(6)
    if (saved._tag !== "Uploaded") throw new Error("not uploaded")
    const e = failure(await world.run(Write.certify(saved, { executor: world.executor })))
    expect(e).toMatchObject({ _tag: "CertificateStale", certificateEpoch: 5, epoch: 6 })
  })

  test("an already certified blob is not certified twice", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    let uploaded: Write.Step | undefined
    value(await world.run(Write.run(BLOB, opts(world, { onStep: (s) => Effect.sync(() => { if (s._tag === "Uploaded") uploaded = s }) }))))
    const again = value(await world.run(Write.run(BLOB, opts(world, { resume: uploaded! }))))
    expect(again.certifiedEpoch).toBe(5)
    expect(world.executed).toEqual(["register", "certify"])
  })

  test("a registration that is gone is RegistrationFailed", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    const saved = await crashAfter(world, "Registered")
    world.chain.clear()
    expect(failure(await world.run(Write.run(BLOB, opts(world, { resume: saved }))))._tag).toBe("RegistrationFailed")
  })

  test("resuming with other bytes is ResumeMismatch, for every step", async () => {
    for (const at of ["Encoded", "Registered", "Uploaded", "Certified"] as const) {
      const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
      const saved = await crashAfter(world, at)
      const e = failure(await world.run(Write.run(bytes(1000, 2), opts(world, { resume: saved }))))
      expect(e._tag).toBe("ResumeMismatch")
    }
  })

  test("stream: the steps, pulled one at a time", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    const first = await world.run(Stream.runCollect(Stream.take(Write.stream(BLOB, opts(world)), 2)))
    expect(Array.from(value(first)).map((s) => s._tag)).toEqual(["Encoded", "Registered"])
    expect(world.executed).toEqual(["register"]) // nothing ran past what was pulled
    const all = Array.from(value(await world.run(Stream.runCollect(Write.stream(BLOB, opts(world))))))
    expect(all.map((s) => s._tag)).toEqual(["Encoded", "Registered", "Uploaded", "Certified"])
    expect(world.executed).toEqual(["register", "certify"]) // the second run reused the registration
  })

  test("a blob too large for the committee is BlobTooLarge before any encoding", async () => {
    const world = makeWorld(HEAVY_AND_LIGHT.map((shards) => ({ shards })))
    const tooLarge = { length: Encoding.maxBlobSize(N) + 1 } as Uint8Array
    expect(failure(await world.run(Write.encode(tooLarge)))._tag).toBe("BlobTooLarge")
  })
})
