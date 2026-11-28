/**
 * The package's one source of randomness.
 *
 * A `Context.Reference` whose default is `crypto.getRandomValues`, so it never
 * appears in `R`. Tests replace it with a deterministic source:
 * `Effect.provideService(Entropy.Entropy, seeded)`.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

/** `crypto.getRandomValues` fills at most 65,536 bytes per call. */
const CHUNK = 65536

const secureRandom = (length: number): Uint8Array => {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i += CHUNK) crypto.getRandomValues(out.subarray(i, Math.min(length, i + CHUNK)))
  return out
}

export const Entropy = /* @__PURE__ */ Context.Reference<(length: number) => Uint8Array>("@unconfirmed/seal/Entropy", {
  defaultValue: () => secureRandom
})

/** `length` bytes from the installed source. */
export const bytes = (length: number): Effect.Effect<Uint8Array> =>
  Effect.flatMap(Effect.service(Entropy), (source) => Effect.sync(() => source(length)))
