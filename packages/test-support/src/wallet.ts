/**
 * An in-process wallet-standard Sui wallet backed by an Ed25519 key. It does
 * what a real wallet does with `sui:signTransaction`: `Transaction.from(await
 * transaction.toJSON())`, (re-)resolve and build with @mysten/sui, sign.
 */
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import type { Wallet, WalletAccount } from "@wallet-standard/base"
import type * as Features from "@unconfirmed/sui-wallet/Features"

const ICON = "data:image/svg+xml;base64,PHN2Zy8+" as const

export type FeatureName =
  | "standard:connect"
  | "standard:disconnect"
  | "standard:events"
  | "sui:signTransaction"
  | "sui:signAndExecuteTransaction"
  | "sui:signPersonalMessage"

const ALL: ReadonlyArray<FeatureName> = [
  "standard:connect",
  "standard:disconnect",
  "standard:events",
  "sui:signTransaction",
  "sui:signAndExecuteTransaction",
  "sui:signPersonalMessage"
]

export interface FakeWalletOptions {
  readonly keypair: Ed25519Keypair
  readonly name?: string
  readonly chains?: ReadonlyArray<`${string}:${string}`>
  readonly features?: ReadonlyArray<FeatureName>
  /** A @mysten/sui client, for transactions that still need resolving, and for executing. */
  readonly client?: unknown
  /** Refuse the next requests as a user would (wallet-standard code 4001000). */
  readonly reject?: { connect?: boolean; sign?: boolean }
  /** Fail every signing request by throwing this value instead. */
  readonly failWith?: () => unknown
  /** Other accounts the wallet authorizes, listed before its Sui account (a multi-chain wallet). */
  readonly otherAccounts?: ReadonlyArray<WalletAccount>
  /** Sign a different message than the one asked for. */
  readonly alterMessage?: (message: Uint8Array) => Uint8Array
  /** Change the transaction before signing, as a wallet re-resolving gas might. */
  readonly mutate?: (tx: Transaction) => void
  /** How `sui:signAndExecuteTransaction` submits (default: `client.core.executeTransaction`, else nothing). */
  readonly execute?: (bytes: Uint8Array, signature: string) => Promise<{ digest: string; effects: string }>
}

export interface FakeWallet {
  readonly wallet: Wallet
  readonly options: FakeWalletOptions
  /** Every transaction JSON the wallet received. */
  readonly received: Array<string>
}

const rejection = () =>
  Object.assign(new Error("User rejected the request"), { name: "WalletStandardError", context: { __code: 4001000 } })

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

export const fakeWallet = (options: FakeWalletOptions): FakeWallet => {
  const chains = options.chains ?? ["sui:devnet", "sui:testnet"]
  const enabled = new Set(options.features ?? ALL)
  const received: Array<string> = []
  const listeners = new Set<(p: Features.StandardEventsChangeProperties) => void>()
  const account: WalletAccount = {
    address: options.keypair.toSuiAddress(),
    publicKey: options.keypair.getPublicKey().toRawBytes(),
    chains: [...chains],
    features: [...enabled].filter((f) => f.startsWith("sui:")) as Array<`${string}:${string}`>,
    label: "fake"
  }
  let accounts: ReadonlyArray<WalletAccount> = []
  const emit = () => listeners.forEach((l) => l({ accounts }))

  const check = (input: Features.SuiSignTransactionInput) => {
    if (options.failWith) throw options.failWith()
    if (options.reject?.sign) throw rejection()
    if (input.account.address !== account.address) throw new Error(`unknown account ${input.account.address}`)
    if (!chains.includes(input.chain as never)) throw new Error(`unsupported chain ${input.chain}`)
  }

  const build = async (input: Features.SuiSignTransactionInput) => {
    check(input)
    const json = await input.transaction.toJSON()
    received.push(json)
    const tx = Transaction.from(json)
    tx.setSenderIfNotSet(account.address)
    options.mutate?.(tx)
    const bytes = await tx.build(options.client ? { client: options.client as never } : {})
    const { signature } = await options.keypair.signTransaction(bytes)
    return { bytes, signature }
  }

  const all: Record<FeatureName, unknown> = {
    "standard:connect": {
      version: "1.0.0",
      connect: async () => {
        if (options.reject?.connect) throw rejection()
        accounts = [...(options.otherAccounts ?? []), account]
        emit()
        return { accounts }
      }
    },
    "standard:disconnect": {
      version: "1.0.0",
      disconnect: async () => {
        accounts = []
        emit()
      }
    },
    "standard:events": {
      version: "1.0.0",
      on: (_event: "change", listener: (p: Features.StandardEventsChangeProperties) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    "sui:signTransaction": {
      version: "2.0.0",
      signTransaction: async (input: Features.SuiSignTransactionInput) => {
        const { bytes, signature } = await build(input)
        return { bytes: b64(bytes), signature }
      }
    },
    "sui:signAndExecuteTransaction": {
      version: "2.0.0",
      signAndExecuteTransaction: async (input: Features.SuiSignTransactionInput) => {
        const { bytes, signature } = await build(input)
        let result: { digest: string; effects: string }
        if (options.execute) result = await options.execute(bytes, signature)
        else if (options.client) {
          const r = await (options.client as any).core.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true } })
          const t = r.Transaction ?? r.FailedTransaction
          result = { digest: t.digest, effects: b64(t.effects.bcs) }
        } else result = { digest: TransactionDataBuilder.getDigestFromBytes(bytes), effects: "" }
        return { bytes: b64(bytes), signature, ...result }
      }
    },
    "sui:signPersonalMessage": {
      version: "1.1.0",
      signPersonalMessage: async (input: Features.SuiSignPersonalMessageInput) => {
        if (options.failWith) throw options.failWith()
        if (options.reject?.sign) throw rejection()
        if (input.account.address !== account.address) throw new Error(`unknown account ${input.account.address}`)
        return options.keypair.signPersonalMessage(options.alterMessage ? options.alterMessage(input.message) : input.message)
      }
    }
  }

  const wallet: Wallet = {
    version: "1.0.0",
    name: options.name ?? "Fake Wallet",
    icon: ICON,
    chains: [...chains],
    features: Object.fromEntries([...enabled].map((f) => [f, all[f]])) as Wallet["features"],
    get accounts() {
      return accounts
    }
  }
  return { wallet, options, received }
}
