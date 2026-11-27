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
import * as Schema from "effect/Schema"
import type { Address } from "./Address.ts"
import * as Ptb from "./Ptb.ts"
import * as Resolve from "./Resolve.ts"
import { isTransactionSigner, type Signer, SigningError, signTransaction, type TransactionSigner } from "./Signer.ts"
import * as T from "./TransactionData.ts"
import { type Effects, Transactions } from "./Transactions.ts"

export interface ResolveOptions<E = never, R = never> {
  readonly sender: Address
  readonly gasOwner?: Address
  readonly gasPrice?: bigint
  readonly gasBudget?: bigint
  readonly expiration?: T.TransactionExpiration
  /**
   * Default: `Resolve.auto` (address balance when it covers the budget, else coins).
   * Also `Resolve.addressBalance` (address balance only, or fail), `Resolve.coins`,
   * `Resolve.fixed(refs)`, or your own step.
   */
  readonly payment?: Resolve.PaymentStrategy<E, R>
}

/** Draft -> TransactionData with the default pipeline. */
export const resolve = <E = never, R = never>(draft: Ptb.Draft, options: ResolveOptions<E, R>) =>
  Effect.succeed<Resolve.Plan>({
    sender: options.sender,
    draft,
    ...(options.gasOwner && { gasOwner: options.gasOwner }),
    ...(options.gasPrice !== undefined && { gasPrice: options.gasPrice }),
    ...(options.gasBudget !== undefined && { gasBudget: options.gasBudget }),
    ...(options.expiration && { expiration: options.expiration })
  }).pipe(
    Effect.flatMap(Resolve.inputs),
    Effect.flatMap(Resolve.balances),
    Effect.flatMap(Resolve.gasPrice),
    Effect.flatMap(Resolve.budget),
    Effect.flatMap((plan) => (options.payment ?? (Resolve.auto as unknown as Resolve.PaymentStrategy<E, R>))(plan)),
    Effect.flatMap(Resolve.finish),
    Effect.withSpan("Tx.resolve")
  )

/** Build a recipe and resolve it. */
export const build = <A, E1, R1, E2 = never, R2 = never>(
  recipe: Effect.Effect<A, E1, R1>,
  options: ResolveOptions<E2, R2>
) => Effect.flatMap(Ptb.build(recipe), ({ draft }) => resolve(draft, options))

/** The BCS bytes of transaction data. */
export const serialize = T.encode

/** The transaction reached the chain and Move aborted. Gas was charged. */
export class ExecutionFailed extends Schema.TaggedError<ExecutionFailed>()("ExecutionFailed", {
  digest: Schema.String,
  description: Schema.String,
  command: Schema.optionalKey(Schema.Number),
  abortCode: Schema.optionalKey(Schema.BigInt)
}) {}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Collect every signature, in the order the signers were given.
 *
 * `TransactionSigner`s (wallets) sign first, one at a time: one may change the
 * transaction (its returned bytes win), but not after another has signed it.
 * Intent-message `Signer`s then sign the final bytes concurrently.
 */
const sign = Effect.fnUntraced(function*(data: T.TransactionData, signers: ReadonlyArray<Signer | TransactionSigner>) {
  let current = data
  let bytes = T.encode(data)
  const signatures: Array<Uint8Array | undefined> = signers.map(() => undefined)
  let signedByTransactionSigner = false
  for (const [i, s] of signers.entries()) {
    if (!isTransactionSigner(s)) continue
    const signed = yield* s.signTransaction(current)
    if (!sameBytes(signed.bytes, bytes)) {
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
 * Takes `Signer`s and `TransactionSigner`s (wallets). A wallet may change the
 * transaction; what is submitted is exactly the bytes it signed.
 */
export const execute = Effect.fn("Tx.execute")(function*(
  data: T.TransactionData,
  signers: Signer | TransactionSigner | ReadonlyArray<Signer | TransactionSigner>
) {
  const { bytes, signatures } = yield* sign(data, Array.isArray(signers) ? signers : [signers as Signer | TransactionSigner])
  const effects = yield* Effect.flatMap(Effect.service(Transactions), (t) => t.execute(bytes, signatures))
  if (effects.status._tag === "Failure") {
    return yield* new ExecutionFailed({
      digest: effects.digest,
      description: effects.status.description,
      ...(effects.status.command !== undefined && { command: effects.status.command }),
      ...(effects.status.abortCode !== undefined && { abortCode: effects.status.abortCode })
    })
  }
  return effects
})

/** Build, resolve, sign with `signer` (a `Signer` or a wallet's `TransactionSigner`; also the sender unless given), execute. */
export const run = <A, E1, R1, E2 = never, R2 = never>(
  recipe: Effect.Effect<A, E1, R1>,
  options: Omit<ResolveOptions<E2, R2>, "sender"> & { readonly signer: Signer | TransactionSigner; readonly sender?: Address }
): Effect.Effect<
  Effects,
  Effect.Error<ReturnType<typeof build<A, E1, R1, E2, R2>>> | Effect.Error<ReturnType<typeof execute>>,
  Effect.Services<ReturnType<typeof build<A, E1, R1, E2, R2>>> | Transactions
> =>
  Effect.flatMap(build(recipe, { ...options, sender: options.sender ?? options.signer.address }), (data) =>
    execute(data, options.signer)
  ) as any
