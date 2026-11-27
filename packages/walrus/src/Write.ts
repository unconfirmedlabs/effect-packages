/**
 * Writing a blob through storage nodes (§4.7): encode, register (a
 * transaction), upload metadata and slivers and collect storage confirmations
 * from `n − f` shards (by weight, T2), aggregate them into a certificate,
 * certify (a transaction).
 *
 *   const certified = yield* Write.run(bytes, { epochs: 1, deletable: true, executor: Write.viaTx(signer) })
 *
 * With `via: "relay"` an upload relay (`UploadRelay`) stores the blob instead:
 * step 1 only computes the id, the register transaction also carries the
 * relay's auth input and tip, and the relay's certificate is verified before
 * it is certified.
 *
 * Each step looks at the chain before it acts, so a write can stop anywhere
 * and continue from its last saved `Step` (or from nothing: registration
 * reuses an owned, uncertified `Blob` for the same blob). Transactions go
 * through an injected `Executor`, so wallets, sponsors and journals
 * (`sui-lifecycle`) all fit without this package depending on them.
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Quorum from "@unconfirmed/quorum/Quorum"
import * as Address from "@unconfirmed/sui/Address"
import * as Objects from "@unconfirmed/sui/Objects"
import * as Ptb from "@unconfirmed/sui/Ptb"
import type * as Signer from "@unconfirmed/sui/Signer"
import type * as Transactions from "@unconfirmed/sui/Transactions"
import * as Tx from "@unconfirmed/sui/Tx"
import * as TypeTag from "@unconfirmed/sui/TypeTag"
import * as Bft from "./Bft.ts"
import * as BlobId from "./BlobId.ts"
import * as Certificate from "./Certificate.ts"
import { type Committee, type CommitteeError, Committees, checkAgainstSystem, type StorageNode as CommitteeNode } from "./Committee.ts"
import { Encoder, type EncodedBlob } from "./Encoder.ts"
import * as Encoding from "./Encoding.ts"
import {
  type BlobTooLarge,
  type CertificateInvalid,
  CertificateStale,
  type CommitteeMismatch,
  type EncoderError,
  NotEnoughConfirmations,
  RegistrationFailed,
  RelayError,
  ResumeMismatch,
  type TipTooHigh
} from "./Errors.ts"
import * as blob from "./generated/walrus/blob.ts"
import * as Messages from "./Messages.ts"
import * as Recipes from "./Recipes.ts"
import { NodeError, retryable, StorageNodes } from "./StorageNode.ts"
import { System, type SystemError, type SystemState } from "./System.ts"
import { authAndTipWith, makeNonce, UploadRelay, type UploadRelayService, verifyCertificate } from "./UploadRelay.ts"

// -----------------------------------------------------------------------------
// Steps
// -----------------------------------------------------------------------------

const Base64 = Schema.Uint8ArrayFromBase64

const encodedFields = {
  blobId: BlobId.BlobId,
  rootHash: Base64,
  unencodedLength: Schema.Number,
  nShards: Schema.Number,
  relayNonce: /* @__PURE__ */ Schema.optionalKey(Base64)
}
const registeredFields = {
  ...encodedFields,
  blobObjectId: Address.Address,
  deletable: Schema.Boolean,
  endEpoch: Schema.Number,
  digest: /* @__PURE__ */ Schema.optionalKey(Schema.String)
}

/** A write's progress. Each value is JSON-serialisable with `Schema.encode(Step)`; saving it lets another process continue. */
export const Step = /* @__PURE__ */ Schema.TaggedUnion({
  Encoded: encodedFields,
  Registered: registeredFields,
  Uploaded: { ...registeredFields, certificate: Certificate.Certificate },
  Certified: {
    blobId: BlobId.BlobId,
    blobObjectId: Address.Address,
    certifiedEpoch: Schema.Number,
    endEpoch: Schema.Number,
    deletable: Schema.Boolean,
    digest: /* @__PURE__ */ Schema.optionalKey(Schema.String)
  }
})
export type Step = typeof Step.Type
export type Encoded = Extract<Step, { readonly _tag: "Encoded" }>
export type Registered = Extract<Step, { readonly _tag: "Registered" }>
export type Uploaded = Extract<Step, { readonly _tag: "Uploaded" }>
export type Certified = Extract<Step, { readonly _tag: "Certified" }>

// -----------------------------------------------------------------------------
// Executor
// -----------------------------------------------------------------------------

/** How transactions are sent. The package depends on neither `Tx.run` nor `sui-lifecycle`; the caller picks. */
export interface Executor<E, R> {
  readonly sender: Address.Address
  readonly execute: <A, E1, R1>(
    recipe: Effect.Effect<A, E1, R1>
  ) => Effect.Effect<Transactions.Effects, E | E1, R | Exclude<R1, Ptb.PtbBuilder>>
}

type TxRunEffect = ReturnType<typeof Tx.run<void, never, Ptb.PtbBuilder, never, never>>
/** The errors of `Tx.run` (resolution, signing, execution) apart from the recipe's own. */
export type TxRunError = Effect.Error<TxRunEffect>
/** The services of `Tx.run` (`Transactions`, and what resolution reads). */
export type TxRunServices = Effect.Services<TxRunEffect>

/** `Tx.run` with this signer (a key or a wallet), and optionally fixed gas terms. */
export const viaTx = (
  signer: Signer.Signer | Signer.TransactionSigner,
  options?: { readonly gasBudget?: bigint; readonly gasPrice?: bigint }
): Executor<TxRunError, TxRunServices> => ({
  sender: signer.address,
  execute: (recipe) => Tx.run(recipe, { signer, ...options }) as any
})

// -----------------------------------------------------------------------------
// Options and errors
// -----------------------------------------------------------------------------

export type Linger = Duration.Input | ((elapsed: Duration.Duration) => Duration.Input)

/** Where the data goes: straight to the storage nodes, or through an upload relay. */
export type Via = "nodes" | "relay"
/** What `via` adds to a write's requirements. */
export type ViaServices<V extends Via> = V extends "relay" ? UploadRelay : never

export interface WriteOptions<E, R, E2 = never, R2 = never, V extends Via = "nodes"> {
  readonly epochs: number
  readonly deletable: boolean
  readonly executor: Executor<E, R>
  /** Who receives the `Blob`. Default: the executor's sender. */
  readonly owner?: Address.Address
  readonly attributes?: Readonly<Record<string, string>>
  /** Default `"nodes"`; `"relay"` needs an `UploadRelay` layer (and ignores `linger`, `retry` and `maxInFlightBytes`). */
  readonly via?: V
  /** Continue from a saved step. The bytes must be the same blob: checked against `blobId`. */
  readonly resume?: Step
  /** Called after each step and awaited before the next one starts: persist here. */
  readonly onStep?: (step: Step) => Effect.Effect<void, E2, R2>
  /** After `n − f` shards confirmed, keep collecting for this long. Default `0.5 × elapsed + 500 ms` (the Rust client's); `0` disables. */
  readonly linger?: Linger
  /** Per node request. Default exponential from 200 ms, capped at 10 s, 6 retries; only retryable `NodeError`s are retried. */
  readonly retry?: Schedule.Schedule<unknown, NodeError>
  /** Bytes of sliver `PUT`s in flight across all nodes. Default 12,500,000. */
  readonly maxInFlightBytes?: number
}

export type UploadOptions = Pick<WriteOptions<never, never>, "linger" | "retry" | "maxInFlightBytes">

export type WriteServices = System | Committees | StorageNodes | Encoder | Objects.Objects

export type WriteError =
  | NotEnoughConfirmations
  | CommitteeMismatch
  | ResumeMismatch
  | RegistrationFailed
  | CertificateStale
  | BlobTooLarge
  | SystemError
  | CommitteeError
  | EncoderError
  | Recipes.RecipeError
  | RelayError
  | TipTooHigh
  | CertificateInvalid

/** The Rust client's default linger (`communication_config.rs`): half the time the quorum took, plus 500 ms. */
export const defaultLinger = (elapsed: Duration.Duration): Duration.Duration =>
  Duration.sum(Duration.times(elapsed, 0.5), Duration.millis(500))

/** Exponential from 200 ms, capped at 10 s, at most 6 retries. */
export const defaultRetry: Schedule.Schedule<unknown, NodeError> = /* @__PURE__ */ Schedule.max([
  /* @__PURE__ */ Schedule.exponential("200 millis").pipe(
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(10))))
  ),
  /* @__PURE__ */ Schedule.recurs(6)
])

export const DEFAULT_MAX_IN_FLIGHT_BYTES = 12_500_000
/** Sliver `PUT`s in flight per node (the Rust client's connection limit). */
export const PER_NODE_CONCURRENCY = 10
/** Below this size a sliver is re-sent rather than asking whether the node has it (`check_and_store_sliver`). */
export const STATUS_CHECK_MIN_BYTES = 5_560

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const systemState = /* @__PURE__ */ Effect.flatMap(Effect.service(System), (s) => s.state)
const refreshedState = /* @__PURE__ */ Effect.flatMap(Effect.service(System), (s) => s.refresh)

type OnChainBlob = blob.Blob
const decodeBlob = /* @__PURE__ */ Objects.decode(blob.Blob)
const decodeBlobBytes = /* @__PURE__ */ Bcs.decode(blob.Blob)

/** The `Blob` object, or `undefined` when it no longer exists. */
const readBlob = (blobObjectId: Address.Address) =>
  Effect.flatMap(Effect.service(Objects.Objects), (objects) =>
    objects.get(blobObjectId).pipe(
      Effect.flatMap((o) => Effect.map(decodeBlob(o), (b): OnChainBlob | undefined => b)),
      Effect.catchTag("ObjectNotFound", () => Effect.succeed(undefined))
    ))

/** Like `readBlob`, but waits briefly for an object the transport has not indexed yet. */
const readCreatedBlob = (blobObjectId: Address.Address) =>
  Effect.flatMap(Effect.service(Objects.Objects), (objects) =>
    objects.get(blobObjectId).pipe(
      Effect.retry({ while: (e) => e._tag === "ObjectNotFound", schedule: Schedule.spaced("500 millis"), times: 20 }),
      Effect.flatMap(decodeBlob)
    ))

const persistenceOf = (step: { readonly deletable: boolean; readonly blobObjectId: Address.Address }): Messages.Persistence =>
  step.deletable ? { _tag: "Deletable", objectId: step.blobObjectId } : { _tag: "Permanent" }

const certifiedOf = (step: Registered | Uploaded, certifiedEpoch: number, endEpoch: number, digest?: string): Certified => ({
  _tag: "Certified",
  blobId: step.blobId,
  blobObjectId: step.blobObjectId,
  certifiedEpoch,
  endEpoch,
  deletable: step.deletable,
  ...(digest !== undefined && { digest })
})

const registeredOf = (encoded: Encoded, b: OnChainBlob, digest?: string): Registered => ({
  ...encoded,
  _tag: "Registered",
  blobObjectId: Address.normalize(b.id),
  deletable: b.deletable,
  endEpoch: b.storage.end_epoch,
  ...(digest !== undefined && { digest })
})

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** The epoch in a confirmation message (M1), if it is one. */
const messageEpoch = (m: Uint8Array): number | undefined => {
  const { type, version, appId } = Messages.BLOB_CERT_INTENT
  if (m.length < 7 || m[0] !== type || m[1] !== version || m[2] !== appId) return undefined
  return new DataView(m.buffer, m.byteOffset + 3, 4).getUint32(0, true)
}

const checkSize = (unencodedLength: number, nShards: number): Effect.Effect<void, BlobTooLarge> =>
  Result.match(Encoding.symbolSize(unencodedLength, nShards), { onFailure: Effect.fail, onSuccess: () => Effect.void })

// -----------------------------------------------------------------------------
// Step 1: encode
// -----------------------------------------------------------------------------

/** Encode for the current shard count. Deterministic; only the id and root are saved. */
export const encode = (bytes: Uint8Array): Effect.Effect<{ readonly step: Encoded; readonly encoded: EncodedBlob }, WriteError, System | Encoder> =>
  Effect.gen(function*() {
    const state = yield* systemState
    yield* checkSize(bytes.length, state.nShards)
    const encoded = yield* (yield* Effect.service(Encoder)).encode(state.nShards, bytes)
    const step: Encoded = {
      _tag: "Encoded",
      blobId: encoded.blobId,
      rootHash: encoded.rootHash,
      unencodedLength: encoded.unencodedLength,
      nShards: encoded.nShards
    }
    return { step, encoded }
  })

/**
 * Step 1 for the relay: only the blob id and root hash (`Encoder.blobId`, no
 * slivers) and a fresh 32-byte nonce for the relay's auth input (R3).
 */
export const encodeForRelay = (bytes: Uint8Array): Effect.Effect<Encoded, WriteError, System | Encoder> =>
  Effect.gen(function*() {
    const state = yield* systemState
    yield* checkSize(bytes.length, state.nShards)
    const { blobId, rootHash } = yield* (yield* Effect.service(Encoder)).blobId(state.nShards, bytes)
    return {
      _tag: "Encoded",
      blobId,
      rootHash,
      unencodedLength: bytes.length,
      nShards: state.nShards,
      relayNonce: yield* makeNonce
    } satisfies Encoded
  })

// -----------------------------------------------------------------------------
// Step 2: register
// -----------------------------------------------------------------------------

export type RegisterOptions<E, R, V extends Via = "nodes"> =
  & Pick<WriteOptions<E, R, never, never, V>, "epochs" | "deletable" | "executor" | "owner" | "attributes" | "via">
  & {
    /** With `via: "relay"`: the blob, for the relay's auth input (its SHA-256 and length). */
    readonly blob?: Uint8Array
  }

/** The relay service when `via` is `"relay"`; a missing layer is a `RelayError`, so that `R` stays honest for direct writes. */
const relayFor = (via: Via | undefined): Effect.Effect<UploadRelayService | undefined, RelayError> =>
  via !== "relay" ? Effect.succeed(undefined) : Effect.flatMap(Effect.serviceOption(UploadRelay), (o) =>
    Option.isSome(o)
      ? Effect.succeed(o.value)
      : Effect.fail(new RelayError({ message: 'via: "relay" needs an UploadRelay layer' })))

/** Whether the relay wants a tip, i.e. a transaction carrying the auth input (R3). */
const wantsTip = (relay: UploadRelayService) => Effect.map(relay.tipConfig, (c) => c._tag === "SendTip")

/** A transaction with only the relay's auth input and tip (for a registration made earlier): its digest. */
const sendAuth = <E, R>(relay: UploadRelayService, executor: Executor<E, R>, blob: Uint8Array, nonce: Uint8Array) =>
  Effect.map(executor.execute(authAndTipWith(relay, { blob, nonce })), (effects) => effects.digest)

/**
 * An owned `Blob` registered for this blob that can still be certified and
 * lasts long enough: same id, size and persistence, uncertified, ending no
 * earlier than `epoch + epochs` (item 14; `resource.rs:298-321`).
 */
export const findRegistration = (
  owner: Address.Address,
  encoded: Pick<Encoded, "blobId" | "unencodedLength">,
  o: { readonly deletable: boolean; readonly minEndEpoch: number }
): Effect.Effect<OnChainBlob | undefined, SystemError, System | Objects.Objects> =>
  Effect.gen(function*() {
    const type = yield* Recipes.blobType
    const objects = yield* Effect.service(Objects.Objects)
    const id = BlobId.toU256(encoded.blobId)
    const size = BigInt(encoded.unencodedLength)
    const owned = yield* Stream.runCollect(objects.listOwned(owner, { type }))
    for (const object of owned) {
      const decoded = decodeBlobBytes(object.contents)
      if (Result.isFailure(decoded)) continue
      const b = decoded.success
      if (
        b.blob_id === id && b.size === size && b.deletable === o.deletable && Option.isNone(b.certified_epoch) &&
        b.storage.end_epoch >= o.minEndEpoch
      ) return b
    }
    return undefined
  })

/**
 * Ensure the blob is registered: reuse an owned registration (see
 * `findRegistration`), else execute `registerBlob` and transfer the `Blob` to
 * the owner.
 */
export const register = <E, R, V extends Via = "nodes">(
  encoded: Encoded,
  o: RegisterOptions<E, R, V>
): Effect.Effect<Registered, WriteError | E, System | Objects.Objects | R | ViaServices<V>> =>
  Effect.flatMap(relayFor(o.via), (relay) => registerWith(relay, encoded, o))

/**
 * With a relay, the relay's auth input and tip come first in the register
 * transaction (R3); a reused registration gets a transaction with only those
 * (when the relay wants a tip). `Registered.digest` is then that
 * transaction's: the one the relay checks.
 */
const registerWith = <E, R>(
  relay: UploadRelayService | undefined,
  encodedIn: Encoded,
  o: Omit<RegisterOptions<E, R, Via>, "via">
): Effect.Effect<Registered, WriteError | E, System | Objects.Objects | R> =>
  Effect.gen(function*() {
    let encoded = encodedIn
    let auth: { readonly blob: Uint8Array; readonly nonce: Uint8Array } | undefined
    if (relay !== undefined) {
      const blob = o.blob
      if (blob === undefined || blob.length !== encoded.unencodedLength) {
        return yield* new RelayError({ message: "registering for the relay needs the blob (its digest goes into the auth input)" })
      }
      const nonce = encoded.relayNonce ?? (yield* makeNonce)
      encoded = { ...encoded, relayNonce: nonce }
      if (yield* wantsTip(relay)) auth = { blob, nonce }
    }
    const owner = Address.normalize(o.owner ?? o.executor.sender)
    const state = yield* systemState
    const existing = yield* findRegistration(owner, encoded, { deletable: o.deletable, minEndEpoch: state.epoch + o.epochs })
    if (existing !== undefined) {
      const digest = relay !== undefined && auth !== undefined ? yield* sendAuth(relay, o.executor, auth.blob, auth.nonce) : undefined
      return registeredOf(encoded, existing, digest)
    }

    const effects = yield* o.executor.execute(Effect.gen(function*() {
      // Input 0 (R3): before anything else touches the builder.
      if (relay !== undefined && auth !== undefined) yield* authAndTipWith(relay, auth)
      const registered = yield* Recipes.registerBlob({
        blobId: encoded.blobId,
        rootHash: encoded.rootHash,
        unencodedLength: encoded.unencodedLength,
        epochs: o.epochs,
        deletable: o.deletable,
        ...(o.attributes !== undefined && { attributes: o.attributes })
      })
      yield* Ptb.transferObjects([registered], yield* Ptb.address(owner))
    }))
    const blobObjectId = yield* createdBlob(effects)
    if (blobObjectId === undefined) {
      return yield* new RegistrationFailed({
        blobObjectId: Address.normalize("0x0"),
        reason: `transaction ${effects.digest} created no Blob`
      })
    }
    const b = yield* readCreatedBlob(blobObjectId).pipe(
      Effect.catchTag("ObjectNotFound", () =>
        Effect.fail(new RegistrationFailed({ blobObjectId, reason: `created by ${effects.digest} but not readable` })))
    )
    return registeredOf(encoded, b, effects.digest)
  })

/** The `Blob` a transaction created: by type in the effects, else by reading the created objects. */
const createdBlob = (effects: Transactions.Effects) =>
  Effect.gen(function*() {
    const type = TypeTag.normalizeString(yield* Recipes.blobType)
    const created = effects.changedObjects.filter((c) => c.operation === "Created")
    const typed = created.find((c) => c.type !== undefined && TypeTag.normalizeString(c.type) === type)
    if (typed !== undefined) return typed.objectId
    const objects = yield* Effect.service(Objects.Objects)
    for (const c of created.filter((c) => c.type === undefined)) {
      const object = yield* objects.get(c.objectId).pipe(Effect.option)
      if (Option.isSome(object) && TypeTag.normalizeString(object.value.type) === type) return c.objectId
    }
    return undefined
  })

// -----------------------------------------------------------------------------
// Step 3: upload
// -----------------------------------------------------------------------------

interface Confirmed {
  readonly node: CommitteeNode
  readonly signature: Uint8Array
}

const failure = (node: CommitteeNode, kind: NodeError["kind"], message: string) =>
  new NodeError({ node: node.url, kind, message })

/** The current committee, checked against the system object (C5); one refresh of both on a mismatch. */
const checkedCommittee = /* @__PURE__ */ Effect.gen(function*() {
  const committees = yield* Effect.service(Committees)
  const first = yield* Effect.zip(systemState, committees.get)
  if (Result.isSuccess(checkAgainstSystem(first[1].current, first[0]))) return { state: first[0], committee: first[1].current }
  const [state, active] = yield* Effect.zip(refreshedState, committees.refresh)
  const checked = checkAgainstSystem(active.current, state)
  if (Result.isFailure(checked)) return yield* checked.failure
  return { state, committee: active.current }
})

const uploadOnce = (
  encoded: EncodedBlob,
  registered: Registered,
  state: SystemState,
  committee: Committee,
  o: UploadOptions
) =>
  Effect.gen(function*() {
    const nodes = yield* Effect.service(StorageNodes)
    const encoder = yield* Effect.service(Encoder)
    const n = committee.nShards
    const blobId = registered.blobId
    const message = Messages.confirmationMessage(committee.epoch, blobId, persistenceOf(registered))
    const schedule = o.retry ?? defaultRetry
    const withRetry = <A>(effect: Effect.Effect<A, NodeError>) => Effect.retry(effect, { schedule, while: retryable })
    const sliverBytes = Math.max(1, encoded.primary[0]?.length ?? 1)
    const permits = Math.max(1, Math.floor((o.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES) / sliverBytes))
    const global = yield* Semaphore.make(permits)
    const newerEpoch = yield* Ref.make<number | undefined>(undefined)

    const putSliver = (node: CommitteeNode, pair: number, axis: "primary" | "secondary", checkFirst: boolean) => {
      const sliver = (axis === "primary" ? encoded.primary : encoded.secondary)[pair]!
      const put = withRetry(nodes.putSliver(node, blobId, pair, axis, sliver))
      const guarded = checkFirst && sliver.length >= STATUS_CHECK_MIN_BYTES
        ? Effect.flatMap(
          nodes.sliverStatus(node, blobId, pair, axis).pipe(Effect.orElseSucceed(() => "nonexistent" as const)),
          (s) => s === "nonexistent" ? put : Effect.void
        )
        : put
      return Semaphore.withPermit(global)(Effect.asVoid(guarded))
    }

    const store = (node: CommitteeNode): Effect.Effect<Confirmed, NodeError> =>
      Effect.gen(function*() {
        const metadata = yield* withRetry(nodes.putMetadata(node, blobId, encoded.metadata))
        const checkFirst = metadata === "alreadyStored"
        const puts = node.shards.flatMap((shard) => {
          const pair = Encoding.pairOfShard(shard, blobId, n)
          return [putSliver(node, pair, "primary", checkFirst), putSliver(node, pair, "secondary", checkFirst)]
        })
        yield* Effect.all(puts, { concurrency: PER_NODE_CONCURRENCY, discard: true })
        const signed = yield* withRetry(nodes.confirmation(node, blobId, persistenceOf(registered)))
        if (!sameBytes(signed.serializedMessage, message)) {
          const epoch = messageEpoch(signed.serializedMessage)
          if (epoch !== undefined && epoch > committee.epoch) yield* Ref.set(newerEpoch, epoch)
          return yield* failure(
            node,
            "InvalidSignature",
            epoch !== undefined && epoch !== committee.epoch
              ? `confirmation for epoch ${epoch}, expected ${committee.epoch}`
              : "confirmation message differs from the expected one"
          )
        }
        const publicKey = state.members[node.index]?.publicKey ?? node.publicKey
        const valid = yield* encoder.blsVerify(signed.signature, publicKey, message).pipe(
          Effect.catchTag("EncoderError", (e) => Effect.fail(failure(node, "InvalidSignature", `malformed signature: ${e.message}`)))
        )
        if (!valid) return yield* failure(node, "InvalidSignature", "confirmation signature does not verify")
        return { node, signature: signed.signature }
      })

    const required = Bft.minCorrect(n)
    const reached = yield* Quorum.run(committee.nodes, {
      weight: (node) => node.shards.length,
      threshold: required,
      order: "shuffle",
      run: store,
      linger: o.linger ?? defaultLinger
    }).pipe(
      Effect.catchTag("QuorumFailed", (e) =>
        Effect.flatMap(Ref.get(newerEpoch), (epoch) =>
          Effect.fail(
            epoch !== undefined ? { _tag: "EpochMoved" as const, epoch } : new NotEnoughConfirmations({
              blobId,
              weight: e.weight,
              required,
              failures: e.failures.map((f) => ({
                node: f.member.url,
                weight: f.weight,
                kind: f.error.kind,
                message: f.error.message
              }))
            })
          )
        ))
    )
    const signers = [...reached.successes].sort((a, b) => a.value.node.index - b.value.node.index)
    const signature = yield* encoder.blsAggregate(signers.map((s) => s.value.signature))
    const certificate = Result.getOrThrow(Certificate.fromParts({
      signers: signers.map((s) => s.value.node.index),
      serializedMessage: message,
      signature
    }))
    const uploaded: Uploaded = { ...registered, _tag: "Uploaded", certificate }
    return uploaded
  })

/**
 * Store metadata and slivers on the current committee and collect verified
 * confirmations from `n − f` shards (by weight), then aggregate them. If the
 * epoch moves during the upload, the committee is reloaded and the step runs
 * again (at most twice).
 */
export const upload = (
  encoded: EncodedBlob,
  registered: Registered,
  o: UploadOptions = {}
): Effect.Effect<Uploaded, WriteError, System | Committees | StorageNodes | Encoder> =>
  Effect.gen(function*() {
    if (encoded.blobId !== registered.blobId) {
      return yield* new ResumeMismatch({ expected: registered.blobId, actual: encoded.blobId })
    }
    for (let round = 0;; round++) {
      const { committee, state } = yield* checkedCommittee
      if (committee.nShards !== encoded.nShards) {
        return yield* new NotEnoughConfirmations({ blobId: registered.blobId, weight: 0, required: Bft.minCorrect(committee.nShards), failures: [] })
      }
      const result = yield* uploadOnce(encoded, registered, state, committee, o).pipe(
        Effect.map((u) => ({ _tag: "Done" as const, u })),
        Effect.catchTag("EpochMoved", (e) => Effect.succeed(e))
      )
      if (result._tag === "Done") return result.u
      if (round >= 1) {
        return yield* new NotEnoughConfirmations({
          blobId: registered.blobId,
          weight: 0,
          required: Bft.minCorrect(committee.nShards),
          failures: [{ node: "", weight: 0, kind: "EpochMoved", message: `nodes confirm for epoch ${result.epoch}` }]
        })
      }
      yield* refreshedState
      yield* Effect.flatMap(Effect.service(Committees), (c) => c.refresh)
    }
  })

// -----------------------------------------------------------------------------
// Step 3, through the relay
// -----------------------------------------------------------------------------

/** Relay requests that failed without an answer, with a 5xx or a 429 are tried twice more, 1 s and 2 s later. */
const relayRetryable = (e: RelayError) => e.status === undefined || e.status >= 500 || e.status === 429
const RELAY_RETRY = /* @__PURE__ */ Schedule.exponential("1 second")

/** The committee with the system object's BLS keys: the ones `certify_blob` aggregates (C5). */
const withSystemKeys = (committee: Committee, state: SystemState): Committee => ({
  ...committee,
  nodes: committee.nodes.map((n) => ({ ...n, publicKey: state.members[n.index]?.publicKey ?? n.publicKey }))
})

const uploadViaRelayWith = (
  relay: UploadRelayService,
  bytes: Uint8Array,
  registered: Registered,
  txDigest: string | undefined
): Effect.Effect<Uploaded, WriteError, System | Committees | Encoder> =>
  Effect.gen(function*() {
    const tipped = yield* wantsTip(relay)
    if (tipped && (registered.relayNonce === undefined || txDigest === undefined)) {
      return yield* new RelayError({ message: "the relay wants a tip: the upload needs the nonce and the digest of the transaction that paid it" })
    }
    const certificate = yield* relay.upload({
      blob: bytes,
      blobId: registered.blobId,
      ...(tipped && { nonce: registered.relayNonce!, txDigest: txDigest! }),
      ...(registered.deletable && { deletableBlobObject: registered.blobObjectId })
    }).pipe(Effect.retry({ schedule: RELAY_RETRY, times: 2, while: relayRetryable }))

    let { committee, state } = yield* checkedCommittee
    if (certificate.epoch > committee.epoch) {
      // The epoch moved while the relay worked: verify against the new committee.
      yield* refreshedState
      yield* Effect.flatMap(Effect.service(Committees), (c) => c.refresh)
      ;({ committee, state } = yield* checkedCommittee)
    }
    const message = Messages.confirmationMessage(committee.epoch, registered.blobId, persistenceOf(registered))
    yield* verifyCertificate(certificate, message, withSystemKeys(committee, state))
    const uploaded: Uploaded = { ...registered, _tag: "Uploaded", certificate }
    return uploaded
  })

/**
 * Step 3 through the relay: post the blob (with the nonce and `txDigest`,
 * default `registered.digest`, when the relay wants a tip), then verify the
 * returned certificate against the current committee (`verifyCertificate`)
 * before anything is certified with it (item 16).
 */
export const uploadViaRelay = (
  bytes: Uint8Array,
  registered: Registered,
  o: { readonly txDigest?: string } = {}
): Effect.Effect<Uploaded, WriteError, System | Committees | Encoder | UploadRelay> =>
  Effect.flatMap(Effect.service(UploadRelay), (relay) => uploadViaRelayWith(relay, bytes, registered, o.txDigest ?? registered.digest))

// -----------------------------------------------------------------------------
// Step 4: certify
// -----------------------------------------------------------------------------

/**
 * Ensure the blob is certified: done if the `Blob` already is; a certificate
 * from another epoch is `CertificateStale` (M4; `run` then uploads again);
 * otherwise execute `certifyBlob`.
 */
export const certify = <E, R>(
  uploaded: Uploaded,
  o: { readonly executor: Executor<E, R> }
): Effect.Effect<Certified, WriteError | E, System | Objects.Objects | R> =>
  Effect.gen(function*() {
    const b = yield* readBlob(uploaded.blobObjectId)
    if (b === undefined) return yield* new RegistrationFailed({ blobObjectId: uploaded.blobObjectId, reason: "the Blob no longer exists" })
    if (Option.isSome(b.certified_epoch)) return certifiedOf(uploaded, b.certified_epoch.value, b.storage.end_epoch)
    const state = yield* refreshedState
    if (uploaded.certificate.epoch !== state.epoch) {
      return yield* new CertificateStale({ certificateEpoch: uploaded.certificate.epoch, epoch: state.epoch })
    }
    if (b.storage.end_epoch <= state.epoch) {
      return yield* new RegistrationFailed({ blobObjectId: uploaded.blobObjectId, reason: `storage ended at epoch ${b.storage.end_epoch}` })
    }
    const effects = yield* o.executor.execute(
      Recipes.certifyBlob({ blobObjectId: uploaded.blobObjectId, certificate: uploaded.certificate })
    )
    // `certify_blob` sets `certified_epoch` to the current epoch, which it checked equals the certificate's (M4).
    return certifiedOf(uploaded, uploaded.certificate.epoch, b.storage.end_epoch, effects.digest)
  })

// -----------------------------------------------------------------------------
// The whole write
// -----------------------------------------------------------------------------

interface Machine {
  readonly step: Step | undefined
  readonly encoded: EncodedBlob | undefined
  /** The bytes' id was checked against the step (relay path: `Encoder.blobId`, no slivers). */
  readonly checked: boolean
  /** Relay path: `step.digest` is an auth transaction sent by this run (a resumed one may be too old for the relay). */
  readonly fresh: boolean
  readonly stale: number
}

/** Certificates thrown away for an epoch change before giving up. */
const MAX_STALE = 2

/** The bytes must be the step's blob: checked cheaply, without slivers. */
const checkId = (bytes: Uint8Array, expected: BlobId.BlobId) =>
  Effect.gen(function*() {
    const state = yield* systemState
    yield* checkSize(bytes.length, state.nShards)
    const { blobId } = yield* (yield* Effect.service(Encoder)).blobId(state.nShards, bytes)
    if (blobId !== expected) return yield* new ResumeMismatch({ expected, actual: blobId })
  })

type AdvanceOptions<E, R> = Omit<WriteOptions<E, R, never, never, Via>, "onStep">

const advance = <E, R>(bytes: Uint8Array, options: AdvanceOptions<E, R>) => {
  const encodedFor = (machine: Machine, expected: BlobId.BlobId) =>
    Effect.gen(function*() {
      if (machine.encoded !== undefined) return machine.encoded
      const { encoded } = yield* encode(bytes)
      if (encoded.blobId !== expected) return yield* new ResumeMismatch({ expected, actual: encoded.blobId })
      return encoded
    })
  const checkedFor = (machine: Machine, expected: BlobId.BlobId) =>
    machine.checked || machine.encoded !== undefined ? Effect.void : checkId(bytes, expected)

  /** Relay path: a nonce and an auth transaction the relay will accept for this registration. */
  const freshAuth = (relay: UploadRelayService, step: Registered, fresh: boolean) =>
    Effect.gen(function*() {
      if (!(yield* wantsTip(relay))) return step
      if (fresh && step.relayNonce !== undefined && step.digest !== undefined) return step
      const nonce = step.relayNonce ?? (yield* makeNonce)
      const digest = yield* sendAuth(relay, options.executor, bytes, nonce)
      return { ...step, relayNonce: nonce, digest } satisfies Registered
    })

  /** Steps 2 → 3 checks: the `Blob` still exists, is not certified (else jump to the result) and has not expired. */
  const checkRegistered = (step: Registered) =>
    Effect.gen(function*() {
      const b = yield* readBlob(step.blobObjectId)
      if (b === undefined) return yield* new RegistrationFailed({ blobObjectId: step.blobObjectId, reason: "the Blob no longer exists" })
      if (Option.isSome(b.certified_epoch)) return certifiedOf(step, b.certified_epoch.value, b.storage.end_epoch)
      const state = yield* refreshedState
      if (b.storage.end_epoch <= state.epoch) {
        return yield* new RegistrationFailed({ blobObjectId: step.blobObjectId, reason: `storage ended at epoch ${b.storage.end_epoch}` })
      }
      return undefined
    })

  return (machine: Machine): Effect.Effect<Machine | undefined, WriteError | E, WriteServices | R> =>
    Effect.gen(function*() {
      const relay = yield* relayFor(options.via)
      const step = machine.step
      if (step === undefined) {
        if (relay !== undefined) return { step: yield* encodeForRelay(bytes), encoded: undefined, checked: true, fresh: false, stale: 0 }
        const { encoded, step } = yield* encode(bytes)
        return { step, encoded, checked: true, fresh: false, stale: 0 }
      }
      switch (step._tag) {
        case "Encoded": {
          if (relay !== undefined) {
            yield* checkedFor(machine, step.blobId)
            const registered = yield* registerWith(relay, step, { ...options, blob: bytes })
            return { ...machine, checked: true, fresh: true, step: registered }
          }
          const encoded = yield* encodedFor(machine, step.blobId)
          return { ...machine, encoded, step: yield* registerWith(undefined, step, options) }
        }
        case "Registered": {
          if (relay !== undefined) {
            yield* checkedFor(machine, step.blobId)
            const done = yield* checkRegistered(step)
            if (done !== undefined) return { ...machine, checked: true, step: done }
            const authed = yield* freshAuth(relay, step, machine.fresh)
            const uploaded = yield* uploadViaRelayWith(relay, bytes, authed, authed.digest)
            return { ...machine, checked: true, fresh: true, step: uploaded }
          }
          const encoded = yield* encodedFor(machine, step.blobId)
          const done = yield* checkRegistered(step)
          if (done !== undefined) return { ...machine, encoded, step: done }
          return { ...machine, encoded, step: yield* upload(encoded, step, options) }
        }
        case "Uploaded": {
          // Checks resumed bytes, and is what a stale certificate needs anyway.
          const encoded = relay !== undefined ? undefined : yield* encodedFor(machine, step.blobId)
          if (relay !== undefined) yield* checkedFor(machine, step.blobId)
          const certified = yield* certify(step, options).pipe(
            Effect.catchIf((e): e is CertificateStale => e instanceof CertificateStale, (e) => Effect.succeed(e))
          )
          if (!(certified instanceof CertificateStale)) return { ...machine, encoded, checked: true, step: certified }
          if (machine.stale >= MAX_STALE) return yield* certified
          // M4: a certificate is bound to its epoch. Nodes that already hold the data answer quickly.
          const { certificate: _, ...rest } = step
          const registered: Registered = { ...rest, _tag: "Registered" }
          if (relay !== undefined) {
            // A new epoch means time has passed: send a fresh auth transaction for the relay.
            const authed = yield* freshAuth(relay, registered, false)
            const uploaded = yield* uploadViaRelayWith(relay, bytes, authed, authed.digest)
            return { ...machine, checked: true, fresh: true, step: uploaded, stale: machine.stale + 1 }
          }
          const uploaded = yield* upload(encoded!, registered, options)
          return { ...machine, step: uploaded, encoded, stale: machine.stale + 1 }
        }
        case "Certified":
          return undefined
      }
    })
}

/** The same as `run`, as a pull-driven stream of steps: the next step runs when the consumer asks for it. */
export const stream = <E, R, V extends Via = "nodes">(
  bytes: Uint8Array,
  options: Omit<WriteOptions<E, R, never, never, V>, "onStep">
): Stream.Stream<Step, WriteError | E, WriteServices | R | ViaServices<V>> => {
  const next = advance(bytes, options)
  const start: Machine = { step: options.resume, encoded: undefined, checked: false, fresh: false, stale: 0 }
  const first: Effect.Effect<Machine | undefined, WriteError | E, WriteServices | R> = options.resume?._tag === "Certified"
    ? Effect.as(checkId(bytes, options.resume.blobId), undefined)
    : next(start)
  return Stream.unfold(
    first as Effect.Effect<Machine | undefined, WriteError | E, WriteServices | R> | undefined,
    (pending) =>
      pending === undefined ? Effect.succeed(undefined) : Effect.map(pending, (m) =>
        m === undefined || m.step === undefined
          ? undefined
          : [m.step, m.step._tag === "Certified" ? undefined : next(m)] as const)
  )
}

/**
 * Write a blob and return its `Certified` step. With `resume`, continue from
 * a saved step; `onStep` sees every step and is awaited before the next one.
 * With `via: "relay"`, the blob goes through the `UploadRelay`.
 */
export const run = <E, R, E2 = never, R2 = never, V extends Via = "nodes">(
  bytes: Uint8Array,
  options: WriteOptions<E, R, E2, R2, V>
): Effect.Effect<Certified, WriteError | E | E2, WriteServices | R | R2 | ViaServices<V>> =>
  Effect.gen(function*() {
    if (options.resume?._tag === "Certified") {
      yield* checkId(bytes, options.resume.blobId)
      return options.resume
    }
    const next = advance(bytes, options)
    let machine: Machine = { step: options.resume, encoded: undefined, checked: false, fresh: false, stale: 0 }
    for (;;) {
      const m = yield* next(machine)
      if (m === undefined || m.step === undefined) break
      machine = m
      if (options.onStep) yield* options.onStep(m.step)
      if (m.step._tag === "Certified") return m.step
    }
    // Only reached for a resumed `Certified`, handled above.
    return yield* Effect.die(new Error("Write.run: no Certified step"))
  })
