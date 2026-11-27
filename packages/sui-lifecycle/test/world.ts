/**
 * A scripted chain: per-test stubs of the core `Transactions`, `Objects` and
 * `Chain` services, provided as Layers. `execute` follows a script of
 * behaviours; what landed is remembered, so identical bytes land at most once.
 */
import * as Address from "@unconfirmed/sui/Address"
import { Chain } from "@unconfirmed/sui/Chain"
import { Coins } from "@unconfirmed/sui/Coins"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as Hash from "@unconfirmed/sui/Hash"
import { ObjectNotFound, Objects, type SuiObject } from "@unconfirmed/sui/Objects"
import { Packages } from "@unconfirmed/sui/Packages"
import { RpcError } from "@unconfirmed/sui/RpcError"
import type * as T from "@unconfirmed/sui/TransactionData"
import { type Effects, TransactionNotFound, Transactions } from "@unconfirmed/sui/Transactions"
import { Effect, Layer, Option, Stream } from "effect"
import * as Evidence from "../src/Evidence.ts"
import * as Lifecycle from "../src/Lifecycle.ts"

/**
 * An `Evidence` backend over the world: its epoch, whether the digest landed,
 * and history from `lowest` (default 0: full history) and `first` (where the
 * window's epoch starts).
 */
export const evidence = (
  world: World,
  history: { readonly lowest?: Option.Option<bigint>; readonly first?: Option.Option<bigint> } = {}
) =>
  Evidence.layer({
    observe: (digest, fromEpoch) =>
      Effect.gen(function*() {
        const gap = yield* Evidence.historyGap(
          history.lowest ?? Option.some(0n),
          fromEpoch,
          () => Effect.succeed(history.first ?? Option.none())
        )
        return Option.some({ epoch: world.evidenceEpoch ?? world.epoch, found: world.landed.has(digest), gap })
      })
  })

export const digestOf = (seed: string): T.ObjectDigest => Hash.transactionDigest(new TextEncoder().encode(seed)) as T.ObjectDigest
export const CHAIN_ID = digestOf("chain")
export const COIN = Address.normalize("0xc0")
export const OBJ = Address.normalize("0xab")

export type Behaviour =
  | "land" // executes and answers
  | "abort" // executes with a Move abort and answers
  | "failBefore" // UNAVAILABLE, nothing executed
  | "failAfter" // executes, then UNAVAILABLE
  | "refuse" // INVALID_ARGUMENT
  | "lockConflict" // FAILED_PRECONDITION, a lock held by another transaction
  | "hangAfter" // executes, then never answers
  | "hang" // never answers, nothing executed
  | "lockConflictInvalid" // INVALID_ARGUMENT carrying a lock-conflict message

export interface World {
  epoch: bigint
  chainId: string
  /** The sender's SUI address balance (gas is paid from it unless a test pins coins). */
  addressBalance: bigint
  script: Array<Behaviour>
  executeCalls: number
  getCalls: number
  /** `get` answers NOT_FOUND for this many calls even when landed. */
  hideFor: number
  landed: Map<string, Effects>
  aborted: Set<string>
  objects: Map<string, SuiObject>
  /** The digest of every execute call, in order. */
  sent: Array<string>
  /** Delay inside each execute, to observe overlap. */
  executeDelay: number
  inFlight: number
  maxInFlight: number
  /** A build (simulate) ran while an execute was in flight. */
  builtDuringExecute: boolean
  /** Runs before every `get` (e.g. another process writing the journal). */
  onGet: (digest: string) => Effect.Effect<void>
  /** What the `Evidence` backend (see `evidence`) sees: its epoch (default: `epoch`). */
  evidenceEpoch: bigint | undefined
  objectsInFlight: number
  objectsMaxInFlight: number
}

export const makeWorld = (overrides: Partial<World> = {}): World => ({
  epoch: 10n,
  addressBalance: 1_000_000_000_000n,
  chainId: CHAIN_ID,
  script: [],
  executeCalls: 0,
  getCalls: 0,
  hideFor: 0,
  landed: new Map(),
  aborted: new Set(),
  objects: new Map(),
  sent: [],
  executeDelay: 0,
  inFlight: 0,
  maxInFlight: 0,
  builtDuringExecute: false,
  onGet: () => Effect.void,
  evidenceEpoch: undefined,
  objectsInFlight: 0,
  objectsMaxInFlight: 0,
  ...overrides
})

export const effectsOf = (digest: string, abort: boolean, changedObjects: Effects["changedObjects"] = []): Effects => ({
  digest,
  status: abort
    ? { _tag: "Failure", description: "MoveAbort(...) in command 0", command: 0, abortCode: 7n }
    : { _tag: "Success" },
  gasUsed: { computationCost: 1000n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n },
  changedObjects
})

/** A transaction by someone else that consumed `objectId` at `inputVersion`. */
export const consumer = (world: World, digest: string, objectId: Address.Address, inputVersion: bigint) =>
  world.landed.set(
    digest,
    effectsOf(digest, false, [{
      objectId,
      type: undefined,
      operation: "None",
      version: inputVersion + 100n,
      digest: undefined,
      owner: undefined,
      inputVersion,
      inputDigest: undefined,
      inputOwner: undefined
    }])
  )

const unavailable = (method: string) => new RpcError({ method, code: "UNAVAILABLE", message: "connection reset" })

export const land = (world: World, digest: string, abort = false): Effects => {
  const existing = world.landed.get(digest)
  if (existing) return existing
  const effects = effectsOf(digest, abort)
  world.landed.set(digest, effects)
  return effects
}

export const layer = (world: World) =>
  Layer.mergeAll(
    Layer.succeed(Transactions, {
      simulate: (bytes) =>
        Effect.sync(() => {
          if (world.inFlight > 0) world.builtDuringExecute = true
          return { effects: effectsOf(Hash.transactionDigest(bytes), false), returnValues: [] }
        }),
      execute: (bytes) =>
        Effect.suspend(() => {
          world.executeCalls++
          world.inFlight++
          world.maxInFlight = Math.max(world.maxInFlight, world.inFlight)
          return Effect.sleep(world.executeDelay)
        }).pipe(
          Effect.andThen(Effect.suspend(() => {
          const digest = Hash.transactionDigest(bytes)
          world.sent.push(digest)
          const behaviour = world.script.shift() ?? "land"
          switch (behaviour) {
            case "land":
              return Effect.succeed(land(world, digest))
            case "abort":
              return Effect.succeed(land(world, digest, true))
            case "failBefore":
              return Effect.fail(unavailable("ExecuteTransaction"))
            case "failAfter":
              land(world, digest)
              return Effect.fail(unavailable("ExecuteTransaction"))
            case "refuse":
              return Effect.fail(
                new RpcError({ method: "ExecuteTransaction", code: "INVALID_ARGUMENT", message: "invalid signature" })
              )
            case "lockConflict":
              return Effect.fail(
                new RpcError({
                  method: "ExecuteTransaction",
                  code: "FAILED_PRECONDITION",
                  message: "Transaction is rejected as invalid by more than 1/3 of validators by stake (non-retriable)"
                })
              )
            case "lockConflictInvalid":
              return Effect.fail(
                new RpcError({
                  method: "ExecuteTransaction",
                  code: "INVALID_ARGUMENT",
                  message: "Object (0xab, 5) already locked by a different transaction"
                })
              )
            case "hangAfter":
              land(world, digest)
              return Effect.never
            case "hang":
              return Effect.never
          }
        })),
          Effect.ensuring(Effect.sync(() => void world.inFlight--))
        ),
      get: (digest) =>
        Effect.andThen(world.onGet(digest), () => {
          world.getCalls++
          const found = world.landed.get(digest)
          if (world.hideFor > 0) {
            world.hideFor--
            return Effect.fail(new TransactionNotFound({ digest }))
          }
          return found ? Effect.succeed(found) : Effect.fail(new TransactionNotFound({ digest }))
        })
    }),
    Layer.succeed(Objects, {
      get: (objectId) =>
        Effect.suspend(() => {
          world.objectsInFlight++
          world.objectsMaxInFlight = Math.max(world.objectsMaxInFlight, world.objectsInFlight)
          return Effect.sleep(1)
        }).pipe(
          Effect.andThen(Effect.suspend(() => {
            const o = world.objects.get(objectId)
            return o ? Effect.succeed(o) : Effect.fail(new ObjectNotFound({ objectId }))
          })),
          Effect.ensuring(Effect.sync(() => void world.objectsInFlight--))
        ),
      listOwned: () => Stream.empty
    }),
    Layer.succeed(Chain, {
      info: Effect.sync(() => ({
        chainId: world.chainId as T.ObjectDigest,
        chain: "stub",
        epoch: world.epoch,
        checkpointHeight: 1000n
      })),
      referenceGasPrice: Effect.succeed(1000n)
    }),
    Layer.succeed(Packages, { getFunction: () => Effect.die("no packages in the stub") }),
    Layer.succeed(Coins, {
      getBalance: (_owner, coinType = "0x2::sui::SUI") =>
        Effect.sync(() => ({ coinType, total: world.addressBalance, addressBalance: world.addressBalance, coinBalance: 0n })),
      list: () => Stream.empty
    })
  )

export const ownedObject = (objectId: Address.Address, version: bigint, previousTransaction?: string): SuiObject => ({
  objectId,
  version,
  digest: digestOf(`${objectId}@${version}`),
  owner: { _tag: "AddressOwner", address: Address.normalize("0x1") },
  type: "0x2::coin::Coin<0x2::sui::SUI>",
  contents: new Uint8Array(),
  previousTransaction
})

/**
 * Signed bytes pinning `OBJ@5` as an owned input and `COIN@3` as gas, valid
 * during epochs `epoch` and `epoch + 1`.
 */
export const signedTx = (
  options: { readonly epoch?: bigint; readonly nonce?: number; readonly pinned?: boolean; readonly receiving?: boolean } = {}
) =>
  Effect.gen(function*() {
    const signer = yield* Ed25519.generate
    const epoch = options.epoch ?? 10n
    const pinned = options.pinned ?? true
    const data: T.TransactionData = {
      _tag: "V1",
      kind: {
        _tag: "ProgrammableTransaction",
        inputs: pinned
          ? [{
            _tag: "Object",
            value: {
              _tag: options.receiving ? "Receiving" : "ImmOrOwnedObject",
              objectId: OBJ,
              version: 5n,
              digest: digestOf(`${OBJ}@5`)
            }
          }]
          : [],
        commands: []
      },
      sender: signer.address,
      gasData: {
        payment: pinned ? [{ objectId: COIN, version: 3n, digest: digestOf(`${COIN}@3`) }] : [],
        owner: signer.address,
        price: 1000n,
        budget: 10_000_000n
      },
      expiration: {
        _tag: "ValidDuring",
        minEpoch: Option.some(epoch),
        maxEpoch: Option.some(epoch + 1n),
        minTimestamp: Option.none(),
        maxTimestamp: Option.none(),
        chain: CHAIN_ID,
        nonce: options.nonce ?? 1
      }
    }
    return yield* Lifecycle.sign(data, signer)
  })
