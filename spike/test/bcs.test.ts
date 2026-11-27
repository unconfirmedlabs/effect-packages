/**
 * Byte-for-byte parity with @mysten/sui's BCS for the transaction data model.
 * @mysten/sui is a devDependency used only as the reference implementation.
 */
import { bcs as mysten } from "@mysten/sui/bcs"
import { toBase64 } from "@mysten/sui/utils"
import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import * as Bcs from "../src/bcs/Bcs.ts"
import * as T from "../src/sui/Types.ts"

/** Convert our `_tag` representation into @mysten/bcs's `{ Variant: payload }`, guided by the layout. */
const toMysten = (l: Bcs.Layout, v: any): any => {
  switch (l._tag) {
    case "ubig":
      return v.toString()
    case "byteVector":
      return v
    case "vector":
    case "fixedArray":
      return v.map((x: any) => toMysten(l.item(), x))
    case "option":
      return Option.isNone(v) ? null : toMysten(l.item(), v.value)
    case "tuple":
      return l.items.map((item, i) => toMysten(item(), v[i]))
    case "struct":
      // @mysten/sui's SharedObjectRef takes `{ mutable, mutability: "Name" }` rather than the raw enum
      if ("mutability" in v && "initialSharedVersion" in v) {
        return { objectId: v.objectId, initialSharedVersion: v.initialSharedVersion.toString(), mutable: v.mutability._tag === "Mutable", mutability: v.mutability._tag }
      }
      return Object.fromEntries(l.fields.map(([k, f]) => [k, toMysten(f(), v[k])]))
    case "enum": {
      const variant = l.variants.find((x) => x.name === v._tag)!
      if (variant.payload === "unit") return { [v._tag]: true }
      if (variant.payload === "value") return { [v._tag]: toMysten(variant.layout!(), v.value) }
      return { [v._tag]: toMysten(variant.layout!(), v) }
    }
    default:
      return v
  }
}

const A = (n: number) => T.address(n.toString(16))
import { base58 } from "@scure/base"
const D = (seed: number) => base58.encode(new Uint8Array(32).fill(seed)) as T.ObjectDigest
const _unusedD = (seed: number) => {
  const b = new Uint8Array(32).fill(seed)
  return "11111111111111111111111111111111".length && (require("@scure/base").base58.encode(b) as T.ObjectDigest)
}

const sample: T.TransactionData = {
  _tag: "V1",
  kind: {
    _tag: "ProgrammableTransaction",
    inputs: [
      { _tag: "Pure", bytes: new Uint8Array([1, 2, 3]) },
      { _tag: "Object", value: { _tag: "ImmOrOwnedObject", objectId: A(0xabc), version: 7n, digest: D(9) } },
      {
        _tag: "Object",
        value: {
          _tag: "SharedObject",
          objectId: A(6),
          initialSharedVersion: 1n,
          mutability: { _tag: "Immutable" }
        }
      }
    ],
    commands: [
      { _tag: "SplitCoins", coin: { _tag: "GasCoin" }, amounts: [{ _tag: "Input", value: 0 }] },
      {
        _tag: "MoveCall",
        package: A(2),
        module: "coin",
        function: "value",
        typeArguments: [T.parseTypeTag("0x2::sui::SUI")],
        arguments: [{ _tag: "NestedResult", value: [0, 0] }, { _tag: "Input", value: 2 }]
      },
      {
        _tag: "MakeMoveVec",
        type: Option.some(T.parseTypeTag("vector<0x2::coin::Coin<0x2::sui::SUI>>")),
        elements: []
      },
      { _tag: "TransferObjects", objects: [{ _tag: "Result", value: 0 }], address: { _tag: "Input", value: 1 } }
    ]
  },
  sender: A(0x1234),
  gasData: { payment: [{ objectId: A(0xbeef), version: 3n, digest: D(4) }], owner: A(0x1234), price: 1000n, budget: 5_000_000n },
  expiration: {
    _tag: "ValidDuring",
    minEpoch: Option.some(10n),
    maxEpoch: Option.some(11n),
    minTimestamp: Option.none(),
    maxTimestamp: Option.none(),
    chain: D(1),
    nonce: 42
  }
}

describe("Bcs", () => {
  test("TransactionData matches @mysten/sui byte for byte", () => {
    const ours = Bcs.encodeSync(T.TransactionData)(sample)
    const theirs = mysten.TransactionData.serialize(toMysten(Bcs.layoutOf(T.TransactionData), sample)).toBytes()
    expect(toBase64(ours)).toBe(toBase64(theirs))
  })

  test("round trips", () => {
    const bytes = Bcs.encodeSync(T.TransactionData)(sample)
    const back = Bcs.decodeSync(T.TransactionData)(bytes)
    expect(Bcs.encodeSync(T.TransactionData)(back)).toEqual(bytes)
  })

  test("decodes bytes produced by @mysten/sui", () => {
    const theirs = mysten.TransactionData.serialize(toMysten(Bcs.layoutOf(T.TransactionData), sample)).toBytes()
    const ours = Bcs.decodeSync(T.TransactionData)(theirs)
    expect(ours._tag).toBe("V1")
    expect(ours.kind.commands.length).toBe(4)
  })

  test("out-of-range values are a typed failure, not truncated bytes", () => {
    const r = Bcs.encode(Bcs.u8)(256)
    expect(Result.isFailure(r)).toBe(true)
  })

  test("trailing bytes are rejected", () => {
    const r = Bcs.decode(Bcs.u16)(new Uint8Array([1, 0, 0]))
    expect(Result.isFailure(r)).toBe(true)
  })

  test("type tags round-trip through the string form", () => {
    const s = "vector<0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>>"
    expect(T.formatTypeTag(T.parseTypeTag(s))).toBe(s)
    const ours = Bcs.encodeSync(T.TypeTag)(T.parseTypeTag(s))
    expect(ours).toEqual(mysten.TypeTag.serialize(s).toBytes())
  })
})
