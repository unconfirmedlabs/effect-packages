import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Request from "effect/Request"
import * as RequestResolver from "effect/RequestResolver"
import * as Stream from "effect/Stream"
import type { Address } from "../Address.ts"
import { ObjectNotFound, Objects, type SuiObject } from "../Objects.ts"
import { RpcError } from "../RpcError.ts"
import { OBJECT_MASK, object } from "./convert.ts"
import * as Rpc from "./generated/rpc.ts"
import { GrpcWeb } from "./GrpcWeb.ts"

const MAX_BATCH = 50

const toExit = (o: Parameters<typeof object>[0]): Exit.Exit<SuiObject, RpcError> => {
  try {
    return Exit.succeed(object(o))
  } catch (e) {
    return Exit.fail(new RpcError({ method: "BatchGetObjects", code: "DATA_LOSS", message: String(e) }))
  }
}

class GetObject extends Request.Class<{ readonly objectId: Address }, SuiObject, ObjectNotFound | RpcError> {}

/**
 * `Objects` over gRPC. Concurrent `get`s anywhere in the program are
 * deduplicated and coalesced into `BatchGetObjects` calls of up to 50.
 */
export const layer: Layer.Layer<Objects, never, GrpcWeb> = Layer.effect(
  Objects,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb

    const resolver = RequestResolver.make<GetObject>((entries) =>
      grpc
        .unary(Rpc.LedgerService_BatchGetObjects, {
          requests: entries.map((e) => ({ object_id: e.request.objectId })),
          read_mask: OBJECT_MASK
        })
        .pipe(
          Effect.match({
            onFailure: (error) => entries.forEach((e) => e.completeUnsafe(Exit.fail(error))),
            onSuccess: (res) =>
              entries.forEach((entry, i) => {
                const r = res.objects?.[i]?.result
                entry.completeUnsafe(
                  r?._tag === "object"
                    ? toExit(r.value)
                    : Exit.fail(new ObjectNotFound({ objectId: entry.request.objectId }))
                )
              })
          })
        )
    ).pipe(
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
              Effect.map((r) =>
                [(r.objects ?? []).map(object), Option.fromNullishOr(r.next_page_token?.length ? r.next_page_token : undefined)] as const
              )
            ))
    })
  })
)
