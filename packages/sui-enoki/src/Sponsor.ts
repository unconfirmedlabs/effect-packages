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
 * Each step is exported for flows that stop in between.
 */
import * as Address from "@unconfirmed/sui/Address"
import type * as Coins from "@unconfirmed/sui/Coins"
import * as Hash from "@unconfirmed/sui/Hash"
import type * as Objects from "@unconfirmed/sui/Objects"
import type * as Packages from "@unconfirmed/sui/Packages"
import * as Ptb from "@unconfirmed/sui/Ptb"
import * as Resolve from "@unconfirmed/sui/Resolve"
import type * as RpcError from "@unconfirmed/sui/RpcError"
import * as Signer from "@unconfirmed/sui/Signer"
import * as T from "@unconfirmed/sui/TransactionData"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { EnokiClient, type EnokiError, type EnokiNetwork } from "./EnokiClient.ts"

/** Enoki answered with transaction bytes that are not the transaction we asked it to sponsor. */
export class UnexpectedSponsoredTransaction extends Schema.TaggedError<UnexpectedSponsoredTransaction>()(
  "UnexpectedSponsoredTransaction",
  { reason: Schema.String }
) {}

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

export interface SponsorOptions {
  /** Signs the sponsored transaction; its address is the sender unless `sender` is given. */
  readonly signer: Signer.Signer
  readonly network?: EnokiNetwork
  readonly sender?: Address.Address
  /**
   * Identify a zkLogin sender by JWT instead of address (public API keys).
   * `allowedAddresses` / `allowedMoveCallTargets` apply only to sender-based sponsorship.
   */
  readonly jwt?: string
  readonly allowedAddresses?: ReadonlyArray<string>
  readonly allowedMoveCallTargets?: ReadonlyArray<string>
  /**
   * The gas owner Enoki must use. Default: the app's sponsor address for
   * `network` from `getApp` (mainnet/testnet), when it lists one. Either way
   * the gas owner must not be the sender, so the user never pays.
   */
  readonly sponsorAddress?: Address.Address
  /** Refuse sponsored transactions with a larger gas budget (MIST). */
  readonly maxBudget?: bigint
  /** Refuse sponsored transactions with a higher gas price (MIST per unit). */
  readonly maxGasPrice?: bigint
}

export interface Sponsored {
  readonly digest: string
  /** The sponsored `TransactionData` bytes that were signed and executed. */
  readonly bytes: Uint8Array
  readonly signature: Uint8Array
}

const unexpected = (reason: string) => new UnexpectedSponsoredTransaction({ reason })

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

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
      if (!sameBytes(encodeKind(data.kind), expected.kind)) return Effect.fail(unexpected("transaction kind was changed"))
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

/** The sponsor address to require: given, or the app's for this network (if it lists one). */
const sponsorFor = (enoki: EnokiClient["Service"], options: SponsorOptions) =>
  options.sponsorAddress !== undefined
    ? Effect.succeed<Address.Address | undefined>(options.sponsorAddress)
    : options.network === "mainnet" || options.network === "testnet"
    ? Effect.flatMap(enoki.getApp, (app) => {
      const listed = app.sponsorAddresses?.[options.network as "mainnet" | "testnet"]
      if (listed === undefined) return Effect.succeed(undefined)
      return Result.match(Schema.decodeUnknownResult(Address.Strict)(listed), {
        onFailure: () => Effect.fail(unexpected(`Enoki listed an invalid sponsor address ${listed}`)),
        onSuccess: (a) => Effect.succeed<Address.Address | undefined>(a)
      })
    })
    : Effect.succeed<Address.Address | undefined>(undefined)

/**
 * Sponsor a `TransactionKind`, check what comes back, sign it with the
 * user's `Signer`, and execute it through Enoki.
 */
export const sponsorAndExecute = Effect.fn("Sponsor.sponsorAndExecute")(function*(kind: Uint8Array, options: SponsorOptions) {
  const enoki = yield* EnokiClient
  const sender = options.sender ?? options.signer.address
  const network = options.network !== undefined ? { network: options.network } : {}
  const [sponsor, sponsored] = yield* Effect.all([sponsorFor(enoki, options), enoki.createSponsoredTransaction(
    options.jwt !== undefined
      ? { ...network, transactionKindBytes: kind, jwt: options.jwt }
      : {
        ...network,
        transactionKindBytes: kind,
        sender,
        ...(options.allowedAddresses && { allowedAddresses: options.allowedAddresses }),
        ...(options.allowedMoveCallTargets && { allowedMoveCallTargets: options.allowedMoveCallTargets })
      }
  )], { concurrency: "unbounded" })
  yield* check(sponsored.bytes, {
    kind,
    sender,
    digest: sponsored.digest,
    sponsor,
    maxBudget: options.maxBudget,
    maxGasPrice: options.maxGasPrice
  })
  const { signature } = yield* Signer.signTransaction(options.signer, sponsored.bytes)
  const { digest } = yield* enoki.executeSponsoredTransaction({ digest: sponsored.digest, signature })
  return { digest, bytes: sponsored.bytes, signature } satisfies Sponsored
}) as (
  kind: Uint8Array,
  options: SponsorOptions
) => Effect.Effect<Sponsored, EnokiError | UnexpectedSponsoredTransaction | Signer.SigningError, EnokiClient>

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
  | Resolve.InsufficientBalance
  | Resolve.InvalidBalanceIntent
  | Resolve.AllowanceError
  | EnokiError
  | UnexpectedSponsoredTransaction
  | Signer.SigningError,
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
