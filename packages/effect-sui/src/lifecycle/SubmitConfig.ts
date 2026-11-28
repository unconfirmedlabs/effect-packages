/**
 * The lifecycle's policies, as a `Context.Reference`: every default is in
 * force with no setup, and any of them can be overridden for one fiber with
 * `SubmitConfig.with({...})(effect)` or for a program with `layer({...})`.
 */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"

export interface SubmitConfigService {
  /** Delays between re-sends of the identical bytes after a retryable transport failure. */
  readonly resubmit: Schedule.Schedule<unknown, unknown>
  /** Total execute attempts, the first included. */
  readonly resubmitAttempts: number
  /** One execute with no answer within this is a retryable failure (the bytes may have landed). */
  readonly executeTimeout: Duration.Duration
  /** How long `reconcile` keeps asking for a digest the node does not (yet) serve. */
  readonly lookupTimeout: Duration.Duration
  /** Spacing of those lookups. */
  readonly lookupInterval: Duration.Duration
  /** The delay between the two observations the expiry rule needs. */
  readonly reconcileRecheck: Duration.Duration
  /**
   * Whether a closed epoch window may be evidence at all. `"never"` is for a
   * deployment behind a mixed-node load balancer, where even a repeated
   * observation may be answered by two different nodes.
   */
  readonly expiryEvidence: "epochThenMiss" | "never"
  /** After a successful execute, wait until reads see the transaction (never changes the outcome). */
  readonly awaitVisibility: boolean
  readonly visibilityTimeout: Duration.Duration
}

export type Overrides = {
  readonly [K in keyof SubmitConfigService]?: SubmitConfigService[K] extends Duration.Duration ? Duration.Input
    : SubmitConfigService[K]
}

export const defaults: SubmitConfigService = {
  resubmit: Schedule.exponential("250 millis").pipe(
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(30)))),
    Schedule.jittered
  ),
  resubmitAttempts: 5,
  executeTimeout: Duration.seconds(60),
  lookupTimeout: Duration.seconds(5),
  lookupInterval: Duration.millis(500),
  reconcileRecheck: Duration.seconds(2),
  expiryEvidence: "epochThenMiss",
  awaitVisibility: true,
  visibilityTimeout: Duration.seconds(15)
}

export const SubmitConfig = Context.Reference<SubmitConfigService>("@unconfirmed/sui-lifecycle/SubmitConfig", {
  defaultValue: () => defaults
})

const merge = (base: SubmitConfigService, overrides: Overrides): SubmitConfigService => {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    out[key] = Duration.isDuration((base as any)[key]) ? Duration.fromInputUnsafe(value as Duration.Input) : value
  }
  return out as unknown as SubmitConfigService
}

/** Overrides merged over the defaults. */
export const layer = (overrides: Overrides): Layer.Layer<never> => Layer.succeed(SubmitConfig, merge(defaults, overrides))

/** Overrides merged over the config in force, for one effect. */
export const with_ = (overrides: Overrides) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.service(SubmitConfig), (config) =>
    Effect.provideService(effect, SubmitConfig, merge(config, overrides)))

export { with_ as with }
