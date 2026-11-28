/**
 * The wallet-standard features a Sui wallet implements, declared locally (types
 * and names only) so this package needs no Mysten runtime. They mirror
 * `@mysten/wallet-standard` 0.22.
 */
import type { IdentifierString, WalletAccount } from "@wallet-standard/base"

/** `sui:mainnet`, `sui:testnet`, `sui:devnet`, `sui:localnet`, ... */
export type SuiChain = `sui:${string}`

export const SUI_MAINNET = "sui:mainnet" satisfies SuiChain
export const SUI_TESTNET = "sui:testnet" satisfies SuiChain
export const SUI_DEVNET = "sui:devnet" satisfies SuiChain
export const SUI_LOCALNET = "sui:localnet" satisfies SuiChain

// -----------------------------------------------------------------------------
// standard:*
// -----------------------------------------------------------------------------

export const StandardConnect = "standard:connect"
export interface StandardConnectFeature {
  readonly [StandardConnect]: {
    readonly version: "1.0.0"
    readonly connect: (input?: { readonly silent?: boolean }) => Promise<{ readonly accounts: ReadonlyArray<WalletAccount> }>
  }
}

export const StandardDisconnect = "standard:disconnect"
export interface StandardDisconnectFeature {
  readonly [StandardDisconnect]: {
    readonly version: "1.0.0"
    readonly disconnect: () => Promise<void>
  }
}

export const StandardEvents = "standard:events"
export interface StandardEventsChangeProperties {
  readonly accounts?: ReadonlyArray<WalletAccount>
  readonly chains?: ReadonlyArray<IdentifierString>
  readonly features?: Readonly<Record<IdentifierString, unknown>>
}
export interface StandardEventsFeature {
  readonly [StandardEvents]: {
    readonly version: "1.0.0"
    readonly on: (event: "change", listener: (properties: StandardEventsChangeProperties) => void) => () => void
  }
}

// -----------------------------------------------------------------------------
// sui:*
// -----------------------------------------------------------------------------

/** What `sui:signTransaction` receives: anything with `toJSON()` giving Mysten's v2 transaction JSON. */
export interface TransactionInput {
  readonly toJSON: () => Promise<string>
}

export interface SuiSignTransactionInput {
  readonly transaction: TransactionInput
  readonly account: WalletAccount
  readonly chain: IdentifierString
  readonly signal?: AbortSignal
}

/** Base64 BCS `TransactionData` and the base64 serialized signature. */
export interface SignedTransaction {
  readonly bytes: string
  readonly signature: string
}

export const SuiSignTransaction = "sui:signTransaction"
export interface SuiSignTransactionFeature {
  readonly [SuiSignTransaction]: {
    readonly version: "2.0.0"
    readonly signTransaction: (input: SuiSignTransactionInput) => Promise<SignedTransaction>
  }
}

export interface SuiSignAndExecuteTransactionOutput extends SignedTransaction {
  readonly digest: string
  /** Base64 BCS `TransactionEffects`. */
  readonly effects: string
}

export const SuiSignAndExecuteTransaction = "sui:signAndExecuteTransaction"
export interface SuiSignAndExecuteTransactionFeature {
  readonly [SuiSignAndExecuteTransaction]: {
    readonly version: "2.0.0"
    readonly signAndExecuteTransaction: (input: SuiSignTransactionInput) => Promise<SuiSignAndExecuteTransactionOutput>
  }
}

export interface SuiSignPersonalMessageInput {
  readonly message: Uint8Array
  readonly account: WalletAccount
  readonly chain?: IdentifierString
}

export const SuiSignPersonalMessage = "sui:signPersonalMessage"
export interface SuiSignPersonalMessageFeature {
  readonly [SuiSignPersonalMessage]: {
    readonly version: "1.1.0"
    readonly signPersonalMessage: (input: SuiSignPersonalMessageInput) => Promise<SignedTransaction>
  }
}

/** Every feature this package uses, all optional: a wallet is checked feature by feature. */
export type SuiWalletFeatures =
  & Partial<StandardConnectFeature>
  & Partial<StandardDisconnectFeature>
  & Partial<StandardEventsFeature>
  & Partial<SuiSignTransactionFeature>
  & Partial<SuiSignAndExecuteTransactionFeature>
  & Partial<SuiSignPersonalMessageFeature>
