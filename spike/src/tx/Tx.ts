/**
 * Draft -> TransactionData -> signed -> executed.
 *
 * Resolution is a plain Effect over `SuiClient`. Its lookups run with
 * unbounded concurrency and the client's request batching turns N object reads
 * into one `BatchGetObjects` and N function signatures into cached lookups.
 * There is no plugin chain: anything that wants to rewrite a transaction
 * (sponsorship, intents, policy checks) is a function `Draft -> Effect<Draft>`
 * or `TransactionData -> Effect<TransactionData>` and composes with `pipe`.
 */
import { Effect, Option, Schema } from "effect"
import * as Bcs from "../bcs/Bcs.ts"
import { type Signer, signTransaction, type SigningError } from "../crypto/Signer.ts"
import type { GrpcError } from "../grpc/GrpcWeb.ts"
import { type MalformedResponse, type MoveFunction, type ObjectNotFound, SuiClient, type SuiObject } from "../sui/SuiClient.ts"
import * as T from "../sui/Types.ts"
import type { Draft } from "./Ptb.ts"

export class GasEstimationFailed extends Schema.TaggedError<GasEstimationFailed>()("GasEstimationFailed", {
  error: Schema.String
}) {}

export class ExecutionFailed extends Schema.TaggedError<ExecutionFailed>()("ExecutionFailed", {
  digest: Schema.String,
  error: Schema.String
}) {}

export type ResolveError = ObjectNotFound | GrpcError | MalformedResponse | GasEstimationFailed

export interface ResolveOptions {
  readonly sender: T.Address
  readonly gas?: {
    readonly price?: bigint
    readonly budget?: bigint
    /** Coins to pay with. Omitted: pay from the sender's address balance. */
    readonly payment?: ReadonlyArray<T.ObjectRef>
    readonly owner?: T.Address
  }
}

type Usage = { mutable: boolean; receiving: boolean }

const TX_CONTEXT = "0x0000000000000000000000000000000000000000000000000000000000000002::tx_context::TxContext"
const RECEIVING = "0x0000000000000000000000000000000000000000000000000000000000000002::transfer::Receiving"

/** How each input index is used, from the command list and the called functions' signatures. */
const usages = (draft: Draft, functions: ReadonlyMap<number, MoveFunction>) => {
  const out = new Map<number, Usage>()
  const mark = (arg: T.Argument, mutable: boolean, receiving = false) => {
    if (arg._tag !== "Input") return
    const u = out.get(arg.value) ?? { mutable: false, receiving: false }
    out.set(arg.value, { mutable: u.mutable || mutable, receiving: u.receiving || receiving })
  }
  draft.commands.forEach((c, i) => {
    switch (c._tag) {
      case "MoveCall": {
        const params = (functions.get(i)?.parameters ?? []).filter((p) => p.typeName !== TX_CONTEXT)
        c.arguments.forEach((a, j) => {
          const p = params[j]
          mark(a, p === undefined || p.reference !== "Immutable", p?.typeName === RECEIVING)
        })
        return
      }
      case "TransferObjects":
        return c.objects.forEach((a) => mark(a, true))
      case "SplitCoins":
        return mark(c.coin, true)
      case "MergeCoins":
        return [c.destination, ...c.sources].forEach((a) => mark(a, true))
      case "MakeMoveVec":
        return c.elements.forEach((a) => mark(a, true))
      default:
        return
    }
  })
  return out
}

const toObjectArg = (obj: SuiObject, usage: Usage | undefined, forced: boolean | undefined): T.ObjectArg => {
  if (obj.owner._tag === "Shared" || obj.owner._tag === "ConsensusAddressOwner") {
    const mutable = forced ?? usage?.mutable ?? true
    return {
      _tag: "SharedObject",
      objectId: obj.objectId,
      initialSharedVersion: obj.owner._tag === "Shared" ? obj.owner.initialSharedVersion : obj.owner.startVersion,
      mutability: { _tag: mutable ? "Mutable" : "Immutable" }
    }
  }
  if (usage?.receiving) return { _tag: "Receiving", ...obj.ref }
  return { _tag: "ImmOrOwnedObject", ...obj.ref }
}

const GAS_SAFE_OVERHEAD = 1000n
const MAX_BUDGET = 50_000_000_000n

/** Fill in object refs, gas price, payment and budget. */
export const resolve = Effect.fn("Tx.resolve")(function*(draft: Draft, options: ResolveOptions) {
  const client = yield* SuiClient

  const unresolved = draft.inputs.flatMap((input, index) => (input._tag === "UnresolvedObject" ? [{ input, index }] : []))
  const moveCalls = draft.commands.flatMap((c, index) => (c._tag === "MoveCall" ? [{ c, index }] : []))

  // Everything we need from the chain, all at once. The client batches.
  const [objects, functions, price, chain] = yield* Effect.all([
    Effect.forEach(unresolved, ({ input }) => client.getObject(input.objectId), { concurrency: "unbounded" }),
    Effect.forEach(moveCalls, ({ c, index }) =>
      Effect.map(client.getFunction({ package: c.package, module: c.module, function: c.function }), (f) => [index, f] as const), { concurrency: "unbounded" }),
    options.gas?.price !== undefined ? Effect.succeed(options.gas.price) : client.getReferenceGasPrice,
    client.getChain
  ], { concurrency: "unbounded" })

  const use = usages(draft, new Map(functions))
  const inputs = [...draft.inputs] as Array<T.CallArg | Draft["inputs"][number]>
  unresolved.forEach(({ input, index }, i) => {
    inputs[index] = { _tag: "Object", value: toObjectArg(objects[i]!, use.get(index), input.mutable) }
  })

  const kind: T.TransactionKind = {
    _tag: "ProgrammableTransaction",
    inputs: inputs as ReadonlyArray<T.CallArg>,
    commands: draft.commands
  }

  // Address-balance gas needs replay protection from a ValidDuring expiration.
  const payment = options.gas?.payment ?? []
  const addressBalanceExpiration: T.TransactionExpiration = {
    _tag: "ValidDuring",
    minEpoch: Option.some(chain.epoch),
    maxEpoch: Option.some(chain.epoch + 1n),
    minTimestamp: Option.none(),
    maxTimestamp: Option.none(),
    chain: chain.chainId,
    nonce: (Math.random() * 2 ** 32) >>> 0
  }
  const expiration: T.TransactionExpiration = payment.length > 0 ? { _tag: "None" } : addressBalanceExpiration

  const data = (budget: bigint): T.TransactionData => ({
    _tag: "V1",
    kind,
    sender: options.sender,
    gasData: { payment, owner: options.gas?.owner ?? options.sender, price, budget },
    expiration
  })

  if (options.gas?.budget !== undefined) return data(options.gas.budget)

  // Budget from a dry run with a placeholder payment ([] + ValidDuring): the
  // node mocks the gas coin, so the estimate doesn't depend on coin balances.
  const sim = yield* client.simulate(
    Bcs.encodeSync(T.TransactionData)({
      ...data(MAX_BUDGET),
      gasData: { payment: [], owner: options.gas?.owner ?? options.sender, price, budget: MAX_BUDGET },
      expiration: addressBalanceExpiration
    })
  )
  if (!sim.success || !sim.gasUsed) return yield* new GasEstimationFailed({ error: sim.error ?? "no gas summary" })
  const base = sim.gasUsed.computationCost + GAS_SAFE_OVERHEAD * price
  const total = base + sim.gasUsed.storageCost - sim.gasUsed.storageRebate
  return data(total > base ? total : base)
})

export const serialize = Bcs.encodeSync(T.TransactionData)

/** Sign, submit, and fail with `ExecutionFailed` if Move aborted. */
export const execute = Effect.fn("Tx.execute")(function*(data: T.TransactionData, signer: Signer) {
  const client = yield* SuiClient
  const bytes = serialize(data)
  const signature = yield* signTransaction(signer, bytes)
  const result = yield* client.execute(bytes, [signature])
  if (!result.success) return yield* new ExecutionFailed({ digest: result.digest, error: result.error ?? "unknown" })
  return result
}) as (data: T.TransactionData, signer: Signer) => Effect.Effect<
  { readonly digest: string },
  SigningError | GrpcError | ExecutionFailed,
  SuiClient
>
