/**
 * The `seal_approve*` transaction (§4.6, P1–P5): what a key server dry-runs
 * to decide whether to release keys.
 *
 * Only the `ProgrammableTransaction` is sent and signed (P2): no sender, gas
 * or expiration, so building one needs no chain access unless object inputs
 * have to be resolved. Recipes are ordinary `@unconfirmed/effect-sui` `Ptb` recipes
 * (`Approval.call`, `Move.call`, generated builders), built with `Ptb.build`.
 */
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as AddressModule from "@unconfirmed/effect-sui/Address"
import type { Address } from "@unconfirmed/effect-sui/Address"
import type * as Objects from "@unconfirmed/effect-sui/Objects"
import type * as Packages from "@unconfirmed/effect-sui/Packages"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import * as Resolve from "@unconfirmed/effect-sui/Resolve"
import type { RpcError } from "@unconfirmed/effect-sui/RpcError"
import * as T from "@unconfirmed/effect-sui/TransactionData"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { InvalidApproval } from "./Errors.ts"

export interface Approval {
  /** The package the calls go to: any version of the policy package (P3). */
  readonly packageId: Address
  /** The inner ids, one per command, in order (duplicates kept). */
  readonly ids: ReadonlyArray<Uint8Array>
  readonly ptb: T.ProgrammableTransaction
  /** BCS of `ptb`: what is sent and what the session key signs (P2). */
  readonly bytes: Uint8Array
}

/** The server's limit (`valid_ptb.rs` `MAX_COMMANDS`). */
export const MAX_COMMANDS = 100

const encodePtb = /* @__PURE__ */ Bcs.encodeSync(T.ProgrammableTransaction)
const decodePtb = /* @__PURE__ */ Bcs.decode(T.ProgrammableTransaction)
const decodeKind = /* @__PURE__ */ Bcs.decode(T.TransactionKind)
const decodeTransaction = /* @__PURE__ */ Bcs.decode(T.TransactionData)
const decodeId = /* @__PURE__ */ Bcs.decode(Bcs.byteVector)

/**
 * One `seal_approve*` call with `id` (BCS `vector<u8>`) as its first argument.
 * A recipe step like any other. `arguments` may be arguments already added,
 * or recipe steps (`Ptb.clock`, `Ptb.object(id)`, `Move.pure(...)`) that are
 * run after the id is added, so inputs come in the order `@mysten/sui` gives
 * them.
 */
export const call = <E = never>(o: {
  readonly target: `${string}::${string}::${string}`
  readonly id: Uint8Array
  readonly arguments?: ReadonlyArray<T.Argument | Effect.Effect<T.Argument, E, Ptb.PtbBuilder>>
  readonly typeArguments?: ReadonlyArray<string>
}): Effect.Effect<void, E | Ptb.InvalidPureValue, Ptb.PtbBuilder> =>
  Effect.gen(function*() {
    const args: Array<T.Argument> = [yield* Ptb.pure(Bcs.byteVector, o.id)]
    for (const a of o.arguments ?? []) args.push(Effect.isEffect(a) ? yield* a : a)
    yield* Ptb.moveCall({
      target: o.target,
      arguments: args,
      ...(o.typeArguments !== undefined && { typeArguments: o.typeArguments })
    })
  })

const fail = (reason: string) => Result.fail(new InvalidApproval({ reason }))

/** Check every rule of P1, with the key server's wording (`valid_ptb.rs`), and extract the ids. */
export const fromProgrammable = (ptb: T.ProgrammableTransaction): Result.Result<Approval, InvalidApproval> => {
  if (ptb.commands.length > MAX_COMMANDS) return fail(`Too many commands in PTB (more than ${MAX_COMMANDS})`)
  if (ptb.inputs.length === 0 || ptb.commands.length === 0) return fail("Empty PTB input or command")
  const first = ptb.commands[0]!
  if (first._tag !== "MoveCall") return fail("Invalid first command")
  const packageId = first.package
  const ids: Array<Uint8Array> = []
  for (const [i, cmd] of ptb.commands.entries()) {
    const at = ` (command ${i})`
    if (cmd._tag !== "MoveCall") return fail(`Non MoveCall command${at}`)
    if (!cmd.arguments.every((a) => a._tag === "Input")) return fail(`Only pure inputs are allowed${at}`)
    const arg = cmd.arguments[0]
    if (arg === undefined) return fail(`Empty args${at}`)
    if (arg._tag !== "Input") return fail(`Invalid index for first argument${at}`)
    const input = ptb.inputs[arg.value]
    if (input === undefined || input._tag !== "Pure") return fail(`Invalid first parameter for seal_approve${at}`)
    const id = decodeId(input.bytes)
    if (Result.isFailure(id)) return fail(`Invalid BCS for first parameter for seal_approve${at}`)
    if (!cmd.function.startsWith("seal_approve") || cmd.package !== packageId) {
      return fail(`Invalid function or package id${at}`)
    }
    ids.push(id.success)
  }
  return Result.succeed({ packageId, ids, ptb, bytes: encodePtb(ptb) })
}

/** BCS `ProgrammableTransaction` bytes (what a key server receives). */
export const fromBytes = (bytes: Uint8Array): Result.Result<Approval, InvalidApproval> => {
  const ptb = decodePtb(bytes)
  return Result.isFailure(ptb) ? fail("Invalid BCS") : fromProgrammable(ptb.success)
}

/**
 * What `@mysten/sui`'s `build({ onlyTransactionKind: true })` returns. The
 * kind tag is checked rather than dropped, and full transaction bytes are
 * refused (item 15).
 */
export const fromTransactionKindBytes = (bytes: Uint8Array): Result.Result<Approval, InvalidApproval> => {
  if (bytes.length === 0) return fail("empty TransactionKind bytes")
  if (bytes[0] !== 0) return fail(`TransactionKind tag ${bytes[0]} is not ProgrammableTransaction (0)`)
  const kind = decodeKind(bytes)
  if (Result.isFailure(kind)) {
    return Result.isSuccess(decodeTransaction(bytes))
      ? fail("these are full TransactionData bytes; pass TransactionKind bytes (build with onlyTransactionKind)")
      : fail("Invalid BCS for TransactionKind")
  }
  return fromProgrammable({ inputs: kind.success.inputs, commands: kind.success.commands })
}

const fromDraft = (draft: Ptb.Draft): Result.Result<Approval, InvalidApproval> => {
  const ptb = Ptb.toProgrammable(draft)
  return ptb === undefined
    ? fail("the recipe has unresolved object inputs or intents: use fromRecipe, or Ptb.sharedObject / Ptb.objectArg")
    : fromProgrammable(ptb)
}

/** A recipe with no unresolved objects (pure inputs, `Ptb.sharedObject`, `Ptb.objectArg`, `Move.clock()`): no services. */
export const fromRecipeOffline = <A, E, R>(
  recipe: Effect.Effect<A, E, R>
): Effect.Effect<Approval, E | InvalidApproval, Exclude<R, Ptb.PtbBuilder>> =>
  Effect.flatMap(Ptb.build(recipe), ({ draft }) => Effect.fromResult(fromDraft(draft)))

/**
 * Build the recipe, resolve its object inputs (`Resolve.inputs`: owned refs,
 * shared mutability from the called functions' signatures), check P1. The
 * server strips versions and digests and reads current state (P4), so the
 * result stays usable while ownership does not change.
 */
export const fromRecipe = <A, E, R>(
  recipe: Effect.Effect<A, E, R>
): Effect.Effect<
  Approval,
  E | InvalidApproval | Objects.ObjectNotFound | Resolve.InvalidTransaction | RpcError,
  Exclude<R, Ptb.PtbBuilder> | Objects.Objects | Packages.Packages
> =>
  Ptb.build(recipe).pipe(
    Effect.flatMap(({ draft }) => Resolve.inputs({ sender: AddressModule.ZERO, draft })),
    Effect.flatMap((plan) => Effect.fromResult(fromDraft(plan.draft)))
  )
