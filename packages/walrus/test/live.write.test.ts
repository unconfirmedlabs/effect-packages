/**
 * Live writes on testnet (§6.4, cases 1–2). **Spends SUI and WAL.** Opt in
 * with SUI_LIVE=1 and WALRUS_LIVE=1; with SUI_LIVE=1 alone this file spends
 * nothing (every test is skipped).
 *
 * The signer is the Sui CLI's active address, loaded from
 * `~/.sui/sui_config/sui.keystore`. The key is never printed, logged or
 * written; any error while loading it becomes one fixed message.
 *
 * Blobs are 32 random bytes, deletable, 1 epoch, and burned afterwards.
 *
 * Measured runs (testnet, 2026-11-27, n = 1000, 32-byte blobs, 1 epoch;
 * SUI is the balance change including the burn's rebate; WAL is
 * 63 units × (4724 + 9421) FROST):
 *
 * | Run | Case | SUI (MIST) | WAL (FROST) | Digests (register, certify, burn) |
 * |---|---|---|---|---|
 * | 1 | 1 direct | 3,011,676 | 891,135 | HjNwC8WW…, A6dKAfon…, J5Qfvmt4… |
 * | 2 | 2 resume | 4,017,875 | 891,135 | 9QkZBfmy…, 39n5W3kA…, Wf4pVUMa… |
 * | 3 | 1 direct | 4,017,875 | 891,135 | 4LE8eP4F…, GJK2Qg4j…, DK3QXs6F… |
 * | 4 | 2 resume | 3,011,676 | 891,135 | 76eKdjAP…, 28GBL9S5…, A3DWYBic… |
 *
 * So a write with cleanup costs about 0.003–0.004 SUI and 0.00089 WAL. The
 * register transaction's gas budget is resolved automatically (it rewrites
 * the system object, so the budget is about 0.12 SUI; most is not charged).
 * Balance after run 4: 1,146,580,225 MIST, 936,093,052 FROST.
 *
 * Until the read path (W5) lands, the read-back uses the nodes directly: a
 * quorum of `n − 2f` primary slivers, decoded, compared with the bytes; and
 * `f + 1` shards' worth of nodes reporting the blob certified.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Quorum from "@unconfirmed/quorum/Quorum"
import * as Address from "@unconfirmed/sui/Address"
import * as Coins from "@unconfirmed/sui/Coins"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as Objects from "@unconfirmed/sui/Objects"
import * as PrivateKey from "@unconfirmed/sui/PrivateKey"
import type * as Signer from "@unconfirmed/sui/Signer"
import type * as Transactions from "@unconfirmed/sui/Transactions"
import * as Tx from "@unconfirmed/sui/Tx"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import * as Bft from "../src/Bft.ts"
import * as BlobId from "../src/BlobId.ts"
import * as Committee from "../src/Committee.ts"
import * as Config from "../src/Config.ts"
import * as Encoder from "../src/Encoder.ts"
import * as Encoding from "../src/Encoding.ts"
import * as Recipes from "../src/Recipes.ts"
import * as Status from "../src/Status.ts"
import * as StorageNode from "../src/StorageNode.ts"
import * as System from "../src/System.ts"
import * as Write from "../src/Write.ts"

const live = process.env.SUI_LIVE === "1" && process.env.WALRUS_LIVE === "1"
const suite = live ? describe : describe.skip
const FULLNODE = process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443"
const TIMEOUT = 300_000

// -----------------------------------------------------------------------------
// Signer (never print the key)
// -----------------------------------------------------------------------------

const loadSigner = async (): Promise<Signer.Signer> => {
  try {
    const dir = `${homedir()}/.sui/sui_config`
    const active = /active_address:\s*"?(0x[0-9a-fA-F]{64})/.exec(readFileSync(`${dir}/client.yaml`, "utf-8"))![1]!.toLowerCase()
    const keys = await Effect.runPromise(PrivateKey.decodeKeystore(readFileSync(`${dir}/sui.keystore`, "utf-8")))
    for (const key of keys) {
      const signer = key.scheme === "ED25519"
        ? await Effect.runPromise(Ed25519.fromSecretKey(key.secretKey))
        : key.scheme === "Secp256k1"
        ? await Effect.runPromise((await import("@unconfirmed/sui-secp256k1")).fromSecretKey(key.secretKey))
        : key.scheme === "Secp256r1"
        ? await Effect.runPromise((await import("@unconfirmed/sui-secp256r1")).fromSecretKey(key.secretKey))
        : undefined
      if (signer?.address === active) return signer
    }
  } catch {
    // fall through to the fixed message: no key material in assertion output
  }
  throw new Error("could not load the Sui CLI signer for the active address")
}

// -----------------------------------------------------------------------------
// Layers and helpers
// -----------------------------------------------------------------------------

const layer = Layer.mergeAll(System.layer, Committee.layer(), StorageNode.layer(), Encoder.layer()).pipe(
  Layer.provideMerge(Config.layer(Config.testnet)),
  Layer.provideMerge(SuiGrpc.layer({ baseUrl: FULLNODE })),
  Layer.provideMerge(FetchHttpClient.layer)
)

type Services = Layer.Success<typeof layer>
const runLive = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runPromise(Effect.provide(effect, layer))

const balances = (owner: Address.Address) =>
  Effect.gen(function*() {
    const coins = yield* Effect.service(Coins.Coins)
    const walType = yield* Effect.flatMap(Effect.service(System.System), (s) => s.walType)
    const sui = yield* coins.getBalance(owner)
    const wal = yield* coins.getBalance(owner, walType)
    return { sui: sui.total, wal: wal.total }
  })

const gasOf = (e: Transactions.Effects) => e.gasUsed.computationCost + e.gasUsed.storageCost - e.gasUsed.storageRebate

const burn = (signer: Signer.Signer, blobObjectId: Address.Address) =>
  Tx.run(Recipes.burnBlob(blobObjectId), { signer })

/** Read the blob back from the nodes: `n − 2f` primary slivers, decoded. */
const readBack = (blobId: BlobId.BlobId, length: number) =>
  Effect.gen(function*() {
    const { current } = yield* Effect.flatMap(Effect.service(Committee.Committees), (c) => c.get)
    const nodes = yield* Effect.service(StorageNode.StorageNodes)
    const n = current.nShards
    const shards = Array.from({ length: n }, (_, i) => i)
    const { successes } = yield* Quorum.run(shards, {
      weight: () => 1,
      threshold: n - 2 * Bft.maxFaulty(n),
      concurrency: 200,
      order: "shuffle",
      run: (shard) => nodes.sliver(current.nodeOfShard(shard), blobId, Encoding.pairOfShard(shard, blobId, n), "primary")
    })
    return yield* (yield* Effect.service(Encoder.Encoder)).decode(n, length, successes.map((s) => s.value))
  })

/** `f + 1` shards' worth of nodes report the blob certified (they may need a moment to see the event). */
const certifiedByNodes = (blobId: BlobId.BlobId) =>
  Effect.gen(function*() {
    const { current } = yield* Effect.flatMap(Effect.service(Committee.Committees), (c) => c.get)
    const nodes = yield* Effect.service(StorageNode.StorageNodes)
    const { successes } = yield* Quorum.run(current.nodes, {
      weight: (node) => node.shards.length,
      threshold: Bft.validity(current.nShards),
      run: (node) =>
        Effect.flatMap(nodes.status(node, blobId), (s) =>
          Status.certifiedEpoch(s) === undefined
            ? Effect.fail(new StorageNode.NodeError({ node: node.url, kind: "Unavailable", message: `not certified yet: ${s._tag}` }))
            : Effect.succeed(s)),
      schedule: Schedule.spaced("1 second"),
      while: (e) => e.message.startsWith("not certified yet") || StorageNode.retryable(e)
    }).pipe(Effect.timeout("60 seconds"))
    return successes.map((s) => s.value)
  })

const ownedBlobs = (owner: Address.Address, blobId: BlobId.BlobId) =>
  Effect.gen(function*() {
    const type = yield* Recipes.blobType
    const owned = yield* Stream.runCollect((yield* Effect.service(Objects.Objects)).listOwned(owner, { type }))
    const id = BlobId.toU256(blobId)
    return Array.from(owned).filter((o) => {
      // blob_id is the u256 after the 32-byte UID and the u32 registered_epoch.
      let v = 0n
      for (let i = 63; i >= 32; i--) v = (v << 8n) | BigInt(o.contents[i + 4]!)
      return v === id
    }).map((o) => o.objectId)
  })

const randomBlob = () => crypto.getRandomValues(new Uint8Array(32))

const report = (name: string, digests: Record<string, string>, before: { sui: bigint; wal: bigint }, after: { sui: bigint; wal: bigint }) =>
  // Amounts and digests only; nothing about the key.
  console.log(
    `[live.write] ${name}: digests ${JSON.stringify(digests)}; SUI spent ${before.sui - after.sui} MIST; WAL spent ${
      before.wal - after.wal
    } FROST; balance now ${after.sui} MIST, ${after.wal} FROST`
  )

// -----------------------------------------------------------------------------
// Cases
// -----------------------------------------------------------------------------

suite("live writes (testnet, spends funds)", () => {
  test("1. direct: write, read back, certified on the nodes, burn", async () => {
    const signer = await loadSigner()
    const before = await runLive(balances(signer.address))
    if (before.sui < 300_000_000n || before.wal < 10_000_000n) {
      console.warn(`[live.write] skipped: balance ${before.sui} MIST / ${before.wal} FROST is below 0.3 SUI / 0.01 WAL`)
      return
    }
    const bytes = randomBlob()
    const steps: Array<Write.Step> = []
    const digests: Record<string, string> = {}
    let blobObjectId: Address.Address | undefined
    try {
      const certified = await runLive(Write.run(bytes, {
        epochs: 1,
        deletable: true,
        executor: Write.viaTx(signer),
        onStep: (s) =>
          Effect.sync(() => {
            steps.push(s)
            if (s._tag === "Registered") {
              blobObjectId = s.blobObjectId
              if (s.digest) digests.register = s.digest
            }
          })
      }))
      if (certified.digest) digests.certify = certified.digest
      expect(steps.map((s) => s._tag)).toEqual(["Encoded", "Registered", "Uploaded", "Certified"])
      const uploaded = steps[2]!
      if (uploaded._tag !== "Uploaded") throw new Error("no Uploaded step")
      expect(uploaded.certificate.epoch).toBe(certified.certifiedEpoch)
      expect(certified.endEpoch).toBe(certified.certifiedEpoch + 1)

      const read = await runLive(readBack(certified.blobId, bytes.length))
      expect(read).toEqual(bytes)
      const statuses = await runLive(certifiedByNodes(certified.blobId))
      expect(statuses.length).toBeGreaterThan(0)
    } finally {
      if (blobObjectId !== undefined) digests.burn = (await runLive(burn(signer, blobObjectId))).digest
      report("case 1", digests, before, await runLive(balances(signer.address)))
    }
  }, TIMEOUT)

  test("2. resume: register, drop all state, run again: the registration is reused", async () => {
    const signer = await loadSigner()
    const before = await runLive(balances(signer.address))
    if (before.sui < 300_000_000n || before.wal < 10_000_000n) {
      console.warn(`[live.write] skipped: balance ${before.sui} MIST / ${before.wal} FROST is below 0.3 SUI / 0.01 WAL`)
      return
    }
    const bytes = randomBlob()
    const digests: Record<string, string> = {}
    const toBurn = new Set<Address.Address>()
    try {
      const options = { epochs: 1, deletable: true, executor: Write.viaTx(signer) }
      const registered = await runLive(Effect.flatMap(Write.encode(bytes), ({ step }) => Write.register(step, options)))
      toBurn.add(registered.blobObjectId)
      if (registered.digest) digests.register = registered.digest
      // The crash: nothing is kept. Wait until the owner index shows the Blob, as it would by the time a process restarts.
      await runLive(
        ownedBlobs(signer.address, registered.blobId).pipe(
          Effect.filterOrFail((ids) => ids.includes(registered.blobObjectId), () => new Error("not indexed yet")),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 })
        )
      )

      const steps: Array<Write.Step> = []
      const certified = await runLive(Write.run(bytes, { ...options, onStep: (s) => Effect.sync(() => steps.push(s)) }))
      toBurn.add(certified.blobObjectId)
      if (certified.digest) digests.certify = certified.digest
      expect(certified.blobObjectId).toBe(registered.blobObjectId)
      const second = steps.find((s) => s._tag === "Registered")
      expect(second?._tag === "Registered" && second.digest).toBe(undefined) // no second register transaction
      const owned = await runLive(ownedBlobs(signer.address, registered.blobId))
      expect(owned).toEqual([registered.blobObjectId])
    } finally {
      for (const id of toBurn) digests[`burn ${id.slice(0, 10)}`] = (await runLive(burn(signer, id))).digest
      report("case 2", digests, before, await runLive(balances(signer.address)))
    }
  }, TIMEOUT)
})
