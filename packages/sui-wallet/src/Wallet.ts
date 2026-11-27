/**
 * Wallet-standard Sui wallets as signers.
 *
 *   const wallet = yield* Wallet.find("Sui Wallet")
 *   yield* Wallet.connect(wallet)
 *   const signer = yield* Wallet.signer(wallet, { chain: "sui:testnet" })
 *   yield* Tx.run(recipe, { signer })     // we resolve; the wallet signs; we execute its bytes
 *
 * A wallet never signs intent messages, so a wallet signer is a core
 * `Signer.TransactionSigner`: `signTransaction(data)` hands the wallet our
 * resolved transaction as Mysten transaction JSON (`sui:signTransaction`) and
 * answers the bytes the wallet actually signed. The wallet may re-resolve and
 * change them; `Tx.execute` submits exactly what it signed.
 *
 * Also: `signUnresolved` (the wallet resolves a Draft itself),
 * `signAndExecuteTransaction` (the wallet submits) and `signPersonalMessage`.
 *
 * Failures are typed: a missing feature is `UnsupportedFeature`, a user
 * rejection is `SigningError` with reason `"rejected"`, a connect refusal is
 * `ConnectionError` with reason `"rejected"`.
 */
import { base64 } from "@scure/base"
import { getWallets } from "@wallet-standard/app"
import type { IdentifierString, Wallet as StandardWallet, WalletAccount } from "@wallet-standard/base"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Address from "@unconfirmed/sui/Address"
import * as Hash from "@unconfirmed/sui/Hash"
import * as Signer from "@unconfirmed/sui/Signer"
import type * as T from "@unconfirmed/sui/TransactionData"
import * as TransactionJson from "@unconfirmed/sui/TransactionJson"
import * as Features from "./Features.ts"

export type Wallet = StandardWallet

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class WalletNotFound extends Schema.TaggedError<WalletNotFound>()("WalletNotFound", {
  name: Schema.String
}) {}

/** The wallet doesn't implement a feature this operation needs. */
export class UnsupportedFeature extends Schema.TaggedError<UnsupportedFeature>()("UnsupportedFeature", {
  wallet: Schema.String,
  feature: Schema.String
}) {}

/** Neither the account nor the wallet lists this chain. */
export class UnsupportedChain extends Schema.TaggedError<UnsupportedChain>()("UnsupportedChain", {
  wallet: Schema.String,
  chain: Schema.String
}) {}

/** No such account is connected (connect first, or name an account the wallet authorized). */
export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()("AccountNotFound", {
  wallet: Schema.String,
  address: Schema.optionalKey(Schema.String)
}) {}

export class ConnectionError extends Schema.TaggedError<ConnectionError>()("ConnectionError", {
  wallet: Schema.String,
  reason: Schema.Literals(["rejected", "failed"]),
  message: Schema.String
}) {}

/**
 * The wallet ran `sui:signAndExecuteTransaction` but what it returned can't be
 * trusted (missing or undecodable fields, or a digest that isn't the returned
 * bytes'). The transaction may have executed: check `digest` (if any) on chain
 * before retrying.
 */
export class ExecutionUnconfirmed extends Schema.TaggedError<ExecutionUnconfirmed>()("ExecutionUnconfirmed", {
  wallet: Schema.String,
  digest: Schema.optionalKey(Schema.String),
  message: Schema.String
}) {}

// -----------------------------------------------------------------------------
// Failure mapping
// -----------------------------------------------------------------------------

/** `WalletStandardError` `WALLET_STANDARD_ERROR__USER__REQUEST_REJECTED`. */
const USER_REJECTED = 4001000
/**
 * A user's refusal in words: "User rejected the request", "Rejected by user",
 * "Request cancelled". Anchored to the user or the start of the message, so
 * validator and RPC failures ("rejected as invalid by validators",
 * "cancelled due to congestion", "403 Access denied") don't match.
 */
const USER_WORDING =
  /\buser\b.*\b(reject|denied|declin|cancel)|\b(rejected|denied|declined|cancell?ed) by (the )?user\b|^\s*(the )?(request |transaction |signature )?(rejected|denied|declined|cancell?ed)\b/i
const REJECTION_NAME = /user.?reject|rejected|cancell?ed/i

/** Did the user refuse? Wallet-standard code 4001000 or EIP-1193's 4001 first; then a refusal's name or wording. */
export const isRejection = (e: unknown): boolean => {
  if (typeof e === "string") return USER_WORDING.test(e)
  if (typeof e !== "object" || e === null) return false
  const x = e as { readonly code?: unknown; readonly context?: { readonly __code?: unknown }; readonly name?: unknown; readonly message?: unknown }
  if (x.context?.__code === USER_REJECTED || x.code === 4001 || x.code === USER_REJECTED) return true
  return REJECTION_NAME.test(String(x.name ?? "")) || USER_WORDING.test(String(x.message ?? ""))
}

const describe = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e) ?? String(e))

const signingError = (wallet: Wallet, operation: string) => (e: unknown) =>
  new Signer.SigningError({
    reason: isRejection(e) ? "rejected" : "failed",
    message: `${wallet.name} ${operation}: ${describe(e)}`
  })

const decodeBase64 = (wallet: Wallet, what: string, s: unknown) =>
  Effect.try({
    try: () => {
      if (typeof s !== "string") throw new Error("not a string")
      return base64.decode(s)
    },
    catch: () => new Signer.SigningError({ reason: "failed", message: `${wallet.name} returned ${what} that is not base64` })
  })

// -----------------------------------------------------------------------------
// Discovery
// -----------------------------------------------------------------------------

const features = (wallet: Wallet) => wallet.features as Features.SuiWalletFeatures

/** Lists a `sui:` chain. */
export const isSuiWallet = (wallet: Wallet): boolean => wallet.chains.some((c) => c.startsWith("sui:"))

/** Does the wallet implement `feature`? */
export const hasFeature = (wallet: Wallet, feature: IdentifierString): boolean => feature in wallet.features

/** The Sui wallets registered so far. */
export const wallets: Effect.Effect<ReadonlyArray<Wallet>> = Effect.sync(() => getWallets().get().filter(isSuiWallet))

/** A registered Sui wallet by name. */
export const find = (name: string): Effect.Effect<Wallet, WalletNotFound> =>
  Effect.flatMap(wallets, (ws) => {
    const w = ws.find((x) => x.name === name)
    return w ? Effect.succeed(w) : Effect.fail(new WalletNotFound({ name }))
  })

/** The Sui wallets now, then again whenever a wallet registers or unregisters. */
export const changes: Stream.Stream<ReadonlyArray<Wallet>> = Stream.callback<ReadonlyArray<Wallet>>((queue) =>
  Effect.gen(function*() {
    const api = getWallets()
    const emit = () => Queue.offerUnsafe(queue, api.get().filter(isSuiWallet))
    yield* Effect.acquireRelease(
      Effect.sync(() => [api.on("register", emit), api.on("unregister", emit)]),
      (offs) => Effect.sync(() => offs.forEach((off) => off()))
    )
    emit()
  })
)

/** Register wallets (injected or in-process ones) for the life of the scope. */
export const register = (...ws: ReadonlyArray<Wallet>): Effect.Effect<void, never, Scope.Scope> =>
  Effect.asVoid(Effect.acquireRelease(Effect.sync(() => getWallets().register(...ws)), (unregister) => Effect.sync(unregister)))

// -----------------------------------------------------------------------------
// Connection
// -----------------------------------------------------------------------------

export interface Account {
  readonly address: Address.Address
  /** As the wallet reports it (raw key bytes, no scheme flag). */
  readonly publicKey: Uint8Array
  readonly chains: ReadonlyArray<IdentifierString>
  readonly label: string | undefined
  /** The wallet-standard account, which every `sui:*` call names. */
  readonly account: WalletAccount
}

const toAccount = (a: WalletAccount): Account | undefined => {
  try {
    return { address: Address.normalize(a.address), publicKey: new Uint8Array(a.publicKey), chains: a.chains, label: a.label, account: a }
  } catch {
    return undefined
  }
}

/** The accounts the wallet has authorized (those with a valid Sui address). */
export const accounts = (wallet: Wallet): ReadonlyArray<Account> => wallet.accounts.flatMap((a) => toAccount(a) ?? [])

/** `standard:connect`: ask for access; answer the authorized accounts. `silent` connects only if already authorized. */
export const connect = (
  wallet: Wallet,
  options?: { readonly silent?: boolean }
): Effect.Effect<ReadonlyArray<Account>, UnsupportedFeature | ConnectionError> => {
  const feature = features(wallet)[Features.StandardConnect]
  if (!feature) return Effect.fail(new UnsupportedFeature({ wallet: wallet.name, feature: Features.StandardConnect }))
  return Effect.tryPromise({
    try: () => feature.connect(options?.silent !== undefined ? { silent: options.silent } : undefined),
    catch: (e) =>
      new ConnectionError({ wallet: wallet.name, reason: isRejection(e) ? "rejected" : "failed", message: describe(e) })
  }).pipe(Effect.map((r) => r.accounts.flatMap((a) => toAccount(a) ?? [])))
}

/** `standard:disconnect`, when the wallet has it (a no-op otherwise). */
export const disconnect = (wallet: Wallet): Effect.Effect<void, ConnectionError> => {
  const feature = features(wallet)[Features.StandardDisconnect]
  if (!feature) return Effect.void
  return Effect.tryPromise({
    try: () => feature.disconnect(),
    catch: (e) => new ConnectionError({ wallet: wallet.name, reason: "failed", message: describe(e) })
  })
}

/** The authorized accounts now, then whenever the wallet reports a change (`standard:events`). */
export const accountChanges = (wallet: Wallet): Stream.Stream<ReadonlyArray<Account>, UnsupportedFeature> => {
  const feature = features(wallet)[Features.StandardEvents]
  if (!feature) return Stream.fail(new UnsupportedFeature({ wallet: wallet.name, feature: Features.StandardEvents }))
  return Stream.callback<ReadonlyArray<Account>, UnsupportedFeature>((queue) =>
    Effect.gen(function*() {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          feature.on("change", (p) => {
            if (p.accounts) Queue.offerUnsafe(queue, accounts(wallet))
          })
        ),
        (off) => Effect.sync(off)
      )
      Queue.offerUnsafe(queue, accounts(wallet))
    })
  )
}

// -----------------------------------------------------------------------------
// Signing
// -----------------------------------------------------------------------------

export interface Target {
  readonly chain: Features.SuiChain
  /** Which authorized account (default: the first). */
  readonly account?: Address.Address | string
}

const pick = (wallet: Wallet, address: string | undefined): Effect.Effect<Account, AccountNotFound> =>
  Effect.suspend(() => {
    let wanted: Address.Address | undefined
    if (address !== undefined) {
      try {
        wanted = Address.normalize(address)
      } catch {
        return Effect.fail(new AccountNotFound({ wallet: wallet.name, address }))
      }
    }
    const all = accounts(wallet)
    const a = wanted === undefined ? all[0] : all.find((x) => x.address === wanted)
    return a ? Effect.succeed(a) : Effect.fail(new AccountNotFound({ wallet: wallet.name, ...(wanted && { address: wanted }) }))
  })

/** Pick an authorized account that can act on `chain`. */
export const account = (wallet: Wallet, target: Target): Effect.Effect<Account, AccountNotFound | UnsupportedChain> =>
  Effect.flatMap(pick(wallet, target.account), (a) => {
    const chains = a.chains.length > 0 ? a.chains : wallet.chains
    return chains.includes(target.chain)
      ? Effect.succeed(a)
      : Effect.fail(new UnsupportedChain({ wallet: wallet.name, chain: target.chain }))
  })

/** What `sui:signTransaction` hands the wallet: Mysten's `toJSON()` contract. */
const transactionInput = (json: string): Features.TransactionInput => ({ toJSON: () => Promise.resolve(json) })

const withSender = (tx: T.TransactionData | TransactionJson.Unresolved, sender: Address.Address) =>
  (tx as T.TransactionData)._tag === "V1" || (tx as TransactionJson.Unresolved).sender !== undefined
    ? tx
    : { ...(tx as TransactionJson.Unresolved), sender }

const signedOf = (wallet: Wallet, out: Features.SignedTransaction) =>
  Effect.all({
    bytes: decodeBase64(wallet, "transaction bytes", out?.bytes),
    signature: decodeBase64(wallet, "a signature", out?.signature)
  })

const callSignTransaction = (wallet: Wallet, a: Account, chain: Features.SuiChain, json: string) => {
  const feature = features(wallet)[Features.SuiSignTransaction]
  if (!feature) return Effect.fail(new UnsupportedFeature({ wallet: wallet.name, feature: Features.SuiSignTransaction }))
  return Effect.tryPromise({
    try: (signal) => feature.signTransaction({ transaction: transactionInput(json), account: a.account, chain, signal }),
    catch: signingError(wallet, Features.SuiSignTransaction)
  }).pipe(Effect.flatMap((out) => signedOf(wallet, out)))
}

/**
 * `sui:signTransaction` over either form: resolved `TransactionData`, or an
 * `Unresolved` draft the wallet resolves (sender defaults to the account).
 * Answers the bytes the wallet signed, which may differ from what it was given.
 */
export const signTransaction = (
  wallet: Wallet,
  target: Target,
  tx: T.TransactionData | TransactionJson.Unresolved
): Effect.Effect<
  Signer.Signed,
  Signer.SigningError | UnsupportedFeature | UnsupportedChain | AccountNotFound | TransactionJson.UnsupportedTransactionJson
> =>
  Effect.gen(function*() {
    const a = yield* account(wallet, target)
    const json = yield* TransactionJson.encode(withSender(tx, a.address))
    return yield* callSignTransaction(wallet, a, target.chain, json)
  })

export interface Executed extends Signer.Signed {
  readonly digest: string
  /** BCS `TransactionEffects`, as the wallet returned them. */
  readonly effects: Uint8Array
}

/**
 * `sui:signAndExecuteTransaction`: the wallet signs and submits. The digest
 * it reports must be the digest of the bytes it returns. For our `Effects`,
 * follow with `Transactions.waitFor(digest)`.
 */
export const signAndExecuteTransaction = (
  wallet: Wallet,
  target: Target,
  tx: T.TransactionData | TransactionJson.Unresolved
): Effect.Effect<
  Executed,
  | Signer.SigningError
  | ExecutionUnconfirmed
  | UnsupportedFeature
  | UnsupportedChain
  | AccountNotFound
  | TransactionJson.UnsupportedTransactionJson
> =>
  Effect.gen(function*() {
    const feature = features(wallet)[Features.SuiSignAndExecuteTransaction]
    if (!feature) return yield* new UnsupportedFeature({ wallet: wallet.name, feature: Features.SuiSignAndExecuteTransaction })
    const a = yield* account(wallet, target)
    const json = yield* TransactionJson.encode(withSender(tx, a.address))
    const out = yield* Effect.tryPromise({
      try: (signal) =>
        feature.signAndExecuteTransaction({ transaction: transactionInput(json), account: a.account, chain: target.chain, signal }),
      catch: signingError(wallet, Features.SuiSignAndExecuteTransaction)
    })
    // From here the wallet has submitted: a bad answer is not a signing failure.
    const reported = typeof out?.digest === "string" ? out.digest : undefined
    const unconfirmed = (message: string) =>
      new ExecutionUnconfirmed({ wallet: wallet.name, ...(reported !== undefined && { digest: reported }), message })
    const signed = yield* Effect.mapError(signedOf(wallet, out), (e) => unconfirmed(e.message))
    const effects = typeof out.effects !== "string"
      ? yield* unconfirmed(`${wallet.name} returned no effects`)
      : out.effects === ""
      ? new Uint8Array()
      : yield* Effect.mapError(decodeBase64(wallet, "effects", out.effects), (e) => unconfirmed(e.message))
    const digest = Hash.transactionDigest(signed.bytes)
    if (reported !== digest) {
      return yield* unconfirmed(`${wallet.name} reported digest ${reported} for bytes whose digest is ${digest}`)
    }
    return { ...signed, digest, effects }
  })

/** `sui:signPersonalMessage`. */
export const signPersonalMessage = (
  wallet: Wallet,
  target: { readonly account?: Address.Address | string; readonly chain?: Features.SuiChain },
  message: Uint8Array
): Effect.Effect<Signer.Signed, Signer.SigningError | UnsupportedFeature | UnsupportedChain | AccountNotFound> =>
  Effect.gen(function*() {
    const feature = features(wallet)[Features.SuiSignPersonalMessage]
    if (!feature) return yield* new UnsupportedFeature({ wallet: wallet.name, feature: Features.SuiSignPersonalMessage })
    const a = target.chain === undefined
      ? yield* pick(wallet, target.account)
      : yield* account(wallet, { ...target, chain: target.chain })
    const out = yield* Effect.tryPromise({
      try: () =>
        feature.signPersonalMessage({ message, account: a.account, ...(target.chain !== undefined && { chain: target.chain }) }),
      catch: signingError(wallet, Features.SuiSignPersonalMessage)
    })
    const signed = yield* signedOf(wallet, out)
    if (signed.bytes.length !== message.length || !signed.bytes.every((b, i) => b === message[i])) {
      return yield* new Signer.SigningError({ reason: "failed", message: `${wallet.name} signed a different message than the one requested` })
    }
    return signed
  })

// -----------------------------------------------------------------------------
// The signer
// -----------------------------------------------------------------------------

/**
 * One wallet account on one chain. A `Signer.TransactionSigner`, so `Tx.run`
 * and `Tx.execute` take it like any signer.
 */
export interface WalletSigner extends Signer.TransactionSigner {
  readonly wallet: Wallet
  readonly chain: Features.SuiChain
  readonly account: Account
  /** `sui:signTransaction` over our resolved transaction; answers what the wallet signed. */
  readonly signTransaction: (data: T.TransactionData) => Effect.Effect<Signer.Signed, Signer.SigningError>
  /** `sui:signTransaction` over a Draft the wallet resolves itself. */
  readonly signUnresolved: (
    tx: TransactionJson.Unresolved
  ) => Effect.Effect<Signer.Signed, Signer.SigningError | TransactionJson.UnsupportedTransactionJson>
  readonly signAndExecuteTransaction: (
    tx: T.TransactionData | TransactionJson.Unresolved
  ) => Effect.Effect<Executed, Signer.SigningError | ExecutionUnconfirmed | UnsupportedFeature | TransactionJson.UnsupportedTransactionJson>
  readonly signPersonalMessage: (message: Uint8Array) => Effect.Effect<Signer.Signed, Signer.SigningError | UnsupportedFeature>
}

/** After the account was checked, a lookup failure means the wallet changed under us. */
const gone = (wallet: Wallet) => (e: AccountNotFound | UnsupportedChain) =>
  Effect.fail(new Signer.SigningError({ reason: "unavailable", message: `${wallet.name}: ${e._tag} (the wallet's accounts changed)` }))

/**
 * A signer for a connected wallet account on `chain`. Needs `sui:signTransaction`
 * (`UnsupportedFeature` otherwise); wallets without it can still use
 * `signAndExecuteTransaction` and `signPersonalMessage` directly.
 */
export const signer = (
  wallet: Wallet,
  target: Target
): Effect.Effect<WalletSigner, UnsupportedFeature | AccountNotFound | UnsupportedChain> =>
  Effect.gen(function*() {
    if (!hasFeature(wallet, Features.SuiSignTransaction)) {
      return yield* new UnsupportedFeature({ wallet: wallet.name, feature: Features.SuiSignTransaction })
    }
    const a = yield* account(wallet, target)
    const pinned: Target = { chain: target.chain, account: a.address }
    const unavailable = (e: UnsupportedFeature) =>
      Effect.fail(new Signer.SigningError({ reason: "unavailable", message: `${e.wallet} no longer offers ${e.feature}` }))
    const sign = (tx: T.TransactionData | TransactionJson.Unresolved) =>
      signTransaction(wallet, pinned, tx).pipe(
        Effect.catchTags({ UnsupportedFeature: unavailable, AccountNotFound: gone(wallet), UnsupportedChain: gone(wallet) })
      )
    return {
      address: a.address,
      wallet,
      chain: target.chain,
      account: a,
      signTransaction: (data) =>
        sign(data).pipe(Effect.catchTag("UnsupportedTransactionJson", (e) => Effect.die(e))), // resolved data always encodes
      signUnresolved: sign,
      signAndExecuteTransaction: (tx) =>
        signAndExecuteTransaction(wallet, pinned, tx).pipe(
          Effect.catchTags({ AccountNotFound: gone(wallet), UnsupportedChain: gone(wallet) })
        ),
      signPersonalMessage: (message) =>
        signPersonalMessage(wallet, pinned, message).pipe(
          Effect.catchTags({ AccountNotFound: gone(wallet), UnsupportedChain: gone(wallet) })
        )
    } satisfies WalletSigner
  })
