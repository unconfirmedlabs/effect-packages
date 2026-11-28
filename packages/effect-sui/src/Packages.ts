/**
 * Move package metadata. Packages are immutable, so implementations cache.
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { Address } from "./Address.ts"
import type { RpcError } from "./RpcError.ts"

export type Reference = "Immutable" | "Mutable" | "Value"

export interface Parameter {
  readonly reference: Reference
  /** For datatypes, the type name without type arguments (`0x…2::tx_context::TxContext`). */
  readonly typeName: string | undefined
  /**
   * For a generic datatype, its type arguments as type strings
   * (`Coin<0x…::wal::WAL>` gives `["0x…::wal::WAL"]`). Absent when the
   * datatype has none, or when an argument is a function type parameter.
   */
  readonly typeArguments?: ReadonlyArray<string>
}

export interface MoveFunction {
  readonly isEntry: boolean
  readonly parameters: ReadonlyArray<Parameter>
}

export interface FunctionTarget {
  readonly package: Address
  readonly module: string
  readonly function: string
}

/** No object at the id. (An object that isn't a package is `RpcError` `INVALID_ARGUMENT`.) */
export class PackageNotFound extends /* @__PURE__ */ Schema.TaggedError<PackageNotFound>()("PackageNotFound", {
  packageId: Schema.String
}) {
  override get message(): string {
    return `package ${this.packageId} not found`
  }
}

export class Packages extends /* @__PURE__ */ Context.Service<Packages, {
  readonly getFunction: (target: FunctionTarget) => Effect.Effect<MoveFunction, RpcError>
  /**
   * The package's stored modules: name -> compiled module bytes.
   * Read from the object, so it works when the publish transaction is pruned.
   * Not cached (a package can be hundreds of KB).
   */
  readonly getModules: (packageId: Address) => Effect.Effect<ReadonlyMap<string, Uint8Array>, PackageNotFound | RpcError>
}>()("@unconfirmed/sui/Packages") {}
