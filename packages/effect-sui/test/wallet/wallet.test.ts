/**
 * The wallet adapter against an in-process wallet-standard wallet (Ed25519,
 * parsing what it receives with @mysten/sui's `Transaction.from`).
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { verifyPersonalMessageSignature, verifyTransactionSignature } from "@mysten/sui/verify"
import { base58 } from "@scure/base"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Fiber, Layer, Result, Stream } from "effect"
import {
  Address,
  Ed25519,
  Hash,
  Ptb,
  Resolve,
  SignatureScheme,
  TransactionData as T,
  Tx,
  TypeTag,
  Verify
} from "@unconfirmed/sui"
import * as Testing from "@unconfirmed/sui/Testing"
import { Wallet } from "../src/index.ts"
import { fakeWallet, type FakeWalletOptions } from "@unconfirmed/test-support/wallet"

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

/** An in-memory node; `executed()` is what it was asked to execute. */
const recorder = () => {
  const node = Effect.runSync(Testing.make())
  const requests = () => Effect.runSync(Context.get(node, Testing.Node).requests)
  const executed = () =>
    requests().filter((r) => r.method === "Transactions.execute").map((r) => ({
      bytes: r.args[0] as Uint8Array,
      signatures: r.args[1] as ReadonlyArray<Uint8Array>
    }))
  return { layer: Layer.succeedContext(node), requests, executed }
}

const schemes = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme)

const pay = Effect.gen(function*() {
  const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
  yield* Ptb.transferObjects([coin!], yield* Ptb.address(recipient))
})

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
  test("register, list, find; non-Sui wallets are filtered out; registration is scoped", () =>
    run(Effect.gen(function*() {
      const sui = make({ name: "Sui One" })
      const other = make({ name: "Elsewhere", chains: ["solana:mainnet"] })
      yield* Wallet.register(sui.wallet, other.wallet)
      const names = (yield* Wallet.wallets).map((w) => w.name)
      expect(names).toContain("Sui One")
      expect(names).not.toContain("Elsewhere")
      expect((yield* Wallet.find("Sui One")).chains).toEqual(["sui:devnet", "sui:testnet"])
      expect((yield* Effect.flip(Wallet.find("Elsewhere")))._tag).toBe("WalletNotFound")
      yield* Effect.scoped(Wallet.register(make({ name: "Scoped" }).wallet))
      expect((yield* Effect.flip(Wallet.find("Scoped")))._tag).toBe("WalletNotFound")
    })))

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

  test("a refused connect is rejected; no standard:connect is UnsupportedFeature; a malformed answer or throw is failed", () =>
    run(Effect.gen(function*() {
      const refusing = make({ name: "Refusing", reject: { connect: true } })
      const minimal = make({ name: "Minimal", features: ["sui:signTransaction"] })
      yield* Wallet.register(refusing.wallet, minimal.wallet)
      expect(yield* Effect.flip(Wallet.connect(refusing.wallet))).toMatchObject({ _tag: "ConnectionError", reason: "rejected" })
      expect(yield* Effect.flip(Wallet.connect(minimal.wallet))).toMatchObject({ _tag: "UnsupportedFeature", feature: "standard:connect" })

      const withConnect = (connect: () => Promise<unknown>) =>
        ({ ...make({ name: "Bad Connect" }).wallet, features: { "standard:connect": { version: "1.0.0", connect } } }) as unknown as Wallet.Wallet
      const circular: Record<string, unknown> = {}
      circular.self = circular
      for (
        const wallet of [
          withConnect(async () => undefined),
          withConnect(async () => ({ accounts: "nope" })),
          withConnect(async () => {
            throw circular
          })
        ]
      ) {
        expect(yield* Effect.flip(Wallet.connect(wallet))).toMatchObject({ _tag: "ConnectionError", reason: "failed" })
      }
      expect(Wallet.accounts({ ...minimal.wallet, accounts: undefined } as unknown as Wallet.Wallet)).toEqual([])
    })))
})

describe("multi-chain wallets and malformed answers", () => {
  const evm = {
    address: "0x52908400098527886E0F7030069857D2E4169EE7",
    publicKey: new Uint8Array(33).fill(2),
    chains: ["eip155:1"],
    features: []
  }

  test("non-Sui and short (padded) addresses are skipped; the default account is a Sui one on the requested chain", () =>
    run(Effect.gen(function*() {
      const short = { ...evm, address: "0x2", chains: ["sui:devnet"] }
      const { wallet } = yield* connected({ name: "Multi Chain", otherAccounts: [evm as never, short as never] })
      const ours = A(keypair.toSuiAddress())
      expect(Wallet.accounts(wallet).map((a) => a.address)).toEqual([ours])
      expect((yield* Wallet.signer(wallet, { chain: "sui:testnet" })).address).toBe(ours)
      const signed = yield* Wallet.signPersonalMessage(wallet, {}, new Uint8Array([1]))
      const v = yield* Verify.personalMessage(new Uint8Array([1]), signed.signature).pipe(Effect.provide(schemes))
      expect(v.address).toBe(ours)
    })))

  test("the first Sui account that lists the chain is the default", () =>
    run(Effect.gen(function*() {
      const other = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(8))
      const mainnetOnly = {
        address: other.toSuiAddress(),
        publicKey: other.getPublicKey().toRawBytes(),
        chains: ["sui:mainnet"],
        features: []
      }
      const { wallet } = yield* connected({ name: "Two Sui Accounts", otherAccounts: [mainnetOnly as never] })
      expect((yield* Wallet.account(wallet, { chain: "sui:mainnet" })).address).toBe(A(other.toSuiAddress()))
      expect((yield* Wallet.account(wallet, { chain })).address).toBe(A(keypair.toSuiAddress()))
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
    const [{ bytes, signatures }] = rec.executed() as [ReturnType<typeof rec.executed>[0]]
    expect(bytes).toEqual(T.encode(data))
    // The signature verifies with our registry and with @mysten/sui.
    const verified = await Effect.runPromise(Verify.transaction(bytes, signatures[0]!, { address: signer.address }).pipe(Effect.provide(schemes)))
    expect(verified.address).toBe(signer.address)
    expect((await verifyTransactionSignature(bytes, Buffer.from(signatures[0]!).toString("base64"), { offline: true })).toSuiAddress()).toBe(signer.address)
  })

  test("Tx.run with every gas term fixed looks nothing up; the sender defaults to the wallet account", async () => {
    const rec = recorder()
    const fixedGas = { gasPrice: 1000n, gasBudget: 5_000_000n, payment: Resolve.fixed([gasRef]), expiration: { _tag: "None" } } as const
    const effects = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Runs" })
      const signer = yield* Wallet.signer(wallet, { chain })
      return yield* Tx.run(pay, { signer, ...fixedGas })
    }).pipe(Effect.provide(rec.layer)))
    expect(effects.status._tag).toBe("Success")
    expect(rec.requests().map((r) => r.method)).toEqual(["Transactions.execute"])
    expect(Result.getOrThrow(T.decode(rec.executed()[0]!.bytes)).sender).toBe(A(keypair.toSuiAddress()))
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
    const { bytes, signatures } = rec.executed()[0]!
    expect(bytes).not.toEqual(T.encode(ours))
    const theirs = Result.getOrThrow(T.decode(bytes))
    expect(theirs.gasData.budget).toBe(7_777_777n)
    await Effect.runPromise(Verify.transaction(bytes, signatures[0]!).pipe(Effect.provide(schemes)))
  })

  test("wallet sender + key-signer sponsor: the sponsor signs the wallet's bytes, signatures keep their order", async () => {
    const rec = recorder()
    const sponsor = await Effect.runPromise(Ed25519.fromSecretKey(new Uint8Array(32).fill(9)))
    await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Sponsored" })
      const signer = yield* Wallet.signer(wallet, { chain })
      const data = yield* resolvedFor(signer.address, sponsor.address)
      yield* Tx.execute(data, [sponsor, signer])
    }).pipe(Effect.provide(rec.layer)))
    const { bytes, signatures } = rec.executed()[0]!
    const who = await Effect.runPromise(
      Effect.forEach(signatures, (s) => Verify.transaction(bytes, s)).pipe(Effect.provide(schemes))
    )
    expect(who.map((v) => v.address)).toEqual([sponsor.address, A(keypair.toSuiAddress())])
  })

  test("a wallet may not change gas terms a key-signer sponsor pays for, nor the commands", async () => {
    const sponsor = await Effect.runPromise(Ed25519.fromSecretKey(new Uint8Array(32).fill(9)))
    const attempt = (name: string, mutate: (tx: any) => void) => {
      const rec = recorder()
      return run(Effect.gen(function*() {
        const { wallet } = yield* connected({ name, mutate })
        const signer = yield* Wallet.signer(wallet, { chain })
        const data = yield* resolvedFor(signer.address, sponsor.address)
        return yield* Effect.flip(Tx.execute(data, [sponsor, signer]))
      }).pipe(Effect.provide(rec.layer))).then((e) => ({ e, executed: rec.executed().length }))
    }
    const budget = await attempt("Budget", (tx) => tx.setGasBudget(6_000_000))
    expect(budget.e).toMatchObject({ _tag: "SigningError", reason: "failed" })
    expect(String(budget.e.message)).toContain("gas or expiration")
    expect(budget.executed).toBe(0)
    const drain = await attempt("Drain", (tx) => tx.transferObjects([tx.gas], tx.pure.address(A("0xbad"))))
    expect(drain.e).toMatchObject({ _tag: "SigningError", reason: "failed" })
    expect(String(drain.e.message)).toContain("commands or inputs")
    expect(drain.executed).toBe(0)
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
    expect(rec.executed()).toHaveLength(0)
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
    // The wallet already submitted: not a signing failure, and the reported digest is kept for a lookup.
    expect(e).toMatchObject({ _tag: "ExecutionUnconfirmed", digest: D(1) })
  })

  test("only a user's refusal reads as rejected; validator and RPC failures don't", () => {
    for (
      const m of [
        "User rejected the request.",
        "rejected by the user",
        "MetaMask Tx Signature: User denied transaction signature."
      ]
    ) {
      expect(Wallet.isRejection(new Error(m)), m).toBe(true)
    }
    expect(Wallet.isRejection({ code: 4001, message: "nope" })).toBe(true)
    expect(Wallet.isRejection({ context: { __code: 4001000 }, message: "nope" })).toBe(true)
    expect(Wallet.isRejection(Object.assign(new Error("nope"), { name: "UserRejectedRequestError" }))).toBe(true)
    for (
      const m of [
        "Transaction is rejected as invalid by more than 1/3 of validators by stake (non-retriable)",
        "RPC error: 403 Access denied",
        // A refusal word at the start, or a user who isn't the one refusing (review SIGN-4).
        "Transaction rejected by validators",
        "Rejected: object 0x2 is locked by another transaction",
        "Request cancelled",
        "The user's gas coin was rejected by the validator"
      ]
    ) expect(Wallet.isRejection(new Error(m)), m).toBe(false)
    expect(Wallet.isRejection(Object.assign(new Error("boom"), { name: "TransactionRejectedError" }))).toBe(false)
  })

  test("a rejected signAndExecuteTransaction promise is ExecutionUnconfirmed unless a coded refusal", async () => {
    let n = 0
    const attempt = (failWith: () => unknown) =>
      run(Effect.gen(function*() {
        const { wallet } = yield* connected({ name: `Fails ${n++}`, failWith })
        const signer = yield* Wallet.signer(wallet, { chain })
        return yield* Effect.flip(signer.signAndExecuteTransaction(yield* resolvedFor(signer.address)))
      }))
    // The wallet may have submitted before it timed out waiting for effects: not "nothing was signed".
    const timeout = await attempt(() => new Error("Request timed out waiting for transaction effects"))
    expect(timeout).toMatchObject({ _tag: "ExecutionUnconfirmed" })
    expect(timeout).not.toHaveProperty("digest")
    expect(timeout.message).toContain("timed out")
    // A refusal in words only is not proof that nothing was submitted.
    expect(await attempt(() => new Error("User rejected the request"))).toMatchObject({ _tag: "ExecutionUnconfirmed" })
    // A coded refusal is.
    const coded = await attempt(() => Object.assign(new Error("User rejected the request"), { context: { __code: 4001000 } }))
    expect(coded).toMatchObject({ _tag: "SigningError", reason: "rejected" })
    expect(await attempt(() => ({ code: 4001, message: "denied" }))).toMatchObject({ _tag: "SigningError", reason: "rejected" })
  })

  test("rejection values that can't be stringified are typed failures, not defects", async () => {
    const circular: Record<string, unknown> = { reason: "loop" }
    circular.self = circular
    const crossRealm = { name: "Error", message: "from another realm" } // error-like, not instanceof Error
    let n = 0
    for (const failWith of [() => circular, () => ({ amount: 10n }), () => crossRealm, () => Symbol("x")]) {
      const out = await run(Effect.gen(function*() {
        const { wallet } = yield* connected({ name: `Odd ${n++}`, failWith })
        const signer = yield* Wallet.signer(wallet, { chain })
        const data = yield* resolvedFor(signer.address)
        return {
          sign: yield* Effect.flip(signer.signTransaction(data)),
          message: yield* Effect.flip(signer.signPersonalMessage(new Uint8Array([1]))),
          execute: yield* Effect.flip(signer.signAndExecuteTransaction(data))
        }
      }))
      expect(out.sign).toMatchObject({ _tag: "SigningError", reason: "failed" })
      expect(out.message).toMatchObject({ _tag: "SigningError", reason: "failed" })
      expect(out.execute).toMatchObject({ _tag: "ExecutionUnconfirmed" })
    }
    const realm = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Realm", failWith: () => crossRealm })
      return yield* Effect.flip(Wallet.signPersonalMessage(wallet, {}, new Uint8Array([1])))
    }))
    expect(realm.message).toContain("from another realm")
  })

  test("a wallet that signs a different message than requested is refused", async () => {
    const e = await run(Effect.gen(function*() {
      const { wallet } = yield* connected({ name: "Swaps Messages", alterMessage: (m) => new Uint8Array([...m, 0]) })
      return yield* Effect.flip(Wallet.signPersonalMessage(wallet, {}, new Uint8Array([1, 2, 3])))
    }))
    expect(e).toMatchObject({ _tag: "SigningError", reason: "failed" })
    expect(e.message).toContain("signed a different message")
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
