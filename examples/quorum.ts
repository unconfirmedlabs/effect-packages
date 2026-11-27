/**
 * README examples (Quorum), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Quorum from "@unconfirmed/quorum"

interface Node { readonly shards: ReadonlyArray<number>; readonly url: string }
declare const committee: { readonly nodes: ReadonlyArray<Node> }
declare const nodes: ReadonlyArray<Node>
declare const nShards: number
declare const maxFaulty: number
declare const f: number
declare const storeAndConfirm: (node: Node) => Effect.Effect<Uint8Array, { readonly retryable: boolean }>
declare const getStatus: (node: Node) => Effect.Effect<{ readonly epoch: number }, Error>
declare const canonical: (status: { readonly epoch: number }) => string
declare const weight: (node: Node) => number
declare const nodeRetry: Schedule.Schedule<unknown>

export const quorum = Effect.gen(function*() {
  // #region readme
  const { successes } = yield* Quorum.run(committee.nodes, {
    weight: (node) => node.shards.length,
    threshold: nShards - maxFaulty,
    run: storeAndConfirm,                            // one attempt at one member
    retry: nodeRetry, retryWhile: (e) => e.retryable,  // per-member retry
    concurrency: 50, order: "weightedShuffle",
    linger: (elapsed) => Duration.sum(Duration.times(elapsed, 0.5), Duration.millis(500))  // wait for stragglers
  })

  const { winner } = yield* Quorum.agree(nodes, { weight, run: getStatus, key: canonical, threshold: f + 1, quorum: 2 * f + 1 })
  // #endregion
})
