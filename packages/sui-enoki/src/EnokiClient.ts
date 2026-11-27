/**
 * The Enoki API as a service: zkLogin (salt/address lookup, nonces, ZK
 * proofs), sponsored transactions and app metadata. Requests and responses
 * are Schema-validated; every failure is a typed `EnokiError`.
 *
 *   EnokiHttp.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))
 */
import type * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Signature from "@unconfirmed/sui-zklogin/Signature"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** One entry of Enoki's `errors`; fields are kept only when well-formed. */
export const EnokiErrorDetail = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown)
})
export type EnokiErrorDetail = typeof EnokiErrorDetail.Type

/**
 * A failed Enoki call. `status` is the HTTP status (0 when no response
 * arrived). `code` is Enoki's first error code, or one of ours:
 * `request_failed` (transport), `invalid_response` (body didn't decode),
 * `unknown_error` (an error body without codes). `cause` is the underlying
 * transport or decode failure, when there is one.
 */
export class EnokiError extends Schema.TaggedError<EnokiError>()("EnokiError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
  errors: Schema.Array(EnokiErrorDetail),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  /** Worth retrying as is: no response arrived (status 0), rate limited (429), or a server error (5xx). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }

  /**
   * The transaction must be rebuilt and signed again: Enoki's sponsor address
   * or the reference gas price changed since it was built.
   */
  get requiresRebuild(): boolean {
    return this.code === "invalid_gas_owner" || this.code === "invalid_gas_price"
  }
}

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

export const EnokiNetwork = Schema.Literals(["mainnet", "testnet", "devnet"])
export type EnokiNetwork = typeof EnokiNetwork.Type
export const EnokiDomainNetwork = Schema.Literals(["mainnet", "testnet"])
export type EnokiDomainNetwork = typeof EnokiDomainNetwork.Type

export interface CreateZkLoginNonceInput {
  readonly network?: EnokiNetwork
  readonly ephemeralPublicKey: SignatureScheme.PublicKey
  readonly additionalEpochs?: number
}

export interface CreateZkLoginZkpInput {
  readonly network?: EnokiNetwork
  readonly jwt: string
  readonly ephemeralPublicKey: SignatureScheme.PublicKey
  readonly randomness: string
  /** A u64; sent to Enoki as a JSON number. */
  readonly maxEpoch: bigint
}

interface SponsorBase {
  readonly network?: EnokiNetwork
  /** BCS `TransactionKind`. */
  readonly transactionKindBytes: Uint8Array
}

/** Sponsor for a zkLogin user identified by their JWT (public API key), or for an explicit sender (private key). */
export type CreateSponsoredTransactionInput =
  | SponsorBase & { readonly jwt: string }
  | SponsorBase & {
    readonly sender: string
    readonly allowedAddresses?: ReadonlyArray<string>
    readonly allowedMoveCallTargets?: ReadonlyArray<string>
  }

export interface ExecuteSponsoredTransactionInput {
  readonly digest: string
  /** The sender's serialized signature over the sponsored bytes. */
  readonly signature: Uint8Array
}

export interface SponsorAndExecuteTransactionInput {
  readonly network?: EnokiNetwork
  /** BCS `TransactionData` built with Enoki's sponsor as gas owner and an empty gas payment. */
  readonly transactionBytes: Uint8Array
  readonly signature: Uint8Array
  readonly allowedAddresses?: ReadonlyArray<string>
  readonly allowedMoveCallTargets?: ReadonlyArray<string>
}

// -----------------------------------------------------------------------------
// Responses (the `data` field of Enoki's `{ data }` envelope)
// -----------------------------------------------------------------------------

export const AuthProvider = Schema.String
export const App = Schema.Struct({
  allowedOrigins: Schema.Array(Schema.String),
  authenticationProviders: Schema.Array(Schema.Struct({ providerType: AuthProvider, clientId: Schema.String })),
  domains: Schema.Array(Schema.Struct({ nftId: Schema.String, name: Schema.String, network: EnokiDomainNetwork })),
  /** Enoki's sponsor address per network it sponsors on. */
  sponsorAddresses: Schema.optionalKey(Schema.Struct({
    mainnet: Schema.optionalKey(Schema.String),
    testnet: Schema.optionalKey(Schema.String)
  }))
})
export type App = typeof App.Type

export const ZkLoginAccount = Schema.Struct({
  address: Schema.String,
  publicKey: Schema.String,
  salt: Schema.String
})
export type ZkLoginAccount = typeof ZkLoginAccount.Type

export const ZkLoginAddresses = Schema.Struct({
  addresses: Schema.Array(Schema.Struct({
    clientId: Schema.String,
    salt: Schema.String,
    address: Schema.String,
    publicKey: Schema.String,
    legacy: Schema.optionalKey(Schema.Boolean)
  }))
})
export type ZkLoginAddresses = typeof ZkLoginAddresses.Type

/**
 * An epoch (a u64 on chain) as a `bigint`. Decodes Enoki's JSON number or a decimal string; encodes to a
 * decimal string, so a persisted `SessionData` survives `JSON.stringify`.
 */
export const Epoch = Schema.Union([
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))
]).pipe(
  Schema.decodeTo(Schema.BigInt, {
    decode: SchemaGetter.BigInt(),
    encode: SchemaGetter.transform((b: bigint) => b.toString())
  })
)

export const ZkLoginNonce = Schema.Struct({
  nonce: Schema.String,
  randomness: Schema.String,
  epoch: Epoch,
  maxEpoch: Epoch,
  /** Milliseconds since the epoch. */
  estimatedExpiration: Schema.Number
})
export type ZkLoginNonce = typeof ZkLoginNonce.Type

/** The proof is exactly zkLogin's signature inputs. */
export const ZkLoginZkp = Signature.ZkLoginSignatureInputs
export type ZkLoginZkp = Signature.ZkLoginSignatureInputs

export const SponsoredTransaction = Schema.Struct({
  /** BCS `TransactionData`, gas filled in by Enoki. */
  bytes: Schema.Uint8ArrayFromBase64,
  digest: Schema.String
})
export type SponsoredTransaction = typeof SponsoredTransaction.Type

export const ExecutedTransaction = Schema.Struct({ digest: Schema.String })
export type ExecutedTransaction = typeof ExecutedTransaction.Type

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export class EnokiClient extends Context.Service<EnokiClient, {
  readonly getApp: Effect.Effect<App, EnokiError>
  /** The salt, address and public identifier of the JWT's user. */
  readonly getZkLogin: (input: { readonly jwt: string }) => Effect.Effect<ZkLoginAccount, EnokiError>
  /** Every address of the JWT's user across the app's client ids, flagging legacy ones. */
  readonly getZkLoginAddresses: (input: { readonly jwt: string }) => Effect.Effect<ZkLoginAddresses, EnokiError>
  readonly createZkLoginNonce: (input: CreateZkLoginNonceInput) => Effect.Effect<ZkLoginNonce, EnokiError>
  readonly createZkLoginZkp: (input: CreateZkLoginZkpInput) => Effect.Effect<ZkLoginZkp, EnokiError>
  readonly createSponsoredTransaction: (
    input: CreateSponsoredTransactionInput
  ) => Effect.Effect<SponsoredTransaction, EnokiError>
  readonly executeSponsoredTransaction: (
    input: ExecuteSponsoredTransactionInput
  ) => Effect.Effect<ExecutedTransaction, EnokiError>
  /** Sponsor and execute in one call (private API key). */
  readonly sponsorAndExecuteTransaction: (
    input: SponsorAndExecuteTransactionInput
  ) => Effect.Effect<ExecutedTransaction, EnokiError>
}>()("@unconfirmed/sui-enoki/EnokiClient") {}
