/**
 * Offline: the Effect builder + our BCS produce the same bytes as
 * @mysten/sui's Transaction.build for a fully-specified transaction, and the
 * Effect Ed25519 signer produces the same address and signature.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Inputs, Transaction } from "@mysten/sui/transactions"
import { toBase64 } from "@mysten/sui/utils"
import { base58 } from "@scure/base"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SecureRandom, Signature } from "effect/crypto"
import * as Bcs from "../src/bcs/Bcs.ts"
import * as Signer from "../src/crypto/Signer.ts"
import * as T from "../src/sui/Types.ts"
import * as Ptb from "../src/tx/Ptb.ts"

const sender = T.address("0x1234")
const recipient = T.address("0xcafe")
const coinRef = { objectId: T.address("0xbeef"), version: 3n, digest: base58.encode(new Uint8Array(32).fill(4)) as T.ObjectDigest }
const gasRef = { objectId: T.address("0xfeed"), version: 9n, digest: base58.encode(new Uint8Array(32).fill(7)) as T.ObjectDigest }

/** A reusable recipe: no chain access needed, so its R is only PtbBuilder. */
const payTwo = (to: T.Address, a: bigint, b: bigint) =>
  Effect.gen(function*() {
    const coins = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(a), yield* Ptb.u64(b)])
    yield* Ptb.transferObjects(coins, yield* Ptb.address(to))
  })

const recipe = Effect.gen(function*() {
  const coin = yield* Ptb.objectArg({ _tag: "ImmOrOwnedObject", ...coinRef })
  yield* Ptb.mergeCoins(Ptb.gas, [coin])
  yield* payTwo(recipient, 100n, 200n)
  yield* Ptb.moveCall({ target: "0x2::coin::value", typeArguments: ["0x2::sui::SUI"], arguments: [Ptb.gas] })
})

describe("Ptb", () => {
  test("builds the same bytes as @mysten/sui", async () => {
    const { draft } = await Effect.runPromise(Ptb.build(recipe))
    const ptb = Ptb.toProgrammable(draft)!
    const ours = Bcs.encodeSync(T.TransactionData)({
      _tag: "V1",
      kind: { _tag: "ProgrammableTransaction", ...ptb },
      sender,
      gasData: { payment: [gasRef], owner: sender, price: 1000n, budget: 10_000_000n },
      expiration: { _tag: "None" }
    })

    const tx = new Transaction()
    tx.setSender(sender)
    tx.setGasPrice(1000)
    tx.setGasBudget(10_000_000)
    tx.setGasPayment([{ ...gasRef, version: gasRef.version.toString() }])
    tx.setExpiration({ None: true })
    tx.mergeCoins(tx.gas, [tx.object(Inputs.ObjectRef({ ...coinRef, version: coinRef.version.toString() }))])
    const coins = tx.splitCoins(tx.gas, [tx.pure.u64(100), tx.pure.u64(200)])
    tx.transferObjects([coins[0]!, coins[1]!], tx.pure.address(recipient))
    tx.moveCall({ target: "0x2::coin::value", typeArguments: ["0x2::sui::SUI"], arguments: [tx.gas] })
    const theirs = await tx.build()

    expect(toBase64(ours)).toBe(toBase64(theirs))
  })

  test("bad pure values fail in the error channel", async () => {
    const exit = await Effect.runPromiseExit(Ptb.build(Ptb.u8(300)))
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("InvalidPureValue")
  })

  test("the same object id maps to one input", async () => {
    const { draft } = await Effect.runPromise(Ptb.build(Effect.all([Ptb.object("0x6"), Ptb.object("0x06")])))
    expect(draft.inputs.length).toBe(1)
  })
})

describe("Signer", () => {
  const crypto = Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))

  test("Ed25519 via effect/crypto matches @mysten/sui", async () => {
    const seed = new Uint8Array(32).map((_, i) => i + 1)
    const bytes = Bcs.encodeSync(T.TransactionData)({
      _tag: "V1",
      kind: { _tag: "ProgrammableTransaction", inputs: [], commands: [] },
      sender,
      gasData: { payment: [gasRef], owner: sender, price: 1000n, budget: 10_000_000n },
      expiration: { _tag: "None" }
    })

    const { address, signature } = await Effect.runPromise(
      Effect.gen(function*() {
        const signer = yield* Signer.ed25519(seed)
        return { address: signer.address, signature: yield* Signer.signTransaction(signer, bytes) }
      }).pipe(Effect.provide(crypto))
    )

    const kp = Ed25519Keypair.fromSecretKey(seed)
    expect(address).toBe(kp.toSuiAddress() as T.Address)
    const theirs = await kp.signTransaction(bytes)
    expect(toBase64(signature)).toBe(theirs.signature)
  })
})
