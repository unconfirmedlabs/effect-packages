/**
 * The connection service against in-process wallet-standard wallets whose
 * calls are recorded the moment they are made.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { WalletAccount } from "@wallet-standard/base"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Fiber, Layer, Option, Scope, Stream } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { Address, Ptb, Resolve, TransactionData as T } from "@unconfirmed/effect-sui"
import { fakeWallet, type FakeWalletOptions } from "@unconfirmed/test-support/wallet"
import { Connection, Wallet } from "../../src/wallet/index.ts"

const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7))
const A = Address.normalize(keypair.toSuiAddress())
const chain = "sui:testnet" as const
const KEY = "wallet"

const account = (hex: string, chains: Array<`${string}:${string}`>): WalletAccount => ({
  address: `0x${hex.repeat(64)}`,
  publicKey: new Uint8Array(32),
  chains,
  features: [],
  label: hex
})
const B = account("b", [chain])
const BA = Address.normalize(B.address)
const MAINNET_ONLY = account("c", ["sui:mainnet"])

/** A fake wallet (accounts B, a mainnet-only one, A) recording each wallet-UI call as it is made. */
const spied = (name: string, options: Partial<FakeWalletOptions> = {}) => {
  const fake = fakeWallet({ keypair, name, otherAccounts: [B, MAINNET_ONLY], ...options })
  const calls: Array<string> = []
  const methods = { "standard:connect": "connect", "sui:signTransaction": "signTransaction", "sui:signPersonalMessage": "signPersonalMessage" }
  for (const [feature, method] of Object.entries(methods)) {
    const f = fake.wallet.features[feature as `${string}:${string}`] as Record<string, (input?: any) => Promise<unknown>>
    const original = f[method]!
    f[method] = (input) => {
      calls.push(input?.silent ? `${method} silent` : method)
      return original(input)
    }
  }
  return { ...fake, calls }
}

const memoryStore = (saved?: { wallet: string; address: string }) =>
  Effect.runSync(Effect.gen(function*() {
    const kv = yield* KeyValueStore.KeyValueStore
    if (saved) yield* kv.set(KEY, JSON.stringify(saved))
    return kv
  }).pipe(Effect.provide(KeyValueStore.layerMemory)))

/** What the store holds (a state is saved before it is published). */
const savedIn = (kv: KeyValueStore.KeyValueStore) => Effect.map(kv.get(KEY), (raw) => (raw === undefined ? undefined : JSON.parse(raw)))

const start = (kv: KeyValueStore.KeyValueStore, options: { reconnectTimeout?: number } = {}) =>
  Layer.build(
    Connection.layer({ chain, storage: KEY, ...options }).pipe(Layer.provide(Layer.succeed(KeyValueStore.KeyValueStore, kv)))
  ).pipe(Effect.map(Context.get(Connection.Connection)))

/** The first state, now or later, that is `tag` (and passes `and`). */
const until = <Tag extends Connection.State["_tag"]>(
  connection: Connection.ConnectionService,
  tag: Tag,
  and: (s: Extract<Connection.State, { _tag: Tag }>) => boolean = () => true
) =>
  connection.changes.pipe(
    Stream.filter((s): s is Extract<Connection.State, { _tag: Tag }> => s._tag === tag && and(s as never)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout("2 seconds")
  )

const addresses = (s: Connection.Connected) => s.accounts.map((a) => a.address)

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

describe("Connection", () => {
  test("connect and the signer's calls reach the wallet before runFork returns (popups need the user's gesture)", () =>
    run(Effect.gen(function*() {
      const w = spied("Popup")
      yield* Wallet.register(w.wallet)
      const kv = memoryStore()
      const connection = yield* start(kv)

      const connecting = Effect.runFork(connection.connect(w.wallet))
      expect(w.calls).toEqual(["connect"])
      expect((yield* connection.state)._tag).toBe("Connecting")
      const connected = yield* Fiber.join(connecting)
      expect(addresses(connected)).toEqual([BA, A]) // the mainnet-only account is not on the chain
      expect(connected.account.address).toBe(BA)
      expect(yield* savedIn(kv)).toEqual({ wallet: "Popup", address: B.address })

      yield* connection.switchAccount(A)
      expect(yield* savedIn(kv)).toEqual({ wallet: "Popup", address: A })
      const signer = yield* connection.signer
      expect(signer.address).toBe(A)
      const { draft } = yield* Ptb.build(Effect.gen(function*() {
        yield* Ptb.transferObjects([Ptb.gas], yield* Ptb.address(B.address))
      }))
      const data: T.TransactionData = yield* Resolve.finish({
        sender: A,
        draft,
        gasPrice: 1000n,
        gasBudget: 5_000_000n,
        gasPayment: [{ objectId: Address.normalize("0xfeed"), version: 9n, digest: "11111111111111111111111111111111" as T.ObjectDigest }]
      })
      const signing = [
        Effect.runFork(signer.signPersonalMessage(new Uint8Array([1]))),
        Effect.runFork(signer.signTransaction(data))
      ]
      expect(w.calls).toEqual(["connect", "signPersonalMessage", "signTransaction"])
      yield* Fiber.joinAll(signing)

      yield* connection.disconnect
      expect((yield* connection.state)._tag).toBe("Disconnected")
      expect(yield* savedIn(kv)).toBeUndefined()
      expect((yield* Effect.flip(connection.signer))._tag).toBe("NotConnected")
    })))

  test("autoconnect waits for a late wallet, connects silently and restores the saved account, else the first", () =>
    run(Effect.gen(function*() {
      const restored = yield* start(memoryStore({ wallet: "Late", address: A }))
      expect(yield* restored.state).toEqual({ _tag: "Reconnecting", name: "Late", wallet: undefined })
      const w = spied("Late")
      yield* Wallet.register(w.wallet)
      expect((yield* until(restored, "Connected")).account.address).toBe(A)
      expect(w.calls).toEqual(["connect silent"])

      const kv = memoryStore({ wallet: "Late", address: `0x${"d".repeat(64)}` }) // an account the wallet no longer has
      const fallback = yield* start(kv)
      expect((yield* until(fallback, "Connected")).account.address).toBe(BA)
      expect(yield* savedIn(kv)).toEqual({ wallet: "Late", address: B.address })
    })))

  test("autoconnect gives up when the wallet never registers or refuses: Disconnected, storage cleared", () =>
    run(Effect.gen(function*() {
      const missing = memoryStore({ wallet: "Never", address: A })
      yield* until(yield* start(missing, { reconnectTimeout: 20 }), "Disconnected")
      expect(yield* savedIn(missing)).toBeUndefined()

      yield* Wallet.register(spied("Refusing", { reject: { connect: true } }).wallet)
      const refused = memoryStore({ wallet: "Refusing", address: A })
      const connection = yield* start(refused)
      yield* until(connection, "Reconnecting").pipe(Effect.andThen(until(connection, "Disconnected")))
      expect(yield* savedIn(refused)).toBeUndefined()
    })))

  test("follows the wallet's account changes, and its unregistering", () =>
    run(Effect.gen(function*() {
      const w = spied("Changing")
      const registration = yield* Scope.make()
      yield* Scope.provide(Wallet.register(w.wallet), registration)
      const kv = memoryStore()
      const connection = yield* start(kv)
      yield* connection.connect(w.wallet)

      w.setAccounts([w.account]) // the user removed B (the current account) inside the wallet
      const after = yield* until(connection, "Connected", (s) => s.account.address === A)
      expect(addresses(after)).toEqual([A])
      expect(yield* savedIn(kv)).toEqual({ wallet: "Changing", address: A })

      w.setAccounts([])
      yield* until(connection, "Disconnected")
      expect(yield* savedIn(kv)).toBeUndefined()

      yield* connection.connect(w.wallet)
      yield* Scope.close(registration, Exit.void)
      yield* until(connection, "Disconnected")
    })))
})
