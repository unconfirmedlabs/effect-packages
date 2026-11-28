/**
 * Transaction JSON: parity with @mysten/sui's `Transaction.toJSON()` / `Transaction.from(json)`.
 *
 * - our JSON -> Transaction.from -> Mysten build  ==  our resolve
 * - Mysten toJSON -> our decode -> our resolve    ==  Mysten build
 * - round trips over every command kind, pure and object inputs, intents and gas data
 */
import { Inputs, Transaction } from "@mysten/sui/transactions"
import { base58 } from "@scure/base"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import {
  Address,
  Objects,
  Packages,
  Ptb,
  Resolve,
  TransactionData as T,
  TransactionJson,
  TypeTag
} from "../src/index.ts"
import * as Testing from "../src/Testing.ts"
import { toB64 } from "./support.ts"

const A = Address.normalize
const D = (seed: number) => base58.encode(new Uint8Array(32).fill(seed)) as T.ObjectDigest
const sender = A("0x5e4d")
const recipient = A("0xcafe")
const gasRef = { objectId: A("0xfeed"), version: 9n, digest: D(7) }
const TOKEN = TypeTag.normalizeString("0x123::token::TOKEN")
const PKG = A("0x99")

// -----------------------------------------------------------------------------
// One chain state, served to our resolver and to Mysten's
// -----------------------------------------------------------------------------

type Owner = Objects.Owner
interface ObjectFixture {
  readonly id: string
  readonly version: bigint
  readonly owner: Owner
}
interface Fixture {
  readonly objects: ReadonlyArray<ObjectFixture>
  /** `module::function` -> parameter references (all `0x99`) */
  readonly functions: Record<string, ReadonlyArray<{ reference: Packages.Reference; typeName?: string }>>
  readonly balances: Record<string, bigint>
  readonly coins: Record<string, ReadonlyArray<{ id: string; version: bigint; balance: bigint }>>
}

const owned: Owner = { _tag: "AddressOwner", address: sender }
const fixture: Fixture = {
  objects: [
    { id: "0xa1", version: 11n, owner: owned },
    { id: "0xa2", version: 12n, owner: owned },
    { id: "0x5a", version: 40n, owner: { _tag: "Shared", initialSharedVersion: 5n } },
    { id: "0x5b", version: 41n, owner: { _tag: "Shared", initialSharedVersion: 6n } }
  ],
  functions: {
    "game::play": [{ reference: "Mutable" }, { reference: "Immutable" }, { reference: "Value" }],
    "game::read": [{ reference: "Immutable" }, { reference: "Value" }]
  },
  balances: { [TOKEN]: 1_000n, [TypeTag.SUI]: 20n },
  coins: { [TypeTag.SUI]: [{ id: "0xc1", version: 3n, balance: 10_000n }] }
}

const obj = (id: string) => fixture.objects.find((o) => A(o.id) === A(id))!

const ourLayer = Testing.layer({
  objects: fixture.objects.map((o) => ({ objectId: o.id, version: o.version, digest: D(Number(o.version)), owner: o.owner, type: `${PKG}::game::Thing` })),
  packages: [{
    packageId: PKG,
    functions: Object.fromEntries(Object.entries(fixture.functions).map(([name, params]) => [name, {
      isEntry: false,
      parameters: params.map((p) => ({ reference: p.reference, typeName: p.typeName ?? (p.reference === "Value" ? undefined : `${PKG}::game::Thing`) }))
    }]))
  }],
  addressBalances: Object.entries(fixture.balances).map(([coinType, amount]) => ({ owner: sender, coinType, amount })),
  coins: Object.entries(fixture.coins).flatMap(([coinType, coins]) =>
    coins.map((c) => ({ owner: sender, coinType, balance: c.balance, objectId: c.id, version: c.version, digest: D(Number(c.version)) }))
  )
})

const mystenClient = {
  core: {
    // null: use Mysten's own core resolver against the methods below.
    resolveTransactionPlugin: () => null,
    getObjects: async ({ objectIds }: { objectIds: Array<string> }) => ({
      objects: objectIds.map((id) => {
        const o = obj(id)
        return {
          objectId: A(o.id),
          version: String(o.version),
          digest: D(Number(o.version)),
          owner: o.owner._tag === "Shared"
            ? { $kind: "Shared", Shared: { initialSharedVersion: String(o.owner.initialSharedVersion) } }
            : { $kind: "AddressOwner", AddressOwner: sender }
        }
      })
    }),
    getMoveFunction: async ({ moduleName, name }: { moduleName: string; name: string }) => ({
      function: {
        parameters: fixture.functions[`${moduleName}::${name}`]!.map((p) => ({
          reference: p.reference === "Mutable" ? "mutable" : p.reference === "Immutable" ? "immutable" : null,
          body: p.reference === "Value"
            ? { $kind: "u64" }
            : { $kind: "datatype", datatype: { typeName: "0x99::game::Thing", typeParameters: [] } }
        }))
      }
    }),
    getBalance: async ({ coinType = "0x2::sui::SUI" }: { coinType?: string }) => {
      const t = TypeTag.normalizeString(coinType)
      const ab = fixture.balances[t] ?? 0n
      const cb = (fixture.coins[t] ?? []).reduce((s, c) => s + c.balance, 0n)
      return { balance: { coinType: t, balance: String(ab + cb), addressBalance: String(ab), coinBalance: String(cb) } }
    },
    listCoins: async ({ coinType }: { coinType: string }) => ({
      objects: (fixture.coins[TypeTag.normalizeString(coinType)] ?? []).map((c) => ({
        objectId: A(c.id),
        version: String(c.version),
        digest: D(Number(c.version)),
        balance: String(c.balance),
        type: `0x2::coin::Coin<${coinType}>`
      })),
      hasNextPage: false,
      cursor: null
    })
  }
}

const run = <A, E>(effect: Effect.Effect<A, E, Testing.Services>) =>
  Effect.runPromise(Effect.provide(effect, ourLayer) as Effect.Effect<A, E>)

/** Our side: decode-free resolve of an `Unresolved` (no gas steps; gas is fixed in the fixtures). */
const ourResolve = (tx: TransactionJson.Unresolved) =>
  run(
    TransactionJson.toPlan(tx).pipe(
      Effect.flatMap(Resolve.inputs),
      Effect.flatMap(Resolve.balances),
      Effect.flatMap(Resolve.finish),
      Effect.map(T.encode)
    )
  )

const mystenBuild = (json: string) => Transaction.from(json).build({ client: mystenClient as never })

const gas = { gasPrice: 1000n, gasBudget: 10_000_000n, gasPayment: [gasRef], expiration: { _tag: "None" } as const }
const mystenGas = (tx: Transaction) => {
  tx.setSender(sender)
  tx.setGasPrice(1000)
  tx.setGasBudget(10_000_000)
  tx.setGasPayment([{ ...gasRef, version: "9" }])
  tx.setExpiration({ None: true })
}

// -----------------------------------------------------------------------------
// Fixtures: every command kind, input kind and intent
// -----------------------------------------------------------------------------

const MODULE = new Uint8Array([0xa1, 0x1c, 0xeb, 0x0b, 1, 2, 3])

/** A resolved transaction: every command kind and every resolved input kind. */
const resolved: T.TransactionData = {
  _tag: "V1",
  kind: {
    _tag: "ProgrammableTransaction",
    inputs: [
      { _tag: "Pure", bytes: new Uint8Array([100, 0, 0, 0, 0, 0, 0, 0]) },
      { _tag: "Object", value: { _tag: "ImmOrOwnedObject", objectId: A("0xa1"), version: 11n, digest: D(11) } },
      { _tag: "Object", value: { _tag: "SharedObject", objectId: A("0x5a"), initialSharedVersion: 5n, mutability: { _tag: "Mutable" } } },
      { _tag: "Object", value: { _tag: "SharedObject", objectId: A("0x6"), initialSharedVersion: 1n, mutability: { _tag: "Immutable" } } },
      { _tag: "Object", value: { _tag: "SharedObject", objectId: A("0x5b"), initialSharedVersion: 6n, mutability: { _tag: "NonExclusiveWrite" } } },
      { _tag: "Object", value: { _tag: "Receiving", objectId: A("0xa2"), version: 12n, digest: D(12) } },
      {
        _tag: "FundsWithdrawal",
        reservation: { _tag: "MaxAmountU64", value: 500n },
        typeArg: { _tag: "Balance", value: TypeTag.parse(TOKEN) },
        withdrawFrom: { _tag: "Sender" }
      },
      {
        _tag: "FundsWithdrawal",
        reservation: { _tag: "MaxAmountU64", value: 7n },
        typeArg: { _tag: "Balance", value: TypeTag.parse("0x2::sui::SUI") },
        withdrawFrom: { _tag: "Sponsor" }
      },
      {
        _tag: "FundsWithdrawal",
        reservation: { _tag: "MaxAmountU64", value: 9n },
        typeArg: { _tag: "Balance", value: TypeTag.parse("0x2::sui::SUI") },
        withdrawFrom: { _tag: "SenderAllowance", funder: A("0xf0"), allowance: A("0xa110") }
      },
      { _tag: "Pure", bytes: new Uint8Array(32).fill(0xca) }
    ],
    commands: [
      { _tag: "SplitCoins", coin: { _tag: "GasCoin" }, amounts: [{ _tag: "Input", value: 0 }] },
      { _tag: "MergeCoins", destination: { _tag: "GasCoin" }, sources: [{ _tag: "Input", value: 1 }] },
      {
        _tag: "MoveCall",
        package: PKG,
        module: "game",
        function: "play",
        typeArguments: [TypeTag.parse("0x2::sui::SUI"), TypeTag.parse("vector<0x2::coin::Coin<0x2::sui::SUI>>")],
        arguments: [{ _tag: "Input", value: 2 }, { _tag: "Input", value: 3 }, { _tag: "NestedResult", value: [0, 0] }]
      },
      {
        _tag: "MakeMoveVec",
        type: Option.some(TypeTag.parse("0x99::game::Thing")),
        elements: [{ _tag: "Input", value: 4 }, { _tag: "Input", value: 5 }]
      },
      { _tag: "MakeMoveVec", type: Option.none(), elements: [{ _tag: "Result", value: 2 }] },
      { _tag: "Publish", modules: [MODULE], dependencies: [A("0x1"), A("0x2")] },
      {
        _tag: "Upgrade",
        modules: [MODULE, MODULE],
        dependencies: [A("0x1")],
        package: PKG,
        ticket: { _tag: "Result", value: 5 }
      },
      {
        _tag: "MoveCall",
        package: A("0x2"),
        module: "balance",
        function: "redeem_funds",
        typeArguments: [TypeTag.parse(TOKEN)],
        arguments: [{ _tag: "Input", value: 6 }]
      },
      { _tag: "TransferObjects", objects: [{ _tag: "NestedResult", value: [0, 0] }], address: { _tag: "Input", value: 9 } }
    ]
  },
  sender,
  gasData: { payment: [gasRef], owner: A("0x6a5"), price: 1000n, budget: 5_000_000n },
  expiration: {
    _tag: "ValidDuring",
    minEpoch: Option.some(10n),
    maxEpoch: Option.some(11n),
    minTimestamp: Option.none(),
    maxTimestamp: Option.some(1_700_000_000_000n),
    chain: D(1),
    nonce: 42
  }
}

/** An unresolved draft: unresolved objects, coin and balance intents, withdrawals, pure values. */
const recipe = Effect.gen(function*() {
  const thing = yield* Ptb.object("0xa1")
  const shared = yield* Ptb.object("0x5a")
  const readOnly = yield* Ptb.object("0x5b")
  const [piece] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(100n)])
  yield* Ptb.moveCall({ target: "0x99::game::play", arguments: [shared, readOnly, yield* Ptb.u64(3n)] })
  yield* Ptb.moveCall({ target: "0x99::game::read", arguments: [readOnly, yield* Ptb.u64(4n)] })
  const coin = yield* Ptb.coin({ amount: 300n, type: TOKEN })
  const bal = yield* Ptb.balance({ amount: 200n, type: TOKEN })
  const suiCoin = yield* Ptb.coin({ amount: 50n })
  yield* Ptb.sendBalance(bal, yield* Ptb.address(recipient), TOKEN)
  const w = yield* Ptb.withdrawal({ amount: 5n })
  yield* Ptb.sendFunds(yield* Ptb.redeemCoin(w), yield* Ptb.address(recipient))
  yield* Ptb.transferObjects([thing, piece!, coin, suiCoin], yield* Ptb.address(recipient))
})

const draftOf = <A, E>(r: Effect.Effect<A, E, Ptb.PtbBuilder>) =>
  Effect.runPromise(Effect.map(Ptb.build(r), (b) => b.draft) as Effect.Effect<Ptb.Draft>)

// -----------------------------------------------------------------------------
// Ours -> Mysten
// -----------------------------------------------------------------------------

describe("our JSON -> Transaction.from -> Mysten build", () => {
  test("resolved TransactionData: every command kind and resolved input kind, gas data and expiration", async () => {
    const json = await Effect.runPromise(TransactionJson.encode(resolved))
    const bytes = await Transaction.from(json).build()
    expect(toB64(bytes)).toBe(toB64(T.encode(resolved)))
    expect(JSON.parse(json).digest).toBe(await Transaction.from(json).getDigest())
  })

  test("expiration variants and empty payment", async () => {
    const expirations: Array<T.TransactionExpiration> = [
      { _tag: "None" },
      { _tag: "Epoch", value: 77n },
      {
        _tag: "Validity",
        minEpoch: Option.some(1n),
        maxEpoch: Option.none(),
        minTimestamp: Option.none(),
        maxTimestamp: Option.none(),
        chain: D(3),
        nonce: 7,
        allowedProposers: Option.some({ epoch: 4n, proposers: [1, 2, 3] })
      }
    ]
    for (const expiration of expirations) {
      const data: T.TransactionData = { ...resolved, expiration, gasData: { ...resolved.gasData, payment: [] } }
      const json = await Effect.runPromise(TransactionJson.encode(data))
      expect(toB64(await Transaction.from(json).build())).toBe(toB64(T.encode(data)))
    }
  })

  test("unresolved draft with objects, intents and withdrawals: Mysten resolves it to our bytes", async () => {
    const draft = await draftOf(recipe)
    const tx: TransactionJson.Unresolved = { sender, draft, ...gas }
    const json = await Effect.runPromise(TransactionJson.encode(tx))
    expect(toB64(await mystenBuild(json))).toBe(toB64(await ourResolve(tx)))
  })
})

// -----------------------------------------------------------------------------
// Mysten -> ours
// -----------------------------------------------------------------------------

/** The same transaction as `recipe`, written with @mysten/sui. */
const mystenRecipe = (tx: Transaction) => {
  const thing = tx.object("0xa1")
  const shared = tx.object("0x5a")
  const readOnly = tx.object("0x5b")
  const [piece] = tx.splitCoins(tx.gas, [tx.pure.u64(100)])
  tx.moveCall({ target: "0x99::game::play", arguments: [shared, readOnly, tx.pure.u64(3)] })
  tx.moveCall({ target: "0x99::game::read", arguments: [readOnly, tx.pure.u64(4)] })
  const coin = tx.coin({ balance: 300, type: TOKEN })
  const bal = tx.balance({ balance: 200, type: TOKEN })
  const suiCoin = tx.coin({ balance: 50 })
  tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: [TOKEN], arguments: [bal, tx.pure.address(recipient)] })
  const redeemed = tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: ["0x2::sui::SUI"], arguments: [tx.withdrawal({ amount: 5 })] })
  tx.moveCall({ target: "0x2::coin::send_funds", typeArguments: ["0x2::sui::SUI"], arguments: [redeemed, tx.pure.address(recipient)] })
  tx.transferObjects([thing, piece!, coin, suiCoin], tx.pure.address(recipient))
}

describe("Mysten toJSON -> our decode -> our resolve", () => {
  test("intents kept (supportedIntents), objects unresolved: same bytes as Mysten's build", async () => {
    const tx = new Transaction()
    mystenGas(tx)
    mystenRecipe(tx)
    const json = await tx.toJSON({ supportedIntents: ["CoinWithBalance"] })
    expect(json).toContain("CoinWithBalance")
    const decoded = await Effect.runPromise(TransactionJson.decode(json))
    expect(decoded.draft.commands.filter((c) => c._tag === "BalanceIntent")).toHaveLength(3)
    expect(toB64(await ourResolve(decoded))).toBe(toB64(await mystenBuild(json)))
  })

  test("raw (UnresolvedPure) SplitCoins amounts and TransferObjects addresses are typed as Mysten types them", async () => {
    const base = await baseJson()
    const json = JSON.stringify({
      ...base,
      inputs: [{ UnresolvedPure: { value: "123" } }, { UnresolvedPure: { value: 456 } }, { UnresolvedPure: { value: "0xcafe" } }],
      commands: [
        { SplitCoins: { coin: { GasCoin: true }, amounts: [{ Input: 0 }, { Input: 1 }] } },
        { TransferObjects: { objects: [{ NestedResult: [0, 0] }, { NestedResult: [0, 1] }], address: { Input: 2 } } }
      ]
    })
    expect(json).toContain("UnresolvedPure")
    const decoded = await Effect.runPromise(TransactionJson.decode(json))
    expect(toB64(await ourResolve(decoded))).toBe(toB64(await mystenBuild(json)))
  })

  test("every command kind and resolved input kind, fully resolved: decode -> toTransactionData", async () => {
    const tx = new Transaction()
    tx.setSender(sender)
    tx.setGasOwner(A("0x6a5"))
    tx.setGasPrice(1000)
    tx.setGasBudget(5_000_000)
    tx.setGasPayment([{ ...gasRef, version: "9" }])
    tx.setExpiration({ ValidDuring: { minEpoch: "10", maxEpoch: "11", minTimestamp: null, maxTimestamp: null, chain: D(1), nonce: 42 } })
    const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(100)])
    tx.mergeCoins(tx.gas, [tx.object(Inputs.ObjectRef({ objectId: "0xa1", version: "11", digest: D(11) }))])
    const r = tx.moveCall({
      target: "0x99::game::play",
      typeArguments: ["0x2::sui::SUI"],
      arguments: [
        tx.object(Inputs.SharedObjectRef({ objectId: "0x5a", initialSharedVersion: 5, mutable: true })),
        tx.object(Inputs.SharedObjectRef({ objectId: "0x6", initialSharedVersion: 1, mutable: false })),
        c!
      ]
    })
    tx.makeMoveVec({ type: "0x99::game::Thing", elements: [tx.object(Inputs.ReceivingRef({ objectId: "0xa2", version: "12", digest: D(12) }))] })
    tx.makeMoveVec({ elements: [r] })
    const cap = tx.publish({ modules: [toB64(MODULE)], dependencies: ["0x1", "0x2"] })
    tx.upgrade({ modules: [toB64(MODULE)], dependencies: ["0x1"], package: PKG, ticket: cap })
    tx.moveCall({ target: "0x2::balance::redeem_funds", typeArguments: [TOKEN], arguments: [tx.withdrawal({ amount: 500, type: TOKEN, from: "allowance", allowance: "0xa110", funder: "0xf0" } as never)] })
    tx.moveCall({ target: "0x2::balance::redeem_funds", typeArguments: ["0x2::sui::SUI"], arguments: [tx.withdrawal({ amount: 7, from: "sponsor" })] })
    tx.transferObjects([c!], recipient)
    const json = await tx.toJSON()
    const data = await Effect.runPromise(Effect.flatMap(TransactionJson.decode(json), TransactionJson.toTransactionData))
    expect(toB64(T.encode(data))).toBe(toB64(await tx.build()))
  })
})

// -----------------------------------------------------------------------------
// Round trips
// -----------------------------------------------------------------------------

describe("round trips", () => {
  test("TransactionData -> JSON -> TransactionData is the identity", async () => {
    const back = await Effect.runPromise(
      TransactionJson.encode(resolved).pipe(Effect.flatMap(TransactionJson.decode), Effect.flatMap(TransactionJson.toTransactionData))
    )
    expect(toB64(T.encode(back))).toBe(toB64(T.encode(resolved)))
    expect(back).toEqual(resolved)
  })

  test("Unresolved (objects, intents, withdrawals, pure, gas data) -> JSON -> Unresolved is the identity", async () => {
    const draft = await draftOf(Effect.gen(function*() {
      yield* recipe
      yield* Ptb.object("0xa2", { mutable: true })
      yield* Ptb.coin({ amount: 9n, useGasCoin: false })
    }))
    const tx: TransactionJson.Unresolved = { sender, draft, gasOwner: A("0x6a5"), ...gas }
    const back = await Effect.runPromise(Effect.flatMap(TransactionJson.encode(tx), TransactionJson.decode))
    expect(back).toEqual(tx)
    // Nothing set but the draft.
    const bare = await Effect.runPromise(Effect.flatMap(TransactionJson.encode({ draft }), TransactionJson.decode))
    expect(bare).toEqual({ draft })
    // Every resolved command and input kind survives as a Draft too.
    const { inputs, commands } = resolved.kind
    const asDraft: TransactionJson.Unresolved = { sender, draft: { inputs, commands }, gasOwner: resolved.gasData.owner, gasPrice: 1n, gasBudget: 2n, gasPayment: [], expiration: resolved.expiration }
    expect(await Effect.runPromise(Effect.flatMap(TransactionJson.encode(asDraft), TransactionJson.decode))).toEqual(asDraft)
  })

  test("JSON from Mysten's internal snapshot ($kind everywhere) decodes too", async () => {
    const tx = new Transaction()
    mystenGas(tx)
    mystenRecipe(tx)
    await tx.prepareForSerialization({ supportedIntents: ["CoinWithBalance"] })
    const snapshot = JSON.parse(JSON.stringify(tx.getData(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
    const a = await Effect.runPromise(TransactionJson.decode(snapshot))
    const b = await Effect.runPromise(TransactionJson.decode(await tx.toJSON({ supportedIntents: ["CoinWithBalance"] })))
    expect(a).toEqual(b)
  })
})

// -----------------------------------------------------------------------------
// Refusals
// -----------------------------------------------------------------------------

const decodeError = (input: unknown) => Effect.runPromise(Effect.flip(TransactionJson.decode(input)))

const baseJson = async () => {
  const tx = new Transaction()
  mystenGas(tx)
  tx.transferObjects([tx.splitCoins(tx.gas, [tx.pure.u64(1)])[0]!], recipient)
  return JSON.parse(await tx.toJSON())
}

describe("refusals are typed", () => {
  test("an unknown intent, command kind or input kind is unsupported", async () => {
    const json = await baseJson()
    const intent = { ...json, commands: [...json.commands, { $Intent: { name: "Mystery", inputs: {}, data: {} } }] }
    expect(await decodeError(intent)).toMatchObject({ _tag: "UnsupportedTransactionJson", construct: "intent Mystery" })
    const command = { ...json, commands: [...json.commands, { Teleport: { to: "0x1" } }] }
    expect(await decodeError(command)).toMatchObject({ _tag: "UnsupportedTransactionJson", construct: "command Teleport" })
    const input = { ...json, inputs: [...json.inputs, { $kind: "Quantum", Quantum: {} }] }
    expect(await decodeError(input)).toMatchObject({ _tag: "UnsupportedTransactionJson", construct: "input Quantum" })
  })

  test("UnresolvedPure that needs a Move signature is unsupported", async () => {
    const json = await baseJson()
    json.inputs.push({ UnresolvedPure: { value: 5 } })
    json.commands.push({ MoveCall: { package: "0x99", module: "game", function: "read", typeArguments: [], arguments: [{ Input: json.inputs.length - 1 }] } })
    expect(await decodeError(json)).toMatchObject({ _tag: "UnsupportedTransactionJson", construct: `UnresolvedPure input ${json.inputs.length - 1}` })
  })

  test("a version-pinned UnresolvedObject: owned unless a Move call takes it", async () => {
    const json = await baseJson()
    json.inputs.push({ UnresolvedObject: { objectId: "0xa1", version: "11", digest: D(11) } })
    const at = json.inputs.length - 1
    json.commands.push({ TransferObjects: { objects: [{ Input: at }], address: { Input: 1 } } })
    const ok = await Effect.runPromise(TransactionJson.decode(json))
    expect(ok.draft.inputs[at]).toEqual({ _tag: "Object", value: { _tag: "ImmOrOwnedObject", objectId: A("0xa1"), version: 11n, digest: D(11) } })
    json.commands.push({ MoveCall: { package: "0x99", module: "game", function: "read", typeArguments: [], arguments: [{ Input: at }, { Input: 0 }] } })
    expect(await decodeError(json)).toMatchObject({ _tag: "UnsupportedTransactionJson" })
  })

  test("malformed JSON is InvalidTransactionJson", async () => {
    const json = await baseJson()
    expect((await decodeError("{nope"))._tag).toBe("InvalidTransactionJson")
    expect((await decodeError({ ...json, version: 1 }))._tag).toBe("InvalidTransactionJson")
    expect((await decodeError({ ...json, gasData: { ...json.gasData, budget: "-1" } }))._tag).toBe("InvalidTransactionJson")
    expect((await decodeError({ ...json, inputs: [{ Pure: { bytes: "!!!" } }, ...json.inputs.slice(1)] }))._tag).toBe("InvalidTransactionJson")
    const forward = { ...json, commands: [{ TransferObjects: { objects: [{ Result: 0 }], address: { Input: 1 } } }] }
    expect((await decodeError(forward))._tag).toBe("InvalidTransactionJson")
    const outOfRange = { ...json, commands: [{ TransferObjects: { objects: [{ Input: 99 }], address: { Input: 1 } } }] }
    expect((await decodeError(outOfRange))._tag).toBe("InvalidTransactionJson")
    const intent = { ...json, commands: [{ $Intent: { name: "CoinWithBalance", inputs: {}, data: { type: "gas", balance: "x" } } }] }
    expect((await decodeError(intent))._tag).toBe("InvalidTransactionJson")
  })

  test("toTransactionData needs everything resolved", async () => {
    const draft = await draftOf(recipe)
    const e = await Effect.runPromise(Effect.flip(TransactionJson.toTransactionData({ sender, draft, ...gas })))
    expect(e._tag).toBe("Incomplete")
    const noSender = await Effect.runPromise(Effect.flip(TransactionJson.toTransactionData({ draft: resolved.kind, ...gas })))
    expect(noSender).toMatchObject({ _tag: "Incomplete", missing: "sender" })
  })
})

// -----------------------------------------------------------------------------
// Review regressions
// -----------------------------------------------------------------------------

describe("ambiguous or inconsistent JSON is refused", () => {
  test("an object with two enum variants (Mysten takes the first key, a union the first member)", async () => {
    const json = await baseJson()
    const cmd = { TransferObjects: json.commands[1].TransferObjects, MoveCall: { package: "0x2", module: "m", function: "f", typeArguments: [], arguments: [] } }
    expect((await decodeError({ ...json, commands: [json.commands[0], cmd] }))._tag).toBe("InvalidTransactionJson")
    const input = { ...json.inputs[0], Object: { ImmOrOwnedObject: { objectId: "0x1", version: "1", digest: D(1) } } }
    expect((await decodeError({ ...json, inputs: [input, ...json.inputs.slice(1)] }))._tag).toBe("InvalidTransactionJson")
  })

  test("a bad address inside intent data is a typed error, not a defect", async () => {
    const json = await baseJson()
    const intent = {
      $Intent: {
        name: "AllowanceBalance",
        inputs: { allowance: { Input: 0 }, clock: { Input: 0 } },
        data: { objectId: "not-hex", type: "0x2::sui::SUI", amount: "1", outputKind: "coin" }
      }
    }
    expect((await decodeError({ ...json, commands: [...json.commands, intent] }))._tag).toBe("InvalidTransactionJson")
  })

  test("a nested result past an intent's single value is refused", async () => {
    const json = await baseJson()
    const intent = { $Intent: { name: "CoinWithBalance", inputs: {}, data: { type: "gas", balance: "1" } } }
    const n = json.commands.length
    const use = { TransferObjects: { objects: [{ NestedResult: [n, 1] }], address: json.commands[1].TransferObjects.address } }
    expect((await decodeError({ ...json, commands: [...json.commands, intent, use] }))._tag).toBe("InvalidTransactionJson")
  })

  test("a fully resolved transaction must carry its own digest", async () => {
    const json = JSON.parse(await Effect.runPromise(TransactionJson.encode(resolved)))
    await Effect.runPromise(TransactionJson.decode(json))
    expect((await decodeError({ ...json, digest: D(3) }))._tag).toBe("InvalidTransactionJson")
  })
})

test("an explicit expiration survives address-balance gas (as in @mysten/sui)", async () => {
  const draft = await draftOf(Effect.flatMap(Ptb.address(recipient), (to) => Ptb.transferObjects([], to)))
  const data = await run(TransactionJson.resolve({
    sender,
    draft,
    gasPrice: 1000n,
    gasBudget: 1_000_000n,
    expiration: { _tag: "Epoch", value: 9n }
  }, { payment: Resolve.unchecked }) as Effect.Effect<T.TransactionData, unknown, Objects.Objects>) // price and budget given: no Chain read
  expect(data.gasData.payment).toEqual([])
  expect(data.expiration).toEqual({ _tag: "Epoch", value: 9n })
})
