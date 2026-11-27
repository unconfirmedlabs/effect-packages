/**
 * Weighted first-threshold-of-n: run members concurrently and stop as soon as
 * enough weight has answered (`run`) or agreed on one answer (`agree`).
 *
 * Design: docs/design/quorum.md.
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Random from "effect/Random"
import type * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"

/** A member that answered. `index` is its position in the input: the member's identity. */
export interface Success<M, A> {
  readonly member: M
  readonly index: number
  readonly weight: number
  readonly value: A
}

/** A member that failed for good (not retryable, or its schedule ran out). `error` is its last error. */
export interface Failure<M, E> {
  readonly member: M
  readonly index: number
  readonly weight: number
  readonly error: E
}

/** A member with no outcome: never started, or interrupted in flight. */
export interface Unsettled<M> {
  readonly member: M
  readonly index: number
  readonly weight: number
  readonly started: boolean
}

export type Order = "given" | "shuffle" | "weightedShuffle"

interface Common<M, A, E, R> {
  readonly weight: (member: M) => number
  /** One attempt at one member. Typed failures count against the member; defects fail the whole call. */
  readonly run: (member: M) => Effect.Effect<A, E, R>
  /** Per-member retry policy. Absent: one attempt. */
  readonly schedule?: Schedule.Schedule<unknown, E>
  /** Retry only these errors (default: all). A `false` makes the failure final at once. */
  readonly while?: (error: E) => boolean
  /** Attempts in flight at once; a retrying member keeps its slot. Default `"unbounded"`. */
  readonly concurrency?: number | "unbounded"
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
   * Stop early on failures that make success pointless rather than impossible (a member that judges
   * the request itself: not found, access denied). Checked on every final failure, after the success
   * and unreachable checks; ends in `QuorumFailed` with `reason: "gaveUp"`. Default: none.
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

const describe = (
  what: string,
  reason: "insufficientWeight" | "unreachable" | "gaveUp",
  reached: number,
  needed: number,
  failed: number,
  unsettled: number,
  total: number
) =>
  reason === "insufficientWeight"
    ? `${what} insufficient weight: total ${total} is below ${needed}`
    : `${what} ${reason === "gaveUp" ? "gave up" : reason}: ${reached} of ${needed} reached, ${failed} failed, ${unsettled} unsettled (total ${total})`

/** `run` could not reach its threshold. Carries every success, failure and unsettled member. */
export class QuorumFailed<M, A, E> extends Data.TaggedError("QuorumFailed")<{
  /**
   * `insufficientWeight`: the members' total weight was below the threshold; nothing ran.
   * `unreachable`: failures left too little weight to reach it.
   * `gaveUp`: failures matching `giveUp.when` reached `giveUp.weight` (and its grace, if any, ran out).
   */
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
  /** e.g. "quorum unreachable: 412 of 667 reached, 421 failed, 167 unsettled (total 1000)". No member values. */
  override get message(): string {
    return describe(
      "quorum",
      this.reason,
      this.weight,
      this.threshold,
      weightOf(this.failures),
      weightOf(this.unsettled),
      this.totalWeight
    )
  }
}

/** `agree` could not reach agreement. Carries every group (split answers included) and every failure. */
export class AgreementFailed<M, A, K extends Key, E> extends Data.TaggedError("AgreementFailed")<{
  readonly reason: "insufficientWeight" | "unreachable"
  readonly threshold: number
  readonly quorum: number
  readonly totalWeight: number
  readonly groups: ReadonlyArray<Group<M, A, K>>
  readonly failures: ReadonlyArray<Failure<M, E>>
  readonly unsettled: ReadonlyArray<Unsettled<M>>
}> {
  /** e.g. "agreement unreachable: best 3 of 4 agreed, 5 responded of 7, 2 failed, 1 unsettled (total 10)". */
  override get message(): string {
    if (this.reason === "insufficientWeight") {
      return describe("agreement", this.reason, 0, Math.max(this.quorum, this.threshold), 0, 0, this.totalWeight)
    }
    const best = this.groups.reduce((m, g) => Math.max(m, g.weight), 0)
    return `agreement unreachable: best ${best} of ${this.threshold} agreed, ${weightOf(this.groups)} responded of ${this.quorum}, ${
      weightOf(this.failures)
    } failed, ${weightOf(this.unsettled)} unsettled (total ${this.totalWeight})`
  }
}

/** Sum of `weight` over a list of successes, failures or unsettled members. */
export const weightOf = (items: Iterable<{ readonly weight: number }>): number => {
  let sum = 0
  for (const item of items) sum += item.weight
  return sum
}

/** Failed weight that matches a predicate, e.g. the weight of "not found" answers. */
export const failedWeight = <M, E>(failures: Iterable<Failure<M, E>>, f: (error: E) => boolean): number => {
  let sum = 0
  for (const failure of failures) if (f(failure.error)) sum += failure.weight
  return sum
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface Entry<M> {
  readonly member: M
  readonly index: number
  readonly weight: number
}

interface Tally<M, A, E> {
  readonly total: number
  reached: number
  failed: number
  readonly successes: Array<Success<M, A>>
  readonly failures: Array<Failure<M, E>>
}

type Decision = "continue" | "done" | "fail" | "gaveUp"

interface Outcome<M, A, E> {
  readonly tally: Tally<M, A, E>
  readonly decision: Exclude<Decision, "continue">
  readonly unsettled: ReadonlyArray<Unsettled<M>>
}

const invalid = (message: string) => Effect.die(new Cause.IllegalArgumentError(`Quorum: ${message}`))

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

/** Weights (called once each), zero-weight members dropped, and checks that turn caller bugs into defects. */
const prepare = <M, A, E, R>(
  members: Iterable<M>,
  common: Common<M, A, E, R>,
  numbers: Record<string, number>
): Effect.Effect<{ entries: Array<Entry<M>>; unstarted: Array<Unsettled<M>>; total: number }> =>
  Effect.suspend(() => {
    for (const name in numbers) {
      if (!isFiniteNumber(numbers[name])) return invalid(`${name} must be a finite number, got ${numbers[name]}`)
    }
    const c = common.concurrency
    if (c !== undefined && c !== "unbounded" && !(Number.isInteger(c) && c >= 1)) {
      return invalid(`concurrency must be a positive integer or "unbounded", got ${c}`)
    }
    const entries: Array<Entry<M>> = []
    let index = 0
    let total = 0
    for (const member of members) {
      const weight = common.weight(member)
      if (!isFiniteNumber(weight) || weight < 0) {
        return invalid(`weight of member ${index} must be a finite number >= 0, got ${weight}`)
      }
      if (weight > 0) {
        entries.push({ member, index, weight })
        total += weight
      }
      index++
    }
    const unstarted = entries.map((e) => ({ ...e, started: false }))
    return Effect.succeed({ entries, unstarted, total })
  })

const arrange = <M>(entries: Array<Entry<M>>, order: Order | undefined): Effect.Effect<Array<Entry<M>>> => {
  if (order === "shuffle") return Random.shuffle(entries)
  if (order === "weightedShuffle") {
    // Efraimidis–Spirakis: sort by u^(1/w) descending, so heavier members tend to come first.
    return Effect.gen(function*() {
      const keyed: Array<{ entry: Entry<M>; key: number }> = []
      for (const entry of entries) keyed.push({ entry, key: (yield* Random.next) ** (1 / entry.weight) })
      return keyed.sort((a, b) => b.key - a.key).map((k) => k.entry)
    })
  }
  return Effect.succeed(entries)
}

interface Settled<A, E> {
  readonly slot: number
  readonly exit: Exit.Exit<A, E>
}

/**
 * Runs `entries` (already ordered) at most `concurrency` at a time, folding each settlement into the
 * tally and asking `decide` after each one. Ends on `done`, `fail` or `gaveUp`; after `done`, `lingerFor`
 * may keep the run going for a window, and after `gaveUp`, `grace` (ms) may, ending early on `done` (a
 * success) or `fail` (still gave up). Every attempt still in flight is interrupted, and awaited, before it
 * returns.
 */
const drive = <M, A, E, R>(
  entries: Array<Entry<M>>,
  total: number,
  common: Common<M, A, E, R>,
  decide: (tally: Tally<M, A, E>, success: Success<M, A> | undefined) => Decision,
  lingerFor?: (elapsed: Duration.Duration) => Duration.Input,
  grace = 0
): Effect.Effect<Outcome<M, A, E>, never, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const startedAt = yield* Clock.currentTimeMillis
      const scope = yield* Scope.make("parallel")
      const queue = yield* Queue.unbounded<Settled<A, E>>()
      const tally: Tally<M, A, E> = { total, reached: 0, failed: 0, successes: [], failures: [] }
      const limit = common.concurrency === undefined || common.concurrency === "unbounded"
        ? Infinity
        : common.concurrency
      const state: Array<"queued" | "running" | "settled"> = entries.map(() => "queued")
      const { schedule, while: retryWhile } = common
      let next = 0
      let running = 0

      const attempt = (member: M): Effect.Effect<A, E, R> =>
        schedule ? Effect.retry(common.run(member), { schedule, while: retryWhile }) : common.run(member)

      const fill = Effect.gen(function*() {
        while (running < limit && next < entries.length) {
          const slot = next++
          running++
          state[slot] = "running"
          yield* Effect.forkIn(
            Effect.flatMap(Effect.exit(attempt(entries[slot]!.member)), (exit) => Queue.offer(queue, { slot, exit })),
            scope
          )
        }
      })

      /** Takes one settlement and folds it in. A defect or self-interruption ends the call. */
      const settle = (settled: Settled<A, E>): Effect.Effect<Success<M, A> | undefined> => {
        const { slot, exit } = settled
        const entry = entries[slot]!
        running--
        state[slot] = "settled"
        if (Exit.isSuccess(exit)) {
          const success = { member: entry.member, index: entry.index, weight: entry.weight, value: exit.value }
          tally.successes.push(success)
          tally.reached += entry.weight
          return Effect.succeed(success)
        }
        const cause = exit.cause
        if (Cause.hasDies(cause)) return Effect.failCause(Cause.fromReasons(cause.reasons.filter(Cause.isDieReason))) as never
        const error = Cause.findErrorOption(cause)
        if (Option.isNone(error)) return Effect.interrupt as never
        tally.failures.push({ member: entry.member, index: entry.index, weight: entry.weight, error: error.value })
        tally.failed += entry.weight
        return Effect.succeed(undefined)
      }

      const allSettled = () => tally.successes.length + tally.failures.length === entries.length

      const race = Effect.gen(function*() {
        yield* fill
        while (true) {
          const success = yield* settle(yield* Queue.take(queue))
          let decision = decide(tally, success)
          if (decision === "continue" && allSettled()) decision = "fail"
          if (decision !== "continue") return decision
          yield* fill
        }
      })

      /**
       * Keeps settling (and starting queued members) for `window` ms or until everything has settled.
       * `check`, when given, may end it early with its decision; otherwise the result is "continue".
       */
      const extend = (window: number, check?: (success: Success<M, A> | undefined) => Decision) =>
        Effect.gen(function*() {
          const deadline = (yield* Clock.currentTimeMillis) + window
          if (!(window > 0)) return "continue"
          yield* fill
          while (!allSettled()) {
            const left = deadline - (yield* Clock.currentTimeMillis)
            if (!(left > 0)) break
            const settled = left === Infinity
              ? Option.some(yield* Queue.take(queue))
              : yield* Effect.timeoutOption(Queue.take(queue), left)
            if (Option.isNone(settled)) break
            const success = yield* settle(settled.value)
            const decision = check ? check(success) : "continue"
            if (decision !== "continue") return decision
            yield* fill
          }
          return "continue"
        })

      // After `done`: the linger window, still a success. After `gaveUp`: the grace window, a success if the
      // threshold is reached in it, otherwise (window over, all settled, or unreachable) still `gaveUp`.
      const after = (decision: Exclude<Decision, "continue">): Effect.Effect<Exclude<Decision, "continue">, never, R> =>
        decision === "done" && lingerFor
          ? Effect.as(
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              extend(Duration.toMillis(lingerFor(Duration.millis(now - startedAt))))),
            decision
          )
          : decision === "gaveUp"
          ? Effect.map(extend(grace, (s) => {
            const d = decide(tally, s)
            return d === "gaveUp" ? "continue" : d
          }), (d) => d === "done" ? d : decision)
          : Effect.succeed(decision)

      const exit = yield* Effect.exit(restore(Effect.flatMap(race, after)))
      yield* Scope.close(scope, Exit.void)
      const decision = yield* exit
      const unsettled: Array<Unsettled<M>> = []
      entries.forEach((e, slot) => {
        if (state[slot] !== "settled") {
          unsettled.push({ member: e.member, index: e.index, weight: e.weight, started: state[slot] === "running" })
        }
      })
      unsettled.sort((a, b) => a.index - b.index)
      return { tally, decision, unsettled }
    })
  )

const span = (name: string, threshold: number, total: number, members: number) =>
  Effect.withSpan(name, {
    attributes: { "quorum.threshold": threshold, "quorum.total": total, "quorum.members": members }
  })

const annotate = <M, A, E>(tally: Tally<M, A, E>) =>
  Effect.annotateCurrentSpan({ "quorum.reached": tally.reached, "quorum.failed": tally.failed })

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * Runs members concurrently and succeeds as soon as the weight of successes reaches `threshold`;
 * fails with `QuorumFailed` as soon as failures make that impossible. Everything still in flight is
 * interrupted (and awaited) before it returns.
 */
export const run = <M, A, E, R>(
  members: Iterable<M>,
  options: Options<M, A, E, R>
): Effect.Effect<Reached<M, A, E>, QuorumFailed<M, A, E>, R> =>
  Effect.flatMap(prepare(members, options, { threshold: options.threshold }), ({ entries, unstarted, total }) => {
    const { threshold, linger, giveUp } = options
    let grace = 0
    let given = 0
    if (giveUp) {
      if (!(giveUp.weight > 0 && giveUp.weight < Infinity)) {
        return invalid(`giveUp.weight must be a finite number > 0, got ${giveUp.weight}`)
      }
      grace = Number.isNaN(giveUp.grace) ? NaN : Duration.toMillis(giveUp.grace ?? 0)
      if (!(grace >= 0)) return invalid(`giveUp.grace must be a duration >= 0, got ${giveUp.grace}`)
    }
    const decide = (t: Tally<M, A, E>, success: Success<M, A> | undefined): Decision => {
      if (t.reached >= threshold) return "done"
      if (t.total - t.failed < threshold) return "fail"
      if (giveUp && !success) {
        const f = t.failures[t.failures.length - 1]!
        if (giveUp.when(f.error, f.member) && (given += f.weight) >= giveUp.weight) return "gaveUp"
      }
      return "continue"
    }
    const body: Effect.Effect<Reached<M, A, E>, QuorumFailed<M, A, E>, R> = threshold <= 0
      ? Effect.succeed({ successes: [], weight: 0, totalWeight: total, failures: [], unsettled: unstarted })
      : threshold > total
      ? Effect.fail(
        new QuorumFailed({
          reason: "insufficientWeight",
          threshold,
          totalWeight: total,
          weight: 0,
          successes: [],
          failures: [],
          unsettled: unstarted
        })
      )
      : Effect.flatMap(
        arrange(entries, options.order),
        (ordered) =>
          Effect.flatMap(
            drive(
              ordered,
              total,
              options,
              decide,
              linger === undefined ? undefined : typeof linger === "function" ? linger : () => linger,
              grace
            ),
            ({ tally, decision, unsettled }) =>
              Effect.andThen(
                annotate(tally),
                decision === "done"
                  ? Effect.succeed({
                    successes: tally.successes,
                    weight: tally.reached,
                    totalWeight: total,
                    failures: tally.failures,
                    unsettled
                  })
                  : Effect.fail(
                    new QuorumFailed({
                      reason: decision === "gaveUp" ? decision : "unreachable",
                      threshold,
                      totalWeight: total,
                      weight: tally.reached,
                      successes: tally.successes,
                      failures: tally.failures,
                      unsettled
                    })
                  )
              )
          )
      )
    return span("Quorum.run", threshold, total, entries.length)(body)
  })

// ---------------------------------------------------------------------------
// agree
// ---------------------------------------------------------------------------

interface MutableGroup<M, A, K extends Key> {
  readonly key: K
  weight: number
  readonly successes: Array<Success<M, A>>
}

const heavier = (a: { readonly weight: number }, b: { readonly weight: number }) => a.weight - b.weight

/**
 * Runs members concurrently, groups their answers by `key`, and succeeds once `quorum` weight has
 * answered and some key has `threshold` weight (the most preferred such key wins). Fails with
 * `AgreementFailed` as soon as that is impossible.
 */
export const agree = <M, A, K extends Key, E, R>(
  members: Iterable<M>,
  options: AgreeOptions<M, A, K, E, R>
): Effect.Effect<Agreed<M, A, K, E>, AgreementFailed<M, A, K, E>, R> =>
  Effect.flatMap(
    prepare(members, options, { threshold: options.threshold, quorum: options.quorum ?? options.threshold }),
    ({ entries, unstarted, total }) => {
      const { threshold, key } = options
      if (threshold <= 0) return invalid(`agree needs a positive threshold, got ${threshold}`)
      const quorum = Math.max(threshold, options.quorum ?? threshold)
      const prefer = options.prefer ?? heavier
      const groups: Array<MutableGroup<M, A, K>> = []
      const byKey = new Map<K, MutableGroup<M, A, K>>()
      let winner: MutableGroup<M, A, K> | undefined

      const decide = (t: Tally<M, A, E>, success: Success<M, A> | undefined): Decision => {
        if (success) {
          const k = key(success.value, success.member)
          let group = byKey.get(k)
          if (!group) {
            group = { key: k, weight: 0, successes: [] }
            byKey.set(k, group)
            groups.push(group)
          }
          group.weight += success.weight
          group.successes.push(success)
        }
        let best = 0
        for (const g of groups) {
          if (g.weight > best) best = g.weight
          if (t.reached >= quorum && g.weight >= threshold && (!winner || prefer(g, winner) > 0)) winner = g
        }
        if (winner) return "done"
        const remaining = t.total - t.reached - t.failed
        return t.total - t.failed < quorum || best + remaining < threshold ? "fail" : "continue"
      }

      const body: Effect.Effect<Agreed<M, A, K, E>, AgreementFailed<M, A, K, E>, R> = quorum > total
        ? Effect.fail(
          new AgreementFailed({
            reason: "insufficientWeight",
            threshold,
            quorum,
            totalWeight: total,
            groups: [],
            failures: [],
            unsettled: unstarted
          })
        )
        : Effect.flatMap(
          arrange(entries, options.order),
          (ordered) =>
            Effect.flatMap(drive(ordered, total, options, decide), ({ tally, decision, unsettled }) =>
              Effect.andThen(
                annotate(tally),
                decision === "done" && winner
                  ? Effect.succeed({
                    winner,
                    groups,
                    weight: tally.reached,
                    totalWeight: total,
                    failures: tally.failures,
                    unsettled
                  })
                  : Effect.fail(
                    new AgreementFailed({
                      reason: "unreachable",
                      threshold,
                      quorum,
                      totalWeight: total,
                      groups,
                      failures: tally.failures,
                      unsettled
                    })
                  )
              ))
        )
      return span("Quorum.agree", threshold, total, entries.length)(body)
    }
  )
