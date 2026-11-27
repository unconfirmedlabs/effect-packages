/**
 * The wallet adapter against an in-process wallet-standard wallet (Ed25519,
 * parsing what it receives with @mysten/sui's `Transaction.from`).
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { verifyPersonalMessageSignature, verifyTransactionSignature } from "@mysten/sui/verify"
import { base58 } from "@scure/base"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Result, Stream } from "effect"
import {
  Address,
  Chain,
  Coins,
  Ed25519,
  Hash,
  Objects,
  Packages,
  Ptb,
  Resolve,
  SignatureScheme,
  TransactionData as T,
  Transactions,
  Tx,
  TypeTag,
  Verify
} from "@unconfirmed/sui"
import { Wallet } from "../src/index.ts"
import { fakeWallet, type FakeWalletOptions } from "./FakeWallet.ts"

const A = Address.normalize
const D = (seed: number) => base58.encode(new Uint8Array(32).fill(seed)) as T.ObjectDigest
const SEED = new Uint8Array(32).fill(7)
const keypair = Ed25519Keypair.fromSecretKey(SEED)
const recipient = A("0xcafe")
const gasRef = { objectId: A("0xfeed"), version: 9n, digest: D(9) }
const chain = "sui:devnet" as const

const make = (options: Partial<FakeWalletOptions> = {}) => fakeWallet({ keypair, ...options })

/** Register, connect, and make a signer. */
const connected = (options: Partial<FakeWalletOptions> = {}) =>
  Effect.gen(function*() {
    const fake = make(options)
    yield* Wallet.register(fake.wallet)
    const wallet = yield* Wallet.find(fake.wallet.name)
    yield* Wallet.connect(wallet)
    return { fake, wallet }
  })

/** A Transactions service that records what it was asked to execute. */
const recorder = () => {
  const executed: Array<{ bytes: Uint8Array; signatures: ReadonlyArray<Uint8Array> }> = []
  const layer = Layer.succeed(Transactions.Transactions, {
    simulate: () => Effect.die("no simulation expected"),
    get: () => Effect.die("no reads expected"),
    execute: (bytes, signatures) => {
      executed.push({ bytes, signatures })
      return Effect.succeed({
        digest: Hash.transactionDigest(bytes),
        status: { _tag: "Success" },
        gasUsed: { computationCost: 1n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n },
        changedObjects: []
      })
    }
  })
  return { executed, layer }
}

const unused = Layer.mergeAll(
  Layer.succeed(Objects.Objects, { get: () => Effect.die("unused"), listOwned: () => Stream.die("unused") }),
  Layer.succeed(Packages.Packages, { getFunction: () => Effect.die("unused") }),
  Layer.succeed(Coins.Coins, { getBalance: () => Effect.die("unused"), list: () => Stream.die("unused") }),
  Layer.succeed(Chain.Chain, { info: Effect.die("unused"), referenceGasPrice: Effect.die("unused") })
)

const schemes = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme)

const pay = Effect.gen(function*() {
  const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
  yield* Ptb.transferObjects([coin!], yield* Ptb.address(recipient))
})

const fixedGas = { gasPrice: 1000n, gasBudget: 5_000_000n, payment: Resolve.fixed([gasRef]), expiration: { _tag: "None" } } as const

/** Resolved offline: no services. */
const resolvedFor = (sender: Address.Address, gasOwner?: Address.Address) =>
  Effect.gen(function*() {
    const { draft } = yield* Ptb.build(pay)
    return yield* Resolve.finish({
      sender,
      draft,
      gasPrice: 1000n,
      gasBudget: 5_000_000n,
      gasPayment: [gasRef],
      ...(gasOwner && { gasOwner })
    })
  })

const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.scoped(effect) as Effect.Effect<A, E>)

// -----------------------------------------------------------------------------

describe("discovery and connection", () => {
  test("register, list, find; non-Sui wallets are filtered out", () =>
    run(Effect.gen(function*() {
      const sui = make({ name: "Sui One" })
      const other = make({ name: "Elsewhere", chains: ["solana:mainnet"] })
      yield* Wallet.register(sui.wallet, other.wallet)
      const names = (yield* Wallet.wallets).map((w) => w.name)
      expect(names).toContain("Sui One")
      expect(names).not.toContain("Elsewhere")
      expect((yield* Wallet.find("Sui One")).chains).toEqual(["sui:devnet", "sui:testnet"])
      expect((yield* Effect.flip(Wallet.find("Elsewhere")))._tag).toBe("WalletNotFound")
    })))

  test("registration is scoped", async () => {
    await run(Wallet.register(make({ name: "Scoped" }).wallet))
    const e = await run(Effect.flip(Wallet.find("Scoped")))
    expect(e._tag).toBe("WalletNotFound")
  })

  test("changes emits the current list, then on every registration", () =>
    run(Effect.gen(function*() {
      const fiber = yield* Wallet.changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Wallet.register(make({ name: "Late Arrival" }).wallet)
      const lists = yield* Fiber.join(fiber)
      expect(lists[0]!.map((w) => w.name)).not.toContain("Late Arrival")
      expect(lists[1]!.map((w) => w.name)).toContain("Late Arrival")
    })))

  test("connect exposes accounts (our address for the same key) and chains; disconnect", () =>
    run(Effect.gen(function*() {
      const fake = make({ name: "Connectable" })
      yield* Wallet.register(fake.wallet)
      const wallet = yield* Wallet.find("Connectable")
      expect(Wallet.accounts(wallet)).toEqual([])
      const changes = yield* Wallet.accountChanges(wallet).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const accounts = yield* Wallet.connect(wallet)
      const ours = yield* Ed25519.fromSecretKey(SEED)
      expect(accounts.map((a) => a.address)).toEqual([ours.address])
      expect(accounts[0]!.publicKey).toEqual(ours.publicKey.bytes)
      expect(accounts[0]!.chains).toEqual(["sui:devnet", "sui:testnet"])
      yield* Wallet.disconnect(wallet)
      expect(Wallet.accounts(wallet)).toEqual([])
      expect((yield* Fiber.join(changes)).map((as) => as.length)).toEqual([0, 1, 0])
    })))

  test("a refused connect is ConnectionError(rejected); no standard:connect is UnsupportedFeature", () =>
    run(Effect.gen(function*() {
      const refusing = make({ name: "Refusing", reject: { connect: true } })
      const minimal = make({ name: "Minimal", features: ["sui:signTransaction"] })
      yield* Wallet.register(refusing.wallet, minimal.wallet)
      expect(yield* Effect.flip(Wallet.connect(refusing.wallet))).toMatchObject({ _tag: "ConnectionError", reason: "rejected" })
      expect(yield* Effect.flip(Wallet.connect(minimal.wallet))).toMatchObject({ _tag: "UnsupportedFeature", feature: "standard:connect" })
    })))
})

describe("the wallet as a TransactionSigner", () => {
  test("Tx.execute: the wallet signs our resolved bytes (via Transaction.from) and we execute them", async () => {
    const rec = recorder()
    const { fake, data, signer } = await run(Effect.gen(function*() {
      const { fake, wallet } = yield* connected({ name: "Signs" })
      const signer = yield* Wallet.signer(wallet, { chain })
      const data = yield* resolvedFor(signer.address)
      yield* Tx.execute(data, signer)
      return { fake, data, signer }
    }).pipe(Effect.provide(rec.layer)))
    expect(fake.received).toHaveLength(1)
    expect(JSON.parse(fake.received[0]!).digest).toBe(Hash.transactionDigest(T.encode(data)))
    const [{ bytes, signatures }] = rec.executed as [typeof rec.executed[0]]
    expect(bytes).toEqual(T.encode(data))
    // The signature verifies with our registry and with @mysten/sui.
    const verified = await Effect.runPromise(Verify.transaction(bytes, signatures[0]!, { address: signer.address }).pipe(Effect.provide(schemes)))
    expect(verified.address).toBe(signer.address)
    expect((await verifyTransactionSignature(bytes, Buffer.from(signatures[0]!).toString("base64"), { offline: true })).toSuiAddress()).toBe(signer.address)
  })

  test("Tx.run with a wallet signer (sender = the wallet account)", async () => {
    const rec = recorder()
    const effects = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Runs" })
      const signer = yield* Wallet.signer(wallet, { chain })
      return yield* Tx.run(pay, { signer, ...fixedGas })
    }).pipe(Effect.provide(Layer.merge(rec.layer, unused))))
    expect(effects.status._tag).toBe("Success")
    const data = Result.getOrThrow(T.decode(rec.executed[0]!.bytes))
    expect(data.sender).toBe(A(keypair.toSuiAddress()))
  })

  test("a wallet that changes the transaction: we execute exactly the bytes it signed", async () => {
    const rec = recorder()
    const ours = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Changes", mutate: (tx) => tx.setGasBudget(7_777_777) })
      const signer = yield* Wallet.signer(wallet, { chain })
      const data = yield* resolvedFor(signer.address)
      yield* Tx.execute(data, signer)
      return data
    }).pipe(Effect.provide(rec.layer)))
    const { bytes, signatures } = rec.executed[0]!
    expect(bytes).not.toEqual(T.encode(ours))
    const theirs = Result.getOrThrow(T.decode(bytes))
    expect(theirs.gasData.budget).toBe(7_777_777n)
    await Effect.runPromise(Verify.transaction(bytes, signatures[0]!).pipe(Effect.provide(schemes)))
  })

  test("wallet sender + key-signer sponsor: the sponsor signs the wallet's final bytes, signatures keep their order", async () => {
    const rec = recorder()
    const sponsor = await Effect.runPromise(Ed25519.fromSecretKey(new Uint8Array(32).fill(9)))
    await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Sponsored", mutate: (tx) => tx.setGasBudget(6_000_000) })
      const signer = yield* Wallet.signer(wallet, { chain })
      const data = yield* resolvedFor(signer.address, sponsor.address)
      yield* Tx.execute(data, [sponsor, signer])
    }).pipe(Effect.provide(rec.layer)))
    const { bytes, signatures } = rec.executed[0]!
    const who = await Effect.runPromise(
      Effect.forEach(signatures, (s) => Verify.transaction(bytes, s)).pipe(Effect.provide(schemes))
    )
    expect(who.map((v) => v.address)).toEqual([sponsor.address, A(keypair.toSuiAddress())])
  })

  test("a second wallet may not change what the first already signed", async () => {
    const other = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3))
    const e = await run(Effect.gen(function*() {
      const a = yield* connected({ name: "First" })
      const b = yield* connected({ name: "Second", keypair: other, mutate: (tx) => tx.setGasBudget(1_234_567) })
      const s1 = yield* Wallet.signer(a.wallet, { chain })
      const s2 = yield* Wallet.signer(b.wallet, { chain })
      const data = yield* resolvedFor(s1.address, s2.address)
      return yield* Effect.flip(Tx.execute(data, [s1, s2]))
    }).pipe(Effect.provide(recorder().layer)))
    expect(e).toMatchObject({ _tag: "SigningError", reason: "failed" })
  })

  test("a user rejection is SigningError(rejected), and nothing is executed", async () => {
    const rec = recorder()
    const e = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Rejects", reject: { sign: true } })
      const signer = yield* Wallet.signer(wallet, { chain })
      return yield* Effect.flip(Tx.execute(yield* resolvedFor(signer.address), signer))
    }).pipe(Effect.provide(rec.layer)))
    expect(e).toMatchObject({ _tag: "SigningError", reason: "rejected" })
    expect(rec.executed).toHaveLength(0)
  })

  test("signer needs sui:signTransaction, a supported chain and a connected account", () =>
    run(Effect.gen(function*() {
      const noSign = make({ name: "No Sign", features: ["standard:connect", "sui:signPersonalMessage"] })
      yield* Wallet.register(noSign.wallet)
      yield* Wallet.connect(noSign.wallet)
      expect(yield* Effect.flip(Wallet.signer(noSign.wallet, { chain }))).toMatchObject({ _tag: "UnsupportedFeature", feature: "sui:signTransaction" })

      const fake = make({ name: "Not Connected" })
      yield* Wallet.register(fake.wallet)
      expect((yield* Effect.flip(Wallet.signer(fake.wallet, { chain })))._tag).toBe("AccountNotFound")
      yield* Wallet.connect(fake.wallet)
      expect(yield* Effect.flip(Wallet.signer(fake.wallet, { chain: "sui:mainnet" }))).toMatchObject({ _tag: "UnsupportedChain", chain: "sui:mainnet" })
      expect((yield* Effect.flip(Wallet.signer(fake.wallet, { chain, account: "0x1" })))._tag).toBe("AccountNotFound")
      expect((yield* Wallet.signer(fake.wallet, { chain, account: keypair.toSuiAddress() })).address).toBe(A(keypair.toSuiAddress()))
    })))
})

describe("the wallet resolves", () => {
  const TOKEN = TypeTag.normalizeString("0x123::token::TOKEN")
  const client = {
    core: {
      resolveTransactionPlugin: () => null,
      getBalance: async () => ({ balance: { coinType: TOKEN, balance: "1000", addressBalance: "1000", coinBalance: "0" } }),
      listCoins: async () => ({ objects: [], hasNextPage: false, cursor: null })
    }
  }

  test("signUnresolved: a Draft with a coin intent goes to the wallet as JSON; it resolves and signs", async () => {
    const signed = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Resolver", client })
      const signer = yield* Wallet.signer(wallet, { chain })
      const { draft } = yield* Ptb.build(Effect.gen(function*() {
        const coin = yield* Ptb.coin({ amount: 300n, type: TOKEN })
        yield* Ptb.transferObjects([coin], yield* Ptb.address(recipient))
      }))
      return yield* signer.signUnresolved({ draft, gasPrice: 1000n, gasBudget: 5_000_000n, gasPayment: [gasRef], expiration: { _tag: "None" } })
    }))
    const data = Result.getOrThrow(T.decode(signed.bytes))
    expect(data.sender).toBe(A(keypair.toSuiAddress()))
    // The intent was resolved by the wallet: redeem from the address balance, split, send the rest home.
    const calls = data.kind.commands.flatMap((c) => (c._tag === "MoveCall" ? [`${c.module}::${c.function}`] : []))
    expect(calls).toEqual(["coin::redeem_funds", "coin::send_funds"])
    expect((await verifyTransactionSignature(signed.bytes, Buffer.from(signed.signature).toString("base64"), { offline: true })).toSuiAddress()).toBe(keypair.toSuiAddress())
  })
})

describe("signAndExecute and personal messages", () => {
  test("signAndExecuteTransaction: the wallet submits; the digest matches the bytes it signed", async () => {
    const submitted: Array<Uint8Array> = []
    const out = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({
        name: "Executes",
        execute: async (bytes) => {
          submitted.push(bytes)
          return { digest: Hash.transactionDigest(bytes), effects: Buffer.from([1, 2, 3]).toString("base64") }
        }
      })
      const signer = yield* Wallet.signer(wallet, { chain })
      const data = yield* resolvedFor(signer.address)
      return { data, result: yield* signer.signAndExecuteTransaction(data) }
    }))
    expect(out.result.bytes).toEqual(T.encode(out.data))
    expect(submitted[0]).toEqual(out.result.bytes)
    expect(out.result.digest).toBe(Hash.transactionDigest(T.encode(out.data)))
    expect(out.result.effects).toEqual(new Uint8Array([1, 2, 3]))
  })

  test("a wallet reporting a digest that isn't its bytes' digest is refused", async () => {
    const e = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Lies", execute: async () => ({ digest: D(1), effects: "" }) })
      const signer = yield* Wallet.signer(wallet, { chain })
      return yield* Effect.flip(signer.signAndExecuteTransaction(yield* resolvedFor(signer.address)))
    }))
    expect(e).toMatchObject({ _tag: "SigningError", reason: "failed" })
  })

  test("signPersonalMessage verifies with our registry and with @mysten/sui", async () => {
    const message = new TextEncoder().encode("hello from effect")
    const signed = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Messages" })
      const signer = yield* Wallet.signer(wallet, { chain })
      // Also without a signer (any connected account, no chain).
      const direct = yield* Wallet.signPersonalMessage(wallet, {}, message)
      const viaSigner = yield* signer.signPersonalMessage(message)
      expect(direct).toEqual(viaSigner)
      return viaSigner
    }))
    expect(signed.bytes).toEqual(message)
    const v = await Effect.runPromise(Verify.personalMessage(message, signed.signature).pipe(Effect.provide(schemes)))
    expect(v.address).toBe(A(keypair.toSuiAddress()))
    expect((await verifyPersonalMessageSignature(message, Buffer.from(signed.signature).toString("base64"), { offline: true })).toSuiAddress()).toBe(keypair.toSuiAddress())
  })

  test("missing features are UnsupportedFeature; a rejected message is SigningError(rejected)", () =>
    run(Effect.gen(function*() {
      const signOnly = make({ name: "Sign Only", features: ["standard:connect", "sui:signTransaction"] })
      yield* Wallet.register(signOnly.wallet)
      yield* Wallet.connect(signOnly.wallet)
      const signer = yield* Wallet.signer(signOnly.wallet, { chain })
      const data = yield* resolvedFor(signer.address)
      expect(yield* Effect.flip(signer.signAndExecuteTransaction(data))).toMatchObject({ _tag: "UnsupportedFeature", feature: "sui:signAndExecuteTransaction" })
      expect(yield* Effect.flip(signer.signPersonalMessage(new Uint8Array([1])))).toMatchObject({ _tag: "UnsupportedFeature", feature: "sui:signPersonalMessage" })

      const { wallet } = yield* connected({ name: "Refuses Messages", reject: { sign: true } })
      expect(yield* Effect.flip(Wallet.signPersonalMessage(wallet, {}, new Uint8Array([1])))).toMatchObject({ _tag: "SigningError", reason: "rejected" })
    })))
})
