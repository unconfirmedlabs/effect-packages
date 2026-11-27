/**
 * The services' pruned gRPC handles (`generated/lean.ts`) against the full
 * ones (`generated/rpc.ts`): every service call, run once decoding with each,
 * on responses that also carry fields the services never read, gives the same
 * result. And the request checks that keep `scripts/grpc-lean.ts` honest.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as Result from "effect/Result"
import * as ProtobufDescriptor from "effect/protobuf/ProtobufDescriptor"
import * as ProtobufMessage from "effect/protobuf/ProtobufMessage"
import { readFileSync } from "node:fs"
import * as Address from "../src/Address.ts"
import { Chain } from "../src/Chain.ts"
import { CheckpointData } from "../src/CheckpointData.ts"
import { Checkpoints } from "../src/Checkpoints.ts"
import { Coins } from "../src/Coins.ts"
import { DynamicFields } from "../src/DynamicFields.ts"
import { Events } from "../src/Events.ts"
import { Objects } from "../src/Objects.ts"
import { Packages } from "../src/Packages.ts"
import { Transactions } from "../src/Transactions.ts"
import * as SuiGrpc from "../src/grpc/index.ts"
import { GrpcWeb } from "../src/grpc/GrpcWeb.ts"
import * as Lean from "../src/grpc/generated/lean.ts"
import * as Full from "../src/grpc/generated/rpc.ts"
import type { Rpc } from "../src/grpc/Rpc.ts"

const fullByPath = new Map<string, Rpc<any, any, boolean>>(Object.values(Full).map((h: any) => [h.path, h]))
const registry = Result.getOrThrow(ProtobufDescriptor.fromFileDescriptorSet(readFileSync(new URL("../proto/sui-rpc.binpb", import.meta.url))))
/** Encodes a full `<Method>Response`, as a node would. */
const encodeResponse = (method: string, value: object) =>
  Result.getOrThrow(ProtobufMessage.encode(registry.getMessage(`sui.rpc.v2.${method}Response`)!)(value as ProtobufMessage.Message))
const short = (path: string) => path.split("/").pop()!

const A = (n: number) => Address.normalize(`0x${n.toString(16)}`)
const bytes = (...xs: Array<number>) => new Uint8Array(xs)
const ts = { seconds: 1_700_000_000n, nanos: 123_000_000 }
const bcs = (name: string, ...xs: Array<number>) => ({ name, value: bytes(...xs) })

const object = (n: number) => ({
  bcs: bcs("Object", 9, 9, 9),
  object_id: A(n),
  version: 7n,
  digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  owner: { kind: 1, address: A(0xa11ce) },
  object_type: "0x2::coin::Coin<0x2::sui::SUI>",
  has_public_transfer: true,
  contents: bcs("0x2::coin::Coin<0x2::sui::SUI>", ...new Array(32).fill(1), 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0),
  previous_transaction: "7ZUx5yEAfMtL7SaZcH4rUZz3ZTzPZN9ZVqw4vFY3eGzC",
  storage_rebate: 988_000n,
  json: { kind: { _tag: "string_value", value: "ignored" } },
  balance: 1_000_000n
})

const changed = {
  object_id: A(0x5),
  input_state: 2,
  input_version: 6n,
  input_digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  input_owner: { kind: 1, address: A(0xa11ce) },
  output_state: 2,
  output_version: 8n,
  output_digest: "7ZUx5yEAfMtL7SaZcH4rUZz3ZTzPZN9ZVqw4vFY3eGzC",
  output_owner: { kind: 3, version: 3n },
  id_operation: 1,
  object_type: "0x2::coin::Coin<0x2::sui::SUI>"
}

const executed = (status: "ok" | "abort") => ({
  digest: "8YvJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  transaction: { bcs: bcs("TransactionData", 1, 2, 3), digest: "ignored", version: 1, sender: A(0xa11ce), gas_payment: { budget: 5n, price: 1000n } },
  signatures: [{ bcs: bcs("UserSignature", 0, 1), scheme: 0 }],
  effects: {
    bcs: bcs("TransactionEffects", 4, 5),
    digest: "effects-digest",
    version: 2,
    status: status === "ok"
      ? { success: true }
      : {
        success: false,
        error: {
          description: "MoveAbort in 0x2::coin",
          command: 1n,
          kind: 2,
          error_details: { _tag: "abort", value: { abort_code: 7n, location: { package: A(2), module: "coin", function: 3, instruction: 4, function_name: "split" } } }
        }
      },
    epoch: 11n,
    gas_used: { computation_cost: 1000n, storage_cost: 2000n, storage_rebate: 500n, non_refundable_storage_fee: 5n },
    transaction_digest: "8YvJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    gas_object: changed,
    events_digest: "events-digest",
    dependencies: ["dep1", "dep2"],
    lamport_version: 8n,
    changed_objects: [changed, { ...changed, object_id: A(0x6), input_state: 1, output_state: 3, id_operation: 2 }]
  },
  events: {
    bcs: bcs("TransactionEvents", 6),
    digest: "events-digest",
    events: [{ package_id: A(2), module: "coin", sender: A(0xa11ce), event_type: "0x2::coin::Minted", contents: bcs("0x2::coin::Minted", 1), json: { kind: { _tag: "bool_value", value: true } } }]
  },
  checkpoint: 42n,
  timestamp: ts,
  balance_changes: [{ address: A(0xa11ce), coin_type: "0x2::sui::SUI", amount: "-1000" }],
  objects: { objects: [object(0x5)] },
  transaction_index: 3n
})

const checkpoint = {
  sequence_number: 42n,
  digest: "checkpoint-digest",
  summary: { bcs: bcs("CheckpointSummary", 1), digest: "checkpoint-digest", epoch: 11n, sequence_number: 42n, total_network_transactions: 900n, timestamp: ts },
  signature: { epoch: 11n, signature: bytes(1, 2), bitmap: bytes(3) },
  contents: { bcs: bcs("CheckpointContents", 1), digest: "contents-digest", version: 1 },
  transactions: [executed("ok"), executed("abort")],
  objects: { objects: [object(0x7)] }
}

const event = {
  package_id: A(2),
  module: "coin",
  sender: A(0xa11ce),
  event_type: "0x2::coin::Minted",
  contents: bcs("0x2::coin::Minted", 1, 2),
  json: { kind: { _tag: "number_value", value: 1 } },
  checkpoint: 42n,
  transaction_digest: "8YvJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  transaction_index: 3n,
  event_index: 1
}

/** One full response per method, carrying fields outside every read mask. */
const responses: Record<string, ReadonlyArray<object>> = {
  GetServiceInfo: [{ chain_id: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S", chain: "testnet", epoch: 11n, checkpoint_height: 100n, timestamp: ts, lowest_available_checkpoint: 10n, lowest_available_checkpoint_objects: 11n, server: "sui-node" }],
  GetEpoch: [{
    epoch: {
      epoch: 11n,
      committee: { epoch: 11n, members: [{ public_key: bytes(1, 2, 3), weight: 10n }] },
      first_checkpoint: 90n,
      last_checkpoint: 120n,
      start: ts,
      end: ts,
      reference_gas_price: 750n,
      protocol_config: { protocol_version: 99n, feature_flags: { a: true }, attributes: { max_tx_size: "128" } },
      ended_in_safe_mode: false
    }
  }],
  BatchGetObjects: [{ objects: [{ result: { _tag: "object", value: object(0x5) } }, { result: { _tag: "error", value: { code: 5, message: "not found" } } }] }],
  ListOwnedObjects: [{ objects: [object(0x5), object(0x6)], next_page_token: new Uint8Array() }],
  GetBalance: [{ balance: { coin_type: "0x2::sui::SUI", balance: 3000n, address_balance: 1000n, coin_balance: 2000n } }],
  GetFunction: [{
    function: {
      name: "transfer",
      visibility: 2,
      is_entry: true,
      type_parameters: [{ constraints: [1, 2], is_phantom: false }],
      parameters: [
        { reference: 2, body: { type: 10, type_name: "0x2::coin::Coin", type_parameter_instantiation: [{ type: 10, type_name: "0x2::sui::SUI" }] } },
        { body: { type: 1 } },
        { reference: 1, body: { type: 10, type_name: "0x2::tx_context::TxContext" } }
      ],
      returns: [{ body: { type: 6 } }]
    }
  }],
  SimulateTransaction: [{ transaction: executed("abort"), command_outputs: [{ return_values: [{ argument: { kind: 3, result: 0 }, value: bcs("u64", 1, 0, 0, 0, 0, 0, 0, 0) }], mutated_by_ref: [{ value: bcs("x", 1) }] }], suggested_gas_price: 800n }],
  ExecuteTransaction: [{ transaction: executed("ok") }],
  GetTransaction: [{ transaction: executed("abort") }],
  GetCheckpoint: [{ checkpoint }],
  ListCheckpoints: [{ checkpoint, watermark: { checkpoint: 42n }, end: { reason: 3 } }],
  SubscribeCheckpoints: [{ cursor: 42n, checkpoint }],
  ListEvents: [{ event, watermark: { checkpoint: 42n }, end: { reason: 3 } }],
  SubscribeEvents: [{ event }],
  ListDynamicFields: [{
    dynamic_fields: [{
      kind: 1,
      parent: A(0x9),
      field_id: A(0xf),
      field_object: object(0xf),
      name: bcs("u64", 1, 0, 0, 0, 0, 0, 0, 0),
      value: bcs("bool", 1),
      value_type: "bool",
      child_object: object(0xe)
    }],
    next_page_token: new Uint8Array()
  }]
}

/** A node that encodes each request with the handle the service passed (running its checks) and answers with the full response, decoded by the lean or the full handle. */
const node = (decodeWith: "lean" | "full") => {
  const seen = new Set<string>()
  const respond = (method: Rpc<any, any, boolean>, req: unknown) => {
    const name = short(method.path)
    seen.add(name)
    method.codec().encode(req)
    const full = fullByPath.get(method.path)!
    const decoder = decodeWith === "lean" ? method.codec() : full.codec()
    return (responses[name] ?? []).map((r) => Result.getOrThrow(decoder.decode(encodeResponse(name, r))))
  }
  const layer = Layer.succeed(GrpcWeb, GrpcWeb.of({
    unary: (method, req) => Effect.sync(() => respond(method, req)[0]) as any,
    serverStream: (method, req) => Stream.suspend(() => Stream.fromIterable(respond(method, req))) as any
  }))
  return { layer, seen }
}

const services = Layer.mergeAll(
  SuiGrpc.ChainGrpc.layer,
  SuiGrpc.PackagesGrpc.layer,
  SuiGrpc.TransactionsGrpc.layer,
  SuiGrpc.CheckpointsGrpc.layer,
  SuiGrpc.CheckpointDataGrpc.layer,
  SuiGrpc.EventsGrpc.layer,
  Layer.mergeAll(SuiGrpc.CoinsGrpc.layer, SuiGrpc.DynamicFieldsGrpc.layer).pipe(Layer.provideMerge(SuiGrpc.ObjectsGrpc.layer))
)

const everyCall = Effect.gen(function*() {
  const chain = yield* Chain
  const objects = yield* Objects
  const coins = yield* Coins
  const packages = yield* Packages
  const transactions = yield* Transactions
  const checkpoints = yield* Checkpoints
  const data = yield* CheckpointData
  const events = yield* Events
  const fields = yield* DynamicFields
  const all = <A, E>(s: Stream.Stream<A, E>) => Stream.runCollect(Stream.take(s, 5))
  return {
    info: yield* chain.info,
    gasPrice: yield* chain.referenceGasPrice,
    objects: yield* Effect.all([objects.get(A(0x5)), Effect.flip(objects.get(A(0x6)))], { concurrency: "unbounded" }),
    owned: yield* all(objects.listOwned(A(0xa11ce))),
    balance: yield* coins.getBalance(A(0xa11ce)),
    coinList: yield* all(coins.list(A(0xa11ce))),
    fn: yield* packages.getFunction({ package: A(2), module: "pay", function: "transfer" }),
    simulate: yield* transactions.simulate(bytes(1, 2, 3)),
    dryRun: yield* transactions.simulate(bytes(1, 2, 3), { checks: false }),
    execute: yield* transactions.execute(bytes(1, 2, 3), [bytes(4, 5)]),
    get: yield* transactions.get("8YvJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"),
    checkpoint: yield* data.get(42n),
    checkpointList: yield* all(data.list({ start: 42n, end: 43n })),
    checkpointSubscribe: yield* Stream.runCollect(Stream.take(data.subscribe, 1)),
    summarySubscribe: yield* Stream.runCollect(Stream.take(checkpoints.subscribe, 1)),
    summaries: yield* all(checkpoints.list({ start: 42n, end: 43n })),
    events: yield* all(events.list({ start: 42n, end: 43n })),
    subscribed: yield* Stream.runCollect(Stream.take(events.subscribe(), 1)),
    fields: yield* all(fields.list(A(0x9)))
  }
})

const run = (decodeWith: "lean" | "full") => {
  const n = node(decodeWith)
  return Effect.runPromise(everyCall.pipe(Effect.provide(services.pipe(Layer.provide(n.layer))))).then((r) => ({ r, seen: n.seen }))
}

describe("pruned gRPC handles", () => {
  test("every service call decodes the same with pruned and full descriptors", async () => {
    const lean = await run("lean")
    const full = await run("full")
    expect(lean.r).toEqual(full.r)
    // The fixture really exercises the read fields.
    expect(lean.r.gasPrice).toBe(750n)
    expect(lean.r.info.checkpointHeight > 0n).toBe(true)
    expect(lean.r.execute.changedObjects.length).toBe(2)
    expect(lean.r.checkpoint.transactions.length).toBe(2)
    // Every pruned handle was called.
    expect([...lean.seen].sort()).toEqual(Object.keys(Lean).map((k) => k.split("_").pop()!).sort())
  })

  test("a read-mask path or request field outside the pruned descriptor is a defect", () => {
    const codec = Lean.LedgerService_GetEpoch.codec()
    expect(() => codec.encode({ read_mask: { paths: ["reference_gas_price", "protocol_config"] } })).toThrow(/read-mask path "protocol_config"/)
    expect(() => codec.encode({})).toThrow(/a read mask is required/)
    expect(() => codec.encode({ read_mask: { paths: ["reference_gas_price"] } })).not.toThrow()
    const execute = Lean.TransactionExecutionService_ExecuteTransaction.codec()
    const read_mask = { paths: ["effects.status"] }
    expect(() => execute.encode({ transaction: { bcs: { value: bytes(1) } }, read_mask })).not.toThrow()
    expect(() => execute.encode({ transaction: { sender: A(1) }, read_mask })).toThrow(/request field transaction.sender/)
    expect(() => execute.encode({ signatures: [{ bcs: { value: bytes(1) }, scheme: 0 }], read_mask })).toThrow(/signatures.scheme/)
  })

  test("SuiGrpc.layer also provides its GrpcWeb (X-8)", async () => {
    const layer = SuiGrpc.layer({ url: "https://example.invalid" }).pipe(Layer.provide(FetchHttpClient.layer))
    // EvidenceGrpc / ZkLoginVerifierGrpc / Rpc escape hatches need GrpcWeb: no second transport.
    const found = await Effect.runPromise(Effect.gen(function*() {
      yield* Chain
      return typeof (yield* GrpcWeb).unary
    }).pipe(Effect.provide(layer)))
    expect(found).toBe("function")
  })
})
