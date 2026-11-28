/**
 * An in-memory Sui node for tests: every capability service (Chain, Objects,
 * Coins, Packages, Transactions, Checkpoints, DynamicFields, Events,
 * CheckpointData) over state the test seeds, with a log of what was asked.
 *
 *   const layer = Testing.layer({ objects: [{ objectId, type, contents }] })
 *   const node = yield* Testing.Node          // seed and inspect mid-test
 *   yield* node.setAddressBalance({ owner, amount: 1_000_000_000n })
 *   const effects = yield* Tx.run(recipe, { signer, include: ["events"] })
 *   expect(yield* node.requests).toContainEqual({ method: "Objects.get", args: [id1, id2] })
 *
 * What it models, and what it doesn't:
 *
 * - `Objects.get` is batched as the transports batch it (concurrent gets, up
 *   to 50 a batch, one log entry per batch). `DynamicFields.get` / `getObject`
 *   read through the same batches. The batch window is one scheduler yield,
 *   not a timer, so it works under `TestClock`.
 * - Transactions are not executed. Simulating or executing one asks the
 *   responder (`respond`), which answers the outcome (status, gas, changed
 *   objects, events, balance changes, return values; default: success, no gas,
 *   nothing changed). State changes only through the `Node` handle, which a
 *   responder may call. Signatures are not checked.
 * - Each executed transaction (and each `putTransaction`) lands in a
 *   checkpoint of its own, at the current clock, so `Transactions.get` /
 *   `waitFor`, `Events`, `Checkpoints` and `CheckpointData` see it.
 * - `Transactions.resolve` is not provided, so `Tx.build` / `Tx.run` resolve
 *   client-side: object inputs from `Objects`, Move signatures from
 *   `putPackage({ functions })`, gas from `Coins` (fund the sender first).
 * - Unsupported or unseeded things fail typed: an unseeded Move function is
 *   `RpcError` `NOT_FOUND`, a `StreamHead` event filter `UNIMPLEMENTED`,
 *   transaction bytes that don't decode `INVALID_ARGUMENT`.
 *
 * Not in the `@unconfirmed/effect-sui` barrel: import `@unconfirmed/effect-sui/Testing`.
 */
import { base58 } from "@scure/base"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as EffectRequest from "effect/Request"
import * as RequestResolver from "effect/RequestResolver"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as Address from "./Address.ts"
import { Chain } from "./Chain.ts"
import { type Checkpoint, CheckpointData, CheckpointNotFound, type CheckpointTransaction } from "./CheckpointData.ts"
import { type CheckpointSummary, Checkpoints } from "./Checkpoints.ts"
import { type Balance, Coins, fromObjects } from "./Coins.ts"
import * as DynamicFields from "./DynamicFields.ts"
import { type Event, type EventFilter, Events, type Literal, toDnf, type TransactionEvent } from "./Events.ts"
import { blake2b256, transactionDigest } from "./Hash.ts"
import { ObjectNotFound, Objects, type Owner, type SuiObject } from "./Objects.ts"
import { type MoveFunction, PackageNotFound, Packages } from "./Packages.ts"
import { RpcError } from "./RpcError.ts"
import * as T from "./TransactionData.ts"
import {
  type BalanceChange,
  type ChangedObject,
  type Effects,
  type GasUsed,
  type Include,
  type Status,
  TransactionNotFound,
  Transactions
} from "./Transactions.ts"
import * as TypeTag from "./TypeTag.ts"

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

/** An object to put on the node. Ids and types are normalized as a node reports them. */
export interface ObjectInput {
  readonly objectId: string
  readonly type: string
  /** The Move struct's BCS bytes, e.g. `Bcs.encodeSync(Counter)(value)`. Default empty. */
  readonly contents?: Uint8Array
  /** Default shared, initial version 1. */
  readonly owner?: Owner
  /** Default 1, or one more than the version it replaces. */
  readonly version?: bigint
  /** Default derived from the id and version. */
  readonly digest?: string
  readonly previousTransaction?: string | undefined
}

/** A `0x2::dynamic_field::Field<N, V>` under `parent`, at the id `DynamicFields.deriveId` gives. */
export interface DynamicFieldInput {
  readonly parent: string
  readonly name: DynamicFields.Name
  readonly valueType: string
  /** The value's BCS bytes. */
  readonly value: Uint8Array
}

/** A dynamic object field: the `Field<Wrapper<N>, ID>` and its child object, which the field owns. */
export interface DynamicObjectFieldInput {
  readonly parent: string
  readonly name: DynamicFields.Name
  readonly object: Omit<ObjectInput, "owner">
}

/** A `0x2::coin::Coin<T>` owned by `owner`. */
export interface CoinInput {
  readonly owner: string
  readonly balance: bigint
  /** Default SUI. */
  readonly coinType?: string
  /** Default a fresh id. */
  readonly objectId?: string
  readonly version?: bigint
  readonly digest?: string
}

export interface AddressBalanceInput {
  readonly owner: string
  readonly amount: bigint
  /** Default SUI. */
  readonly coinType?: string
}

export interface PackageInput {
  readonly packageId: string
  /** Module name -> compiled bytes, for `Packages.getModules`. */
  readonly modules?: Readonly<Record<string, Uint8Array>>
  /** `"module::function"` -> signature, for `Packages.getFunction` (what client-side resolution reads for object arguments). */
  readonly functions?: Readonly<Record<string, MoveFunction>>
}

export interface ChainInput {
  readonly chainId?: string
  /** Default `"localnet"`. */
  readonly chain?: string
  /** Default 0. */
  readonly epoch?: bigint
  /** Default 1000. */
  readonly referenceGasPrice?: bigint
}

/** An event a transaction emits. `sender` defaults to the transaction's; `packageId` and `module` to the event type's. */
export interface EventInput {
  readonly type: string
  readonly contents: Uint8Array
  readonly sender?: string
  readonly packageId?: string
  readonly module?: string
}

/** What a transaction did, as the responder scripts it. Everything defaults to nothing: success, no gas. */
export interface Outcome {
  readonly status?: Status
  readonly gasUsed?: GasUsed
  readonly changedObjects?: ReadonlyArray<ChangedObject>
  readonly events?: ReadonlyArray<EventInput>
  readonly balanceChanges?: ReadonlyArray<BalanceChange>
  /** Each command's return values (simulation only). */
  readonly returnValues?: ReadonlyArray<ReadonlyArray<Uint8Array>>
}

/** A transaction that landed without going through `execute` (sent elsewhere): for `Transactions.get` and `Events`. */
export interface TransactionInput extends Outcome {
  /** Default a fresh digest. */
  readonly digest?: string
  /** The events' default sender. Default `0x0`. */
  readonly sender?: string
}

/** A transaction the node was asked to simulate (each `Resolve.budget` dry run too) or execute. */
export interface Submission {
  readonly mode: "simulate" | "execute"
  readonly data: T.TransactionData
  readonly bytes: Uint8Array
  readonly digest: string
  /** Empty for a simulation. */
  readonly signatures: ReadonlyArray<Uint8Array>
}

/** Scripts transaction outcomes. An `RpcError` fails the simulate / execute call itself. */
export type Responder = (submission: Submission) => Outcome | Effect.Effect<Outcome, RpcError>

export interface Seed {
  readonly objects?: ReadonlyArray<ObjectInput>
  readonly dynamicFields?: ReadonlyArray<DynamicFieldInput | DynamicObjectFieldInput>
  readonly coins?: ReadonlyArray<CoinInput>
  readonly addressBalances?: ReadonlyArray<AddressBalanceInput>
  readonly packages?: ReadonlyArray<PackageInput>
  /** Landed in order, one checkpoint each, after genesis (checkpoint 0). */
  readonly transactions?: ReadonlyArray<TransactionInput>
  /** The `0x6` clock and the timestamp of new checkpoints, in ms. Default 0. */
  readonly clockMs?: bigint
  readonly chain?: ChainInput
  readonly respond?: Responder
}

export type Method =
  | "Chain.info"
  | "Chain.referenceGasPrice"
  | "Objects.get"
  | "Objects.listOwned"
  | "Coins.getBalance"
  | "Coins.listBalances"
  | "Coins.list"
  | "Packages.getFunction"
  | "Packages.getModules"
  | "Transactions.simulate"
  | "Transactions.execute"
  | "Transactions.get"
  | "DynamicFields.get"
  | "DynamicFields.getObject"
  | "DynamicFields.list"
  | "Events.list"
  | "Events.subscribe"
  | "Checkpoints.list"
  | "Checkpoints.subscribe"
  | "CheckpointData.get"
  | "CheckpointData.list"
  | "CheckpointData.subscribe"

/**
 * One request the node answered, with the call's arguments as given (decode
 * transaction bytes with `TransactionData.decode`). `Objects.get` is the one
 * exception: an entry per batch, whose arguments are the ids its gets asked
 * for, in order, repeats included (a transport sends each id once).
 */
export interface Request {
  readonly method: Method
  readonly args: ReadonlyArray<unknown>
}

/** The handle on the node: seed and change its state mid-test, and read the request log. */
export class Node extends /* @__PURE__ */ Context.Service<Node, {
  /** Put (or replace) an object. */
  readonly putObject: (object: ObjectInput) => Effect.Effect<SuiObject>
  readonly removeObject: (objectId: string) => Effect.Effect<void>
  /** Put a dynamic field (or object field and its child); answers the field object. */
  readonly putDynamicField: (field: DynamicFieldInput | DynamicObjectFieldInput) => Effect.Effect<SuiObject>
  readonly putCoin: (coin: CoinInput) => Effect.Effect<SuiObject>
  readonly setAddressBalance: (balance: AddressBalanceInput) => Effect.Effect<void>
  /** Put a package: its object (type `package`), modules and function signatures. */
  readonly putPackage: (pkg: PackageInput) => Effect.Effect<void>
  /** Land a transaction in a new checkpoint; answers its effects, with everything included. */
  readonly putTransaction: (transaction: TransactionInput) => Effect.Effect<Effects>
  /** Set the `0x6` clock and the timestamp of later checkpoints. */
  readonly setClock: (timestampMs: bigint) => Effect.Effect<void>
  readonly setChain: (chain: ChainInput) => Effect.Effect<void>
  /** Replace the responder. */
  readonly respond: (responder: Responder) => Effect.Effect<void>
  readonly requests: Effect.Effect<ReadonlyArray<Request>>
  readonly clearRequests: Effect.Effect<void>
}>()("@unconfirmed/effect-sui/Testing/Node") {}

/** Every capability service the layer provides. */
export type Services =
  | Chain
  | Objects
  | Coins
  | Packages
  | Transactions
  | Checkpoints
  | DynamicFields.DynamicFields
  | Events
  | CheckpointData

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

const MAX_BATCH = 50
const SUI = TypeTag.SUI
const COIN = "0x2::coin::Coin"
const SHARED: Owner = { _tag: "Shared", initialSharedVersion: 1n }
const NO_GAS: GasUsed = { computationCost: 0n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n }

const encodeAddress = /* @__PURE__ */ Bcs.encodeSync(Bcs.Address)
const encodeClock = /* @__PURE__ */ Bcs.encodeSync(/* @__PURE__ */ Bcs.struct({ id: Bcs.Address, timestamp_ms: Bcs.u64 }))
const decodeCoin = /* @__PURE__ */ Bcs.decode(/* @__PURE__ */ Bcs.struct({ id: Bcs.Address, balance: Bcs.u64 }))
const encodeCoin = /* @__PURE__ */ Bcs.encodeSync(/* @__PURE__ */ Bcs.struct({ id: Bcs.Address, balance: Bcs.u64 }))

/** A stable 32-byte digest of `label`, base58. */
const digestOf = (label: string): string => base58.encode(blake2b256(new TextEncoder().encode(`testing:${label}`)))

/** A type as a node reports it; `package` and other non-types as given. */
const normalizeType = (type: string): string => {
  try {
    return TypeTag.normalizeString(type)
  } catch {
    return type
  }
}

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** `Field<N, V>` -> `[N, V]`, formatted. */
const fieldTypes = (type: string): readonly [string, string] | undefined => {
  try {
    const t = TypeTag.parse(type)
    return t._tag === "struct" && t.typeParams.length === 2
      ? [TypeTag.format(t.typeParams[0]!), TypeTag.format(t.typeParams[1]!)]
      : undefined
  } catch {
    return undefined
  }
}

interface FieldEntry {
  readonly kind: "Field" | "Object"
  readonly parent: Address.Address
  readonly name: DynamicFields.Name
}

interface Landed {
  readonly effects: Effects & {
    readonly events: ReadonlyArray<TransactionEvent>
    readonly balanceChanges: ReadonlyArray<BalanceChange>
  }
}

const view = (stored: Landed["effects"], include: ReadonlyArray<Include> | undefined, landed: boolean): Effects => ({
  digest: stored.digest,
  status: stored.status,
  gasUsed: stored.gasUsed,
  changedObjects: stored.changedObjects,
  ...(landed && stored.checkpoint !== undefined && { checkpoint: stored.checkpoint }),
  ...(landed && stored.timestampMs !== undefined && { timestampMs: stored.timestampMs }),
  ...(include?.includes("events") && { events: stored.events }),
  ...(include?.includes("balanceChanges") && { balanceChanges: stored.balanceChanges })
})

const matches = (l: Literal, e: Event): boolean => {
  const p = l.predicate
  const emitted = `${e.packageId}::${e.module}`
  const hit = p._tag === "Sender"
    ? e.sender === p.address
    : p._tag === "EmitModule"
    ? emitted === p.module || emitted.startsWith(`${p.module}::`)
    : p._tag === "EventType"
    ? TypeTag.matchesPath(p.type, e.type)
    : false
  return l.negated ? !hit : hit
}

/** The filter as a predicate; an `RpcError` for what the in-memory node can't evaluate. */
const eventPredicate = (method: Method, filter: EventFilter | undefined): Result.Result<(e: Event) => boolean, RpcError> => {
  if (filter === undefined) return Result.succeed(() => true)
  const dnf = toDnf(filter)
  if (dnf.some((term) => term.some((l) => l.predicate._tag === "StreamHead"))) {
    return Result.fail(new RpcError({ method, code: "UNIMPLEMENTED", message: "the in-memory node has no authenticated event streams (StreamHead)" }))
  }
  return Result.succeed((e) => dnf.some((term) => term.every((l) => matches(l, e))))
}

class GetObject extends EffectRequest.Class<{ readonly objectId: Address.Address }, SuiObject, ObjectNotFound | RpcError> {}

/**
 * A new in-memory node: every capability service plus its `Node` handle.
 * Starts with the `0x6` clock and a genesis checkpoint (0), whose digest is
 * the chain id, then `seed`. Use `layer` unless one node must outlive a run
 * (`Layer.succeedContext(Effect.runSync(Testing.make()))` shares it).
 */
export const make = (seed: Seed = {}): Effect.Effect<Context.Context<Services | Node>> => Effect.gen(function*() {
  const objects = new Map<Address.Address, SuiObject>()
  const fields = new Map<Address.Address, FieldEntry>()
  const addressBalances = new Map<string, bigint>()
  const packages = new Map<Address.Address, { readonly modules: ReadonlyMap<string, Uint8Array>; readonly functions: ReadonlyMap<string, MoveFunction> }>()
  const transactions = new Map<string, Landed>()
  const checkpoints: Array<Checkpoint> = []
  const requests: Array<Request> = []
  const landedCheckpoints = yield* PubSub.unbounded<Checkpoint>()
  let chain = { chainId: digestOf("genesis"), chain: "localnet", epoch: 0n, referenceGasPrice: 1000n }
  let clock = 0n
  let responder: Responder = () => ({})
  let fresh = 0

  const log = (method: Method, ...args: ReadonlyArray<unknown>) => void requests.push({ method, args })
  const freshId = () => Address.fromBytes(blake2b256(new TextEncoder().encode(`testing:object:${fresh++}`)))

  // --- state -----------------------------------------------------------------

  const putObject = (o: ObjectInput): SuiObject => {
    const objectId = Address.normalize(o.objectId)
    const version = o.version ?? (objects.has(objectId) ? objects.get(objectId)!.version + 1n : 1n)
    const object: SuiObject = {
      objectId,
      version,
      digest: (o.digest ?? digestOf(`${objectId}:${version}`)) as T.ObjectDigest,
      owner: o.owner ?? SHARED,
      type: normalizeType(o.type),
      contents: o.contents ?? new Uint8Array(),
      previousTransaction: o.previousTransaction
    }
    objects.set(objectId, object)
    return object
  }

  const setClock = (ms: bigint) => {
    clock = ms
    putObject({ objectId: Address.CLOCK, type: "0x2::clock::Clock", contents: encodeClock({ id: Address.CLOCK, timestamp_ms: ms }) })
  }

  const putDynamicField = (f: DynamicFieldInput | DynamicObjectFieldInput): SuiObject => {
    const parent = Address.normalize(f.parent)
    const nameType = normalizeType(f.name.type)
    const name = { type: nameType, bcs: f.name.bcs }
    if ("object" in f) {
      const wrapper = DynamicFields.objectFieldNameType(nameType)
      const fieldId = DynamicFields.deriveId(parent, wrapper, name.bcs)
      const child = putObject({ ...f.object, owner: { _tag: "ObjectOwner", address: fieldId } })
      fields.set(fieldId, { kind: "Object", parent, name })
      return putObject({
        objectId: fieldId,
        type: `0x2::dynamic_field::Field<${wrapper}, 0x2::object::ID>`,
        owner: { _tag: "ObjectOwner", address: parent },
        contents: concat(encodeAddress(fieldId), name.bcs, encodeAddress(child.objectId))
      })
    }
    const fieldId = DynamicFields.deriveId(parent, nameType, name.bcs)
    fields.set(fieldId, { kind: "Field", parent, name })
    return putObject({
      objectId: fieldId,
      type: `0x2::dynamic_field::Field<${nameType}, ${f.valueType}>`,
      owner: { _tag: "ObjectOwner", address: parent },
      contents: concat(encodeAddress(fieldId), name.bcs, f.value)
    })
  }

  const putCoin = (c: CoinInput): SuiObject => {
    const objectId = c.objectId === undefined ? freshId() : Address.normalize(c.objectId)
    return putObject({
      objectId,
      type: `${COIN}<${c.coinType ?? SUI}>`,
      owner: { _tag: "AddressOwner", address: Address.normalize(c.owner) },
      contents: encodeCoin({ id: objectId, balance: c.balance }),
      ...(c.version !== undefined && { version: c.version }),
      ...(c.digest !== undefined && { digest: c.digest })
    })
  }

  const balanceKey = (owner: Address.Address, coinType: string) => `${owner}|${coinType}`
  const setAddressBalance = (b: AddressBalanceInput) =>
    void addressBalances.set(balanceKey(Address.normalize(b.owner), TypeTag.normalizeString(b.coinType ?? SUI)), b.amount)

  const putPackage = (p: PackageInput) => {
    const packageId = Address.normalize(p.packageId)
    putObject({ objectId: packageId, type: "package", owner: { _tag: "Immutable" } })
    packages.set(packageId, {
      modules: new Map(Object.entries(p.modules ?? {})),
      functions: new Map(Object.entries(p.functions ?? {}).map(([k, f]) => [`${packageId}::${k}`, f] as const))
    })
  }

  const setChain = (c: ChainInput) => void (chain = { ...chain, ...c })

  /** Land a transaction in a checkpoint of its own; a digest that already landed answers what it did. */
  const land = (digest: string, sender: Address.Address, o: Outcome): Landed["effects"] => {
    const existing = transactions.get(digest)
    if (existing) return existing.effects
    const sequenceNumber = BigInt(checkpoints.length)
    const events: Array<TransactionEvent> = (o.events ?? []).map((e, eventIndex) => {
      const type = normalizeType(e.type)
      const tag = Result.try(() => TypeTag.parse(type))
      const struct = Result.isSuccess(tag) && tag.success._tag === "struct" ? tag.success : undefined
      return {
        type,
        sender: e.sender === undefined ? sender : Address.normalize(e.sender),
        packageId: e.packageId !== undefined ? Address.normalize(e.packageId) : struct?.address ?? Address.ZERO,
        module: e.module ?? struct?.module ?? "",
        contents: e.contents,
        transactionDigest: digest,
        eventIndex
      }
    })
    const effects: Landed["effects"] = {
      digest,
      status: o.status ?? { _tag: "Success" },
      gasUsed: o.gasUsed ?? NO_GAS,
      changedObjects: o.changedObjects ?? [],
      checkpoint: sequenceNumber,
      timestampMs: clock,
      events,
      balanceChanges: o.balanceChanges ?? []
    }
    const transaction: CheckpointTransaction = {
      digest,
      index: 0n,
      status: effects.status,
      gasUsed: effects.gasUsed,
      changedObjects: effects.changedObjects,
      events: events.map((e) => ({ ...e, checkpoint: sequenceNumber, transactionIndex: 0n }))
    }
    const checkpoint = { sequenceNumber, digest: digestOf(`checkpoint:${sequenceNumber}`), epoch: chain.epoch, timestampMs: clock, transactions: [transaction] }
    checkpoints.push(checkpoint)
    transactions.set(digest, { effects })
    PubSub.publishUnsafe(landedCheckpoints, checkpoint)
    return effects
  }

  const putTransaction = (t: TransactionInput) =>
    land(t.digest ?? digestOf(`transaction:${checkpoints.length}`), t.sender === undefined ? Address.ZERO : Address.normalize(t.sender), t)

  // --- seed ------------------------------------------------------------------

  if (seed.chain) setChain(seed.chain)
  setClock(seed.clockMs ?? 0n)
  checkpoints.push({ sequenceNumber: 0n, digest: chain.chainId, epoch: chain.epoch, timestampMs: clock, transactions: [] })
  for (const p of seed.packages ?? []) putPackage(p)
  for (const o of seed.objects ?? []) putObject(o)
  for (const f of seed.dynamicFields ?? []) putDynamicField(f)
  for (const c of seed.coins ?? []) putCoin(c)
  for (const b of seed.addressBalances ?? []) setAddressBalance(b)
  for (const t of seed.transactions ?? []) putTransaction(t)
  if (seed.respond) responder = seed.respond

  // --- services --------------------------------------------------------------

  const resolver = RequestResolver.make<GetObject>((entries) =>
    Effect.sync(() => {
      log("Objects.get", ...entries.map((e) => e.request.objectId))
      for (const entry of entries) {
        const o = objects.get(entry.request.objectId)
        entry.completeUnsafe(o ? Exit.succeed(o) : Exit.fail(new ObjectNotFound({ objectId: entry.request.objectId })))
      }
    })
  ).pipe(RequestResolver.batchN(MAX_BATCH))
  const getObject = (objectId: Address.Address) => Effect.request(new GetObject({ objectId }), resolver)

  const owned = (owner: Address.Address, type: string | undefined) =>
    [...objects.values()].filter((o) =>
      (o.owner._tag === "AddressOwner" || o.owner._tag === "ConsensusAddressOwner") && o.owner.address === owner &&
      (type === undefined || TypeTag.matchesPath(type, o.type))
    )

  const objectsService = Objects.of({
    get: getObject,
    listOwned: (owner, options) =>
      Stream.suspend(() => {
        log("Objects.listOwned", owner, options)
        return Stream.fromIterable(owned(owner, options?.type))
      })
  })

  const coinType = (method: Method, type: string) =>
    Effect.try({
      try: () => TypeTag.normalizeString(type),
      catch: (e) => new RpcError({ method, code: "INVALID_ARGUMENT", message: `invalid coin type ${type}: ${e instanceof Error ? e.message : String(e)}` })
    })
  const balanceOf = (owner: Address.Address, type: string): Effect.Effect<Balance, RpcError> => {
    let coinBalance = 0n
    for (const o of owned(owner, `${COIN}<${type}>`)) {
      const c = decodeCoin(o.contents)
      if (Result.isFailure(c)) {
        return Effect.fail(new RpcError({ method: "Coins.getBalance", code: "DATA_LOSS", message: `malformed coin ${o.objectId}` }))
      }
      coinBalance += c.success.balance
    }
    const addressBalance = addressBalances.get(balanceKey(owner, type)) ?? 0n
    return Effect.succeed({ coinType: type, total: addressBalance + coinBalance, addressBalance, coinBalance })
  }

  const coinsService = Coins.of({
    getBalance: (owner, type = SUI) =>
      Effect.suspend(() => {
        log("Coins.getBalance", owner, type)
        return Effect.flatMap(coinType("Coins.getBalance", type), (t) => balanceOf(owner, t))
      }),
    listBalances: (owner) =>
      Stream.suspend(() => {
        log("Coins.listBalances", owner)
        const types = new Set<string>()
        for (const key of addressBalances.keys()) if (key.startsWith(`${owner}|`)) types.add(key.slice(owner.length + 1))
        for (const o of owned(owner, COIN)) {
          const t = Result.try(() => TypeTag.parse(o.type))
          if (Result.isSuccess(t) && t.success._tag === "struct" && t.success.typeParams[0]) types.add(TypeTag.format(t.success.typeParams[0]))
        }
        return Stream.fromIterable([...types].sort()).pipe(Stream.mapEffect((t) => balanceOf(owner, t)))
      }),
    list: (owner, type) =>
      Stream.suspend(() => {
        log("Coins.list", owner, type)
        return fromObjects("Coins.list", type, (t) => Stream.suspend(() => Stream.fromIterable(owned(owner, t))))
      })
  })

  const chainService = Chain.of({
    info: Effect.sync(() => {
      log("Chain.info")
      return {
        chainId: chain.chainId as T.ObjectDigest,
        chain: chain.chain,
        epoch: chain.epoch,
        checkpointHeight: BigInt(checkpoints.length - 1)
      }
    }),
    referenceGasPrice: Effect.sync(() => {
      log("Chain.referenceGasPrice")
      return chain.referenceGasPrice
    })
  })

  const packagesService = Packages.of({
    getFunction: (target) =>
      Effect.suspend(() => {
        log("Packages.getFunction", target)
        const key = `${Address.normalize(target.package)}::${target.module}::${target.function}`
        const f = packages.get(Address.normalize(target.package))?.functions.get(key)
        return f
          ? Effect.succeed(f)
          : Effect.fail(new RpcError({
            method: "Packages.getFunction",
            code: "NOT_FOUND",
            message: `no function ${key} on the in-memory node (seed it with putPackage({ functions }))`
          }))
      }),
    getModules: (packageId) =>
      Effect.suspend((): Effect.Effect<ReadonlyMap<string, Uint8Array>, PackageNotFound | RpcError> => {
        log("Packages.getModules", packageId)
        const p = packages.get(packageId)
        if (p) return Effect.succeed(p.modules)
        return objects.has(packageId)
          ? Effect.fail(new RpcError({ method: "Packages.getModules", code: "INVALID_ARGUMENT", message: `${packageId} is not a package` }))
          : Effect.fail(new PackageNotFound({ packageId }))
      })
  })

  const submission = (method: Method, mode: Submission["mode"], bytes: Uint8Array, signatures: ReadonlyArray<Uint8Array>) =>
    Effect.flatMap(
      Result.match(T.decode(bytes), {
        onFailure: (e) => Effect.fail(new RpcError({ method, code: "INVALID_ARGUMENT", message: `not TransactionData: ${e.message}` })),
        onSuccess: (data) => Effect.succeed<Submission>({ mode, data, bytes, digest: transactionDigest(bytes), signatures })
      }),
      (s) =>
        Effect.map(
          Effect.suspend(() => {
            const out = responder(s)
            return Effect.isEffect(out) ? out : Effect.succeed(out)
          }),
          (outcome) => [s, outcome] as const
        )
    )

  const transactionsService = Transactions.of({
    simulate: (bytes, options) =>
      Effect.suspend(() => {
        log("Transactions.simulate", bytes, options)
        return Effect.map(submission("Transactions.simulate", "simulate", bytes, []), ([s, o]) => ({
          effects: {
            digest: s.digest,
            status: o.status ?? { _tag: "Success" },
            gasUsed: o.gasUsed ?? NO_GAS,
            changedObjects: o.changedObjects ?? []
          },
          returnValues: o.returnValues ?? []
        }))
      }),
    execute: (bytes, signatures, options) =>
      Effect.suspend(() => {
        log("Transactions.execute", bytes, signatures, options)
        const done = transactions.get(transactionDigest(bytes))
        if (done) return Effect.succeed(view(done.effects, options?.include, false))
        return Effect.map(
          submission("Transactions.execute", "execute", bytes, signatures),
          ([s, o]) => view(land(s.digest, s.data.sender, o), options?.include, false)
        )
      }),
    get: (digest, options) =>
      Effect.suspend(() => {
        log("Transactions.get", digest, options)
        const t = transactions.get(digest)
        return t ? Effect.succeed(view(t.effects, options?.include, true)) : Effect.fail(new TransactionNotFound({ digest }))
      })
  })

  const readField = (parent: Address.Address, type: string, name: DynamicFields.Name) =>
    Effect.flatMap(
      Effect.try({
        try: () => DynamicFields.deriveId(parent, type, name.bcs),
        catch: (e) => new DynamicFields.InvalidDynamicFieldName({ nameType: type, issue: e instanceof Error ? e.message : String(e) })
      }),
      (fieldId) =>
        getObject(fieldId).pipe(
          Effect.catchTag("ObjectNotFound", () => Effect.fail(new DynamicFields.DynamicFieldNotFound({ parent, nameType: name.type, fieldId }))),
          Effect.map((field): DynamicFields.DynamicField => ({
            parent,
            fieldId,
            name,
            valueType: fieldTypes(field.type)?.[1] ?? field.type,
            value: field.contents.subarray(32 + name.bcs.length),
            field
          }))
        )
    )

  const dynamicFieldsService = DynamicFields.DynamicFields.of({
    get: (parent, name) =>
      Effect.suspend(() => {
        log("DynamicFields.get", parent, name)
        return readField(parent, name.type, name)
      }),
    getObject: (parent, name) =>
      Effect.suspend(() => {
        log("DynamicFields.getObject", parent, name)
        return Effect.flatMap(readField(parent, DynamicFields.objectFieldNameType(name.type), name), (f) =>
          getObject(Address.fromBytes(f.value.subarray(0, 32))).pipe(
            Effect.catchTag("ObjectNotFound", () =>
              Effect.fail(new DynamicFields.DynamicFieldNotFound({ parent, nameType: name.type, fieldId: f.fieldId })))
          ))
      }),
    list: (parent, options) =>
      Stream.suspend(() => {
        log("DynamicFields.list", parent, options)
        const out: Array<DynamicFields.FieldInfo> = []
        for (const [fieldId, entry] of fields) {
          const field = objects.get(fieldId)
          if (entry.parent !== parent || field === undefined) continue
          if (options?.nameType !== undefined && !TypeTag.matchesPath(options.nameType, entry.name.type)) continue
          const value = field.contents.subarray(32 + entry.name.bcs.length)
          const childId = entry.kind === "Object" ? Address.fromBytes(value.subarray(0, 32)) : undefined
          out.push({
            kind: entry.kind,
            parent,
            fieldId,
            name: entry.name,
            valueType: childId !== undefined ? objects.get(childId)?.type ?? "" : fieldTypes(field.type)?.[1] ?? "",
            value,
            childId
          })
        }
        return Stream.fromIterable(out)
      })
  })

  const range = <A>(start: bigint | undefined, end: bigint | undefined, f: (c: Checkpoint) => Iterable<A>) =>
    checkpoints.filter((c) => (start === undefined || c.sequenceNumber >= start) && (end === undefined || c.sequenceNumber < end)).flatMap(
      (c) => [...f(c)]
    )
  const allEvents = (c: Checkpoint) => c.transactions.flatMap((t) => t.events)
  const summary = (c: Checkpoint): CheckpointSummary => ({ sequenceNumber: c.sequenceNumber, digest: c.digest })
  const live = Stream.fromPubSub(landedCheckpoints)

  const eventsService = Events.of({
    list: (options) =>
      Stream.suspend(() => {
        log("Events.list", options)
        return Result.match(eventPredicate("Events.list", options?.filter), {
          onFailure: Stream.fail,
          onSuccess: (keep) => {
            const events = range(options?.start, options?.end, allEvents).filter(keep)
            return Stream.fromIterable(options?.descending ? events.reverse() : events)
          }
        })
      }),
    subscribe: (filter) =>
      Stream.suspend(() => {
        log("Events.subscribe", filter)
        return Result.match(eventPredicate("Events.subscribe", filter), {
          onFailure: Stream.fail,
          onSuccess: (keep) => live.pipe(Stream.flatMap((c) => Stream.fromIterable(allEvents(c).filter(keep))))
        })
      })
  })

  const checkpointsService = Checkpoints.of({
    list: (options) =>
      Stream.suspend(() => {
        log("Checkpoints.list", options)
        return Stream.fromIterable(range(options?.start, options?.end, (c) => [summary(c)]))
      }),
    subscribe: Stream.suspend(() => {
      log("Checkpoints.subscribe")
      return Stream.map(live, summary)
    })
  })

  const checkpointDataService = CheckpointData.of({
    get: (sequenceNumber) =>
      Effect.suspend(() => {
        log("CheckpointData.get", sequenceNumber)
        const c = checkpoints[Number(sequenceNumber)]
        return c ? Effect.succeed(c) : Effect.fail(new CheckpointNotFound({ sequenceNumber }))
      }),
    list: (options) =>
      Stream.suspend(() => {
        log("CheckpointData.list", options)
        return Stream.fromIterable(range(options?.start, options?.end, (c) => [c]))
      }),
    subscribe: Stream.suspend(() => {
      log("CheckpointData.subscribe")
      return live
    })
  })

  const node = Node.of({
    putObject: (o) => Effect.sync(() => putObject(o)),
    removeObject: (objectId) => Effect.sync(() => void objects.delete(Address.normalize(objectId))),
    putDynamicField: (f) => Effect.sync(() => putDynamicField(f)),
    putCoin: (c) => Effect.sync(() => putCoin(c)),
    setAddressBalance: (b) => Effect.sync(() => setAddressBalance(b)),
    putPackage: (p) => Effect.sync(() => putPackage(p)),
    putTransaction: (t) => Effect.sync(() => putTransaction(t)),
    setClock: (ms) => Effect.sync(() => setClock(ms)),
    setChain: (c) => Effect.sync(() => setChain(c)),
    respond: (r) => Effect.sync(() => void (responder = r)),
    requests: Effect.sync(() => [...requests]),
    clearRequests: Effect.sync(() => void (requests.length = 0))
  })

  return Context.make(Objects, objectsService).pipe(
    Context.add(Coins, coinsService),
    Context.add(Chain, chainService),
    Context.add(Packages, packagesService),
    Context.add(Transactions, transactionsService),
    Context.add(DynamicFields.DynamicFields, dynamicFieldsService),
    Context.add(Events, eventsService),
    Context.add(Checkpoints, checkpointsService),
    Context.add(CheckpointData, checkpointDataService),
    Context.add(Node, node)
  )
})

/** A fresh in-memory node for each use of the layer (see `make`). */
export const layer = (seed: Seed = {}): Layer.Layer<Services | Node> => Layer.effectContext(make(seed))
