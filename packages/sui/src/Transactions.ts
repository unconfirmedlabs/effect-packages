/**
 * Simulating, executing and reading transactions.
 */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { Address } from "./Address.ts"
import type { Owner } from "./Objects.ts"
import type { RpcError } from "./RpcError.ts"
import type { ObjectDigest } from "./TransactionData.ts"

export interface GasUsed {
  readonly computationCost: bigint
  readonly storageCost: bigint
  readonly storageRebate: bigint
  readonly nonRefundableStorageFee: bigint
}

export type Status =
  | { readonly _tag: "Success" }
  | {
    readonly _tag: "Failure"
    /** The node's description, e.g. `MoveAbort(...) in command 1`. */
    readonly description: string
    readonly command: number | undefined
    readonly abortCode: bigint | undefined
    /** Where a Move abort happened, when the transport reports it. */
    readonly location?: AbortLocation
    /** A clever error's decoded fields (`#[error] const E: vector<u8> = ...`), when the transport reports them. */
    readonly cleverError?: CleverError
  }

export interface AbortLocation {
  readonly package: Address
  readonly module: string
  readonly function: string | undefined
  readonly instruction: number | undefined
}

export interface CleverError {
  readonly errorCode: bigint | undefined
  readonly lineNumber: bigint | undefined
  readonly constantName: string | undefined
  readonly constantType: string | undefined
  /** The constant's value rendered as text, when the node could render it. */
  readonly rendered: string | undefined
}

export interface ChangedObject {
  readonly objectId: Address
  readonly type: string | undefined
  readonly operation: "Created" | "Deleted" | "None"
  readonly version: bigint | undefined
  readonly digest: ObjectDigest | undefined
  readonly owner: Owner | undefined
  /** The object's state before the transaction; all `undefined` for objects that didn't exist. */
  readonly inputVersion: bigint | undefined
  readonly inputDigest: ObjectDigest | undefined
  readonly inputOwner: Owner | undefined
}

export interface Effects {
  readonly digest: string
  readonly status: Status
  readonly gasUsed: GasUsed
  readonly changedObjects: ReadonlyArray<ChangedObject>
}

export interface Simulation {
  readonly effects: Effects
  /** Each command's return values, as BCS bytes. */
  readonly returnValues: ReadonlyArray<ReadonlyArray<Uint8Array>>
}

export class TransactionNotFound extends /* @__PURE__ */ Schema.TaggedError<TransactionNotFound>()("TransactionNotFound", {
  digest: Schema.String
}) {}

export class Transactions extends /* @__PURE__ */ Context.Service<Transactions, {
  /** Run without committing. `checks: false` skips signature/ownership checks (dev-inspect). */
  readonly simulate: (txBytes: Uint8Array, options?: { readonly checks?: boolean }) => Effect.Effect<Simulation, RpcError>
  /** Submit signed bytes. A Move abort is a successful submission with a `Failure` status. */
  readonly execute: (txBytes: Uint8Array, signatures: ReadonlyArray<Uint8Array>) => Effect.Effect<Effects, RpcError>
  readonly get: (digest: string) => Effect.Effect<Effects, TransactionNotFound | RpcError>
}>()("@unconfirmed/sui/Transactions") {}

/** `waitFor` gave up: the transaction wasn't visible within the timeout. */
export class TransactionWaitTimeout extends /* @__PURE__ */ Schema.TaggedError<TransactionWaitTimeout>()("TransactionWaitTimeout", {
  digest: Schema.String,
  timeoutMillis: Schema.Number
}) {}

export interface WaitForOptions {
  /** Overall bound. Default 60 seconds. */
  readonly timeout?: Duration.Input
  /**
   * When to look again after `TransactionNotFound`. Default: every 500 ms
   * (until the timeout). If a finite schedule runs out first, the last
   * `TransactionNotFound` is the failure.
   */
  readonly schedule?: Schedule.Schedule<unknown>
}

/**
 * Wait until a transaction is readable (e.g. after `execute` on another node,
 * or a digest from elsewhere) and return its effects. Only `TransactionNotFound`
 * is retried; transport failures surface as they are.
 */
export const waitFor = (
  digest: string,
  options?: WaitForOptions
): Effect.Effect<Effects, TransactionWaitTimeout | TransactionNotFound | RpcError, Transactions> => {
  const timeout = options?.timeout ?? "60 seconds"
  return Effect.flatMap(Effect.service(Transactions), (t) =>
    t.get(digest).pipe(
      Effect.retry({ while: (e) => e._tag === "TransactionNotFound", schedule: options?.schedule ?? Schedule.spaced("500 millis") }),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new TransactionWaitTimeout({ digest, timeoutMillis: Duration.toMillis(timeout) }))
      }),
      Effect.withSpan("Transactions.waitFor", { attributes: { digest } })
    ))
}
