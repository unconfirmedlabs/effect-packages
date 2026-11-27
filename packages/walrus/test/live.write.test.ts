/**
 * Live writes on testnet (§6.4, cases 1–4). **Spends SUI and WAL.** Opt in
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
 * | 5 | 3 relay (W8) | 3,975,382 | 891,135 | 38XNVBBH…, —, BmeoWciP… (relay accepted the tip; the response parse failed: `blob_id` is a byte array, fixed) |
 * | 6 | 3 relay | 3,999,781 | 891,135 | Gm3roqAC…, GBidX3Sq…, Hj7uTr63… |
 * | 7 | 1 direct | 4,017,875 | 891,135 | 3nWZJtTV…, 3mbeUbCt…, CnAgr59v… |
 * | 8 | 2 resume | 4,017,875 | 891,135 | 5wK7Srmz…, 9SBknNf2…, 5JAtvGWE… |
 * | 9 | 3 relay | 5,005,980 | 891,135 | 9Qx1dpFz…, B72Zw37p…, 7dp4MysX… |
 *
 * So a write with cleanup costs about 0.003–0.005 SUI and 0.00089 WAL. The
 * register transaction's gas budget is resolved automatically (it rewrites
 * the system object, so the budget is about 0.12 SUI; most is not charged).
 * Through the relay, the register transaction also carries the auth input
 * (input 0, 72 bytes) and the relay's tip: 105 MIST (testnet's constant tip),
 * a coin redeemed from the address balance and transferred to the tip
 * address; the relay accepts it (balance change +105 to
 * `0x4b6a…52b6` in Gm3roqAC…). The relay path's SUI includes that tip and the
 * tip coin's storage.
 * Balance after run 9: 1,128,551,532 MIST, 931,637,377 FROST.
 *
 * Case 1 reads back with `Read.blob` and checks `Read.status` (retried until
 * the nodes have seen the certification).
 *
 * Case 4 (W9) writes a three-entry quilt (`Quilt.encode` at n = 1000 gives a
 * 445,556-byte blob, still 63 storage units) with `Quilt.ATTRIBUTE`, reads one
 * patch by id from verified secondary slivers and one by identifier, then
 * burns it. The address is shared with other live runs, so a balance change
 * can include their transactions.
 *
 * | Run | Case | SUI (MIST) | WAL (FROST) | Digests (register, certify, burn) |
 * |---|---|---|---|---|
 * | 5 | 4 quilt | 6,001,475 | 891,135 | 5neYUEPk…, CkUUakBw…, Eef8ntaN… |
 * | 6 | 1 direct (`Read`) | 4,017,875 | 891,135 | 9Bm8TECa…, 2yLdjgdt…, HzL7YfZF… |
 * | 7 | 4 quilt | 3,011,874 | 891,135 | 5FuvqCJu…, CrrhbW9R…, CsCAaxgR… |
 *
 * Balance after run 7: 1,120,522,307 MIST, 928,963,972 FROST.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Address from "@unconfirmed/sui/Address"
import * as Coins from "@unconfirmed/sui/Coins"
import * as Objects from "@unconfirmed/sui/Objects"
import type * as Signer from "@unconfirmed/sui/Signer"
import type * as Transactions from "@unconfirmed/sui/Transactions"
import * as Tx from "@unconfirmed/sui/Tx"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import { loadCliSigner } from "@unconfirmed/test-support/keystore"
import * as BlobId from "../src/BlobId.ts"
import * as Committee from "../src/Committee.ts"
import * as Config from "../src/Config.ts"
import * as Encoder from "../src/Encoder.ts"
import * as Quilt from "../src/Quilt.ts"
import * as QuiltRead from "../src/QuiltRead.ts"
import * as Read from "../src/Read.ts"
import * as Recipes from "../src/Recipes.ts"
import * as Status from "../src/Status.ts"
import * as StorageNode from "../src/StorageNode.ts"
import * as System from "../src/System.ts"
import * as UploadRelay from "../src/UploadRelay.ts"
import * as Write from "../src/Write.ts"

const live = process.env.SUI_LIVE === "1" && process.env.WALRUS_LIVE === "1"
const suite = live ? describe : describe.skip
const FULLNODE = process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443"
const TIMEOUT = 300_000

// -----------------------------------------------------------------------------
// Signer (never print the key)
// -----------------------------------------------------------------------------

const loadSigner = loadCliSigner

// -----------------------------------------------------------------------------
// Layers and helpers
// -----------------------------------------------------------------------------

const RELAY = process.env.WALRUS_RELAY_URL ?? UploadRelay.TESTNET_HOST

const layer = Layer.mergeAll(
  System.layer,
  Committee.layer(),
  StorageNode.layer(),
  Encoder.layer(),
  UploadRelay.layer({ host: RELAY, maxTip: 1_000_000n })
).pipe(
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

/** `Read.status` until it reports the blob certified (nodes may need a moment to see the event). */
const certifiedStatus = (blobId: BlobId.BlobId) =>
  Read.status(blobId).pipe(
    Effect.filterOrFail((s) => Status.certifiedEpoch(s) !== undefined, (s) => new Error(`not certified yet: ${s._tag}`)),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 })
  )

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

      const read = await runLive(Read.blob(certified.blobId))
      expect(read).toEqual(bytes)
      const status = await runLive(certifiedStatus(certified.blobId))
      expect(Status.certifiedEpoch(status)).toBe(certified.certifiedEpoch)
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

  test("3. relay: write through the testnet upload relay (tip from the address balance), read back, burn", async () => {
    const signer = await loadSigner()
    const before = await runLive(balances(signer.address))
    if (before.sui < 300_000_000n || before.wal < 10_000_000n) {
      console.warn(`[live.write] skipped: balance ${before.sui} MIST / ${before.wal} FROST is below 0.3 SUI / 0.01 WAL`)
      return
    }
    const tipConfig = await runLive(Effect.flatMap(Effect.service(UploadRelay.UploadRelay), (r) => r.tipConfig))
    const bytes = randomBlob()
    const steps: Array<Write.Step> = []
    const digests: Record<string, string> = {}
    let blobObjectId: Address.Address | undefined
    try {
      const certified = await runLive(Write.run(bytes, {
        epochs: 1,
        deletable: true,
        executor: Write.viaTx(signer),
        via: "relay",
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
      const encoded = steps[0]!
      expect(encoded._tag === "Encoded" && encoded.relayNonce?.length).toBe(32)
      const uploaded = steps[2]!
      if (uploaded._tag !== "Uploaded") throw new Error("no Uploaded step")
      expect(uploaded.certificate.epoch).toBe(certified.certifiedEpoch)

      const read = await runLive(Read.blob(certified.blobId))
      expect(read).toEqual(bytes)
      const status = await runLive(certifiedStatus(certified.blobId))
      expect(Status.certifiedEpoch(status)).toBe(certified.certifiedEpoch)
    } finally {
      if (blobObjectId !== undefined) digests.burn = (await runLive(burn(signer, blobObjectId))).digest
      const tip = tipConfig._tag === "SendTip" ? UploadRelay.tipAmount(tipConfig, bytes.length, 1000) : 0n
      console.log(`[live.write] case 3: relay ${RELAY}, tip ${tip} MIST (${tipConfig._tag})`)
      report("case 3", digests, before, await runLive(balances(signer.address)))
    }
  }, TIMEOUT)

  test("4. quilt: three entries; one patch by id from verified slivers, one by identifier; burn", async () => {
    const signer = await loadSigner()
    const before = await runLive(balances(signer.address))
    if (before.sui < 300_000_000n || before.wal < 10_000_000n) {
      console.warn(`[live.write] skipped: balance ${before.sui} MIST / ${before.wal} FROST is below 0.3 SUI / 0.01 WAL`)
      return
    }
    const entries: ReadonlyArray<Quilt.QuiltEntry> = [
      { identifier: "hello.txt", contents: new TextEncoder().encode("hello, quilt"), tags: { "content-type": "text/plain" } },
      { identifier: "random.bin", contents: randomBlob() },
      { identifier: "note.json", contents: new TextEncoder().encode(JSON.stringify({ at: Date.now() })) }
    ]
    const digests: Record<string, string> = {}
    let blobObjectId: Address.Address | undefined
    try {
      const { nShards } = await runLive(Effect.flatMap(Effect.service(System.System), (s) => s.state))
      const encoded = Quilt.encode(entries, nShards)
      if (encoded._tag === "Failure") throw new Error(encoded.failure.reason)
      const { quilt, patches } = encoded.success
      const certified = await runLive(Write.run(quilt, {
        epochs: 1,
        deletable: true,
        attributes: Quilt.ATTRIBUTE,
        executor: Write.viaTx(signer),
        onStep: (s) =>
          Effect.sync(() => {
            if (s._tag === "Registered") {
              blobObjectId = s.blobObjectId
              if (s.digest) digests.register = s.digest
            }
          })
      }))
      if (certified.digest) digests.certify = certified.digest

      const random = patches.find((p) => p.identifier === "random.bin")!
      const byId = await runLive(QuiltRead.patch(Quilt.patchId(certified.blobId, random)))
      expect(byId).toEqual({ identifier: "random.bin", tags: {}, contents: entries[1]!.contents })
      const byName = await runLive(QuiltRead.byIdentifier(certified.blobId, "hello.txt"))
      expect(byName).toEqual({ identifier: "hello.txt", tags: { "content-type": "text/plain" }, contents: entries[0]!.contents })
      console.log(`[live.write] case 4: quilt ${certified.blobId}, ${quilt.length} bytes, patches ${patches.map((p) => `${p.identifier} [${p.startIndex}, ${p.endIndex})`).join(", ")}`)
    } finally {
      if (blobObjectId !== undefined) digests.burn = (await runLive(burn(signer, blobObjectId))).digest
      report("case 4", digests, before, await runLive(balances(signer.address)))
    }
  }, TIMEOUT)
})
