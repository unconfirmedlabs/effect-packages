/**
 * Live decryption under an owned-object policy on testnet (§6.4). **Spends
 * SUI.** Opt in with SUI_LIVE=1 and SEAL_LIVE=1; with SUI_LIVE=1 alone this
 * file spends nothing (the test is skipped).
 *
 * The signer is `SUI_LIVE_PRIVATE_KEY` (a `suiprivkey1…` key of a funded
 * testnet account), as in `packages/effect-walrus/test/live.write.test.ts`. The key
 * is never printed, logged or written; any error while loading it becomes one
 * fixed message.
 *
 * `private_data::store_entry(nonce, data)` on Mysten's canary package creates
 * a `PrivateData` object owned by the wallet whose key id is
 * `bcs(sender) ‖ nonce`. 32 bytes are encrypted under that id (2 of 3:
 * Mysten's two servers and the committee) and decrypted at once with
 * `private_data::seal_approve(id, &PrivateData)`: an owned-object input, the
 * wallet's key signing the session's personal message, and a seconds-old
 * object (servers whose fullnode lags answer `InvalidParameter`, which is
 * retried). The canary predates `private_data::destroy`, so each run leaves
 * one small object behind (storage is not refunded).
 *
 * Measured runs (testnet, 2026-11-27, 16-byte nonce, 32 bytes of data; SUI is
 * the store transaction's gas: computation + storage − rebate):
 *
 * | Run | SUI (MIST) | Digest (store_entry) | Object |
 * |---|---|---|---|
 * | 1 | 2,991,200 (computation 1,000,000, storage 1,991,200, rebate 0) | 3hekLPTi13dttyMaba1Qb2B5VZ9A8w5Fhh4ZGrmvnX5X | 0xd2aacbdd…6e8db2 |
 *
 * So about 0.003 SUI per run, as simulated in §6.4. The id format
 * `bcs(sender) ‖ nonce` is confirmed: the servers released the keys. The
 * whole test took 3 s. Balance after run 1: 1,113,531,326 MIST.
 */
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import type * as Address from "@unconfirmed/effect-sui/Address"
import * as Coins from "@unconfirmed/effect-sui/Coins"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import type * as Transactions from "@unconfirmed/effect-sui/Transactions"
import * as Tx from "@unconfirmed/effect-sui/Tx"
import * as SuiGrpc from "@unconfirmed/effect-sui/grpc"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { loadLiveSigner } from "@unconfirmed/test-support/funded"
import * as Approval from "../src/Approval.ts"
import * as Config from "../src/Config.ts"
import * as Seal from "../src/Seal.ts"

const live = process.env.SUI_LIVE === "1" && process.env.SEAL_LIVE === "1"
const suite = live ? describe : describe.skip
const FULLNODE = process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443"
const CANARY = "0x58dce5d91278bceb65d44666ffa225ab397fc3ae9d8398c8c779c5530bd978c2"
const MIN_BALANCE = 50_000_000n // 0.05 SUI
const TIMEOUT = 120_000

// -----------------------------------------------------------------------------
// Signer (never print the key)
// -----------------------------------------------------------------------------

const loadSigner = loadLiveSigner

// -----------------------------------------------------------------------------
// Layers
// -----------------------------------------------------------------------------

const layer = Seal.layer({ servers: [Config.testnet.mysten1, Config.testnet.mysten2, Config.testnet.committee] }).pipe(
  Layer.provideMerge(SuiGrpc.layer({ url: FULLNODE })),
  Layer.provideMerge(FetchHttpClient.layer)
)
type Services = Layer.Success<typeof layer>
const runLive = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runPromise(Effect.provide(effect, layer))

const balance = (owner: Address.Address) =>
  Effect.flatMap(Effect.service(Coins.Coins), (c) => c.getBalance(owner)).pipe(Effect.map((b) => b.total))

const gasOf = (e: Transactions.Effects) => e.gasUsed.computationCost + e.gasUsed.storageCost - e.gasUsed.storageRebate

// -----------------------------------------------------------------------------
// The case
// -----------------------------------------------------------------------------

suite("live owned-object policy (testnet, spends funds)", () => {
  test("private_data: store, encrypt under bcs(sender) ‖ nonce, decrypt with the owned object", async () => {
    const signer = await loadSigner()
    const before = await runLive(balance(signer.address))
    if (before < MIN_BALANCE) {
      console.warn(`[live.owned] skipped: balance ${before} MIST is below 0.05 SUI`)
      return
    }
    const nonce = crypto.getRandomValues(new Uint8Array(16))
    const data = crypto.getRandomValues(new Uint8Array(32))

    const effects = await runLive(Tx.run(
      Effect.gen(function*() {
        yield* Ptb.moveCall({
          target: `${CANARY}::private_data::store_entry`,
          arguments: [yield* Ptb.pure(Bcs.byteVector, nonce), yield* Ptb.pure(Bcs.byteVector, data)]
        })
      }),
      { signer }
    ))
    expect(effects.status._tag).toBe("Success")
    const created = effects.changedObjects.find((o) => o.operation === "Created" && o.type?.endsWith("::private_data::PrivateData"))
    expect(created).toBeDefined()
    const objectId = created!.objectId

    // The key id: bcs(sender) is the 32 address bytes.
    const id = new Uint8Array([...Uint8Array.from(Buffer.from(signer.address.slice(2), "hex")), ...nonce])
    const plain = await runLive(Effect.gen(function*() {
      const { encryptedObject } = yield* Seal.encrypt({ packageId: CANARY, id, data, threshold: 2 })
      const session = yield* Seal.session({ packageId: CANARY, signer })
      // The fullnode may not have indexed the object yet: resolve until it has.
      const approval = yield* Approval.fromRecipe(
        Approval.call({ target: `${CANARY}::private_data::seal_approve`, id, arguments: [Ptb.object(objectId)] })
      ).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 15 }))
      return yield* Seal.decrypt({ data: encryptedObject, session, approval })
    }))
    expect(plain).toEqual(data)

    const after = await runLive(balance(signer.address))
    // Amounts and digests only; nothing about the key.
    console.log(
      `[live.owned] store_entry ${effects.digest}: gas ${gasOf(effects)} MIST (computation ${effects.gasUsed.computationCost}, storage ${effects.gasUsed.storageCost}, rebate ${effects.gasUsed.storageRebate}); object ${objectId}; balance ${before} -> ${after} MIST`
    )
  }, TIMEOUT)
})
