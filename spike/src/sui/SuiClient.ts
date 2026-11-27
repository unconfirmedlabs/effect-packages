/**
 * The typed Sui client: domain values out, typed errors, no Promises.
 *
 * The interesting part is what *isn't* here. There is no DataLoader, no cache
 * scope, no AbortSignal, no retry loop: `getObject` is an Effect `Request`, so
 * every concurrent `getObject` anywhere in the program (the resolver, a Walrus
 * committee read, your own code) is deduplicated and coalesced into one
 * `BatchGetObjects` call. Package metadata (`getFunction`) is immutable on
 * chain, so it is cached for the life of the layer.
 */
import { Context, Data, Effect, Exit, Layer, Request, RequestResolver, Schema, Stream } from "effect"
import type { ProtobufMessage } from "effect/protobuf"
import { type GrpcError, GrpcWeb } from "../grpc/GrpcWeb.ts"
import * as T from "./Types.ts"

// -----------------------------------------------------------------------------
// Domain
// -----------------------------------------------------------------------------

export type Owner =
  | { readonly _tag: "AddressOwner"; readonly address: T.Address }
  | { readonly _tag: "ObjectOwner"; readonly address: T.Address }
  | { readonly _tag: "Shared"; readonly initialSharedVersion: bigint }
  | { readonly _tag: "Immutable" }
  | { readonly _tag: "ConsensusAddressOwner"; readonly startVersion: bigint; readonly address: T.Address }

export class SuiObject extends Data.Class<{
  readonly objectId: T.Address
  readonly version: bigint
  readonly digest: T.ObjectDigest
  readonly owner: Owner
  readonly type: string
  /** The Move struct's BCS bytes (without the object envelope). */
  readonly contents: Uint8Array
}> {
  get ref(): T.ObjectRef {
    return { objectId: this.objectId, version: this.version, digest: this.digest }
  }
}

export type Reference = "Immutable" | "Mutable" | "Value"
export interface MoveParameter {
  readonly reference: Reference
  /** `0x2::tx_context::TxContext`, `0x2::transfer::Receiving`, ... for datatypes. */
  readonly typeName: string | undefined
}
export interface MoveFunction {
  readonly parameters: ReadonlyArray<MoveParameter>
}

export class ObjectNotFound extends Schema.TaggedError<ObjectNotFound>()("ObjectNotFound", {
  objectId: Schema.String
}) {}

export class MalformedResponse extends Schema.TaggedError<MalformedResponse>()("MalformedResponse", {
  method: Schema.String,
  issue: Schema.String
}) {}

export interface SimulationResult {
  readonly success: boolean
  readonly error: string | undefined
  /** BCS bytes of each command's return values. */
  readonly returnValues: ReadonlyArray<ReadonlyArray<Uint8Array>>
  readonly gasUsed: { readonly computationCost: bigint; readonly storageCost: bigint; readonly storageRebate: bigint } | undefined
}

export interface ExecutionResult {
  readonly digest: string
  readonly success: boolean
  readonly error: string | undefined
}

// -----------------------------------------------------------------------------
// Proto -> domain (Schema over the plain protobuf values)
// -----------------------------------------------------------------------------

const ProtoObject = Schema.Struct({
  object_id: T.Address,
  version: Schema.BigInt,
  digest: T.ObjectDigest,
  owner: Schema.Struct({
    kind: Schema.Number,
    address: Schema.optionalKey(Schema.String),
    version: Schema.optionalKey(Schema.BigInt)
  }),
  object_type: Schema.String,
  contents: Schema.optionalKey(Schema.Struct({ value: Schema.Uint8Array }))
})
const decodeProtoObject = Schema.decodeUnknownEffect(ProtoObject)

const toOwner = (o: typeof ProtoObject.Type["owner"]): Owner => {
  switch (o.kind) {
    case 1:
      return { _tag: "AddressOwner", address: T.address(o.address!) }
    case 2:
      return { _tag: "ObjectOwner", address: T.address(o.address!) }
    case 3:
      return { _tag: "Shared", initialSharedVersion: o.version! }
    case 4:
      return { _tag: "Immutable" }
    default:
      return { _tag: "ConsensusAddressOwner", startVersion: o.version ?? 0n, address: T.address(o.address!) }
  }
}

const toObject = (method: string) => (raw: unknown) =>
  decodeProtoObject(raw).pipe(
    Effect.mapError((e) => new MalformedResponse({ method, issue: e.message })),
    Effect.map((o) =>
      new SuiObject({
        objectId: o.object_id,
        version: o.version,
        digest: o.digest,
        owner: toOwner(o.owner),
        type: o.object_type,
        contents: o.contents?.value ?? new Uint8Array()
      })
    )
  )

const OBJECT_MASK = { paths: ["object_id", "version", "digest", "owner", "object_type", "contents"] }
const MAX_BATCH = 50

const REFERENCES: Record<number, Reference> = { 0: "Value", 1: "Immutable", 2: "Mutable" }

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export class SuiClient extends Context.Service<SuiClient, {
  readonly getObject: (objectId: T.Address) => Effect.Effect<SuiObject, ObjectNotFound | GrpcError | MalformedResponse>
  readonly getFunction: (target: {
    readonly package: T.Address
    readonly module: string
    readonly function: string
  }) => Effect.Effect<MoveFunction, GrpcError>
  readonly getChain: Effect.Effect<{ readonly chainId: T.ObjectDigest; readonly epoch: bigint }, GrpcError>
  readonly getReferenceGasPrice: Effect.Effect<bigint, GrpcError>
  readonly simulate: (
    txBytes: Uint8Array,
    options?: { readonly checks?: boolean }
  ) => Effect.Effect<SimulationResult, GrpcError>
  readonly execute: (txBytes: Uint8Array, signatures: ReadonlyArray<Uint8Array>) => Effect.Effect<ExecutionResult, GrpcError>
  readonly checkpoints: (options?: { readonly pageSize?: number }) => Stream.Stream<{ readonly sequenceNumber: bigint; readonly digest: string }, GrpcError>
}>()("@effect-sdks/sui/SuiClient") {
  static readonly layer = Layer.effect(
    SuiClient,
    Effect.gen(function*() {
      const grpc = yield* GrpcWeb

      // --- getObject: one Request type, coalesced into BatchGetObjects -----------
      class GetObject extends Request.Class<
        { readonly objectId: T.Address },
        SuiObject,
        ObjectNotFound | GrpcError | MalformedResponse
      > {}

      const objectResolver = RequestResolver.make<GetObject>(
        Effect.fnUntraced(function*(entries) {
          const response = yield* grpc
            .unary("sui.rpc.v2.LedgerService/BatchGetObjects", {
              requests: entries.map((e) => ({ object_id: e.request.objectId })),
              read_mask: OBJECT_MASK
            })
            .pipe(Effect.exit)
          if (Exit.isFailure(response)) {
            for (const e of entries) e.completeUnsafe(response as Exit.Exit<never, GrpcError>)
            return
          }
          const results = (response.value["objects"] ?? []) as Array<ProtobufMessage.Message>
          yield* Effect.forEach(entries, (entry, i) => {
            const result = results[i]?.["result"] as { _tag: string; value: ProtobufMessage.Message } | undefined
            if (result?._tag === "object") {
              return toObject("BatchGetObjects")(result.value).pipe(
                Effect.exit,
                Effect.map((exit) => entry.completeUnsafe(exit))
              )
            }
            return Effect.sync(() =>
              entry.completeUnsafe(Exit.fail(new ObjectNotFound({ objectId: entry.request.objectId })))
            )
          }, { discard: true })
        })
      ).pipe(
        RequestResolver.setDelay("1 millis"),
        RequestResolver.batchN(MAX_BATCH),
        RequestResolver.withSpan("SuiClient.getObject.resolver")
      )

      const getObject = (objectId: T.Address) =>
        Effect.request(new GetObject({ objectId }), objectResolver).pipe(
          Effect.withSpan("SuiClient.getObject", { attributes: { objectId } })
        )

      // --- getFunction: immutable package metadata, cached ---------------------
      class GetFunction extends Request.Class<
        { readonly package: T.Address; readonly module: string; readonly function: string },
        MoveFunction,
        GrpcError
      > {}
      const functionResolver = yield* RequestResolver.fromEffect(({ request: req }: Request.Entry<GetFunction>) =>
        grpc
          .unary("sui.rpc.v2.MovePackageService/GetFunction", {
            package_id: req.package,
            module_name: req.module,
            name: req.function
          })
          .pipe(
            Effect.map((res): MoveFunction => {
              const fn = (res["function"] ?? {}) as ProtobufMessage.Message
              const params = (fn["parameters"] ?? []) as Array<ProtobufMessage.Message>
              return {
                parameters: params.map((p) => {
                  const body = (p["body"] ?? {}) as ProtobufMessage.Message
                  return {
                    reference: REFERENCES[(p["reference"] as number | undefined) ?? 0] ?? "Value",
                    typeName: body["type_name"] as string | undefined
                  }
                })
              }
            })
          )
      ).pipe(RequestResolver.withCache({ capacity: 4096 }))

      const getFunction = (target: { readonly package: T.Address; readonly module: string; readonly function: string }) =>
        Effect.request(new GetFunction(target), functionResolver)

      // --- chain identity & gas price: cached per layer --------------------------
      const getChain = yield* grpc.unary("sui.rpc.v2.LedgerService/GetServiceInfo", {}).pipe(
        Effect.map((info) => ({ chainId: info["chain_id"] as T.ObjectDigest, epoch: info["epoch"] as bigint })),
        Effect.cachedWithTTL("30 seconds")
      )

      const getReferenceGasPrice = yield* grpc
        .unary("sui.rpc.v2.LedgerService/GetEpoch", { read_mask: { paths: ["epoch", "reference_gas_price"] } })
        .pipe(
          Effect.map((res) => ((res["epoch"] as ProtobufMessage.Message)["reference_gas_price"] as bigint)),
          Effect.cachedWithTTL("1 minute")
        )

      // --- simulate / execute -----------------------------------------------------
      const simulate = Effect.fn("SuiClient.simulate")(function*(
        txBytes: Uint8Array,
        options?: { readonly checks?: boolean }
      ) {
        const res = yield* grpc.unary("sui.rpc.v2.TransactionExecutionService/SimulateTransaction", {
          transaction: { bcs: { value: txBytes } },
          read_mask: { paths: ["transaction.effects.status", "transaction.effects.gas_used", "command_outputs"] },
          checks: options?.checks === false ? 1 : 0
        })
        const tx = (res["transaction"] ?? {}) as any
        const status = tx.effects?.status ?? {}
        const outputs = (res["command_outputs"] ?? []) as Array<any>
        return {
          success: status.success === true,
          error: status.error ? JSON.stringify(status.error, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : undefined,
          returnValues: outputs.map((o) => (o.return_values ?? []).map((v: any) => v.value?.value ?? new Uint8Array())),
          gasUsed: tx.effects?.gas_used
            ? {
              computationCost: tx.effects.gas_used.computation_cost ?? 0n,
              storageCost: tx.effects.gas_used.storage_cost ?? 0n,
              storageRebate: tx.effects.gas_used.storage_rebate ?? 0n
            }
            : undefined
        } satisfies SimulationResult
      })

      const execute = Effect.fn("SuiClient.execute")(function*(
        txBytes: Uint8Array,
        signatures: ReadonlyArray<Uint8Array>
      ) {
        const res = yield* grpc.unary("sui.rpc.v2.TransactionExecutionService/ExecuteTransaction", {
          transaction: { bcs: { value: txBytes } },
          signatures: signatures.map((s) => ({ bcs: { value: s } })),
          read_mask: { paths: ["digest", "effects.status"] }
        })
        const tx = (res["transaction"] ?? {}) as any
        return {
          digest: tx.digest as string,
          success: tx.effects?.status?.success === true,
          error: tx.effects?.status?.error ? JSON.stringify(tx.effects.status.error, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : undefined
        } satisfies ExecutionResult
      })

      const checkpoints = (options?: { readonly pageSize?: number }) =>
        grpc.serverStream("sui.rpc.v2.LedgerService/ListCheckpoints", { page_size: options?.pageSize ?? 100 }).pipe(
          Stream.map((m) => {
            const cp = (m["checkpoint"] ?? {}) as ProtobufMessage.Message
            return { sequenceNumber: cp["sequence_number"] as bigint, digest: cp["digest"] as string }
          })
        )

      return SuiClient.of({
        getObject,
        getFunction,
        getChain,
        getReferenceGasPrice,
        simulate,
        execute,
        checkpoints
      })
    })
  )
}

