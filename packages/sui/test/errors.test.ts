/**
 * Every error class renders a short `message` from its fields (review X-6), so
 * `String(e)`, `Cause.pretty` and promise rejections say more than the tag.
 */
import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  CheckpointData,
  DynamicFields,
  Events,
  Objects,
  PrivateKey,
  Ptb,
  Resolve,
  SignatureScheme,
  Signer,
  TransactionJson,
  Transactions,
  Tx
} from "../src/index.ts"

const ID = "0x" + "ab".repeat(32)

describe("error messages", () => {
  test("render their fields", () => {
    const cases: Array<[Error, string]> = [
      [new Objects.ObjectNotFound({ objectId: ID }), `object ${ID} not found`],
      [new Objects.ObjectDecodeError({ objectId: ID, type: "0x2::coin::Coin<0x2::sui::SUI>", issue: "eof" }), `cannot decode object ${ID} as 0x2::coin::Coin<0x2::sui::SUI>: eof`],
      [new Resolve.InsufficientGas({ owner: ID, required: 10n, available: 3n }), `${ID} has 3 MIST for gas, needs 10`],
      [new Resolve.InsufficientBalance({ owner: ID, coinType: "0x2::sui::SUI", required: 10n, available: 3n }), `${ID} has 3 of 0x2::sui::SUI, needs 10`],
      [new Resolve.Incomplete({ missing: "gas budget" }), "missing gas budget"],
      [new Resolve.InvalidTransaction({ reason: "too many inputs" }), "too many inputs"],
      [new Resolve.GasEstimationFailed({ description: "MoveAbort", command: 1, abortCode: 7n, location: "0x2::m::f" }), "gas estimation failed: MoveAbort in command 1, abort code 7 at 0x2::m::f"],
      [new Resolve.GasEstimationFailed({ description: "InsufficientGas" }), "gas estimation failed: InsufficientGas"],
      [new Resolve.AllowanceSpenderMismatch({ allowance: ID, spender: null, sender: "0x1" }), `allowance ${ID} spender is none, sender is 0x1`],
      [new Tx.ExecutionFailed({ digest: "D1", description: "MoveAbort", abortCode: 2n }), "transaction D1 failed: MoveAbort, abort code 2"],
      [new Transactions.TransactionNotFound({ digest: "D1" }), "transaction D1 not found"],
      [new Transactions.TransactionWaitTimeout({ digest: "D1", timeoutMillis: 500 }), "transaction D1 not seen within 500 ms"],
      [new CheckpointData.CheckpointNotFound({ sequenceNumber: 42n }), "checkpoint 42 not found"],
      [new DynamicFields.DynamicFieldNotFound({ parent: "0xp", nameType: "u64", fieldId: "0xf" }), "dynamic field 0xf (u64) of 0xp not found"],
      [new Events.EventDecodeError({ transactionDigest: "D1", eventIndex: 0, type: "0x2::e::E", issue: "eof" }), "cannot decode event 0 of D1 as 0x2::e::E: eof"],
      [new Ptb.InvalidPureValue({ issue: "bad address" }), "bad address"],
      [new TransactionJson.UnsupportedTransactionJson({ construct: "Intent", reason: "unknown" }), "unsupported Intent: unknown"],
      [new SignatureScheme.InvalidSignature({ scheme: "ED25519", reason: "bad length" }), "invalid ED25519 signature: bad length"]
    ]
    for (const [e, message] of cases) {
      expect(e.message).toBe(message)
      expect(String(e)).toBe(`${(e as unknown as { _tag: string })._tag}: ${message}`)
    }
  })

  test("show in Cause.pretty and promise rejections; encoding is unchanged", async () => {
    const e = new Objects.ObjectNotFound({ objectId: ID })
    expect(Cause.pretty(Cause.fail(e))).toContain(`ObjectNotFound: object ${ID} not found`)
    const rejected = await Effect.runPromise(Effect.fail(e)).catch((x: unknown) => x as Error)
    expect(rejected.message).toContain(`object ${ID} not found`)
    expect(Schema.encodeSync(Objects.ObjectNotFound)(e)).toEqual({ _tag: "ObjectNotFound", objectId: ID })
  })

  test("an invalid secret key's message does not contain the key", async () => {
    const encoded = await Effect.runPromise(PrivateKey.encode({ flag: 0, secretKey: new Uint8Array(32).fill(7) }))
    const tampered = encoded.slice(0, -1) + (encoded.endsWith("q") ? "p" : "q")
    const e = await Effect.runPromise(Effect.flip(PrivateKey.decode(tampered)))
    expect(e).toBeInstanceOf(Signer.InvalidKey)
    expect(e.message.length).toBeGreaterThan(0)
    expect(e.message).not.toContain(tampered)
    expect(e.message).not.toContain(encoded.slice(10, 40))
  })
})
