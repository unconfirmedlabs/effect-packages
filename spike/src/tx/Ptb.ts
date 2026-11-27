/**
 * Programmable transaction blocks as Effects.
 *
 * A PTB "recipe" is an ordinary Effect that requires the `PtbBuilder` service:
 *
 *   const pay = (to: Address, amount: bigint) => Effect.gen(function*() {
 *     const [coin] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(amount)])
 *     yield* Ptb.transferObjects([coin!], yield* Ptb.address(to))
 *   })
 *
 * Consequences of that one decision:
 * - Recipes compose with `yield*`, `Effect.forEach`, `Effect.all` — no `tx.add(thunk)`.
 * - A recipe's requirements are in its type. One that needs chain data
 *   (Walrus reading its system object for prices) says `R = PtbBuilder | Walrus`;
 *   one that does not is guaranteed buildable offline.
 * - A recipe's failures are in its type, too.
 * - `Ptb.build` gives each build a fresh builder: no shared mutable
 *   `Transaction` object escapes, so a recipe can't be "half-applied" twice.
 *
 * Pure arguments are typed by their BCS schema at the call site
 * (`Ptb.pure(Bcs.u64, 5n)`), so there is no "UnresolvedPure" phase and no
 * round-trip to fetch a function signature just to serialize a number.
 */
import { Context, Effect, Result, Schema } from "effect"
import * as Bcs from "../bcs/Bcs.ts"
import * as T from "../sui/Types.ts"

/** An object input whose version/ownership the resolver will look up. */
export interface UnresolvedObject {
  readonly _tag: "UnresolvedObject"
  readonly objectId: T.Address
  /** Force shared-object mutability; otherwise inferred from how it's used. */
  readonly mutable?: boolean
}

export type Input = T.CallArg | UnresolvedObject

/** What a build produces: commands plus inputs that may still need resolving. */
export interface Draft {
  readonly inputs: ReadonlyArray<Input>
  readonly commands: ReadonlyArray<T.Command>
}

export class InvalidPureValue extends Schema.TaggedError<InvalidPureValue>()("InvalidPureValue", {
  issue: Schema.String
}) {}

interface MutableDraft {
  inputs: Array<Input>
  commands: Array<T.Command>
  objectIndex: Map<string, number>
}

export class PtbBuilder extends Context.Service<PtbBuilder, MutableDraft>()("@effect-sdks/sui/PtbBuilder") {}

const addCommand = (command: T.Command) =>
  Effect.map(Effect.service(PtbBuilder), (d): T.Argument => {
    d.commands.push(command)
    return { _tag: "Result", value: d.commands.length - 1 }
  })

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

export const gas: T.Argument = { _tag: "GasCoin" }

export const nested = (result: T.Argument, index: number): T.Argument => {
  if (result._tag !== "Result") throw new Error("nested() needs a command result")
  return { _tag: "NestedResult", value: [result.value, index] }
}

/** A pure argument, serialized now by its BCS schema. */
export const pure = <A, E>(schema: Schema.Codec<A, E>, value: A) => {
  const encode = Bcs.encode(schema)
  return Effect.flatMap(Effect.service(PtbBuilder), (d) =>
    Result.match(encode(value), {
      onFailure: (e) => Effect.fail(new InvalidPureValue({ issue: e.message })),
      onSuccess: (bytes) => {
        d.inputs.push({ _tag: "Pure", bytes })
        return Effect.succeed<T.Argument>({ _tag: "Input", value: d.inputs.length - 1 })
      }
    }))
}

export const u8 = (v: number) => pure(Bcs.u8, v)
export const u64 = (v: bigint) => pure(Bcs.u64, v)
export const bool = (v: boolean) => pure(Bcs.bool, v)
export const string = (v: string) => pure(Bcs.string, v)
export const address = (v: string) => pure(Bcs.Address, T.address(v))

/** An object input by id. The same id always maps to the same input. */
export const object = (objectId: string, options?: { readonly mutable?: boolean }) =>
  Effect.map(Effect.service(PtbBuilder), (d): T.Argument => {
    const id = T.address(objectId)
    const existing = d.objectIndex.get(id)
    if (existing !== undefined) return { _tag: "Input", value: existing }
    d.inputs.push({ _tag: "UnresolvedObject", objectId: id, ...(options?.mutable !== undefined && { mutable: options.mutable }) })
    d.objectIndex.set(id, d.inputs.length - 1)
    return { _tag: "Input", value: d.inputs.length - 1 }
  })

/** An already-resolved object input (offline builds, sponsored flows). */
export const objectArg = (arg: T.ObjectArg) =>
  Effect.map(Effect.service(PtbBuilder), (d): T.Argument => {
    d.inputs.push({ _tag: "Object", value: arg })
    return { _tag: "Input", value: d.inputs.length - 1 }
  })

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

export const moveCall = (call: {
  readonly target: `${string}::${string}::${string}`
  readonly typeArguments?: ReadonlyArray<string>
  readonly arguments?: ReadonlyArray<T.Argument>
}) => {
  const [pkg, module, fn] = call.target.split("::") as [string, string, string]
  return addCommand({
    _tag: "MoveCall",
    package: T.address(pkg),
    module,
    function: fn,
    typeArguments: (call.typeArguments ?? []).map(T.parseTypeTag),
    arguments: call.arguments ?? []
  })
}

export const splitCoins = (coin: T.Argument, amounts: ReadonlyArray<T.Argument>) =>
  Effect.map(addCommand({ _tag: "SplitCoins", coin, amounts }), (r) => amounts.map((_, i) => nested(r, i)))

export const mergeCoins = (destination: T.Argument, sources: ReadonlyArray<T.Argument>) =>
  addCommand({ _tag: "MergeCoins", destination, sources })

export const transferObjects = (objects: ReadonlyArray<T.Argument>, address: T.Argument) =>
  addCommand({ _tag: "TransferObjects", objects, address })

export const makeMoveVec = (elements: ReadonlyArray<T.Argument>, type?: string) =>
  addCommand({
    _tag: "MakeMoveVec",
    type: type === undefined ? { _tag: "None" } as any : { _tag: "Some", value: T.parseTypeTag(type) },
    elements
  })

// -----------------------------------------------------------------------------
// Building
// -----------------------------------------------------------------------------

/**
 * Run a recipe against a fresh builder. Whatever else the recipe needs (`R`)
 * is still required; `PtbBuilder` is not.
 */
export const build = <A, E, R>(
  recipe: Effect.Effect<A, E, R>
): Effect.Effect<{ readonly value: A; readonly draft: Draft }, E, Exclude<R, PtbBuilder>> =>
  Effect.suspend(() => {
    const d: MutableDraft = { inputs: [], commands: [], objectIndex: new Map() }
    return recipe.pipe(
      Effect.map((value) => ({ value, draft: { inputs: d.inputs, commands: d.commands } })),
      Effect.provideService(PtbBuilder, d)
    )
  })

/** A draft with no unresolved inputs is already a `ProgrammableTransaction`. */
export const toProgrammable = (draft: Draft): T.ProgrammableTransaction | undefined =>
  draft.inputs.every((i) => i._tag !== "UnresolvedObject")
    ? { inputs: draft.inputs as ReadonlyArray<T.CallArg>, commands: draft.commands }
    : undefined
