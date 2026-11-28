/**
 * Byte-for-byte parity with @mysten/sui (a devDependency used only as the reference).
 */
import { bcs as mysten } from "@mysten/sui/bcs"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Inputs, Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { base58 } from "@scure/base"
import { Bcs } from "@unconfirmed/effect-bcs"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Option, Result } from "effect"
import { Address, Ed25519, Hash, Move, Ptb, Signer, TransactionData as T, Tx, TypeTag } from "../src/index.ts"
import { toB64, toMysten } from "./support.ts"

const A = Address.normalize
const D = (seed: number) => base58.encode(new Uint8Array(32).fill(seed)) as T.ObjectDigest
const sender = A("0x1234")
const gasRef = { objectId: A("0xfeed"), version: 9n, digest: D(7) }

const sample: T.TransactionData = {
  _tag: "V1",
  kind: {
    _tag: "ProgrammableTransaction",
    inputs: [
      { _tag: "Pure", bytes: new Uint8Array([1, 2, 3]) },
      { _tag: "Object", value: { _tag: "ImmOrOwnedObject", objectId: A("0xabc"), version: 7n, digest: D(9) } },
      { _tag: "Object", value: { _tag: "SharedObject", objectId: A("0x6"), initialSharedVersion: 1n, mutability: { _tag: "Immutable" } } },
      { _tag: "Object", value: { _tag: "Receiving", objectId: A("0xdef"), version: 2n, digest: D(3) } }
    ],
    commands: [
      { _tag: "SplitCoins", coin: { _tag: "GasCoin" }, amounts: [{ _tag: "Input", value: 0 }] },
      {
        _tag: "MoveCall",
        package: A("0x2"),
        module: "coin",
        function: "value",
        typeArguments: [TypeTag.parse("0x2::sui::SUI")],
        arguments: [{ _tag: "NestedResult", value: [0, 0] }, { _tag: "Input", value: 2 }]
      },
      { _tag: "MakeMoveVec", type: Option.some(TypeTag.parse("vector<0x2::coin::Coin<0x2::sui::SUI>>")), elements: [] },
      { _tag: "TransferObjects", objects: [{ _tag: "Result", value: 0 }], address: { _tag: "Input", value: 1 } }
    ]
  },
  sender,
  gasData: { payment: [gasRef], owner: sender, price: 1000n, budget: 5_000_000n },
  expiration: {
    _tag: "ValidDuring",
    minEpoch: Option.some(10n),
    maxEpoch: Option.some(11n),
    minTimestamp: Option.none(),
    maxTimestamp: Option.none(),
    chain: D(1),
    nonce: 42
  }
}

describe("TransactionData", () => {
  const theirs = () => mysten.TransactionData.serialize(toMysten(Bcs.layoutOf(T.TransactionData), sample)).toBytes()

  test("encodes like @mysten/sui, decodes its bytes back, and has the same digest", () => {
    expect(toB64(T.encode(sample))).toBe(toB64(theirs()))
    expect(toB64(T.encode(Result.getOrThrow(T.decode(theirs()))))).toBe(toB64(theirs()))
    expect(Hash.transactionDigest(T.encode(sample))).toBe(TransactionDataBuilder.getDigestFromBytes(theirs()))
  })
})

describe("Ptb", () => {
  const coinRef = { objectId: A("0xbeef"), version: 3n, digest: D(4) }
  const payTwo = (to: Address.Address, a: bigint, b: bigint) =>
    Effect.gen(function*() {
      const coins = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(a), yield* Ptb.u64(b)])
      yield* Ptb.transferObjects(coins, yield* Ptb.address(to))
    })

  test("builds the same bytes as Transaction.build", async () => {
    const { draft } = await Effect.runPromise(
      Ptb.build(Effect.gen(function*() {
        const coin = yield* Ptb.objectArg({ _tag: "ImmOrOwnedObject", ...coinRef })
        yield* Ptb.mergeCoins(Ptb.gas, [coin])
        yield* payTwo(A("0xcafe"), 100n, 200n)
        yield* Ptb.moveCall({ target: "0x2::coin::value", typeArguments: ["0x2::sui::SUI"], arguments: [Ptb.gas] })
      }))
    )
    const ours = T.encode({
      _tag: "V1",
      kind: { _tag: "ProgrammableTransaction", ...Ptb.toProgrammable(draft)! },
      sender,
      gasData: { payment: [gasRef], owner: sender, price: 1000n, budget: 10_000_000n },
      expiration: { _tag: "None" }
    })

    const tx = new Transaction()
    tx.setSender(sender)
    tx.setGasPrice(1000)
    tx.setGasBudget(10_000_000)
    tx.setGasPayment([{ ...gasRef, version: "9" }])
    tx.setExpiration({ None: true })
    tx.mergeCoins(tx.gas, [tx.object(Inputs.ObjectRef({ ...coinRef, version: "3" }))])
    const coins = tx.splitCoins(tx.gas, [tx.pure.u64(100), tx.pure.u64(200)])
    tx.transferObjects([coins[0]!, coins[1]!], tx.pure.address(A("0xcafe")))
    tx.moveCall({ target: "0x2::coin::value", typeArguments: ["0x2::sui::SUI"], arguments: [tx.gas] })
    expect(toB64(ours)).toBe(toB64(await tx.build()))
  })
})

describe("kind bytes (generated-call refs, buildKind, fromKind, digest)", () => {
  const Package = Context.Reference<string>("test/pool", { defaultValue: () => A("0xabc") })
  const pool = { objectId: A("0x5001"), initialSharedVersion: 7n, mutable: true }
  const cap = { objectId: A("0xca9"), version: 3n, digest: D(4) }
  const parcel = { objectId: A("0xb0c"), version: 2n, digest: D(5) }
  // As a generated `pool::deposit(amount: u64, pool: &mut Pool, cap: &Cap, parcel: Receiving<Parcel>): Coin`.
  const deposit = (amount: bigint, args: ReadonlyArray<Move.ObjectInput>) =>
    Move.call(Package, "pool::deposit", [], [Move.pure(Bcs.u64, amount), ...args.map(Move.obj)], 1)
  const mysten = () => {
    const tx = new Transaction()
    tx.moveCall({
      target: `${A("0xabc")}::pool::deposit`,
      arguments: [
        tx.pure.u64(5),
        tx.sharedObjectRef({ ...pool, initialSharedVersion: "7" }),
        tx.objectRef({ ...cap, version: "3" }),
        tx.receivingRef({ ...parcel, version: "2" })
      ]
    })
    return tx
  }

  test("shared, owned and receiving refs are added in parameter order: buildKind equals onlyTransactionKind", async () => {
    const ours = await Effect.runPromise(
      Ptb.buildKind(deposit(5n, [pool, { ...cap, digest: String(cap.digest) }, Ptb.receiving(parcel)]))
    )
    expect(toB64(ours.bytes)).toBe(toB64(await mysten().build({ onlyTransactionKind: true })))
    const unresolved = await Effect.runPromise(Effect.flip(Ptb.buildKind(deposit(5n, ["0x5001", cap, Ptb.receiving(parcel)]))))
    expect(unresolved._tag).toBe("Incomplete")
  })

  test("fromKind rebuilds the kind and extends it as Transaction.fromKind does; Tx.digest equals getDigest", async () => {
    const kind = await mysten().build({ onlyTransactionKind: true })
    const roundTrip = await Effect.runPromise(Ptb.buildKind(Ptb.fromKind(kind)))
    expect(toB64(roundTrip.bytes)).toBe(toB64(kind))

    const extended = await Effect.runPromise(Ptb.build(Effect.gen(function*() {
      const { results } = yield* Ptb.fromKind(kind)
      yield* Ptb.moveCall({ target: `${A("0xabc")}::pool::touch`, arguments: [yield* Ptb.sharedObject(pool.objectId, 7n, false)] })
      yield* Ptb.transferObjects([Ptb.nested(results[0]!, 0)], yield* Ptb.address(sender))
    })))
    const data: T.TransactionData = {
      _tag: "V1",
      kind: { _tag: "ProgrammableTransaction", ...Ptb.toProgrammable(extended.draft)! },
      sender,
      gasData: { payment: [gasRef], owner: sender, price: 1000n, budget: 10_000_000n },
      expiration: { _tag: "None" }
    }
    const tx = Transaction.fromKind(kind)
    tx.moveCall({ target: `${A("0xabc")}::pool::touch`, arguments: [tx.sharedObjectRef({ ...pool, initialSharedVersion: "7", mutable: false })] })
    tx.transferObjects([{ $kind: "NestedResult", NestedResult: [0, 0] }], tx.pure.address(sender))
    tx.setSender(sender)
    tx.setGasPrice(1000)
    tx.setGasBudget(10_000_000)
    tx.setGasPayment([{ ...gasRef, version: "9" }])
    tx.setExpiration({ None: true })
    expect(toB64(T.encode(data))).toBe(toB64(await tx.build()))
    expect(await Effect.runPromise(Tx.digest(data))).toBe(await tx.getDigest())
  })
})

describe("Ed25519", () => {
  const seed = new Uint8Array(32).map((_, i) => i + 1)
  const kp = Ed25519Keypair.fromSecretKey(seed)

  test("address and transaction signature match; personal message signatures verify with @mysten/sui", async () => {
    const signer = await Effect.runPromise(Ed25519.fromSecretKey(seed))
    expect(signer.address).toBe(kp.toSuiAddress() as Address.Address)
    const bytes = T.encode(sample)
    const ours = await Effect.runPromise(Signer.signTransaction(signer, bytes))
    expect(toB64(ours.signature)).toBe((await kp.signTransaction(bytes)).signature)
    const msg = new TextEncoder().encode("hello")
    const signed = await Effect.runPromise(Signer.signPersonalMessage(signer, msg))
    const pk = await verifyPersonalMessageSignature(msg, toB64(signed.signature), { offline: true })
    expect(pk.toSuiAddress()).toBe(signer.address)
  })
})
