/**
 * Move package metadata. Packages are immutable, so implementations cache.
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
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
  /**
   * The full parameter type as a type string, without the reference
   * (`u64`, `vector<u8>`, `0x…2::coin::Coin<0x…2::sui::SUI>`). Absent when it
   * mentions a function type parameter, or when the transport doesn't report it.
   */
  readonly type?: string
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

export class Packages extends /* @__PURE__ */ Context.Service<Packages, {
  readonly getFunction: (target: FunctionTarget) => Effect.Effect<MoveFunction, RpcError>
}>()("@unconfirmed/sui/Packages") {}
