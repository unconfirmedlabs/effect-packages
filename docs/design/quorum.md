# `@unconfirmed/quorum` — design

Status: implemented (Q1, Q2 and Q3: `giveUp`, from `seal.md` §5), 2026-11-27; open questions decided as recommended (§9). Differences from the original draft are listed in §10. Implementers: read this whole file, then `EXPLORATION.md` §7.

A generic weighted first-threshold-of-n combinator. It depends only on `effect` 4.1.6 and knows nothing about Sui, Walrus or Seal. Two entry points share one engine:

- `Quorum.run`: succeed as soon as the accumulated weight of successful members reaches a threshold.
- `Quorum.agree`: group successful answers by a key; succeed when one key has enough weight.

Reference versions read for this design: `@mysten/walrus` 2.0.1, `@mysten/seal` 2.0.1 (root devDependencies, exact), Walrus Rust repo `MystenLabs/walrus` at `2bd352b6` (workspace version 1.62.0). Paths below starting with `crates/` or `contracts/` are in that repo; `walrus/dist/...` and `seal/dist/...` are under `node_modules/@mysten/`.

## 1. Package layout

```
packages/quorum/
  package.json      name @unconfirmed/quorum, type module, sideEffects false,
                    exports { ".": "./src/index.ts", "./*": "./src/*.ts" }, dependencies { effect: "4.1.6" }
  tsconfig.json     { "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
  src/Quorum.ts     everything public
  src/index.ts      export * as Quorum from "./Quorum.ts"
  test/run.test.ts, test/agree.test.ts, test/order.test.ts, test/world.ts (scripted members)
```

Library code uses namespace subpath imports only (`import * as Effect from "effect/Effect"`). No `Schema` import anywhere in this package (see §4).

## 2. Public API

```ts
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as Schedule from "effect/Schedule"

/** A member that answered. `index` is its position in the input: the member's identity. */
export interface Success<M, A> { readonly member: M; readonly index: number; readonly weight: number; readonly value: A }
/** A member that failed for good (not retryable, or its schedule ran out). `error` is its last error. */
export interface Failure<M, E> { readonly member: M; readonly index: number; readonly weight: number; readonly error: E }
/** A member with no outcome: never started, or interrupted in flight. */
export interface Unsettled<M> { readonly member: M; readonly index: number; readonly weight: number; readonly started: boolean }

export type Order = "given" | "shuffle" | "weightedShuffle"

interface Common<M, A, E, R> {
  readonly weight: (member: M) => number
  /** One attempt at one member. Typed failures count against the member; defects do not (§3.6). */
  readonly run: (member: M) => Effect.Effect<A, E, R>
  /** Per-member retry policy. Absent: one attempt. */
  readonly schedule?: Schedule.Schedule<unknown, E>
  /** Retry only these errors (default: all). A `false` makes the failure final at once. */
  readonly while?: (error: E) => boolean
  /** Attempts in flight at once. Default `"unbounded"`. */
  readonly concurrency?: number | "unbounded" | ((progress: Progress) => number)   // a function: asked when a slot may open (as built)
  /** Start order. Default `"given"`. */
  readonly order?: Order
}

export interface Options<M, A, E, R> extends Common<M, A, E, R> {
  /** Succeed when the weight of successes is >= this. */
  readonly threshold: number
  /**
   * After the threshold is reached, keep going for this long so that more members can finish.
   * A function receives the time it took to reach the threshold. Default: none.
   */
  readonly linger?: Duration.Input | ((elapsed: Duration.Duration) => Duration.Input)
  /**
   * Stop early on failures that make success pointless rather than impossible (§3.2). Ends in
   * `QuorumFailed` with `reason: "gaveUp"`. Default: none.
   */
  readonly giveUp?: GiveUp<M, E>
}

export interface GiveUp<M, E> {
  /** Which final failures count. Retried errors count only once the member has failed for good. */
  readonly when: (error: E, member: M) => boolean
  /** Give up once the counted failures weigh at least this much. Finite and > 0. */
  readonly weight: number
  /**
   * Keep running this long after that point; reaching the threshold meanwhile still succeeds, and the
   * call gives up when the window ends, every member has settled, or the threshold becomes unreachable.
   * Default: none (give up at once).
   */
  readonly grace?: Duration.Input
}

export interface Reached<M, A, E> {
  /** In completion order. Their weight sums to `weight`. */
  readonly successes: ReadonlyArray<Success<M, A>>
  readonly weight: number
  readonly totalWeight: number
  /** Failures seen before returning. Never needed for correctness; useful for logs and health tracking. */
  readonly failures: ReadonlyArray<Failure<M, E>>
  readonly unsettled: ReadonlyArray<Unsettled<M>>
}

export declare const run: <M, A, E, R>(
  members: Iterable<M>,
  options: Options<M, A, E, R>
) => Effect.Effect<Reached<M, A, E>, QuorumFailed<M, A, E>, R>

export type Key = string | number | bigint | boolean

export interface Group<M, A, K extends Key> {
  readonly key: K
  readonly weight: number
  /** In completion order. */
  readonly successes: ReadonlyArray<Success<M, A>>
}

export interface AgreeOptions<M, A, K extends Key, E, R> extends Common<M, A, E, R> {
  /** The answer's identity. Keys are compared with `===`: derive a canonical string for structured answers. */
  readonly key: (value: A, member: M) => K
  /** The weight one key needs. */
  readonly threshold: number
  /** The total weight that must have answered before deciding. Default (and minimum): `threshold`. */
  readonly quorum?: number
  /** Among keys at or over the threshold, which wins: positive when `a` is preferred. Default: heavier, then first seen. */
  readonly prefer?: (a: Group<M, A, K>, b: Group<M, A, K>) => number
}

export interface Agreed<M, A, K extends Key, E> {
  readonly winner: Group<M, A, K>
  /** Every group seen, including the winner, in first-seen order. */
  readonly groups: ReadonlyArray<Group<M, A, K>>
  /** Weight of all successes. */
  readonly weight: number
  readonly totalWeight: number
  readonly failures: ReadonlyArray<Failure<M, E>>
  readonly unsettled: ReadonlyArray<Unsettled<M>>
}

export declare const agree: <M, A, K extends Key, E, R>(
  members: Iterable<M>,
  options: AgreeOptions<M, A, K, E, R>
) => Effect.Effect<Agreed<M, A, K, E>, AgreementFailed<M, A, K, E>, R>
```

Errors (`effect/Data`, see §4):

```ts
export class QuorumFailed<M, A, E> extends Data.TaggedError("QuorumFailed")<{
  /** `insufficientWeight`: the members' total weight was below the threshold; nothing ran.
   *  `unreachable`: failures left too little weight to reach it.
   *  `gaveUp`: failures matching `giveUp.when` reached `giveUp.weight` (and its grace, if any, ran out). */
  readonly reason: "insufficientWeight" | "unreachable" | "gaveUp"
  readonly threshold: number
  readonly totalWeight: number
  /** Weight of `successes`. */
  readonly weight: number
  readonly successes: ReadonlyArray<Success<M, A>>
  /** Every member that failed, with its typed error. */
  readonly failures: ReadonlyArray<Failure<M, E>>
  readonly unsettled: ReadonlyArray<Unsettled<M>>
}> {
  /** e.g. "quorum unreachable: 412 of 667 reached, 421 failed, 167 unsettled (total 1000)", or "quorum gave up: …"
   *  in the same format. No member values. */
  get message(): string
}

export class AgreementFailed<M, A, K extends Key, E> extends Data.TaggedError("AgreementFailed")<{
  readonly reason: "insufficientWeight" | "unreachable"
  readonly threshold: number
  readonly quorum: number
  readonly totalWeight: number
  readonly groups: ReadonlyArray<Group<M, A, K>>
  readonly failures: ReadonlyArray<Failure<M, E>>
  readonly unsettled: ReadonlyArray<Unsettled<M>>
}> {
  get message(): string
}
```

Helpers (pure, exported because both consumers need them):

```ts
/** Sum of `weight` over a list of successes, failures or unsettled members. */
export declare const weightOf: (items: Iterable<{ readonly weight: number }>) => number
/** Failed weight that matches a predicate, e.g. the weight of "not found" answers. */
export declare const failedWeight: <M, E>(failures: Iterable<Failure<M, E>>, f: (error: E) => boolean) => number
```

### Usage

```ts
// Walrus: confirmations from n - f shards, then half as long again for stragglers (Rust client's default).
const { successes } = yield* Quorum.run(committee.nodes, {
  weight: (node) => node.shards.length,
  threshold: nShards - maxFaulty,
  run: (node) => storeAndConfirm(node),                       // Effect<Confirmation, NodeError, StorageNodes>
  schedule: nodeRetry,                                        // a capped backoff, e.g. built from Schedule.exponential
  while: (e) => e.retryable,
  linger: (elapsed) => Duration.sum(Duration.times(elapsed, 0.5), Duration.millis(500))
}).pipe(Effect.catchTag("QuorumFailed", (e) => Effect.fail(notEnoughConfirmations(e))))

// Walrus: the first 334 primary slivers, at most 334 requests in flight.
yield* Quorum.run(shards, { weight: () => 1, threshold: 334, concurrency: 334, order: "shuffle", run: fetchSliver })

// Walrus: the latest blob status that f + 1 shards vouch for, after hearing from 2f + 1.
const { winner, groups } = yield* Quorum.agree(committee.nodes, {
  weight: (node) => node.shards.length, run: getStatus,
  key: canonicalStatus, threshold: f + 1, quorum: 2 * f + 1,
  prefer: (a, b) => statusRank(a.successes[0]!.value, b.successes[0]!.value)
})

// Seal: key shares from servers weighing t in total; shares already cached lower the threshold.
// Refusals that judge the request weigh t: an honest server refused, so stop (after a 2 s grace for lagging fullnodes).
yield* Quorum.run(uncachedServers, {
  weight: (s) => s.weight, threshold: t - cachedWeight, run: fetchAndVerifyKey,
  giveUp: { when: (e) => e.definitive, weight: t, grace: "2 seconds" }
})

// Walrus: metadata from any one node, but stop once not-found / blocked answers weigh 2f + 1.
yield* Quorum.run(committee.nodes, {
  weight: (node) => node.shards.length, threshold: 1, run: fetchMetadata,
  giveUp: { when: (e) => e.kind === "NotFound" || e.kind === "Blocked", weight: 2 * f + 1 }
})
```

## 3. Semantics

Terms: `total` is the sum of all member weights. At any moment `reached` is the weight of successes, `failed` the weight of final failures, and `remaining = total - reached - failed`.

### 3.1 Validation, before anything runs

| Input | Behaviour |
|---|---|
| `weight(m)` is `NaN`, infinite or negative | **Defect** (`Effect.die`, message names the index). A caller bug. |
| `weight(m) === 0` | The member is dropped: never started, absent from every result list, not counted in `total`. |
| Fractional weights | Allowed; integers are recommended, because sums of floats are compared with `>=`. |
| `threshold` (or `quorum`) is `NaN` or infinite; `concurrency` is `< 1`, `NaN` or not an integer | **Defect**. |
| `concurrency` is a function returning anything but a positive integer or `Infinity` | **Defect**, when it is asked (at the start and after each settlement). |
| `threshold <= 0` | **Success at once** with no successes; nothing is started. (Seal: every share was cached.) For `agree`: the same rule is a defect, because there is no winner to return. |
| `threshold > total` (for `agree`: `max(threshold, quorum) > total`), which includes an empty member list with `threshold > 0` | **Typed failure** `reason: "insufficientWeight"`; nothing is started; every member is listed in `unsettled` with `started: false`. This is data-dependent (a small committee, a misconfigured Seal threshold), so it is not a defect. |
| Duplicate members | Not detected. Each element of the input is its own member, identified by `index`; equal values each run and each count. Callers that need distinct members deduplicate first. (Seal lists a server once per unit of weight, `seal/dist/client.mjs:152`; with this package it passes each server once with its weight.) |
| `weight` or `key` throws | **Defect**. |
| `linger` returns `NaN` or a non-positive duration | No window. |
| `giveUp.weight` is not finite or `<= 0`; `giveUp.grace` is negative or `NaN` | **Defect**, checked before anything runs (also when `threshold <= 0`). A zero grace is no grace. |

Defects from validation are `Cause.IllegalArgumentError`s whose message starts with `Quorum:`.

`weight` is called exactly once per member, up front.

### 3.2 Running

- Members start in `order`, at most `concurrency` in flight. A member's slot covers its whole retried attempt, including the time it sleeps between retries.
- A member's attempt is `run(m)` retried with `Effect.retry({ schedule, while })`. When it finally fails, the member is recorded in `failures` with its last error and never runs again.
- **Success** is checked on every member success: `reached >= threshold`. The check happens on the success that crosses the line, not on the next one (the off-by-one in `walrus/dist/client.mjs:286-291` and `:337-346`).
- **Fail fast** is checked on every final failure: `reached + remaining < threshold`. All outstanding attempts are interrupted and `QuorumFailed` (`reason: "unreachable"`) is returned at once, without waiting for members that cannot change the answer.
- The success check runs before the failure check, so a run in which the last member to settle reaches the threshold succeeds (the bug in `walrus/dist/client.mjs:355-358`).
- **Give up** (`giveUp`, `run` only) is checked on every final failure, after the success and fail-fast checks: when the weight of final failures for which `when(error, member)` holds reaches `weight`. Retries do not count until the member's schedule is exhausted or `while` says no; `when` is called once per final failure. Without `grace` (or with a zero grace) the call fails at once with `QuorumFailed` (`reason: "gaveUp"`). With `grace`, the run continues exactly as before (in-flight members keep going, queued members still start) for that long, measured with `Clock` from the moment of giving up; the threshold reached in the window is a success (linger does not apply to it); the window ends early, still as `gaveUp`, when every member has settled or the threshold becomes unreachable; when it runs out the rest are interrupted and the call fails with `gaveUp`. "Unreachable" wins when it fires on the same failure or earlier. The use case is failures that judge the request rather than the member (Walrus: not found / blocked at `2f + 1`; Seal: access denied at weight `t`), where a low threshold would otherwise wait for every slow member to fail.
- `while` only matters together with `schedule`; without a schedule every member gets one attempt.
- Result lists: `successes` and `failures` are in completion order, `unsettled` in input (`index`) order.
- When the run ends, every attempt still in flight is interrupted, and `run` returns only after those interruptions have completed (their finalizers have run). No fiber outlives the call.

### 3.3 Order

- `"given"`: input order.
- `"shuffle"`: a uniform shuffle (`Random.shuffle`).
- `"weightedShuffle"`: sort descending by `u ** (1 / weight)` with `u` from `Random.next` (Efraimidis–Spirakis; the same formula as `walrus/dist/utils/randomness.mjs:2-6`). Heavier members tend to start first.

Randomness comes from Effect's `Random` service, so tests pin it with `Random.withSeed`.

### 3.4 Linger

Without `linger`, the run ends the moment the threshold is reached. With it:

1. Let `elapsed` be the time from the start of the run to the moment the threshold was reached (measured with `Clock`, so `TestClock` controls it), and `d = linger(elapsed)`.
2. The run continues exactly as before (in-flight members keep going, queued members still start as slots free up) until every member has settled or `d` has passed, whichever is first. Then the rest are interrupted.
3. Successes and failures that arrive during the window are included in the result. The result is a success whatever happens in the window; fail-fast no longer applies. A member that dies or interrupts itself in the window ends the window (the rest are interrupted) and is logged at warning level; it does not discard the reached quorum.
4. Settlements already queued when the deciding one is taken (members that finished in the same turn) are folded in before the run returns, with or without a window.

A non-positive `d` means no window.

### 3.5 `agree`

After every success, with `responded` the weight of all successes and `best` the largest group weight:

- **Decide** at the first moment when `responded >= quorum` and at least one key has weight `>= threshold`. The winner is the most preferred key among those at or over the threshold (`prefer`; default heavier, then first seen). The run ends there; it does not wait for a preferred key that might still catch up.
- **Fail fast** when `responded + remaining < quorum` or `best + remaining < threshold`: `AgreementFailed` (`reason: "unreachable"`), carrying every group and every failure, so the caller can still inspect split answers (Walrus checks a minority status against the chain).
- `quorum` below `threshold` is treated as `threshold`. `agree` has no `linger`.
- Everything in §3.1, §3.2, §3.3 and §3.6 applies unchanged.

### 3.6 Defects and interruption

- **A defect in a member's `run` is not a member failure.** Before the threshold is reached it fails the whole call with that defect, after interrupting the other attempts (after it, see §3.4 point 3). Defects are bugs; folding them into the failure set hides them (`seal/dist/client.mjs:220` logs an invalid key with `console.warn` and carries on). A consumer that expects a throwable (a decode, a WASM call) turns it into a typed error inside `run`.
- **Interrupting the caller** interrupts every attempt and waits for them; no result is produced.
- **A member that interrupts itself** (its exit is interruption while the run is not shutting down) interrupts the whole call. Interruption is not a typed failure.
- **Timeouts are not built in.** A per-attempt timeout belongs in `run` (`Effect.timeoutOrElse` to a typed error, which is then retryable or not like any other). An overall deadline wraps the call (`Effect.timeout`); interruption does the cleanup.

### 3.7 Not included, deliberately

- No progress callback. Wrap `run` if you need per-member events.
- ~~No "give up" predicate over failures.~~ Reversed by Q3 (`giveUp`, §3.2). The original argument was that "unreachable" coincides with what both consumers care about; it holds for Walrus slivers (`n - 2f` needed, so unreachable exactly at `2f + 1` failed) but not for Walrus metadata (threshold 1, `walrus.md` §4.5 "As built (W5)") nor for Seal with `2t <= total` (`seal.md` §5). Callers still classify `failures` afterwards with `failedWeight`.
- No `giveUp` for `agree`, and no per-member weight or several predicates in one `giveUp`: no consumer needs them.
- No detached tail (see open question 1).

## 4. Why `Data.TaggedError`, not `Schema.TaggedError`

`QuorumFailed` is generic in the caller's member and error types. A `Schema.TaggedError` needs a schema per field, which would either erase those types to `unknown` or make every caller pass schemas for `M` and `E`. It would also pull `Schema` (about 40 KB minified, README "What ships") into a package whose only job is a race. So this package uses `Data.TaggedError`, which is typed, yieldable and matched by `catchTag` exactly like the others. Consumers convert at their boundary into their own `Schema.TaggedError` (Walrus: `NotEnoughConfirmations`, `NotEnoughSlivers`; Seal: `ThresholdNotMet`), summarising the failures into serialisable fields. This is open question 2.

## 5. What the reference clients do (evidence for the design)

| Fact | Source |
|---|---|
| The Rust client's primitive is the same shape: weighted futures, a concurrency cap, stop at a weight predicate, or run for a duration. | `crates/walrus-sdk/src/utils.rs:70-225` (`WeightedFutures::execute_weight`, `execute_time`, `next_threshold`) |
| **After the write quorum, the Rust client keeps uploading** for `0.5 × time-to-quorum + 500 ms`, then drops what is left. Results from the window are kept. | `crates/walrus-sdk/src/uploader.rs:312-364`; defaults in `crates/walrus-sdk/src/config/sliver_write_extra_time.rs:36-42` |
| The window blocks by default (`TailHandling::Blocking`); a detached mode runs it in a background task. | `crates/walrus-sdk/src/config/communication_config.rs:263`; `crates/walrus-sdk/src/uploader.rs:320-343` |
| `@mysten/walrus` never stops early on writes: it awaits every node (`Promise.all`), each request bounded only by a 30 s timeout. It fails once failed weight exceeds `f`. | `walrus/dist/client.mjs:1131-1148`; `walrus/dist/storage-node/client.mjs:12` |
| Rust reads stop at the threshold with bounded concurrency: metadata at weight 1 with 3 in flight, slivers at `n - 2f` with at most `n - 2f` in flight, status at `2f + 1` under a timeout. | `crates/walrus-sdk/src/node_client.rs:2386-2456`, `:2237-2300`, `:2510-2575`; `crates/walrus-sdk/src/config/communication_config.rs` (`mod default`) |
| Rust blob status: collect `2f + 1` weight, group identical statuses, walk them from latest to earliest and take the first with more than `f` weight (or one it can verify on chain). This is `agree` with `quorum = 2f + 1`, `threshold = f + 1`, `prefer` = status order. | `crates/walrus-sdk/src/node_client.rs:2510-2575`; order in `crates/walrus-storage-node-client/src/api.rs:138` |
| Seal: weighted servers, threshold `t`, cached keys count toward `t`, abort when the remaining weight cannot reach it. Errors collapse to a "majority error"; an invalid key is a `console.warn`. | `seal/dist/client.mjs:182-238` |

**Does `linger` belong here? Yes.** Only the combinator owns the attempt fibers and the scheduling loop. A consumer cannot add a grace period from outside without rebuilding the race, and the feature costs one branch after the success check. It is off by default, Walrus writes turn it on with the Rust client's formula, and Seal never sets it.

## 6. Implementation notes

Not binding, but the semantics above must hold.

- One internal `drive(members, common, decide)` where `decide(tally)` answers `continue`, `done` or `fail`; `run` and `agree` are two `decide` functions. About 150 lines in total.
- Suggested shape: `Effect.uninterruptibleMask` around a `Scope`; attempts forked into that scope with `Effect.forkIn`, each ending with `Effect.exit` and offering `{ index, exit }` to an unbounded `Queue`; a single loop takes from the queue, updates the tally, asks `decide`, and starts the next queued members. Closing the scope interrupts and awaits what is left. A defect or interruption in an `exit` ends the loop with that cause.
- Linger: after `done`, race the same loop (with a `decide` that always continues) against `Effect.sleep(d)`.
- Span: `Effect.withSpan("Quorum.run")` / `"Quorum.agree"` with attributes `quorum.threshold`, `quorum.total`, `quorum.reached`, `quorum.failed`, `quorum.members`.
- No module-level side effects; every export tree-shakes.

## 7. Test plan

All offline, `bun:test`, driven by `TestClock` (`import { TestClock } from "effect/testing"`, `Effect.provide(TestClock.layer())`, as in `packages/sui-lifecycle/test/lifecycle.test.ts`). A member is modelled as `Effect.sleep(d)` followed by success or failure, with a `Ref` recording starts, completions and interruptions (`Effect.onInterrupt`). Each test forks the call, advances the clock, and asserts both the result and the virtual time at which it was produced.

`run.test.ts`

1. Succeeds at the threshold and interrupts the rest: delays 1 s, 2 s, 10 s, weights 1, threshold 2. Result at exactly 2 s; the third member is interrupted and listed in `unsettled` with `started: true`.
2. Returns on the crossing success: exactly `threshold` weight succeeds and every other member is `Effect.never`. The call completes. (Regression for `client.mjs:286-291`.)
3. The last member to settle reaches the threshold: success, not failure. (Regression for `client.mjs:355-358`.)
4. Fails fast: weights `[3, 3, 3, 1]`, threshold 7, two weight-3 members fail at 1 s, the others take 10 s. `QuorumFailed` (`unreachable`) at 1 s; the others are interrupted.
5. Weights: one heavy member reaches the threshold alone; many light ones are needed otherwise.
6. Retry: a member fails twice and then succeeds under `Schedule.spaced("1 second")` (success at 2 s plus its own delays); `while` returning `false` ends it after one attempt; an exhausted schedule records the last error; attempts are counted.
7. Concurrency: with `concurrency: 2` no more than two are ever in flight, members start in order, and a retrying member keeps its slot.
8. Linger: threshold reached at 2 s, `linger: (e) => 0.5e + 500 ms` gives 1.5 s; a member finishing at 3 s is in `successes`, one finishing at 5 s is interrupted at 3.5 s; the call returns at 3.5 s. A second case where everything settles at 2.5 s returns at 2.5 s.
9. Edge table from §3.1: empty list with threshold 0 (success) and 1 (`insufficientWeight`, `run` never called); threshold above total; zero-weight member never run; negative and `NaN` weight die; duplicates both count; invalid `concurrency` dies.
10. A defect in one member fails the call with that defect and interrupts the others.
11. Interrupting the caller interrupts every attempt; afterwards no attempt is running (all finalizers ran).
12. The failure value: every failed member with its error and weight; `successes` holds the partial successes; `unsettled` distinguishes started from not started; `message` contains no member values.

`agree.test.ts`

13. Early agreement: three members answer `"a"`, threshold 3, `quorum` default: decided at the third answer; a slow fourth is interrupted.
14. `quorum` above `threshold`: a key is over the threshold early but the decision waits until `quorum` weight has answered.
15. `prefer`: two keys at or over the threshold when the quorum is met; the preferred one wins; the default picks the heavier.
16. Split: answers spread so that no key can reach the threshold: `AgreementFailed` as soon as that is certain, with all groups.
17. Failures shrink `remaining`: enough failures make the quorum unreachable.

`order.test.ts`

18. `"shuffle"` and `"weightedShuffle"` are deterministic under `Random.withSeed` and are permutations of the input.
19. Over 2,000 seeds, a member of weight 10 starts before a member of weight 1 in roughly 10/11 of the runs (tolerance ±3%).

`run.test.ts`, `giveUp` (Q3, all under `TestClock` with the virtual time asserted)

20. Fails at once without grace when matching failures reach the weight (and a zero grace is no grace); non-matching failures do not count; a retrying member counts only when final (`when` called once); with grace, a threshold reached inside the window succeeds, and the window keeps starting queued members; the window ends in `gaveUp` at the exact time; it ends early as `gaveUp` once the threshold is unreachable; "unreachable" still wins when it comes first; invalid `weight` or `grace` dies before anything runs.

Type tests (in `run.test.ts`, compile-time only): the error channel is `QuorumFailed<M, A, E>` and `R` is the members' `R`; a `schedule` whose input is not `E` does not compile.

Bundle: add a program to `scripts/bundle-report.ts` (`Quorum.run` over three `Effect.succeed` members) and record Bun / esbuild / Rolldown sizes next to the "Effect baseline" row. Expectation: under 3 KB minified on top of `Effect`, and no `Schema` in the output.

Measured (KB minified / gzip): Bun 59.0 / 20.1, esbuild 57.9 / 20.2, Rolldown 57.9 / 19.2; no `Schema`. A bare `Effect.runPromise(Effect.succeed(1))` is 26 KB with esbuild. `Quorum.ts` itself (both entry points, `effect` external) is 6.0 / 2.4 KB; the rest of the difference is Effect modules it uses (`Schedule` via `Effect.retry`, the tracer via `withSpan`, `Queue`, `Scope`, `Duration`, `timeoutOption`), most of which an app with `HttpClient` already ships. So the 3 KB expectation holds gzipped for the package's own code, not for the Effect modules it pulls in.

## 8. Work packages

| # | Scope | Depends on | Files | Acceptance |
|---|---|---|---|---|
| Q1 | Package scaffold; the engine; `run` with retry, concurrency, order, linger; `QuorumFailed`; helpers. | — | `packages/quorum/{package.json,tsconfig.json}`, `src/Quorum.ts`, `src/index.ts`, `test/run.test.ts`, `test/order.test.ts`; root `package.json` devDependency `@unconfirmed/quorum: workspace:*` | Tests 1–12, 18–19 and the type tests pass; `bun run typecheck` clean; no import from `"effect"` (barrel) or `effect/Schema` in `src/`. |
| Q2 | `agree`, `AgreementFailed`; bundle-report row; README package-table row and a short section. | Q1 | `src/Quorum.ts`, `test/agree.test.ts`, `scripts/bundle-report.ts`, `README.md` | Tests 13–17 pass; bundle sizes recorded for all three bundlers; `run` behaviour unchanged (Q1 tests still pass). |

Q1 and Q2 are sequential and small; one agent can take both. Walrus work packages W1–W4 and W10 (see `walrus.md`) do not need this package and can run in parallel with it.

## 9. Open questions

1. **Detached linger.** The Rust client can return at quorum and let the tail finish in a background task. Here that would be a second entry point taking a `Scope`. *Recommendation: not in v1.* The blocking window costs about half the upload time again on writes, which is acceptable; add `runScoped` later if write latency matters. The option shape (`linger`) does not change.
2. **`Data.TaggedError` for the two errors.** It departs from the repo's "errors are `Schema.TaggedError`" convention, for the reasons in §4. *Recommendation: accept the exception for this one generic package*, and keep the rule for every domain package.
3. **A retrying member keeps its concurrency slot.** Releasing the slot while it sleeps would let other members progress but makes "at most N requests in flight" harder to reason about. *Recommendation: keep the slot*, as the Rust client does (`backoff::retry` inside the future, `crates/walrus-sdk/src/node_client/communication/node.rs`).
4. **Zero-weight members are dropped silently.** The alternative is a defect. *Recommendation: drop*; a storage node with no shards or a key server with weight 0 is legitimate input and running it is wasted work.

## 10. As built

Differences from the draft above (the sections have been updated to match):

- **Bundle expectation.** The package's own code is ~6 KB minified / 2.4 KB gzip, not under 3 KB minified, and a quorum-only program pulls in ~32 KB of Effect modules beyond a bare `Effect.runPromise` (§7). `Effect.forEach` was avoided in the engine to save ~2 KB.
- **`agree` insufficient weight** is `max(threshold, quorum) > total` (§3.1), since a quorum above the total weight can never be met.
- **Fail-fast checks run after every settlement**, success or failure. For `run` this is equivalent to checking only on failures (a success never lowers `reached + remaining`); for `agree` it is required (§3.5). If every member has settled and neither condition fired, the call fails as `unreachable` (defensive; not reachable with the conditions above).
- **Linger keeps starting queued members** during the window (as §3.4 says), including the ones whose slots freed up before the threshold was reached.
- **`giveUp` (Q3)**, added after Q1/Q2 as designed in `seal.md` §5, with three calls the design left open: the counted weight is checked with `>=`; during the grace window, the threshold becoming unreachable ends the call at once, as `gaveUp` (nothing in the window can change the outcome, and the give-up came first); validation runs even when `threshold <= 0`. The engine change is a fourth decision (`gaveUp`) and the linger loop generalised to take an optional check. `Quorum.ts` alone (esbuild, minified, `effect` external) went from 6121 / 2459 to 6775 / 2722 bytes (+0.26 KB gzip).
- **Tests** record events in plain arrays rather than `Ref`s (they run in one fiber per member under `TestClock`, so order is deterministic); helpers live in `test/world.ts`.
- **Review fixes (`docs/review/walrus.md`).** (1) `concurrency` may be a function of `Progress { succeeded, failed, reachedWeight, failedWeight }`, asked whenever a slot may open, so a window can widen as members fail (`(p) => 3 + p.failed`, Walrus metadata); lowering it never interrupts a running member. (2) QRM-1: a defect or self-interruption after the threshold is reached (linger window) ends the window and is logged; the call succeeds (§3.4 point 3). During a `giveUp` grace no quorum was reached, so a defect still fails the call. (3) QRM-2: settlements queued with the deciding one are drained without waiting (`Queue.poll`). The drain does not yield: a yield lets members forked but not yet started send requests that are then interrupted (seen in Walrus's read tests). Under `TestClock`, members whose sleeps end at the same virtual instant still settle in separate turns, so only same-turn settlements are kept. `Quorum.ts` alone: 6775 / 2722 → 7538 / 2992 bytes (minified / gzip).
