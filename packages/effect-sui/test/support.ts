import type * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { GrpcWeb } from "../src/grpc/GrpcWeb.ts"
import type { RpcError } from "../src/RpcError.ts"

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

export interface GrpcScript {
  readonly unary?: (method: string, req: any, n: number) => Effect.Effect<any, RpcError>
  readonly stream?: (method: string, req: any, n: number) => Stream.Stream<any, RpcError>
}

/** A scripted node behind `GrpcWeb`: records every request; `n` counts calls per method. */
export const fakeGrpc = (script: GrpcScript) => {
  const requests: Array<{ method: string; req: any }> = []
  const counts = new Map<string, number>()
  const tick = (m: string) => {
    const n = counts.get(m) ?? 0
    counts.set(m, n + 1)
    return n
  }
  const short = (path: string) => path.split("/").pop()!
  const layer = Layer.succeed(GrpcWeb, GrpcWeb.of({
    unary: (method, req) =>
      Effect.suspend(() => {
        const m = short(method.path)
        requests.push({ method: m, req })
        return script.unary ? script.unary(m, req, tick(m)) : Effect.die(`unexpected ${m}`)
      }),
    serverStream: (method, req) =>
      Stream.suspend(() => {
        const m = short(method.path)
        requests.push({ method: m, req })
        return script.stream ? script.stream(m, req, tick(m)) : Stream.die(`unexpected ${m}`)
      })
  }))
  return { layer, requests }
}

export { DEVNET, faucet, grpcLayer, live, TESTNET } from "@unconfirmed/test-support/live"
