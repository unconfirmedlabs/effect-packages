/**
 * The app's wallet connection: which wallet and account are connected, kept
 * up to date, remembered across page loads. What dApp Kit's connection store
 * does, as a service.
 *
 *   const connection = yield* Connection.Connection
 *   yield* connection.connect(wallet)                 // run it from the click handler
 *   yield* Tx.run(recipe, { signer: yield* connection.signer })
 *
 * `state` / `changes` (a Stream) are `Disconnected`, `Connecting`,
 * `Reconnecting` (restoring the saved connection on load) or `Connected`.
 * A connection is to one chain: `accounts` are the wallet's accounts on it.
 *
 * Wallet popups: browsers open a popup only inside a user gesture. `connect`
 * calls the wallet's `standard:connect` before anything that could suspend,
 * so `Effect.runFork(connection.connect(wallet))` in a click handler reaches
 * the wallet while the click is still on the stack. (Run it at the start of
 * a fiber: one that has used its operation budget yields before its next
 * step.) The actions need no
 * services, so a React or plain-JS app can take the service once and run
 * them with `Effect.runFork`.
 *
 * With `storage`, the wallet name and account address are saved in a
 * `KeyValueStore` under that key and, unless `autoConnect: false`, restored
 * on start: wait for the wallet to register (wallets register late), connect
 * silently, pick the saved account (else the first). A failure ends
 * `Disconnected` and clears the key.
 *
 * Once connected, the wallet's `standard:events` are followed: a vanished
 * account is replaced by the first remaining one, no accounts left (or the
 * wallet unregistering) is `Disconnected`.
 */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as Address from "../Address.ts"
import type * as Features from "./Features.ts"
import * as Wallet from "./Wallet.ts"

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

export interface Disconnected {
  readonly _tag: "Disconnected"
}

/** `connect` is waiting for the wallet (its popup is open). */
export interface Connecting {
  readonly _tag: "Connecting"
  readonly wallet: Wallet.Wallet
}

/** Restoring the saved connection. `wallet` is undefined until the wallet named `name` registers. */
export interface Reconnecting {
  readonly _tag: "Reconnecting"
  readonly name: string
  readonly wallet: Wallet.Wallet | undefined
}

export interface Connected {
  readonly _tag: "Connected"
  readonly wallet: Wallet.Wallet
  /** The account in use, one of `accounts`. */
  readonly account: Wallet.Account
  /** The wallet's authorized accounts on the connection's chain. */
  readonly accounts: ReadonlyArray<Wallet.Account>
}

export type State = Disconnected | Connecting | Reconnecting | Connected

const disconnected: Disconnected = { _tag: "Disconnected" }

const connected = (wallet: Wallet.Wallet, account: Wallet.Account, accounts: ReadonlyArray<Wallet.Account>): Connected => ({
  _tag: "Connected",
  wallet,
  account,
  accounts
})

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export class NotConnected extends Schema.TaggedError<NotConnected>()("NotConnected", {}) {
  override get message(): string {
    return "no wallet connected"
  }
}

export interface ConnectionService {
  readonly chain: Features.SuiChain
  readonly state: Effect.Effect<State>
  /** The state now, then every change. */
  readonly changes: Stream.Stream<State>
  /** The registered Sui wallets now, then on every (un)registration (`Wallet.changes`). */
  readonly wallets: Stream.Stream<ReadonlyArray<Wallet.Wallet>>
  /**
   * Connect a registered wallet and use its first account on the chain. The
   * wallet is called synchronously when this runs (see the module docs). On
   * failure the previous connection (or `Disconnected`) is back; a wallet with
   * no account on the chain is `UnsupportedChain`. The last connect to finish
   * wins.
   */
  readonly connect: (
    wallet: Wallet.Wallet
  ) => Effect.Effect<Connected, Wallet.UnsupportedFeature | Wallet.ConnectionError | Wallet.UnsupportedChain>
  /** Forget the connection (and the saved one), then `standard:disconnect` the wallet. */
  readonly disconnect: Effect.Effect<void, Wallet.ConnectionError>
  /** Use another of the connected wallet's accounts. */
  readonly switchAccount: (address: string) => Effect.Effect<Connected, NotConnected | Wallet.AccountNotFound>
  /** The connected account's address. */
  readonly address: Effect.Effect<Address.Address, NotConnected>
  /** A signer for the connected account on the chain (`Wallet.signer`), for `Tx.run` / `Tx.execute`. */
  readonly signer: Effect.Effect<Wallet.WalletSigner, NotConnected | Wallet.UnsupportedFeature>
}

export class Connection extends /* @__PURE__ */ Context.Service<Connection, ConnectionService>()(
  "@unconfirmed/effect-sui/wallet/Connection"
) {}

export interface Options {
  /** The one chain the app uses, e.g. `"sui:testnet"`. */
  readonly chain: Features.SuiChain
  /** A `KeyValueStore` key to remember the connection under (the layer then needs a `KeyValueStore`). */
  readonly storage?: string | undefined
  /** Restore the saved connection on start. Default true (with `storage`). */
  readonly autoConnect?: boolean | undefined
  /** How long to wait for the saved wallet to register. Default 3 s. */
  readonly reconnectTimeout?: Duration.Input | undefined
}

/** The wallet's accounts that act on `chain` (an account listing no chains acts on the wallet's). */
const onChain = (wallet: Wallet.Wallet, chain: Features.SuiChain, all: ReadonlyArray<Wallet.Account>) =>
  all.filter((a) => (a.chains.length > 0 ? a.chains : wallet.chains).includes(chain))

const sameAddresses = (a: ReadonlyArray<Wallet.Account>, b: ReadonlyArray<Wallet.Account>) =>
  a.length === b.length && a.every((x, i) => x.address === b[i]!.address)

interface Saved {
  readonly wallet: string
  readonly address: string
}

const parseSaved = (raw: string | undefined): Saved | undefined => {
  try {
    const v = raw === undefined ? undefined : JSON.parse(raw)
    return typeof v?.wallet === "string" && typeof v?.address === "string" ? { wallet: v.wallet, address: v.address } : undefined
  } catch {
    return undefined
  }
}

const make = (options: Options) =>
  Effect.gen(function*() {
    const { chain, storage: key } = options
    const kv = key === undefined ? undefined : yield* KeyValueStore.KeyValueStore
    const saved = kv === undefined || key === undefined || options.autoConnect === false
      ? undefined
      : parseSaved(yield* Effect.orElseSucceed(kv.get(key), () => undefined))
    const ref = yield* SubscriptionRef.make<State>(
      saved ? { _tag: "Reconnecting", name: saved.wallet, wallet: undefined } : disconnected
    )

    const persist = (s: State): Effect.Effect<void> =>
      kv === undefined || key === undefined
        ? Effect.void
        : (s._tag === "Connected"
          ? kv.set(key, JSON.stringify({ wallet: s.wallet.name, address: s.account.address }))
          : s._tag === "Disconnected"
          ? kv.remove(key)
          : Effect.void).pipe(Effect.ignore({ log: "Warn" }))

    /**
     * The one way the state changes, one change at a time: `f` (undefined: no
     * change), saved, then published, so whoever sees a state can rely on it
     * being saved. Answers the state before, and the new one.
     */
    const lock = yield* Semaphore.make(1)
    const transition = (f: (s: State) => State | undefined) =>
      lock.withPermit(Effect.gen(function*() {
        const before = yield* SubscriptionRef.get(ref)
        const after = f(before)
        if (after !== undefined) {
          yield* persist(after)
          yield* SubscriptionRef.set(ref, after)
        }
        return [before, after] as const
      }))

    const notConnected = () => Effect.fail(new NotConnected())
    const current = Effect.flatMap(SubscriptionRef.get(ref), (s) => (s._tag === "Connected" ? Effect.succeed(s) : notConnected()))

    const connect = (wallet: Wallet.Wallet) =>
      Effect.gen(function*() {
        // The wallet first, in this fiber's first steps: nothing before it suspends, so a
        // popup it opens is still inside the user's gesture. The state follows.
        const pending = yield* Effect.forkChild(Wallet.connect(wallet), { startImmediately: true })
        const [previous] = yield* transition(() => ({ _tag: "Connecting", wallet }))
        // On failure, back to the previous connection or Disconnected (an interrupted restore isn't resumed).
        const settled = previous._tag === "Connected" ? previous : disconnected
        const restore = transition((s) => (s._tag === "Connecting" && s.wallet === wallet ? settled : undefined))
        const accounts = onChain(wallet, chain, yield* Effect.onError(Fiber.join(pending), () => restore))
        if (accounts.length === 0) {
          yield* restore
          return yield* new Wallet.UnsupportedChain({ wallet: wallet.name, chain })
        }
        const next = connected(wallet, accounts[0]!, accounts)
        yield* transition(() => next)
        return next
      })

    const disconnect = Effect.gen(function*() {
      const [previous] = yield* transition((s) => (s._tag === "Disconnected" ? undefined : disconnected))
      if (previous._tag !== "Disconnected" && previous.wallet !== undefined) yield* Wallet.disconnect(previous.wallet)
    })

    const switchAccount = (address: string) =>
      Effect.gen(function*() {
        const s = yield* current
        let wanted: Address.Address | undefined
        try {
          wanted = Address.normalize(address)
        } catch {
          // not an address: not one of the accounts either
        }
        const account = s.accounts.find((a) => a.address === wanted)
        if (!account) return yield* new Wallet.AccountNotFound({ wallet: s.wallet.name, address })
        const next = connected(s.wallet, account, s.accounts)
        yield* transition(() => next)
        return next
      })

    // Restore the saved connection, unless the user connects (or disconnects) first.
    const reconnect = (saved: Saved) =>
      Effect.gen(function*() {
        const found = yield* Wallet.changes.pipe(
          Stream.map((ws) => ws.find((w) => w.name === saved.wallet)),
          Stream.filter((w): w is Wallet.Wallet => w !== undefined),
          Stream.runHead,
          Effect.timeoutOption(options.reconnectTimeout ?? Duration.seconds(3)),
          Effect.map(Option.flatten)
        )
        const still = (next: State) => (s: State) => (s._tag === "Reconnecting" ? next : undefined)
        if (Option.isNone(found)) {
          yield* transition(still(disconnected))
          return
        }
        const wallet = found.value
        const [, waiting] = yield* transition(still({ _tag: "Reconnecting", name: saved.wallet, wallet }))
        if (waiting === undefined) return
        const accounts = onChain(wallet, chain, yield* Effect.orElseSucceed(Wallet.connect(wallet, { silent: true }), () => []))
        const account = accounts.find((a) => a.address === saved.address) ?? accounts[0]
        yield* transition(still(account ? connected(wallet, account, accounts) : disconnected))
      })
    if (saved) yield* Effect.forkScoped(reconnect(saved))

    // Follow the connected wallet's accounts.
    const onAccounts = (wallet: Wallet.Wallet, all: ReadonlyArray<Wallet.Account>) => (s: State): State | undefined => {
      if (s._tag !== "Connected" || s.wallet !== wallet) return undefined
      const accounts = onChain(wallet, chain, all)
      const account = accounts.find((a) => a.address === s.account.address) ?? accounts[0]
      if (!account) return disconnected
      return account.address === s.account.address && sameAddresses(accounts, s.accounts)
        ? undefined
        : connected(wallet, account, accounts)
    }
    yield* SubscriptionRef.changes(ref).pipe(
      Stream.map((s) => (s._tag === "Connected" ? s.wallet : undefined)),
      Stream.changesWith((a, b) => a === b),
      Stream.switchMap((wallet) =>
        wallet === undefined
          ? Stream.empty
          : Wallet.accountChanges(wallet).pipe(
            Stream.ignore, // no standard:events: nothing to follow
            Stream.mapEffect((all) => transition(onAccounts(wallet, all)))
          )
      ),
      Stream.runDrain,
      Effect.forkScoped
    )

    // A connected wallet that unregisters is gone.
    yield* Wallet.changes.pipe(
      Stream.runForEach((ws) => transition((s) => (s._tag === "Connected" && !ws.includes(s.wallet) ? disconnected : undefined))),
      Effect.forkScoped
    )

    return Connection.of({
      chain,
      state: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      wallets: Wallet.changes,
      connect,
      disconnect,
      switchAccount,
      address: Effect.map(current, (s) => s.account.address),
      signer: Effect.flatMap(current, (s) =>
        Wallet.signer(s.wallet, { chain, account: s.account.address }).pipe(
          // the account was connected a moment ago: it went away under us
          Effect.catchTags({ AccountNotFound: notConnected, UnsupportedChain: notConnected })
        ))
    })
  })

/**
 * The connection service. Its fibers (restoring, following the wallet) live
 * in the layer's scope. With `storage`, it needs a `KeyValueStore`, e.g.
 * `KeyValueStore.layerStorage(() => localStorage)`.
 */
export function layer(options: Options & { readonly storage: string }): Layer.Layer<Connection, never, KeyValueStore.KeyValueStore>
export function layer(options: Options & { readonly storage?: undefined }): Layer.Layer<Connection>
export function layer(options: Options): Layer.Layer<Connection, never, KeyValueStore.KeyValueStore> {
  return Layer.effect(Connection, make(options))
}
