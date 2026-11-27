import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Request from "effect/Request"
import * as RequestResolver from "effect/RequestResolver"
import * as Stream from "effect/Stream"
import type { Address } from "../Address.ts"
import { ObjectNotFound, Objects, type SuiObject } from "../Objects.ts"
import { RpcCode, RpcError } from "../RpcError.ts"
import { convert, OBJECT_MASK, object } from "./convert.ts"
import type * as P from "./generated/proto.ts"
import * as Rpc from "./generated/lean.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

const MAX_BATCH = 50
const BATCH = Rpc.LedgerService_BatchGetObjects.path

const malformed = (message: string) => new RpcError({ method: BATCH, code: "DATA_LOSS", message: `malformed response: ${message}` })

/**
 * One entry of a `BatchGetObjects` answer: an object, `ObjectNotFound` only for
 * a `NOT_FOUND` status, any other per-object status as that `RpcError`, and a
 * missing entry as `DATA_LOSS`.
 */
const toExit = (objectId: Address, r: P.GetObjectResult | undefined): Exit.Exit<SuiObject, ObjectNotFound | RpcError> => {
  const result = r?.result
  if (result === undefined) return Exit.fail(malformed(`no result for ${objectId}`))
  if (result._tag === "error") {
    const code = result.value.code ?? 2
    if (code === 5) return Exit.fail(new ObjectNotFound({ objectId }))
    return Exit.fail(new RpcError({ method: BATCH, code: RpcCode[code] ?? "UNKNOWN", message: result.value.message ?? "" }))
  }
  try {
    return Exit.succeed(object(result.value))
  } catch (e) {
    return Exit.fail(malformed(e instanceof Error ? e.message : String(e)))
  }
}

class GetObject extends Request.Class<{ readonly objectId: Address }, SuiObject, ObjectNotFound | RpcError> {}

/**
 * `Objects` over gRPC. Concurrent `get`s anywhere in the program are
 * coalesced into `BatchGetObjects` calls of up to 50, and gets of the same id
 * within a batch share one entry.
 */
export const layer: Layer.Layer<Objects, never, GrpcWeb> = Layer.effect(
  Objects,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb

    const resolver = RequestResolver.make<GetObject>((entries) => {
      const ids = [...new Set(entries.map((e) => e.request.objectId))]
      return grpc
        .unary(Rpc.LedgerService_BatchGetObjects, { requests: ids.map((object_id) => ({ object_id })), read_mask: OBJECT_MASK })
        .pipe(
          Effect.match({
            onFailure: (error) => entries.forEach((e) => e.completeUnsafe(Exit.fail(error))),
            onSuccess: (res) => {
              const byId = new Map(ids.map((id, i) => [id, toExit(id, res.objects?.[i])] as const))
              entries.forEach((entry) => entry.completeUnsafe(byId.get(entry.request.objectId)!))
            }
          })
        )
    }).pipe(
      RequestResolver.setDelay("1 millis"),
      RequestResolver.batchN(MAX_BATCH),
      RequestResolver.withSpan("Objects.get.resolver")
    )

    return Objects.of({
      get: (objectId) =>
        Effect.request(new GetObject({ objectId }), resolver).pipe(
          Effect.withSpan("Objects.get", { attributes: { objectId } })
        ),
      listOwned: (owner, options) =>
        Stream.paginate(undefined as Uint8Array | undefined, (page_token) =>
          grpc
            .unary(Rpc.StateService_ListOwnedObjects, {
              owner,
              read_mask: OBJECT_MASK,
              page_size: options?.pageSize ?? 100,
              ...(page_token && { page_token }),
              ...(options?.type && { object_type: options.type })
            })
            .pipe(
              Effect.flatMap((r) =>
                convert(Rpc.StateService_ListOwnedObjects.path, () =>
                  [(r.objects ?? []).map(object), Option.fromNullishOr(r.next_page_token?.length ? r.next_page_token : undefined)] as const)
              )
            ))
    })
  })
)
