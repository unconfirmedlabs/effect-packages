/**
 * The common path in one place: build a recipe, resolve it, sign, execute.
 *
 *   const effects = yield* Tx.run(recipe, { signer })
 *
 * Every piece is also exported on its own (`Ptb.build`, the `Resolve` steps,
 * `Signer.signTransaction`, `Transactions.execute`) for flows that need to
 * stop in between: sponsorship, multi-party signing, offline signing.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Address } from "./Address.ts"
import * as Hash from "./Hash.ts"
import * as Ptb from "./Ptb.ts"
import * as Resolve from "./Resolve.ts"
import { isTransactionSigner, type Signer, SigningError, signTransaction, type TransactionSigner } from "./Signer.ts"
import * as T from "./TransactionData.ts"
import { type Effects, type IncludeOptions, Transactions } from "./Transactions.ts"
import * as Bytes from "@unconfirmed/bcs/Bytes"

export interface ResolveOptions<E = never, R = never> {
  readonly sender: Address
  readonly gasOwner?: Address
  readonly gasPrice?: bigint
  readonly gasBudget?: bigint
  /** Refuse a resolved budget above this (`GasBudgetExceeded`). Without it the node's budget is still refused above 50 SUI. */
  readonly maxGasBudget?: bigint
  readonly expiration?: T.TransactionExpiration
  /**
   * Default: `Resolve.auto` (address balance when it covers the budget, else coins).
   * Also `Resolve.addressBalance` (address balance only, or fail), `Resolve.coins`,
   * `Resolve.fixed(refs)`, or your own step.
   */
  readonly payment?: Resolve.PaymentStrategy<E, R>
  /**
   * Where the transaction is completed.
   *
   * - `"auto"` (default): on the node, as `"server"`, when the transport can
   *   (`Transactions.resolve`: gRPC and GraphQL) and `payment` is the default,
   *   `Resolve.auto` or `Resolve.fixed`; otherwise client-side. A server
   *   attempt that fails with a non-retryable `RpcError` (a missing object,
   *   gas the node can't select, an old node) is redone client-side, whose
   *   errors are precise (`ObjectNotFound`, `InsufficientGas`).
   * - `"server"`: `Resolve.balances` (coin/balance intents), then one verified
   *   simulation on the node (`Resolve.server`). `Incomplete` if the transport
   *   can't, `InvalidTransaction` with a custom payment strategy.
   * - `"client"`: the client-side steps only (`Resolve.inputs`, `balances`,
   *   `gasPrice`, `budget`, the payment strategy), every answer read here:
   *   for independent verification, or a transport without `resolve`.
   */
  readonly resolve?: "auto" | "server" | "client"
}

const basePlan = (draft: Ptb.Draft, options: ResolveOptions<any, any>): Resolve.Plan => ({
  sender: options.sender,
  draft,
  ...(options.gasOwner && { gasOwner: options.gasOwner }),
  ...(options.gasPrice !== undefined && { gasPrice: options.gasPrice }),
  ...(options.gasBudget !== undefined && { gasBudget: options.gasBudget }),
  ...(options.maxGasBudget !== undefined && { maxGasBudget: options.maxGasBudget }),
  ...(options.expiration && { expiration: options.expiration })
})

/** The client-side pipeline. */
const resolveClient = <E, R>(plan: Resolve.Plan, payment: Resolve.PaymentStrategy<E, R> | undefined) => {
  const strategy: Resolve.PaymentStrategy<E | Resolve.DefaultPaymentError, R | Resolve.DefaultPaymentServices> = payment ??
    Resolve.auto
  return Effect.all([Resolve.inputs(plan), Resolve.prefetch(plan, { payment: payment === undefined })], {
    concurrency: "unbounded"
  }).pipe(
    Effect.map(([resolved, pre]): Resolve.Plan => ({
      ...resolved,
      ...(pre.gasPrice !== undefined && { gasPrice: pre.gasPrice }),
      ...(pre.prefetched && { prefetched: pre.prefetched })
    })),
    Effect.flatMap(Resolve.balances),
    Effect.flatMap(Resolve.gasPrice),
    Effect.flatMap(Resolve.budget),
    Effect.flatMap(strategy),
    Effect.flatMap(Resolve.finish)
  )
}

/**
 * The payment the node can be handed: none (it selects), or a fixed non-empty
 * one; `undefined` for a custom strategy, or `fixed([])`, which the node can't
 * tell from "select one".
 */
const serverPayment = (
  payment: Resolve.PaymentStrategy<any, any> | undefined
): { readonly refs?: ReadonlyArray<T.ObjectRef> } | undefined =>
  payment === undefined || payment === Resolve.auto
    ? {}
    : Array.isArray((payment as Partial<Resolve.FixedPayment>).payment) && (payment as Resolve.FixedPayment).payment.length > 0
    ? { refs: (payment as Resolve.FixedPayment).payment }
    : undefined

/** Nothing to look up: every input resolved, no intents, price, budget and payment fixed. */
const complete = (plan: Resolve.Plan) =>
  plan.gasPrice !== undefined && plan.gasBudget !== undefined && plan.gasPayment !== undefined &&
  Ptb.toProgrammable(plan.draft) !== undefined

/**
 * Draft -> TransactionData.
 *
 * By default on the node, in one verified `SimulateTransaction` with gas
 * selection (`Resolve.server`, after `Resolve.balances` for coin/balance
 * intents), as `@mysten/sui` does; see `resolve` in `ResolveOptions` for when
 * it resolves client-side instead. Client-side, object lookups and everything
 * independent of them (gas price, chain info, the gas owner's SUI balance and
 * coins: `Resolve.prefetch`) run in one round trip; then intents, the budget
 * dry run and payment. The error type always includes the default payment
 * strategy's (`InsufficientGas`), which is what runs when `payment` is not given.
 */
export const resolve = <E = never, R = never>(draft: Ptb.Draft, options: ResolveOptions<E, R>) => {
  const mode = options.resolve ?? "auto"
  const plan = basePlan(draft, options)
  const client = resolveClient(plan, options.payment)
  const capped = (data: T.TransactionData) =>
    options.maxGasBudget !== undefined && data.gasData.budget > options.maxGasBudget
      ? Effect.fail(new Resolve.GasBudgetExceeded({ budget: data.gasData.budget, max: options.maxGasBudget }))
      : Effect.succeed(data)
  const payment = serverPayment(options.payment)
  const withPayment: Resolve.Plan = payment?.refs ? { ...plan, gasPayment: payment.refs } : plan
  // The node refuses gas selection for a sponsored transaction that uses the gas coin
  // ("Gas object is not an owned object with owner: <sender>"), so that resolves client-side.
  const sponsoredGasCoin = plan.gasOwner !== undefined && plan.gasOwner !== plan.sender && payment?.refs === undefined &&
    Resolve.usesGasCoin(draft)
  if (mode === "client" || (mode === "auto" && (payment === undefined || sponsoredGasCoin || complete(withPayment)))) {
    return client.pipe(Effect.flatMap(capped), Effect.withSpan("Tx.resolve"))
  }
  const resolved = Effect.flatMap(Effect.serviceOption(Transactions), (service) => {
    const transactions = Option.getOrUndefined(service)
    if (mode === "auto" && transactions?.resolve === undefined) return client
    if (transactions?.resolve === undefined) {
      return Effect.fail(new Resolve.Incomplete({ missing: "server-side resolution (this Transactions transport has no resolve)" }))
    }
    if (payment === undefined) {
      return Effect.fail(new Resolve.InvalidTransaction({
        reason: "resolve: \"server\" lets the node pick the gas payment; a custom payment strategy needs resolve: \"client\""
      }))
    }
    const serverSide = Effect.flatMap(Resolve.balances(withPayment), Resolve.server)
    return mode === "server"
      ? Effect.flatMap(serverSide, Resolve.finish)
      : serverSide.pipe(
        Effect.map(Option.some),
        Effect.catchIf((e) => e._tag === "RpcError" && !e.retryable, () => Effect.succeedNone),
        Effect.flatMap(Option.match({ onNone: () => client, onSome: Resolve.finish }))
      )
  })
  return resolved.pipe(Effect.flatMap(capped), Effect.withSpan("Tx.resolve"))
}

/** Build a recipe and resolve it. */
export const build = <A, E1, R1, E2 = never, R2 = never>(
  recipe: Effect.Effect<A, E1, R1>,
  options: ResolveOptions<E2, R2>
) => Effect.flatMap(Ptb.build(recipe), ({ draft }) => resolve(draft, options))

/** The BCS bytes of transaction data. */
export const serialize = T.encode

/** The transaction digest of resolved data (what the chain and `Effects.digest` call it), as `@mysten/sui`'s `getDigest`. */
export const digest = (data: T.TransactionData): Effect.Effect<string, Resolve.InvalidTransaction> =>
  Effect.map(Resolve.encode(data), Hash.transactionDigest)

/** The transaction reached the chain and failed (a Move abort: `abort`). Gas was charged. */
export class ExecutionFailed extends /* @__PURE__ */ Schema.TaggedError<ExecutionFailed>()("ExecutionFailed", {
  digest: Schema.String,
  ...Resolve.FailureFields
}) {
  override get message(): string {
    return `transaction ${this.digest} failed: ${Resolve.describeFailure(this)}`
  }
}

/**
 * `Tx.simulate`: the transaction would fail (a Move abort: `abort`), found in
 * the resolving dry run or in the simulation itself.
 */
export class SimulationFailed extends /* @__PURE__ */ Schema.TaggedError<SimulationFailed>()("SimulationFailed", Resolve.FailureFields) {
  override get message(): string {
    return `simulation failed: ${Resolve.describeFailure(this)}`
  }
}

/**
 * Build and resolve a recipe as `build` does, then simulate the result (with
 * the node's checks unless `checks: false`): a dry run in one call, answering
 * the resolved data, effects and return values. An execution failure, whether
 * resolution's own dry run or the simulation finds it, is `SimulationFailed`
 * with the Move abort. For a sender without gas, pass
 * `payment: Resolve.unchecked` (the node mocks the gas coin).
 */
export const simulate = <A, E1, R1, E2 = never, R2 = never>(
  recipe: Effect.Effect<A, E1, R1>,
  options: ResolveOptions<E2, R2> & { readonly checks?: boolean }
) =>
  Effect.gen(function*() {
    const data = yield* build(recipe, options).pipe(
      Effect.catchIf((e): e is Resolve.GasEstimationFailed => e instanceof Resolve.GasEstimationFailed, ({ description, command, abort }) =>
        Effect.fail(
          new SimulationFailed({ description, ...(command !== undefined && { command }), ...(abort !== undefined && { abort }) })
        ))
    )
    const bytes = yield* Resolve.encode(data)
    const simulation = yield* Effect.flatMap(
      Effect.service(Transactions),
      (t) => t.simulate(bytes, options.checks === undefined ? undefined : { checks: options.checks })
    )
    const status = simulation.effects.status
    if (status._tag === "Failure") return yield* new SimulationFailed(Resolve.failureFields(status))
    return { data, effects: simulation.effects, returnValues: simulation.returnValues }
  }).pipe(Effect.withSpan("Tx.simulate"))

/**
 * A key or transaction signer whose address is neither the transaction's
 * sender nor its gas owner: the node would refuse its signature. Refused
 * before anything is signed or sent. To sign for another address through its
 * alias set, wrap the key in `AddressAlias.signer`.
 */
export class SignerMismatch extends /* @__PURE__ */ Schema.TaggedError<SignerMismatch>()("SignerMismatch", {
  signer: Schema.String,
  sender: Schema.String,
  gasOwner: Schema.String
}) {
  override get message(): string {
    return `signer ${this.signer} is neither the sender ${this.sender} nor the gas owner ${this.gasOwner}`
  }
}

const mismatch = (signer: Address, sender: Address, gasOwner: Address): SignerMismatch | undefined =>
  signer === sender || signer === gasOwner ? undefined : new SignerMismatch({ signer, sender, gasOwner })


/**
 * What a transaction signer may change. Its returned bytes must keep the
 * sender, the programmable transaction and the gas owner. It may re-pick gas
 * price, budget and payment only when no key `Signer` is the gas owner (a
 * sponsor key never signs gas terms it didn't see), and the expiration only
 * when no key `Signer` is the sender or the gas owner (a key never signs a
 * validity window it didn't see).
 */
const checkChange = (
  before: T.TransactionData,
  after: T.TransactionData,
  keySigners: ReadonlyArray<Signer>
): SigningError | undefined => {
  const refused = (what: string) =>
    new SigningError({ reason: "failed", message: `a transaction signer changed the transaction's ${what}` })
  if (after.sender !== before.sender) return refused("sender")
  if (after.gasData.owner !== before.gasData.owner) return refused("gas owner")
  const restOf = (d: T.TransactionData) => T.encode({ ...d, gasData: before.gasData, expiration: before.expiration })
  if (!Bytes.equal(restOf(after), restOf(before))) return refused("commands or inputs")
  const keyIs = (address: string) => keySigners.some((k) => k.address === address)
  const gasChanged = !Bytes.equal(T.encode({ ...before, gasData: after.gasData }), T.encode(before))
  const expirationChanged = !Bytes.equal(T.encode({ ...before, expiration: after.expiration }), T.encode(before))
  if (gasChanged && keyIs(before.gasData.owner)) return refused("gas or expiration, which a key signer pays for")
  if (expirationChanged && (keyIs(before.sender) || keyIs(before.gasData.owner))) {
    return refused("expiration, which a key signer signs")
  }
  return undefined
}

/**
 * Collect every signature, in the order the signers were given.
 *
 * `TransactionSigner`s (wallets) sign first, one at a time. One may change the
 * gas terms (its returned bytes win, see `checkChange`), but not after another
 * has signed. Intent-message `Signer`s then sign the final bytes concurrently.
 * A signer that is neither the sender nor the gas owner is `SignerMismatch`
 * before anyone signs.
 */
const sign = /* @__PURE__ */ Effect.fnUntraced(function*(data: T.TransactionData, signers: ReadonlyArray<Signer | TransactionSigner>) {
  for (const s of signers) {
    const refused = mismatch(s.address, data.sender, data.gasData.owner)
    if (refused) return yield* refused
  }
  let current = data
  let bytes = yield* Resolve.encode(data)
  const signatures: Array<Uint8Array | undefined> = signers.map(() => undefined)
  let signedByTransactionSigner = false
  for (const [i, s] of signers.entries()) {
    if (!isTransactionSigner(s)) continue
    const signed = yield* s.signTransaction(current)
    if (!Bytes.equal(signed.bytes, bytes)) {
      if (signedByTransactionSigner) {
        return yield* new SigningError({
          reason: "failed",
          message: "a transaction signer changed a transaction that another signer had already signed"
        })
      }
      const decoded = T.decode(signed.bytes)
      if (decoded._tag === "Failure") {
        return yield* new SigningError({ reason: "failed", message: `the signer returned bytes that are not TransactionData: ${decoded.failure.message}` })
      }
      const refused = checkChange(current, decoded.success, signers.filter((x): x is Signer => !isTransactionSigner(x)))
      if (refused) return yield* refused
      current = decoded.success
      bytes = signed.bytes
    }
    signedByTransactionSigner = true
    signatures[i] = signed.signature
  }
  const final = bytes
  yield* Effect.forEach(
    signers.entries(),
    ([i, s]) =>
      isTransactionSigner(s) ? Effect.void : Effect.map(signTransaction(s, final), (x) => {
        signatures[i] = x.signature
      }),
    { concurrency: "unbounded", discard: true }
  )
  return { bytes: final, signatures: signatures as Array<Uint8Array> }
})

/**
 * Sign and submit; a `Failure` status becomes `ExecutionFailed`.
 *
 * Takes `Signer`s and `TransactionSigner`s (wallets), each the sender or the
 * gas owner (else `SignerMismatch`; an alias signs through `AddressAlias.signer`).
 * A wallet may re-pick the gas terms it pays for, never the sender, commands,
 * inputs or gas owner, and nothing a key signer pays for; what is submitted is
 * exactly the bytes it signed.
 */
export const execute = /* @__PURE__ */ Effect.fn("Tx.execute")(function*(
  data: T.TransactionData,
  signers: Signer | TransactionSigner | ReadonlyArray<Signer | TransactionSigner>,
  options?: IncludeOptions
) {
  const { bytes, signatures } = yield* sign(data, Array.isArray(signers) ? signers : [signers as Signer | TransactionSigner])
  const effects = yield* Effect.flatMap(Effect.service(Transactions), (t) => t.execute(bytes, signatures, options))
  if (effects.status._tag === "Failure") {
    return yield* new ExecutionFailed({
      digest: effects.digest,
      ...Resolve.failureFields(effects.status)
    })
  }
  return effects
})

/**
 * Build, resolve, sign with `signer` (a `Signer` or a wallet's `TransactionSigner`; also the sender unless given), execute.
 * `include` (`["events", "balanceChanges"]`) adds those to the effects.
 */
export const run = <A, E1, R1, E2 = never, R2 = never>(
  recipe: Effect.Effect<A, E1, R1>,
  options: Omit<ResolveOptions<E2, R2>, "sender"> & IncludeOptions & {
    readonly signer: Signer | TransactionSigner
    readonly sender?: Address
  }
): Effect.Effect<
  Effects,
  Effect.Error<ReturnType<typeof build<A, E1, R1, E2, R2>>> | Effect.Error<ReturnType<typeof execute>>,
  Effect.Services<ReturnType<typeof build<A, E1, R1, E2, R2>>> | Transactions
> =>
  Effect.suspend(() => {
    const sender = options.sender ?? options.signer.address
    const refused = mismatch(options.signer.address, sender, options.gasOwner ?? sender)
    return refused
      ? Effect.fail(refused)
      : Effect.flatMap(build(recipe, { ...options, sender }), (data) =>
        execute(data, options.signer, options.include && { include: options.include }))
  }) as any
