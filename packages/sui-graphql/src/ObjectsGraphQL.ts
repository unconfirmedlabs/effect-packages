import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as GraphQL from "effect/graphql/GraphQL"
import * as GraphQLClient from "effect/graphql/GraphQLClient"
import * as GraphQLGroup from "effect/graphql/GraphQLGroup"
import type * as GraphQLProtocol from "effect/graphql/GraphQLProtocol"
import * as GraphQLResolver from "effect/graphql/GraphQLResolver"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as RequestResolver from "effect/RequestResolver"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Objects from "@unconfirmed/sui/Objects"
import { RpcError } from "@unconfirmed/sui/RpcError"
import { call, MOVE_OBJECT_FIELDS, MoveObjectNode, moveObject, OBJECT_FIELDS, ObjectNode, object } from "./convert.ts"

/** The largest batch sent (the server accepts up to `serviceConfig.maxMultiGetSize`, 200 on Mysten's endpoints). */
const MAX_BATCH = 50
/** The largest page the server allows for `Address.objects`. */
const MAX_PAGE = 50

export const MultiGetObjects = GraphQL.query("MultiGetObjects", {
  document: `query MultiGetObjects($keys:[ObjectKey!]!){multiGetObjects(keys:$keys){${OBJECT_FIELDS}}}`,
  variables: { keys: Schema.Array(Schema.Struct({ address: Schema.String })) },
  // Entries are decoded one by one in `get`, so one malformed object fails only its own lookup.
  result: Schema.Struct({ multiGetObjects: Schema.Array(Schema.NullOr(Schema.Unknown)) })
})

export const ListOwnedObjects = GraphQL.query("ListOwnedObjects", {
  document: "query ListOwnedObjects($owner:SuiAddress!,$first:Int,$after:String,$type:String){" +
    `address(address:$owner){objects(first:$first,after:$after,filter:{type:$type}){pageInfo{hasNextPage endCursor}nodes{${MOVE_OBJECT_FIELDS}}}}}`,
  variables: {
    owner: Schema.String,
    first: Schema.Number,
    after: Schema.NullOr(Schema.String),
    type: Schema.NullOr(Schema.String)
  },
  result: Schema.Struct({
    address: Schema.NullOr(Schema.Struct({
      objects: Schema.NullOr(Schema.Struct({
        pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
        nodes: Schema.Array(MoveObjectNode)
      }))
    }))
  })
})

export const group = GraphQLGroup.make(MultiGetObjects, ListOwnedObjects)

const decodeObject = Schema.decodeUnknownEffect(ObjectNode)

/**
 * `Objects` over GraphQL. Concurrent `get`s anywhere in the program are
 * deduplicated and coalesced into `multiGetObjects` requests of up to 50 keys.
 *
 * `listOwned`'s `type` filter is passed to GraphQL as is, so it also accepts a
 * package (`0x2`) or module (`0x2::coin`) prefix, which the gRPC layer rejects.
 */
export const layer: Layer.Layer<Objects.Objects, never, GraphQLProtocol.GraphQLProtocol> = Layer.effect(
  Objects.Objects,
  Effect.gen(function*() {
    const client = yield* GraphQLClient.make(group)

    // A `null` entry fails only its lookup with NoSuchElementError; a GraphQL
    // error under `multiGetObjects.<i>` fails only lookup `i`.
    const resolver = GraphQLResolver.ordered(client.MultiGetObjects, {
      variables: (ids: ReadonlyArray<string>) => ({ keys: ids.map((address) => ({ address })) }),
      path: ["multiGetObjects"]
    }).pipe(
      RequestResolver.setDelay("1 millis"),
      RequestResolver.batchN(MAX_BATCH),
      RequestResolver.withSpan("Objects.get.resolver")
    )
    const lookup = GraphQLResolver.request(resolver)

    return Objects.Objects.of({
      get: (objectId) =>
        lookup(objectId).pipe(
          Effect.flatMap((entry): Effect.Effect<Objects.SuiObject, Objects.ObjectNotFound | RpcError> =>
            entry === null || entry === undefined
              ? Effect.fail(new Objects.ObjectNotFound({ objectId }))
              : decodeObject(entry).pipe(
                Effect.map(object),
                Effect.mapError((e) =>
                  new RpcError({ method: "MultiGetObjects", code: "DATA_LOSS", message: `malformed object ${objectId}: ${e.message}` })
                )
              )
          ),
          Effect.catchIf(Cause.isNoSuchElementError, () => Effect.fail(new Objects.ObjectNotFound({ objectId }))),
          call,
          Effect.withSpan("Objects.get", { attributes: { objectId } })
        ),
      listOwned: (owner, options) =>
        Stream.paginate(null as string | null, (after) =>
          client
            .ListOwnedObjects({
              owner,
              first: Math.min(options?.pageSize ?? MAX_PAGE, MAX_PAGE),
              after,
              type: options?.type ?? null
            })
            .pipe(
              call,
              Effect.map((r) => {
                const page = r.address?.objects
                const next = page?.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
                return [(page?.nodes ?? []).map(moveObject), Option.fromNullishOr(next)] as const
              })
            ))
    })
  })
)
