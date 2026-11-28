/**
 * Against Mysten's public GraphQL endpoints, with the gRPC implementation as the
 * reference for the same inputs. Opt in with SUI_LIVE=1.
 */
import { Bcs } from "@unconfirmed/bcs"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schedule, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import {
  Address,
  AddressAlias,
  Chain,
  CheckpointData,
  Checkpoints,
  Coins,
  DynamicFields,
  Ed25519,
  Events,
  Objects,
  Packages,
  Ptb,
  Resolve,
  Transactions,
  Tx
} from "@unconfirmed/sui"
import * as SuiGrpc from "../../sui/src/grpc/index.ts"
import { DEVNET, faucet, grpcLayer, live, TESTNET } from "@unconfirmed/test-support/live"
import { fundedAddress } from "@unconfirmed/test-support/funded"
import * as SuiGraphQL from "../src/index.ts"

const suite = live ? describe : describe.skip
const A = Address.normalize
const GQL_TESTNET = process.env.SUI_GRAPHQL_TESTNET_URL ?? SuiGraphQL.TESTNET
const GQL_DEVNET = process.env.SUI_GRAPHQL_DEVNET_URL ?? SuiGraphQL.DEVNET

/** An HttpClient that records `<host> <GraphQL operation | gRPC method>` for every request. */
const recordingHttp = () => {
  const requests: Array<string> = []
  const layer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      Effect.service(HttpClient.HttpClient),
      HttpClient.tapRequest((req) =>
        Effect.sync(() => {
          const url = new URL(req.url)
          if (url.hostname.startsWith("faucet")) {
            requests.push("faucet")
          } else if (url.hostname.startsWith("graphql")) {
            const body = (req.body as any).body
            requests.push(`graphql ${body ? JSON.parse(new TextDecoder().decode(body)).operationName : "?"}`)
          } else {
            requests.push(`grpc ${url.pathname.split("/").pop()}`)
          }
        })
      )
    )
  ).pipe(Layer.provide(FetchHttpClient.layer))
  return { layer, requests }
}

const graphqlLayer = (url: string) => {
  const http = recordingHttp()
  return { layer: SuiGraphQL.layer({ url }).pipe(Layer.provideMerge(http.layer)), requests: http.requests }
}

const both = <A, E>(effect: Effect.Effect<A, E, SuiGraphQL.Services>) =>
  Effect.runPromise(
    Effect.all([
      effect.pipe(Effect.provide(grpcLayer(TESTNET).layer)),
      effect.pipe(Effect.provide(graphqlLayer(GQL_TESTNET).layer))
    ], { concurrency: 2 })
  )

const clockRecipe = Effect.gen(function*() {
  return yield* Ptb.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [yield* Ptb.object("0x6")] })
})

suite("testnet parity with gRPC", () => {
  test("objects: packages and immutables exactly, the clock's shape, a missing object", async () => {
    const [g, q] = await both(
      Effect.flatMap(Effect.service(Objects.Objects), (o) =>
        Effect.all([
          Effect.forEach([A("0x2"), A("0x1")], o.get, { concurrency: "unbounded" }),
          o.get(A("0x6")),
          Effect.flip(o.get(A("0xabcdef")))
        ]))
    )
    expect(q[0]).toEqual(g[0])
    expect(q[2]).toEqual(g[2])
    const [gc, qc] = [g[1], q[1]]
    expect([qc.objectId, qc.type, qc.owner]).toEqual([gc.objectId, gc.type, gc.owner])
    // The clock ticks every checkpoint, and the GraphQL indexer trails the full node
    // by a few, so the bytes match exactly only at the same version.
    expect(qc.contents.length).toBe(gc.contents.length)
    expect([...qc.contents.subarray(0, 32)]).toEqual([...gc.contents.subarray(0, 32)])
    if (qc.version === gc.version) expect([...qc.contents]).toEqual([...gc.contents])
  })

  test("getFunction signatures (&Clock, &mut / by-value, type parameters, &mut TxContext) and failures match", async () => {
    const targets = [
      ["0x2", "clock", "timestamp_ms"],
      ["0x2", "coin", "join"],
      ["0x2", "transfer", "public_transfer"],
      ["0x2", "pay", "split"],
      ["0x3", "sui_system", "request_add_stake"]
    ] as const
    const [g, q] = await both(
      Effect.flatMap(Effect.service(Packages.Packages), (p) =>
        Effect.all([
          Effect.forEach(targets, ([pkg, module, fn]) => p.getFunction({ package: A(pkg), module, function: fn })),
          Effect.flip(p.getFunction({ package: A("0x6"), module: "clock", function: "timestamp_ms" })),
          Effect.flip(p.getFunction({ package: A("0x2"), module: "clock", function: "nope" })),
          Effect.flip(Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.get("11111111111111111111111111111111")))
        ]))
    )
    const [signatures, notPackage, missing, noTransaction] = q
    expect(signatures).toEqual(g[0])
    expect(signatures[0]!.parameters).toEqual([{ reference: "Immutable", typeName: `${A("0x2")}::clock::Clock` }])
    expect(signatures[1]!.parameters.map((p) => p.reference)).toEqual(["Mutable", "Value"])
    const code = (e: { readonly _tag: string; readonly code?: string }) => e._tag === "RpcError" && e.code
    expect([code(notPackage), code(missing)]).toEqual([code(g[1]), code(g[2])])
    expect(noTransaction).toEqual(g[3])
  })

  test("coins: balance and listing", async () => {
    const [g, q] = await both(
      Effect.flatMap(Effect.service(Coins.Coins), (c) =>
        Effect.all([
          c.getBalance(A("0x1")),
          c.list(A("0x1")).pipe(Stream.take(120), Stream.runCollect, Effect.map((cs) => cs.map((c) => c.ref.objectId).sort()))
        ]))
    )
    expect(q).toEqual(g)
  })

  test("chain info and gas price", async () => {
    const [g, q] = await both(
      Effect.flatMap(Effect.service(Chain.Chain), (c) => Effect.all([c.info, c.referenceGasPrice]))
    )
    expect(q[0].chainId).toBe(g[0].chainId)
    expect(q[0].chain).toBe(g[0].chain)
    expect(q[0].epoch).toBe(g[0].epoch)
    expect(q[1]).toBe(g[1])
  })

  test("checkpoint list", async () => {
    const info = await Effect.runPromise(
      Effect.flatMap(Effect.service(Chain.Chain), (c) => c.info).pipe(Effect.provide(grpcLayer(TESTNET).layer))
    )
    const start = info.checkpointHeight - 1000n
    const [g, q] = await both(
      Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.list({ start, end: start + 60n }).pipe(Stream.runCollect))
    )
    expect(q.length).toBe(60)
    expect(q).toEqual(g)
  })

  test("Tx.build resolves the same inputs (shared mutability, budget), and simulate agrees", async () => {
    const recipe = Effect.gen(function*() {
      yield* Ptb.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [yield* Ptb.object("0x6")] })
      yield* Ptb.moveCall({ target: "0x3::sui_system::active_validator_addresses", arguments: [yield* Ptb.object("0x5")] })
    })
    const [g, q] = await both(
      Effect.gen(function*() {
        const data = yield* Tx.build(recipe, { sender: A("0x1"), payment: Resolve.addressBalance })
        const sim = yield* Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.simulate(Tx.serialize(data), { checks: false }))
        return { data, sim }
      })
    )
    expect(q.data.kind).toEqual(g.data.kind)
    const inputs = q.data.kind.inputs.map((i) => i._tag === "Object" && i.value._tag === "SharedObject" && i.value.mutability._tag)
    expect(inputs).toEqual(["Immutable", "Mutable"])
    // Budgets are estimated from each transport's own simulation.
    const ratio = Number(q.data.gasData.budget) / Number(g.data.gasData.budget)
    expect(ratio).toBeGreaterThan(0.8)
    expect(ratio).toBeLessThan(1.25)
    expect(q.sim.effects.status).toEqual(g.sim.effects.status)
    expect(q.sim.returnValues.length).toBe(g.sim.returnValues.length)
    const ms = (v: Uint8Array) => Number(Bcs.decodeSync(Bcs.u64)(v))
    expect(Math.abs(ms(q.sim.returnValues[0]![0]!) - ms(g.sim.returnValues[0]![0]!))).toBeLessThan(120_000)
  })

  test("an address's alias set reads alike; re-enabling it aborts as SimulationFailed with the same structured abort", async () => {
    // A testnet address that enabled aliases (an alias set can't be deleted).
    const owner = A("0x50044dc5ec176a977766842b2fbb939826c829dd9b322da8668037deb9aabc6e")
    const [g, q] = await both(Effect.gen(function*() {
      const aliases = yield* AddressAlias.get(owner)
      const failed = yield* Effect.flip(Tx.simulate(AddressAlias.enable, { sender: owner, payment: Resolve.unchecked }))
      return { aliases, failed }
    }))
    expect(g.aliases).toMatchObject({ enabled: true, objectId: AddressAlias.aliasesId(owner) })
    expect(q.aliases).toEqual(g.aliases)
    expect(g.failed).toMatchObject({
      _tag: "SimulationFailed",
      command: 0,
      abort: { code: 2n, package: A("0x2"), module: "address_alias", function: "enable", constant: "EAliasAlreadyExists" }
    })
    expect(q.failed._tag === "SimulationFailed" && q.failed.abort).toEqual(g.failed._tag === "SimulationFailed" && g.failed.abort)
  })

  test("concurrent gets are one multiGetObjects request", async () => {
    const { layer, requests } = graphqlLayer(GQL_TESTNET)
    const objs = await Effect.runPromise(
      Effect.flatMap(Effect.service(Objects.Objects), (o) =>
        Effect.forEach(["0x5", "0x6", "0x8", "0x6"].map(A), o.get, { concurrency: "unbounded" })).pipe(Effect.provide(layer))
    )
    expect(objs.map((o) => o.type.split("::").pop())).toEqual(["SuiSystemState", "Clock", "Random", "Clock"])
    expect(requests).toEqual(["graphql MultiGetObjects"])
  })
})

/** gRPC reports accumulator (address-balance) writes as changes with no type or version; GraphQL omits them. */
const withoutAccumulators = (c: CheckpointData.Checkpoint): CheckpointData.Checkpoint => ({
  ...c,
  transactions: c.transactions.map((t) => ({
    ...t,
    // The abort text differs by transport (gRPC sends the node's debug form,
    // GraphQL a sentence); the command and abort code are compared.
    status: t.status._tag === "Failure" ? { ...t.status, description: "<abort>" } : t.status,
    changedObjects: t.changedObjects
      .filter((o) => o.type !== undefined || o.version !== undefined)
      .slice()
      .sort((a, b) => a.objectId.localeCompare(b.objectId))
  }))
})

const tipOf = (layer: Layer.Layer<SuiGraphQL.Services>) =>
  Effect.runPromise(Effect.flatMap(Effect.service(Chain.Chain), (c) => c.info).pipe(Effect.provide(layer)))

suite("testnet parity with gRPC: new services", () => {
  test("dynamic fields of 0x5: list, get by name (derived id), getObject on a plain field", async () => {
    const [g, q] = await both(
      Effect.gen(function*() {
        const df = yield* DynamicFields.DynamicFields
        const fields = yield* df.list(A("0x5")).pipe(Stream.runCollect)
        const first = fields[0]!
        const field = yield* df.get(A("0x5"), first.name)
        const notObject = yield* Effect.flip(df.getObject(A("0x5"), first.name))
        return { fields, field: { ...field, field: { ...field.field, version: 0n, digest: "", contents: new Uint8Array(), previousTransaction: undefined } }, notObject }
      })
    )
    expect(q.fields.length).toBeGreaterThan(0)
    expect(q.fields).toEqual(g.fields)
    expect(q.fields[0]!.fieldId).toBe(DynamicFields.deriveId(A("0x5"), q.fields[0]!.name.type, q.fields[0]!.name.bcs))
    expect(q.field.fieldId).toBe(q.fields[0]!.fieldId)
    expect(q.field.valueType).toBe(g.field.valueType)
    expect(q.notObject).toEqual(g.notObject)
    expect(q.notObject._tag).toBe("DynamicFieldNotFound")
  })

  test("events for a fixed range and filter, ascending and descending", async () => {
    const tip = await tipOf(grpcLayer(TESTNET).layer)
    const start = tip.checkpointHeight - 3000n
    // A filter built from the range's own events, so every part of it matches something:
    // OR of (an event type) and (an emitting module AND NOT a sender).
    const sample = await Effect.runPromise(
      Effect.flatMap(Effect.service(Events.Events), (e) => e.list({ start, end: start + 30n }).pipe(Stream.runCollect)).pipe(
        Effect.provide(grpcLayer(TESTNET).layer)
      )
    )
    const a = sample[0]!
    const b = sample.find((e) => e.type !== a.type) ?? a
    const filter = Events.any(
      Events.eventType(a.type.replace(/<.*$/, "")),
      Events.all(Events.emitModule(`${b.packageId}::${b.module}`), Events.not(Events.sender(a.sender)))
    )
    const [g, q] = await both(
      Effect.flatMap(Effect.service(Events.Events), (e) =>
        Effect.all([
          e.list({ start, end: start + 30n }).pipe(Stream.runCollect),
          e.list({ start, end: start + 30n, descending: true }).pipe(Stream.take(80), Stream.runCollect),
          e.list({ start, end: start + 200n, filter }).pipe(Stream.take(150), Stream.runCollect)
        ]))
    )
    expect(q[0].length).toBeGreaterThan(0)
    expect(q[2].length).toBeGreaterThan(0)
    expect(q[0]).toEqual(g[0])
    expect(q[1]).toEqual(g[1])
    expect(q[2]).toEqual(g[2])
    console.log("events compared:", q[0].length, q[1].length, q[2].length)
  }, 60_000)

  test("CheckpointData.get and list for fixed checkpoints", async () => {
    const tip = await tipOf(grpcLayer(TESTNET).layer)
    const cp = tip.checkpointHeight - 500n
    const [g, q] = await both(
      Effect.flatMap(Effect.service(CheckpointData.CheckpointData), (c) =>
        Effect.all([c.get(cp), c.list({ start: cp, end: cp + 3n }).pipe(Stream.runCollect)]))
    )
    expect(q[0].transactions.length).toBeGreaterThan(0)
    expect(withoutAccumulators(q[0])).toEqual(withoutAccumulators(g[0]))
    expect(q[1].map(withoutAccumulators)).toEqual(g[1].map(withoutAccumulators))
    const missing = await Effect.runPromise(
      Effect.flip(Effect.flatMap(Effect.service(CheckpointData.CheckpointData), (c) => c.get(tip.checkpointHeight + 10_000_000n))).pipe(
        Effect.provide(graphqlLayer(GQL_TESTNET).layer)
      )
    )
    expect(missing._tag).toBe("CheckpointNotFound")
  }, 60_000)

  test("CheckpointData.follow over GraphQL: history then live, gap-free", async () => {
    const { layer } = graphqlLayer(GQL_TESTNET)
    const tip = await tipOf(layer)
    const start = tip.checkpointHeight - 3n
    const cps = await Effect.runPromise(
      CheckpointData.follow(start).pipe(Stream.take(8), Stream.runCollect, Effect.provide(layer), Effect.timeout("90 seconds"))
    )
    expect(cps.map((c) => c.sequenceNumber)).toEqual(Array.from({ length: 8 }, (_, i) => start + BigInt(i)))
  }, 120_000)

  test("Checkpoints, Events and CheckpointData subscriptions over graphql-sse", async () => {
    const { layer } = graphqlLayer(GQL_TESTNET)
    const [light, events, cps] = await Effect.runPromise(
      Effect.all([
        Effect.flatMap(Effect.service(Checkpoints.Checkpoints), (c) => c.subscribe.pipe(Stream.take(3), Stream.runCollect)),
        Effect.flatMap(Effect.service(Events.Events), (e) => e.subscribe().pipe(Stream.take(2), Stream.runCollect)),
        Effect.flatMap(Effect.service(CheckpointData.CheckpointData), (c) => c.subscribe.pipe(Stream.take(2), Stream.runCollect))
      ], { concurrency: 3 }).pipe(Effect.provide(layer), Effect.timeout("90 seconds"))
    )
    expect(light.map((c) => c.sequenceNumber - light[0]!.sequenceNumber)).toEqual([0n, 1n, 2n])
    expect(events.length).toBe(2)
    expect(events[0]!.transactionDigest.length).toBeGreaterThan(0)
    expect(cps[1]!.sequenceNumber - cps[0]!.sequenceNumber).toBe(1n)
  }, 120_000)

  test("CheckpointData.subscribe keeps up with the chain (lag stays bounded)", async () => {
    // Reference: the light `Checkpoints.subscribe` over the same window. Before
    // fetching ahead, the full stream fell ~35 (testnet) to ~75 (mainnet)
    // checkpoints behind per 30 s, growing without bound.
    const { layer } = graphqlLayer(GQL_TESTNET)
    const seconds = 20
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const data = yield* CheckpointData.CheckpointData
        const cps = yield* Checkpoints.Checkpoints
        const t0 = Date.now()
        const until = () => Effect.sync(() => Date.now() - t0 > seconds * 1000)
        let light: bigint | undefined
        let full: bigint | undefined
        let previous: bigint | undefined
        let gaps = 0
        yield* Effect.all([
          cps.subscribe.pipe(Stream.takeUntilEffect(until), Stream.runForEach((c) => Effect.sync(() => void (light = c.sequenceNumber)))),
          data.subscribe.pipe(
            Stream.takeUntilEffect(until),
            Stream.runForEach((c) =>
              Effect.sync(() => {
                if (previous !== undefined && c.sequenceNumber !== previous + 1n) gaps++
                previous = c.sequenceNumber
                full = c.sequenceNumber
              })
            )
          )
        ], { concurrency: 2 })
        return { light, full, gaps }
      }).pipe(Effect.provide(layer), Effect.timeout("60 seconds"))
    )
    expect(result.gaps).toBe(0)
    expect(result.light).toBeDefined()
    expect(result.full).toBeDefined()
    expect(Number(result.light! - result.full!)).toBeLessThan(20)
  }, 90_000)
})

const fundedTestnet = fundedAddress()
;(fundedTestnet === undefined ? describe.skip : suite)("server-side resolution over GraphQL", () => {
  test("Tx.build resolves on the node: one ResolveTransaction (plus the signature it checks against)", async () => {
    const { layer, requests } = graphqlLayer(GQL_TESTNET)
    const funded = A(fundedTestnet!)
    const data = await Effect.runPromise(Tx.build(clockRecipe, { sender: funded, resolve: "server" }).pipe(Effect.provide(layer)))
    const input = data.kind.inputs[0]!
    expect(input._tag === "Object" && input.value._tag === "SharedObject" && input.value.mutability._tag).toBe("Immutable")
    expect(data.gasData.budget).toBeGreaterThan(0n)
    expect([...requests].sort()).toEqual(["graphql GetMoveFunction", "graphql ResolveTransaction"])
  })
})

suite("mixing transports", () => {
  test("GraphQL Objects/Packages + gRPC Transactions/Chain: resolve + simulate", async () => {
    const http = recordingHttp()
    const mixed = Layer.mergeAll(
      Layer.mergeAll(
        SuiGraphQL.ObjectsGraphQL.layer,
        SuiGraphQL.PackagesGraphQL.layer,
        SuiGraphQL.CoinsGraphQL.layer.pipe(Layer.provide(SuiGraphQL.ObjectsGraphQL.layer))
      ).pipe(
        Layer.provide(SuiGraphQL.SuiGraphQL.protocol({ url: GQL_TESTNET }))
      ),
      Layer.mergeAll(SuiGrpc.TransactionsGrpc.layer, SuiGrpc.ChainGrpc.layer).pipe(
        Layer.provide(SuiGrpc.GrpcWeb.layer({ url: TESTNET }))
      )
    ).pipe(Layer.provideMerge(http.layer))

    const { data, sim } = await Effect.runPromise(
      Effect.gen(function*() {
        const data = yield* Tx.build(clockRecipe, { sender: A("0x1"), payment: Resolve.unchecked })
        const sim = yield* Effect.flatMap(Effect.service(Transactions.Transactions), (t) =>
          t.simulate(Tx.serialize(data), { checks: false }))
        return { data, sim }
      }).pipe(Effect.provide(mixed))
    )
    const input = data.kind.inputs[0]!
    expect(input._tag === "Object" && input.value._tag === "SharedObject" && input.value.mutability._tag).toBe("Immutable")
    expect(sim.effects.status._tag).toBe("Success")
    expect(http.requests).toContain("graphql MultiGetObjects")
    expect(http.requests).toContain("graphql GetMoveFunction")
    expect(http.requests).toContain("grpc SimulateTransaction")
    expect(http.requests.some((r) => r.startsWith("graphql Simulate"))).toBe(false)
    console.log("mixed requests:", http.requests)
  })
})

suite("devnet over GraphQL only", () => {
  test("address balances: deposit, then gas and a coin both drawn from the address balance", async () => {
    const { layer, requests } = graphqlLayer(GQL_DEVNET)
    const { transfer, effects, received } = await Effect.runPromise(
      Effect.gen(function*() {
        const a = yield* Ed25519.generate
        const b = yield* Ed25519.generate
        yield* faucet(a.address)
        // Deposit 1 SUI into A's address balance (gas paid with the faucet coin).
        yield* Tx.run(
          Effect.gen(function*() {
            const [one] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000_000_000n)])
            yield* Ptb.sendFunds(one!, yield* Ptb.address(a.address))
          }),
          { signer: a }
        )
        // The indexer trails execution: wait until it reports the deposit.
        const coins = yield* Coins.Coins
        yield* coins.getBalance(a.address).pipe(
          Effect.repeat({ until: (x) => x.addressBalance >= 1_000_000_000n, schedule: Schedule.spaced("500 millis"), times: 60 })
        )
        // Gas and the coin for B both come from the address balance.
        const transfer = yield* Tx.build(
          Effect.gen(function*() {
            const coin = yield* Ptb.coin({ amount: 2_000n, useGasCoin: false })
            yield* Ptb.transferObjects([coin], yield* Ptb.address(b.address))
          }),
          { sender: a.address }
        )
        const effects = yield* Tx.execute(transfer, a)
        const received = yield* coins.getBalance(b.address).pipe(
          Effect.repeat({ until: (x) => x.coinBalance === 2_000n, schedule: Schedule.spaced("500 millis"), times: 60 })
        )
        return { transfer, effects, received }
      }).pipe(Effect.provide(layer))
    )
    expect(transfer.gasData.payment).toEqual([])
    expect(transfer.expiration._tag).toBe("ValidDuring")
    expect(effects.status._tag).toBe("Success")
    expect(received.coinBalance).toBe(2_000n)
    expect(requests.every((r) => r.startsWith("graphql") || r === "faucet")).toBe(true)
  }, 180_000)

  test("faucet -> Tx.run with coin gas selection -> Transactions.get", async () => {
    const { layer, requests } = graphqlLayer(GQL_DEVNET)
    const { effects, again } = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Ed25519.generate
        yield* faucet(signer.address)
        const effects = yield* Tx.run(
          Effect.gen(function*() {
            const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
            yield* Ptb.transferObjects([coin!], yield* Ptb.address(signer.address))
          }),
          { signer, payment: Resolve.coins }
        )
        // The indexer trails execution; retry exactly the typed "not yet indexed" case.
        const again = yield* Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.get(effects.digest)).pipe(
          Effect.retry({ while: (e) => e._tag === "TransactionNotFound", schedule: Schedule.spaced("500 millis"), times: 40 })
        )
        return { effects, again }
      }).pipe(Effect.provide(layer))
    )
    expect(effects.status._tag).toBe("Success")
    expect(effects.changedObjects.some((c) => c.operation === "Created")).toBe(true)
    expect(again.digest).toBe(effects.digest)
    expect(again.status).toEqual(effects.status)
    expect(again.gasUsed).toEqual(effects.gasUsed)
    expect(requests.every((r) => r.startsWith("graphql") || r === "faucet")).toBe(true)
    expect(requests).toContain("graphql ExecuteTransaction")
    // The same transaction read back over gRPC.
    const viaGrpc = await Effect.runPromise(
      Effect.flatMap(Effect.service(Transactions.Transactions), (t) => t.get(effects.digest)).pipe(
        Effect.retry({ while: (e) => e._tag === "TransactionNotFound", schedule: Schedule.spaced("500 millis"), times: 20 }),
        Effect.provide(grpcLayer(DEVNET).layer)
      )
    )
    const byId = (cs: ReadonlyArray<Transactions.ChangedObject>) => [...cs].sort((a, b) => a.objectId.localeCompare(b.objectId))
    expect(effects.status).toEqual(viaGrpc.status)
    expect(effects.gasUsed).toEqual(viaGrpc.gasUsed)
    expect(byId(effects.changedObjects)).toEqual(byId(viaGrpc.changedObjects))
    expect(byId(again.changedObjects)).toEqual(byId(viaGrpc.changedObjects))
    console.log("devnet requests:", requests)
  }, 60_000)
})
