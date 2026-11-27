/**
 * Against devnet over gRPC-web. Opt in with SUI_LIVE=1.
 */
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Option, Schedule } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import { GrpcWeb } from "@unconfirmed/sui/grpc/GrpcWeb"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Ptb from "@unconfirmed/sui/Ptb"
import * as Resolve from "@unconfirmed/sui/Resolve"
import type * as Signer from "@unconfirmed/sui/Signer"
import { Transactions } from "@unconfirmed/sui/Transactions"
import * as Tx from "@unconfirmed/sui/Tx"
import { DEVNET, faucet, grpcLayer, live } from "@unconfirmed/test-support/live"
import * as Hash from "@unconfirmed/sui/Hash"
import * as SuiGraphQL from "@unconfirmed/sui-graphql/SuiGraphQL"
import { FetchHttpClient } from "effect/http"
import * as Evidence from "../src/Evidence.ts"
import * as EvidenceGraphQL from "../src/EvidenceGraphQL.ts"
import * as EvidenceGrpc from "../src/EvidenceGrpc.ts"
import * as Journal from "../src/Journal.ts"
import { JournalEntry } from "../src/JournalEntry.ts"
import * as JournalKeyValueStore from "../src/JournalKeyValueStore.ts"
import * as Lifecycle from "../src/Lifecycle.ts"

const suite = live ? describe : describe.skip

/** A well-formed digest no transaction has. */
const digestOf = (seed: string) => Hash.transactionDigest(new TextEncoder().encode(`absent:${seed}`))

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
        const { entries: after } = yield* journal.listUnresolved
        return { digest: signed.digest, recovered, after }
      }).pipe(Effect.provide(devnet()))
    )
    expect(result.recovered.map((r) => [r._tag, r.digest])).toEqual([["Executed", result.digest]])
    expect(result.after).toEqual([])
  }, 60_000)

  test("Evidence over gRPC and GraphQL: one consistent observation of a known and an unknown digest", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        const coin = yield* faucet(signer.address)
        const effects = yield* Lifecycle.run(transfer(signer, 1_000n), { signer, payment: Resolve.fixed([Objects.refOf(coin)]) })
        const unknown = digestOf(effects.digest)
        const observe = (layer: Layer.Layer<never>) =>
          Effect.gen(function*() {
            const e = yield* Evidence.Evidence
            return yield* Effect.all([e.observe(effects.digest, 0n), e.observe(unknown, 0n)])
          }).pipe(Effect.provide(layer))
        const grpc = yield* observe(EvidenceGrpc.layer.pipe(Layer.provide(GrpcWeb.layer({ baseUrl: DEVNET }).pipe(Layer.provide(FetchHttpClient.layer)))))
        // The indexer may trail the fullnode by a few seconds.
        const graphql = yield* observe(
          EvidenceGraphQL.layer.pipe(Layer.provide(SuiGraphQL.protocol({ url: SuiGraphQL.DEVNET }).pipe(Layer.provide(FetchHttpClient.layer))))
        ).pipe(
          Effect.repeat({ until: ([known]) => Option.isSome(known) && known.value.found, schedule: Schedule.spaced("1 second"), times: 20 })
        )
        return { grpc, graphql }
      }).pipe(Effect.provide(devnet()))
    )
    for (const [known, missing] of [result.grpc, result.graphql]) {
      expect(Option.getOrThrow(known).found).toBe(true)
      expect(Option.getOrThrow(missing).found).toBe(false)
      expect(Option.getOrThrow(missing).epoch).toBeGreaterThanOrEqual(0n)
    }
  }, 90_000)

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
