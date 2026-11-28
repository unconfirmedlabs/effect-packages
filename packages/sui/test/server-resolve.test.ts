/**
 * Server-side resolution, offline: the unresolved transaction as a gRPC
 * `Transaction`, every refusal of `verifyResolution`,
 * and which path `Tx.resolve` takes.
 */
import { base58 } from "@scure/base"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { toProto } from "../src/grpc/transaction.ts"
import {
  Address,
  Chain,
  CoinReservation,
  Coins,
  Objects,
  Packages,
  type Ptb,
  Resolve,
  TransactionData as T,
  Transactions,
  Tx,
  TypeTag
} from "../src/index.ts"
import { RpcError } from "../src/RpcError.ts"

const A = Address.normalize
const D = (seed: number) => base58.encode(new Uint8Array(32).fill(seed)) as T.ObjectDigest
const sender = A("0x5e4d")
const sponsor = A("0x5905")
const CHAIN = D(9)
const CLOCK = A("0x6")
const OWNED = A("0xa1")
const SHARED = A("0xb2")
const TICKET = A("0xc3")
const u64 = Bcs.encodeSync(Bcs.u64)

/**
 * 0: `clock::timestamp_ms(&Clock)`; 1: `pool::swap(&mut Pool, Coin)` with the
 * owned coin; 2: `inbox::take(&mut Pool, Receiving<T>)`; 3: split 5 off gas.
 */
const draft: Ptb.Draft = {
  inputs: [
    { _tag: "UnresolvedObject", objectId: CLOCK },
    { _tag: "UnresolvedObject", objectId: SHARED },
    { _tag: "UnresolvedObject", objectId: OWNED },
    { _tag: "UnresolvedObject", objectId: TICKET },
    { _tag: "Pure", bytes: u64(5n) }
  ],
  commands: [
    Resolve.moveCall("0x2::clock::timestamp_ms", [], [{ _tag: "Input", value: 0 }]),
    Resolve.moveCall("0xd::pool::swap", [], [{ _tag: "Input", value: 1 }, { _tag: "Input", value: 2 }]),
    Resolve.moveCall("0xd::inbox::take", [], [{ _tag: "Input", value: 1 }, { _tag: "Input", value: 3 }]),
    { _tag: "SplitCoins", coin: { _tag: "GasCoin" }, amounts: [{ _tag: "Input", value: 4 }] }
  ]
}

const param = (reference: Packages.Reference, typeName?: string): Packages.Parameter => ({ reference, typeName })
const functions = new Map<number, Packages.MoveFunction>([
  [0, { isEntry: false, parameters: [param("Immutable", "0x2::clock::Clock")] }],
  [1, { isEntry: false, parameters: [param("Mutable", "0xd::pool::Pool"), param("Value", "0x2::coin::Coin")] }],
  [2, {
    isEntry: false,
    parameters: [param("Mutable", "0xd::pool::Pool"), param("Value", "0x0000000000000000000000000000000000000000000000000000000000000002::transfer::Receiving")]
  }]
])

const plan: Resolve.Plan = { sender, draft }
const GAS_COIN = A("0x9a5")
const shared = (objectId: Address.Address, mutability: "Mutable" | "Immutable" | "NonExclusiveWrite"): T.CallArg => ({
  _tag: "Object",
  value: { _tag: "SharedObject", objectId, initialSharedVersion: 1n, mutability: { _tag: mutability } }
})
const resolvedInputs: Array<T.CallArg> = [
  shared(CLOCK, "Immutable"),
  shared(SHARED, "Mutable"),
  { _tag: "Object", value: { _tag: "ImmOrOwnedObject", objectId: OWNED, version: 4n, digest: D(4) } },
  { _tag: "Object", value: { _tag: "Receiving", objectId: TICKET, version: 2n, digest: D(2) } },
  { _tag: "Pure", bytes: u64(5n) }
]
const validDuring = (min: bigint, max: bigint): T.TransactionExpiration => ({
  _tag: "ValidDuring",
  minEpoch: Option.some(min),
  maxEpoch: Option.some(max),
  minTimestamp: Option.none(),
  maxTimestamp: Option.none(),
  chain: CHAIN,
  nonce: 7
})
const answer = (over: Partial<{ inputs: Array<T.CallArg>; commands: ReadonlyArray<T.Command>; sender: Address.Address; gasData: Partial<T.GasData>; expiration: T.TransactionExpiration }> = {}): T.TransactionData => ({
  _tag: "V1",
  kind: { _tag: "ProgrammableTransaction", inputs: over.inputs ?? resolvedInputs, commands: over.commands ?? (draft.commands as ReadonlyArray<T.Command>) },
  sender: over.sender ?? sender,
  gasData: { payment: [{ objectId: GAS_COIN, version: 3n, digest: D(3) }], owner: sender, price: 1000n, budget: 3_000_000n, ...over.gasData },
  expiration: over.expiration ?? { _tag: "None" }
})
const gasCoinChange = (owner: Address.Address, version = 3n): Transactions.ChangedObject => ({
  objectId: GAS_COIN,
  type: "0x2::coin::Coin<0x2::sui::SUI>",
  operation: "None",
  version: 9n,
  digest: D(8),
  owner: { _tag: "AddressOwner", address: owner },
  inputVersion: version,
  inputDigest: D(3),
  inputOwner: { _tag: "AddressOwner", address: owner }
})
const effects = (changes: ReadonlyArray<Transactions.ChangedObject> = [gasCoinChange(sender)]): Transactions.Effects => ({
  digest: "d",
  status: { _tag: "Success" },
  gasUsed: { computationCost: 1_000_000n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n },
  changedObjects: changes
})

const verify = (data: T.TransactionData, p: Resolve.Plan = plan, fx = effects(), epoch?: bigint) =>
  Resolve.verifyResolution(p, data, fx, functions, epoch)

describe("the unresolved transaction as a gRPC Transaction", () => {
  test("unresolved objects go by id (with a forced mutability), resolved inputs and gas as given", () => {
    const withdrawal: T.CallArg = {
      _tag: "FundsWithdrawal",
      reservation: { _tag: "MaxAmountU64", value: 10n },
      typeArg: { _tag: "Balance", value: TypeTag.parse("0x2::sui::SUI") },
      withdrawFrom: { _tag: "SenderAllowance", funder: sponsor, allowance: SHARED }
    }
    const proto = toProto({
      sender,
      gasOwner: sponsor,
      inputs: [
        { _tag: "UnresolvedObject", objectId: CLOCK, mutable: false },
        { _tag: "UnresolvedObject", objectId: OWNED },
        shared(SHARED, "NonExclusiveWrite"),
        resolvedInputs[3]!,
        { _tag: "Pure", bytes: u64(5n) },
        withdrawal
      ],
      commands: [
        ...draft.commands as ReadonlyArray<T.Command>,
        { _tag: "MergeCoins", destination: { _tag: "GasCoin" }, sources: [{ _tag: "NestedResult", value: [3, 0] }] },
        { _tag: "MakeMoveVec", type: Option.some(TypeTag.parse("u64")), elements: [] }
      ],
      gasPrice: 1000n,
      expiration: validDuring(5n, 6n)
    })
    expect(proto.gas_payment).toEqual({ objects: [], owner: sponsor, price: 1000n })
    const ptb = proto.kind?.data?._tag === "programmable_transaction" ? proto.kind.data.value : undefined
    expect(ptb?.inputs).toEqual([
      { object_id: CLOCK, mutable: false },
      { object_id: OWNED },
      { kind: 3, object_id: SHARED, version: 1n, mutable: false, mutability: 3 },
      { kind: 4, object_id: TICKET, version: 2n, digest: D(2) },
      { kind: 1, pure: u64(5n) },
      { kind: 5, funds_withdrawal: { amount: 10n, coin_type: TypeTag.SUI, source: 3, funder: sponsor, allowance: SHARED } }
    ])
    expect(ptb?.commands?.slice(4)).toEqual([
      { command: { _tag: "merge_coins", value: { coin: { kind: 1 }, coins_to_merge: [{ kind: 3, result: 3, subresult: 0 }] } } },
      { command: { _tag: "make_move_vector", value: { element_type: "u64", elements: [] } } }
    ])
    expect(proto.expiration).toEqual({ kind: 3, min_epoch: 5n, epoch: 6n, chain: CHAIN, nonce: 7 })
  })
})

describe("verifyResolution", () => {
  test("accepts a faithful answer, with or without a bounded ValidDuring", () => {
    expect(verify(answer())).toBeUndefined()
    expect(verify(answer({ expiration: validDuring(5n, 6n) }), plan, effects(), 5n)).toBeUndefined()
  })

  const refused = (data: T.TransactionData, p?: Resolve.Plan, fx?: Transactions.Effects, epoch?: bigint) => {
    const r = verify(data, p, fx, epoch)
    expect(r?._tag).toBe("ResolutionRejected")
    return r!.reason
  }

  test("a changed sender or gas owner", () => {
    expect(refused(answer({ sender: sponsor }))).toContain("sender")
    expect(refused(answer({ gasData: { owner: sponsor } }), plan, effects([gasCoinChange(sponsor)]))).toContain("gas owner")
  })

  test("changed commands", () => {
    const commands = [...draft.commands as ReadonlyArray<T.Command>]
    commands[3] = { _tag: "SplitCoins", coin: { _tag: "GasCoin" }, amounts: [{ _tag: "Input", value: 3 }] }
    expect(refused(answer({ commands }))).toContain("commands")
    expect(refused(answer({ commands: commands.slice(0, 3) }))).toContain("commands")
  })

  test("a different input count, another object, or a changed resolved input", () => {
    expect(refused(answer({ inputs: resolvedInputs.slice(0, 4) }))).toContain("inputs")
    const swapped = [...resolvedInputs]
    swapped[2] = { _tag: "Object", value: { _tag: "ImmOrOwnedObject", objectId: A("0xbad"), version: 4n, digest: D(4) } }
    expect(refused(answer({ inputs: swapped }))).toContain(`not object ${OWNED}`)
    const pure = [...resolvedInputs]
    pure[4] = { _tag: "Pure", bytes: u64(6n) }
    expect(refused(answer({ inputs: pure }))).toContain("input 4 changed")
    const notObject = [...resolvedInputs]
    notObject[0] = { _tag: "Pure", bytes: u64(6n) }
    expect(refused(answer({ inputs: notObject }))).toContain("not object")
  })

  test("a shared object weaker than its commands need, or not as forced", () => {
    const weaker = [...resolvedInputs]
    weaker[1] = shared(SHARED, "Immutable")
    expect(refused(answer({ inputs: weaker }))).toContain("must be Mutable")
    weaker[1] = shared(SHARED, "NonExclusiveWrite")
    expect(refused(answer({ inputs: weaker }))).toContain("must be Mutable")
    // Stronger than needed is fine (the clock as Mutable) unless mutability was forced.
    const stronger = [...resolvedInputs]
    stronger[0] = shared(CLOCK, "Mutable")
    expect(verify(answer({ inputs: stronger }))).toBeUndefined()
    const forced: Resolve.Plan = {
      ...plan,
      draft: { ...draft, inputs: [{ _tag: "UnresolvedObject", objectId: CLOCK, mutable: false }, ...draft.inputs.slice(1)] }
    }
    expect(refused(answer({ inputs: stronger }), forced)).toContain("forced immutable")
  })

  test("Receiving exactly where a function receives", () => {
    const owned = [...resolvedInputs]
    owned[3] = { _tag: "Object", value: { _tag: "ImmOrOwnedObject", objectId: TICKET, version: 2n, digest: D(2) } }
    expect(refused(answer({ inputs: owned }))).toContain("must be Receiving")
    const sharedTicket = [...resolvedInputs]
    sharedTicket[3] = shared(TICKET, "Mutable")
    expect(refused(answer({ inputs: sharedTicket }))).toContain("must be Receiving")
    const receiving = [...resolvedInputs]
    receiving[2] = { _tag: "Object", value: { _tag: "Receiving", objectId: OWNED, version: 4n, digest: D(4) } }
    expect(refused(answer({ inputs: receiving }))).toContain("no command receives it")
  })

  test("gas price, budget, payment and expiration that differ from what was given", () => {
    const fixed: Resolve.Plan = {
      ...plan,
      gasPrice: 1500n,
      gasBudget: 9n,
      gasPayment: [{ objectId: GAS_COIN, version: 3n, digest: D(3) }],
      expiration: { _tag: "Epoch", value: 9n }
    }
    const faithful = answer({ gasData: { price: 1500n, budget: 9n }, expiration: { _tag: "Epoch", value: 9n } })
    expect(verify(faithful, fixed)).toBeUndefined()
    expect(refused({ ...faithful, gasData: { ...faithful.gasData, price: 1000n } }, fixed)).toContain("gas price")
    expect(refused({ ...faithful, gasData: { ...faithful.gasData, budget: 10n } }, fixed)).toContain("budget changed")
    expect(refused({ ...faithful, expiration: { _tag: "None" } }, fixed)).toContain("expiration changed")
    expect(refused({ ...faithful, gasData: { ...faithful.gasData, payment: [] } }, fixed)).toContain("payment changed")
    expect(refused(answer({ gasData: { price: 0n } }))).toContain("gas price")
  })

  test("a budget above the cap (the caller's, else 50 SUI)", () => {
    expect(refused(answer({ gasData: { budget: 50_000_000_001n } }))).toContain("above")
    expect(refused(answer({ gasData: { budget: 3_000_000n } }), { ...plan, maxGasBudget: 2_000_000n })).toContain("above 2000000")
  })

  test("an expiration where none was asked for, beyond a two-epoch ValidDuring", () => {
    expect(refused(answer({ expiration: { _tag: "Epoch", value: 9n } }))).toContain("Epoch")
    expect(refused(answer({ expiration: validDuring(5n, 9n) }))).toContain("ValidDuring")
    expect(refused(answer({ expiration: validDuring(5n, 6n) }), plan, effects(), 8n)).toContain("ValidDuring")
    expect(refused(answer({ expiration: { ...validDuring(5n, 6n), maxTimestamp: Option.some(1n) } as T.TransactionExpiration }))).toContain(
      "ValidDuring"
    )
  })

  test("gas coins the gas owner didn't own at those versions, duplicates, inputs as gas", () => {
    expect(refused(answer(), plan, effects([]))).toContain("not owned by")
    expect(refused(answer(), plan, effects([gasCoinChange(sponsor)]))).toContain("not owned by")
    expect(refused(answer(), plan, effects([gasCoinChange(sender, 2n)]))).toContain("not owned by")
    const coin = { objectId: GAS_COIN, version: 3n, digest: D(3) }
    expect(refused(answer({ gasData: { payment: [coin, coin] } }))).toContain("twice")
    const asInput = { objectId: OWNED, version: 4n, digest: D(4) }
    expect(refused(answer({ gasData: { payment: [asInput] } }))).toContain("also an input")
  })

  test("sponsored: the sponsor's coins and the sponsor's address-balance reservation", () => {
    const sponsored: Resolve.Plan = { ...plan, gasOwner: sponsor }
    const reservation = CoinReservation.make({ reserved: 10n, owner: sponsor, chainId: CHAIN, epoch: 5n })
    const ok = answer({ gasData: { owner: sponsor, payment: [reservation, { objectId: GAS_COIN, version: 3n, digest: D(3) }] }, expiration: validDuring(5n, 6n) })
    expect(verify(ok, sponsored, effects([gasCoinChange(sponsor)]))).toBeUndefined()
    // The sender's coin, or the sender's reservation, may not pay a sponsored transaction.
    expect(refused(ok, sponsored, effects([gasCoinChange(sender)]))).toContain("not owned by")
    const sendersReservation = CoinReservation.make({ reserved: 10n, owner: sender, chainId: CHAIN, epoch: 5n })
    expect(refused({ ...ok, gasData: { ...ok.gasData, payment: [sendersReservation] } }, sponsored)).toContain("reservation")
    // A reservation with no chain to check it against.
    expect(refused({ ...ok, gasData: { ...ok.gasData, payment: [reservation] }, expiration: { _tag: "None" } }, sponsored)).toContain(
      "reservation"
    )
  })
})

// -----------------------------------------------------------------------------
// Tx.resolve: which path
// -----------------------------------------------------------------------------

const clockOnly: Ptb.Draft = { inputs: [{ _tag: "UnresolvedObject", objectId: CLOCK }], commands: [draft.commands[0]!] }
const clockAnswer: T.TransactionData = {
  _tag: "V1",
  kind: { _tag: "ProgrammableTransaction", inputs: [shared(CLOCK, "Immutable")], commands: [draft.commands[0] as T.Command] },
  sender,
  gasData: { payment: [], owner: sender, price: 1000n, budget: 2_000_000n },
  expiration: validDuring(5n, 6n)
}

const services = (resolve: Transactions.Transactions["Service"]["resolve"], calls: Array<string>) =>
  Layer.mergeAll(
    Layer.succeed(Transactions.Transactions, {
      simulate: () =>
        Effect.sync(() => {
          calls.push("simulate")
          return { effects: effects([]), returnValues: [] }
        }),
      execute: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      ...(resolve && { resolve: (tx: Transactions.UnresolvedTransaction) => Effect.suspend(() => (calls.push("resolve"), resolve(tx))) })
    }),
    Layer.succeed(Packages.Packages, {
      getFunction: () => Effect.sync(() => (calls.push("getFunction"), functions.get(0)!)),
      getModules: () => Effect.die("unused")
    }),
    Layer.succeed(Objects.Objects, {
      get: (id) =>
        Effect.sync(() => {
          calls.push("getObject")
          return { objectId: id, version: 9n, digest: D(1), owner: { _tag: "Shared" as const, initialSharedVersion: 1n }, type: "0x2::clock::Clock", contents: new Uint8Array(), previousTransaction: undefined }
        }),
      listOwned: () => Stream.empty
    }),
    Layer.succeed(Chain.Chain, {
      info: Effect.sync(() => (calls.push("info"), { chainId: CHAIN, chain: "test", epoch: 5n, checkpointHeight: 1n })),
      referenceGasPrice: Effect.sync(() => (calls.push("price"), 1000n))
    }),
    Layer.succeed(Coins.Coins, {
      getBalance: (_o, coinType = TypeTag.SUI) =>
        Effect.sync(() => (calls.push("getBalance"), { coinType, total: 10n ** 12n, addressBalance: 10n ** 12n, coinBalance: 0n })),
      listBalances: () => Stream.die("unused"),
      list: () => Stream.empty
    })
  )

const resolveWith = (resolve: Transactions.Transactions["Service"]["resolve"], options: Partial<Tx.ResolveOptions<any, any>> = {}) => {
  const calls: Array<string> = []
  return Effect.runPromiseExit(
    Tx.resolve(clockOnly, { sender, ...options }).pipe(Effect.provide(services(resolve, calls))) as Effect.Effect<T.TransactionData, any>
  ).then((exit) => ({ exit, calls }))
}
const node = (data: T.TransactionData = clockAnswer) => () =>
  Effect.succeed({ transaction: T.encode(data), effects: effects([]), epoch: 5n })

describe("Tx.resolve picks a path", () => {
  test("auto: one resolve (and the signature it checks against), nothing else", async () => {
    const { exit, calls } = await resolveWith(node())
    expect(Exit.isSuccess(exit) && exit.value).toEqual(clockAnswer)
    expect(calls.sort()).toEqual(["getFunction", "resolve"])
  })

  test("auto: a transport without resolve, a custom strategy or fixed([]) resolve client-side", async () => {
    for (const [resolve, options] of [
      [undefined, {}],
      [node(), { payment: Resolve.addressBalance }],
      [node(), { payment: Resolve.fixed([]), gasBudget: 2_000_000n }]
    ] as const) {
      const { exit, calls } = await resolveWith(resolve, options)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).not.toContain("resolve")
      expect(calls).toContain("getObject")
    }
  })

  test("auto: a non-retryable RpcError from the node is redone client-side; a retryable one is not", async () => {
    const refusing = await resolveWith(() => Effect.fail(new RpcError({ method: "SimulateTransaction", code: "INVALID_ARGUMENT", message: "no" })))
    expect(Exit.isSuccess(refusing.exit)).toBe(true)
    expect(refusing.calls).toContain("getObject")
    const down = await resolveWith(() => Effect.fail(new RpcError({ method: "SimulateTransaction", code: "UNAVAILABLE", message: "down" })))
    expect(Exit.isFailure(down.exit)).toBe(true)
    expect(down.calls).not.toContain("getObject")
  })

  test("a rejected answer is an error, never a silent fallback", async () => {
    const { exit, calls } = await resolveWith(node({ ...clockAnswer, sender: sponsor }))
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("ResolutionRejected")
    expect(calls).not.toContain("getObject")
  })

  test("a simulated abort is GasEstimationFailed with the structured abort", async () => {
    const failed = effects([])
    const { exit } = await resolveWith(() =>
      Effect.succeed({
        transaction: T.encode(clockAnswer),
        effects: {
          ...failed,
          status: {
            _tag: "Failure",
            description: "MoveAbort(MoveLocation { .. }, 7) in command 0",
            command: 0,
            abortCode: 7n,
            location: { package: A("0x2"), module: "clock", function: "timestamp_ms", instruction: 3 },
            cleverError: { errorCode: undefined, lineNumber: 12n, constantName: "ENope", constantType: "vector<u8>", rendered: "nope" }
          }
        },
        epoch: 5n
      })
    )
    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    expect(error && "error" in error && error.error).toMatchObject({
      _tag: "GasEstimationFailed",
      command: 0,
      abort: { code: 7n, package: A("0x2"), module: "clock", function: "timestamp_ms", instruction: 3, constant: "ENope", line: 12, rendered: "nope" }
    })
  })

  test("server: no fallback, and a transport without resolve or a custom strategy is refused", async () => {
    const refusing = await resolveWith(
      () => Effect.fail(new RpcError({ method: "SimulateTransaction", code: "INVALID_ARGUMENT", message: "no" })),
      { resolve: "server" }
    )
    expect(Exit.isFailure(refusing.exit) && JSON.stringify(refusing.exit.cause)).toContain("INVALID_ARGUMENT")
    const none = await resolveWith(undefined, { resolve: "server" })
    expect(Exit.isFailure(none.exit) && JSON.stringify(none.exit.cause)).toContain("Incomplete")
    const custom = await resolveWith(node(), { resolve: "server", payment: Resolve.coins })
    expect(Exit.isFailure(custom.exit) && JSON.stringify(custom.exit.cause)).toContain("InvalidTransaction")
  })

  test("client: never asks the node to resolve", async () => {
    const { exit, calls } = await resolveWith(node(), { resolve: "client" })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls).not.toContain("resolve")
    expect(calls).toContain("simulate")
  })

  test("maxGasBudget refuses a larger budget on either path", async () => {
    for (const resolve of ["server", "client"] as const) {
      const { exit } = await resolveWith(node(), { resolve, maxGasBudget: 1_000n })
      expect(Exit.isFailure(exit)).toBe(true)
    }
  })

  test("the node gets what the caller fixed: gas owner, price, budget, payment, expiration", async () => {
    let seen: Transactions.UnresolvedTransaction | undefined
    const payment = [{ objectId: GAS_COIN, version: 3n, digest: D(3) }]
    const data = { ...clockAnswer, gasData: { payment, owner: sponsor, price: 1500n, budget: 9_000_000n } }
    const { exit } = await resolveWith(
      (tx) => {
        seen = tx
        return Effect.succeed({ transaction: T.encode(data), effects: effects([]), epoch: 5n })
      },
      { gasOwner: sponsor, gasPrice: 1500n, gasBudget: 9_000_000n, payment: Resolve.fixed(payment), expiration: clockAnswer.expiration, resolve: "server" }
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(seen).toMatchObject({ sender, gasOwner: sponsor, gasPrice: 1500n, gasBudget: 9_000_000n, gasPayment: payment })
    expect(seen?.inputs).toEqual([{ _tag: "UnresolvedObject", objectId: CLOCK }])
  })
})
