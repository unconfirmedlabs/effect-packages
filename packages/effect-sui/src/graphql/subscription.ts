/**
 * A cursor-resumed, boundedly reconnecting GraphQL subscription, shared by the
 * checkpoint, event and checkpoint-data subscriptions.
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as GraphQLClientError from "effect/graphql/GraphQLClientError"
import * as Schedule from "effect/Schedule"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import type { RpcError } from "../RpcError.ts"
import { toRpcError } from "./convert.ts"

/** Consecutive failed connections (none delivering an item) before a subscription gives up. */
export const MAX_RECONNECTS = 5

/** For `GraphQLClient.make`: the client's own resubscription restarts from the tip, so it is off. */
export const noClientRetry = { subscriptionRetry: Schedule.recurs(0) }

/** Backoff before reconnect `n` (1-based): 500ms * 1.5^(n-1), at most 5s, never less than the server's `Retry-After`. */
const backoff = (n: number, retryAfter: Duration.Duration | undefined): Duration.Duration => {
  const d = Duration.millis(Math.min(500 * 1.5 ** (n - 1), 5000))
  return retryAfter === undefined ? d : Duration.max(d, retryAfter)
}

/**
 * `open(after)` opens the subscription after a cursor (`null`: from the tip).
 * Each edge's cursor is remembered; after a retryable failure the stream
 * reconnects with backoff (honouring `Retry-After`) and resumes after the last
 * cursor, so nothing is skipped or repeated. After {@link MAX_RECONNECTS}
 * consecutive failures without an edge in between, or any non-retryable
 * failure, it fails with the last `RpcError`. Emits the edges; an edge with a
 * `null` node (progress) only advances the cursor.
 */
export const resubscribe = <N>(
  open: (after: string | null) => Stream.Stream<{ readonly cursor: string; readonly node: N | null }, GraphQLClientError.GraphQLClientError>
): Stream.Stream<{ readonly cursor: string; readonly node: N }, RpcError> =>
  Stream.suspend(() => {
    let cursor: string | null = null
    const connect = (failures: number): Stream.Stream<{ readonly cursor: string; readonly node: N }, RpcError> =>
      Stream.suspend(() => {
        let progressed = false
        return open(cursor).pipe(
          Stream.filterMap((edge) => {
            cursor = edge.cursor
            progressed = true
            return edge.node === null ? Result.failVoid : Result.succeed({ cursor: edge.cursor, node: edge.node })
          }),
          Stream.catch((error) => {
            const rpc = toRpcError(error)
            const n = progressed ? 1 : failures + 1
            if (!rpc.retryable || n > MAX_RECONNECTS) return Stream.fail(rpc)
            return Stream.fromEffectDrain(Effect.sleep(backoff(n, error.retryAfter))).pipe(Stream.concat(connect(n)))
          })
        )
      })
    return connect(0)
  })
