/**
 * Enoki-sponsored transactions on top of the core pipeline.
 *
 * Enoki takes only the `TransactionKind` and fills in gas itself, so a
 * sponsored transaction replaces the gas half of `Tx.resolve`
 * (`gasPrice -> budget -> payment -> finish`) with one round trip:
 *
 *   Ptb.build(recipe) -> Resolve.inputs -> transactionKind -> Enoki sponsor
 *     -> check the returned bytes -> Signer.signTransaction -> Enoki execute
 *
 *   const { digest } = yield* Sponsor.run(recipe, { signer, network: "testnet" })
 *
 * Each step is exported for flows that stop in between: `transactionKind`,
 * `sponsor` (create and check), then sign, then `execute`. A failed execute is
 * `ExecutionUnconfirmed`, carrying the signed bytes, signature and digest:
 * check the digest on chain, or `execute` the same signature again, rather
 * than sponsoring a second transaction.
 */
import * as Address from "../Address.ts"
import type * as Coins from "../Coins.ts"
import * as Hash from "../Hash.ts"
import type * as Objects from "../Objects.ts"
import type * as Packages from "../Packages.ts"
import * as Ptb from "../Ptb.ts"
import * as Resolve from "../Resolve.ts"
import type * as RpcError from "../RpcError.ts"
import * as Signer from "../Signer.ts"
import * as T from "../TransactionData.ts"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { EnokiClient, EnokiError, type EnokiNetwork } from "./EnokiClient.ts"
import * as Bytes from "@unconfirmed/effect-bcs/Bytes"

/** Enoki answered with transaction bytes that are not the transaction we asked it to sponsor. */
export class UnexpectedSponsoredTransaction extends Schema.TaggedError<UnexpectedSponsoredTransaction>()(
  "UnexpectedSponsoredTransaction",
  { reason: Schema.String }
) {
  override get message(): string {
    return this.reason
  }
}

const encodeKind = Bcs.encodeSync(T.TransactionKind)

/**
 * The BCS `TransactionKind` of a draft whose object inputs and coin/balance
 * intents are resolved (run `Resolve.inputs` and `Resolve.balances` first).
 */
export const transactionKind = (draft: Ptb.Draft): Effect.Effect<Uint8Array, Resolve.Incomplete> =>
  Effect.suspend(() => {
    const programmable = Ptb.toProgrammable(draft)
    return programmable
      ? Effect.succeed(encodeKind({ _tag: "ProgrammableTransaction", ...programmable }))
      : Effect.fail(new Resolve.Incomplete({ missing: "object inputs or coin/balance intents (run Resolve.inputs and Resolve.balances)" }))
  })

/**
 * Executing a signed sponsored transaction through Enoki failed. Enoki may
 * have executed it anyway (a gateway timeout, a lost response): check `digest`
 * on chain, or post the same `signature` again with `execute`. Sponsoring
 * again would make a second, different transaction (new gas, new digest).
 * `cause` is Enoki's answer; `retryable` is its.
 */
export class ExecutionUnconfirmed extends Schema.TaggedError<ExecutionUnconfirmed>()("ExecutionUnconfirmed", {
  digest: Schema.String,
  /** The sponsored `TransactionData` bytes that were signed. */
  bytes: Schema.Uint8Array,
  signature: Schema.Uint8Array,
  message: Schema.String,
  cause: EnokiError
}) {
  get retryable(): boolean {
    return this.cause.retryable
  }
}

/** What Enoki is asked to sponsor, and the checks the transaction it returns must pass. */
export interface SponsorRequest {
  readonly network?: EnokiNetwork
  readonly sender: Address.Address
  /**
   * Identify a zkLogin sender by JWT instead of address (public API keys).
   * `allowedAddresses` / `allowedMoveCallTargets` apply only to sender-based sponsorship.
   */
  readonly jwt?: string
  readonly allowedAddresses?: ReadonlyArray<string>
  readonly allowedMoveCallTargets?: ReadonlyArray<string>
  /**
   * The gas owner Enoki must use. Default: the app's sponsor address for
   * `network` from `getApp` (mainnet/testnet; an omitted network is Enoki's
   * default, mainnet), when it lists one. Either way the gas owner must not be
   * the sender, so the user never pays.
   */
  readonly sponsorAddress?: Address.Address
  /** Refuse sponsored transactions with a larger gas budget (MIST). */
  readonly maxBudget?: bigint
  /** Refuse sponsored transactions with a higher gas price (MIST per unit). */
  readonly maxGasPrice?: bigint
}

export interface SponsorOptions extends Omit<SponsorRequest, "sender"> {
  /** Signs the sponsored transaction; its address is the sender unless `sender` is given. */
  readonly signer: Signer.Signer
  readonly sender?: Address.Address
}

/** A sponsored transaction Enoki created and `sponsor` checked: sign `bytes`, then `execute`. */
export interface SponsoredTransaction {
  readonly digest: string
  readonly bytes: Uint8Array
}

export interface Sponsored {
  readonly digest: string
  /** The sponsored `TransactionData` bytes that were signed and executed. */
  readonly bytes: Uint8Array
  readonly signature: Uint8Array
}

const unexpected = (reason: string) => new UnexpectedSponsoredTransaction({ reason })


interface Expected {
  readonly kind: Uint8Array
  readonly sender: Address.Address
  readonly digest: string
  readonly sponsor: Address.Address | undefined
  readonly maxBudget: bigint | undefined
  readonly maxGasPrice: bigint | undefined
}

/**
 * Never sign what we didn't ask for: the digest Enoki reports, same sender,
 * same kind, and gas paid by the sponsor (never by the sender) within the caps.
 */
const check = (bytes: Uint8Array, expected: Expected) =>
  Result.match(T.decode(bytes), {
    onFailure: (e) => Effect.fail(unexpected(`undecodable transaction: ${e.message}`)),
    onSuccess: (data) => {
      const { gasData } = data
      const digest = Hash.transactionDigest(bytes)
      if (digest !== expected.digest) return Effect.fail(unexpected(`digest is ${digest}, Enoki reported ${expected.digest}`))
      if (data.sender !== expected.sender) {
        return Effect.fail(unexpected(`sender is ${data.sender}, expected ${expected.sender}`))
      }
      if (!Bytes.equal(encodeKind(data.kind), expected.kind)) return Effect.fail(unexpected("transaction kind was changed"))
      if (gasData.owner === expected.sender) return Effect.fail(unexpected("gas would be paid by the sender"))
      if (expected.sponsor !== undefined && gasData.owner !== expected.sponsor) {
        return Effect.fail(unexpected(`gas owner is ${gasData.owner}, not the sponsor ${expected.sponsor}`))
      }
      if (expected.maxBudget !== undefined && gasData.budget > expected.maxBudget) {
        return Effect.fail(unexpected(`gas budget ${gasData.budget} exceeds ${expected.maxBudget}`))
      }
      if (expected.maxGasPrice !== undefined && gasData.price > expected.maxGasPrice) {
        return Effect.fail(unexpected(`gas price ${gasData.price} exceeds ${expected.maxGasPrice}`))
      }
      return Effect.void
    }
  })

/** The network Enoki sponsors on when the request names none (as `@mysten/enoki` assumes too). */
const DEFAULT_NETWORK = "mainnet"

/** The sponsor address to require: given, or the app's for this network (if it lists one). */
const sponsorFor = (enoki: EnokiClient["Service"], request: SponsorRequest) => {
  if (request.sponsorAddress !== undefined) return Effect.succeed<Address.Address | undefined>(request.sponsorAddress)
  const network = request.network ?? DEFAULT_NETWORK
  if (network !== "mainnet" && network !== "testnet") return Effect.succeed<Address.Address | undefined>(undefined)
  return Effect.flatMap(enoki.getApp, (app) => {
    const listed = app.sponsorAddresses?.[network]
    if (listed === undefined) return Effect.succeed(undefined)
    return Result.match(Schema.decodeUnknownResult(Address.Strict)(listed), {
      onFailure: () => Effect.fail(unexpected(`Enoki listed an invalid sponsor address ${listed}`)),
      onSuccess: (a) => Effect.succeed<Address.Address | undefined>(a)
    })
  })
}

/**
 * Ask Enoki to sponsor a `TransactionKind` and check what comes back: the
 * digest it reports, the sender, the kind, and gas paid by the sponsor within
 * the caps. Answers bytes that are safe to sign.
 */
export const sponsor = Effect.fn("Sponsor.sponsor")(function*(kind: Uint8Array, request: SponsorRequest) {
  const enoki = yield* EnokiClient
  const network = request.network !== undefined ? { network: request.network } : {}
  const [gasOwner, sponsored] = yield* Effect.all([sponsorFor(enoki, request), enoki.createSponsoredTransaction(
    request.jwt !== undefined
      ? { ...network, transactionKindBytes: kind, jwt: request.jwt }
      : {
        ...network,
        transactionKindBytes: kind,
        sender: request.sender,
        ...(request.allowedAddresses && { allowedAddresses: request.allowedAddresses }),
        ...(request.allowedMoveCallTargets && { allowedMoveCallTargets: request.allowedMoveCallTargets })
      }
  )], { concurrency: "unbounded" })
  yield* check(sponsored.bytes, {
    kind,
    sender: request.sender,
    digest: sponsored.digest,
    sponsor: gasOwner,
    maxBudget: request.maxBudget,
    maxGasPrice: request.maxGasPrice
  })
  return { digest: sponsored.digest, bytes: sponsored.bytes } satisfies SponsoredTransaction
}) as (
  kind: Uint8Array,
  request: SponsorRequest
) => Effect.Effect<SponsoredTransaction, EnokiError | UnexpectedSponsoredTransaction, EnokiClient>

/**
 * Execute a signed sponsored transaction through Enoki. Posting the same
 * signature again is safe: it is the same transaction. A failure is
 * `ExecutionUnconfirmed` with everything needed to check or retry.
 */
export const execute = (signed: Sponsored): Effect.Effect<Sponsored, ExecutionUnconfirmed, EnokiClient> =>
  Effect.flatMap(Effect.service(EnokiClient), (enoki) =>
    enoki.executeSponsoredTransaction({ digest: signed.digest, signature: signed.signature }).pipe(
      Effect.map(({ digest }) => ({ digest, bytes: signed.bytes, signature: signed.signature }) satisfies Sponsored),
      Effect.mapError((cause) =>
        new ExecutionUnconfirmed({
          digest: signed.digest,
          bytes: signed.bytes,
          signature: signed.signature,
          message: `executing sponsored transaction ${signed.digest} failed, it may still have executed: ${cause.message}`,
          cause
        })
      )
    )).pipe(Effect.withSpan("Sponsor.execute"))

/**
 * Sponsor a `TransactionKind`, check what comes back, sign it with the
 * user's `Signer`, and execute it through Enoki.
 */
export const sponsorAndExecute = Effect.fn("Sponsor.sponsorAndExecute")(function*(kind: Uint8Array, options: SponsorOptions) {
  const sponsored = yield* sponsor(kind, { ...options, sender: options.sender ?? options.signer.address })
  const { signature } = yield* Signer.signTransaction(options.signer, sponsored.bytes)
  return yield* execute({ digest: sponsored.digest, bytes: sponsored.bytes, signature })
}) as (
  kind: Uint8Array,
  options: SponsorOptions
) => Effect.Effect<
  Sponsored,
  EnokiError | UnexpectedSponsoredTransaction | Signer.SigningError | ExecutionUnconfirmed,
  EnokiClient
>

/** Build a recipe, resolve its object inputs, and have Enoki sponsor and execute it. */
export const run = <A, E, R>(
  recipe: Effect.Effect<A, E, R>,
  options: SponsorOptions
): Effect.Effect<
  Sponsored,
  | E
  | Objects.ObjectNotFound
  | RpcError.RpcError
  | Resolve.Incomplete
  | Resolve.InvalidTransaction
  | Resolve.InsufficientBalance
  | Resolve.InvalidBalanceIntent
  | Resolve.AllowanceError
  | EnokiError
  | UnexpectedSponsoredTransaction
  | Signer.SigningError
  | ExecutionUnconfirmed,
  Exclude<R, Ptb.PtbBuilder> | Objects.Objects | Packages.Packages | Coins.Coins | EnokiClient
> =>
  Ptb.build(recipe).pipe(
    Effect.flatMap(({ draft }) => Resolve.inputs({ sender: options.sender ?? options.signer.address, draft })),
    // Coin/balance intents are sourced from the sender's address balance or coins.
    // The gas coin is the sponsor's, so sponsored recipes should use `useGasCoin: false`.
    Effect.flatMap(Resolve.balances),
    Effect.flatMap((plan) => transactionKind(plan.draft)),
    Effect.flatMap((kind) => sponsorAndExecute(kind, options)),
    Effect.withSpan("Sponsor.run")
  )
