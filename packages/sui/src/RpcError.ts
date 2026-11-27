/**
 * The one transport failure every capability service can raise, whatever the
 * transport. Codes are gRPC's (GraphQL and HTTP map onto them); `retryable`
 * is decided from the code, once, where the failure happens.
 */
import * as Schema from "effect/Schema"

export const RpcCode = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED"
] as const
export type RpcCode = (typeof RpcCode)[number]

const RETRYABLE: ReadonlySet<RpcCode> = /* @__PURE__ */ new Set(["UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED"])

export class RpcError extends /* @__PURE__ */ Schema.TaggedError<RpcError>()("RpcError", {
  method: Schema.String,
  code: Schema.Literals(RpcCode),
  message: Schema.String
}) {
  get retryable(): boolean {
    return RETRYABLE.has(this.code)
  }
}

export const isRetryable = (e: unknown): boolean => e instanceof RpcError && e.retryable
