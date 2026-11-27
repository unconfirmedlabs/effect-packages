import type * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Option from "effect/Option"

/** Our `_tag` values -> @mysten/bcs `{ Variant: payload }` input, guided by the layout. */
export const toMysten = (l: Bcs.Layout, v: any): any => {
  switch (l._tag) {
    case "ubig":
      return v.toString()
    case "vector":
    case "fixedArray":
      return v.map((x: any) => toMysten(l.item(), x))
    case "option":
      return Option.isNone(v) ? null : toMysten(l.item(), v.value)
    case "tuple":
      return l.items.map((item, i) => toMysten(item(), v[i]))
    case "struct":
      if ("mutability" in v && "initialSharedVersion" in v) {
        return {
          objectId: v.objectId,
          initialSharedVersion: v.initialSharedVersion.toString(),
          mutable: v.mutability._tag === "Mutable",
          mutability: v.mutability._tag
        }
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

export const toB64 = (b: Uint8Array) => Buffer.from(b).toString("base64")

export { DEVNET, faucet, grpcLayer, live, TESTNET } from "@unconfirmed/test-support/live"
