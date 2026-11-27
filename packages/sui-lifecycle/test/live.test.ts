/**
 * Against devnet over gRPC-web. Opt in with SUI_LIVE=1.
 */
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Option } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import { GrpcWeb } from "@unconfirmed/sui/grpc/GrpcWeb"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Ptb from "@unconfirmed/sui/Ptb"
import * as Resolve from "@unconfirmed/sui/Resolve"
import type * as Signer from "@unconfirmed/sui/Signer"
import { Transactions } from "@unconfirmed/sui/Transactions"
import * as Tx from "@unconfirmed/sui/Tx"
import { DEVNET, faucet, grpcLayer, live } from "../../sui/test/support.ts"
import * as EvidenceGrpc from "../src/EvidenceGrpc.ts"
import * as Journal from "../src/Journal.ts"
import { JournalEntry } from "../src/JournalEntry.ts"
import * as JournalKeyValueStore from "../src/JournalKeyValueStore.ts"
import * as Lifecycle from "../src/Lifecycle.ts"

const suite = live ? describe : describe.skip

const devnet = () =>
  EvidenceGrpc.layer.pipe(
    Layer.provide(GrpcWeb.layer({ baseUrl: DEVNET })),
    Layer.provideMerge(grpcLayer(DEVNET).layer),
    Layer.provideMerge(JournalKeyValueStore.layer().pipe(Layer.provideMerge(KeyValueStore.layerMemory)))
  )

const transfer = (signer: Signer.Signer, amount: bigint) =>
  Effect.gen(function*() {
    const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(amount)])
    yield* Ptb.transferObjects([coin!], yield* Ptb.address(signer.address))
  })

suite("devnet", () => {
  test("run: a real transaction, journalled Executed", async () => {
    const { effects, tag } = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        const coin = yield* faucet(signer.address)
        const effects = yield* Lifecycle.run(transfer(signer, 1_000n), {
          signer,
          payment: Resolve.fixed([Objects.refOf(coin)])
        })
        const entry = yield* Effect.flatMap(Effect.service(Journal.Journal), (j) => j.get(effects.digest))
        return { effects, tag: Option.getOrThrow(entry)._tag }
      }).pipe(Effect.provide(devnet()))
    )
    expect(effects.status._tag).toBe("Success")
    expect(tag).toBe("Executed")
  }, 60_000)

  test("recovery: signed + journalled, the submit result dropped, reconcileAll finds it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        const coin = yield* faucet(signer.address)
        const expiration = yield* Resolve.validDuring()
        const data = yield* Tx.build(transfer(signer, 2_000n), {
          sender: signer.address,
          expiration,
          payment: Resolve.fixed([Objects.refOf(coin)])
        })
        const signed = yield* Lifecycle.sign(data, signer)
        const journal = yield* Journal.Journal
        yield* journal.put(JournalEntry.cases.Signed.make({ digest: signed.digest, signed, at: yield* DateTime.now }))
        // The send reaches the node, and the process "crashes" before reading the answer.
        yield* Effect.flatMap(Effect.service(Transactions), (t) => t.execute(signed.bytes, signed.signatures)).pipe(
          Effect.ignore
        )
        const recovered = yield* Lifecycle.reconcileAll()
        const after = yield* journal.listUnresolved
        return { digest: signed.digest, recovered, after }
      }).pipe(Effect.provide(devnet()))
    )
    expect(result.recovered.map((r) => [r._tag, r.digest])).toEqual([["Executed", result.digest]])
    expect(result.after).toEqual([])
  }, 60_000)

  test("reconcile: another transaction consumed the pinned gas coin -> NotApplied inputConsumed", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        const coin = yield* faucet(signer.address)
        const expiration = yield* Resolve.validDuring()
        const options = { sender: signer.address, expiration, payment: Resolve.fixed([Objects.refOf(coin)]) }
        const loser = yield* Effect.flatMap(Tx.build(transfer(signer, 3_000n), options), (d) => Lifecycle.sign(d, signer))
        const winner = yield* Effect.flatMap(
          Tx.build(transfer(signer, 4_000n), { ...options, expiration: yield* Resolve.validDuring() }),
          (d) => Lifecycle.sign(d, signer)
        )
        yield* Lifecycle.submit(winner)
        return yield* Effect.flip(Lifecycle.reconcile(loser))
      }).pipe(Effect.provide(devnet()))
    )
    expect(error._tag === "NotApplied" && error.evidence).toBe("inputConsumed")
  }, 60_000)
})
