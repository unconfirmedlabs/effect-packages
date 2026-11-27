/**
 * The two ways zkLogin inputs are refused. Neither is thrown across the
 * public API: every function that can refuse answers an `Effect` failing
 * with one of these.
 */
import * as Schema from "effect/Schema"

/** A value the zkLogin circuit cannot represent (too long, out of field, escaped claim, ...). */
export class InvalidZkLoginInput extends Schema.TaggedError<InvalidZkLoginInput>()("InvalidZkLoginInput", {
  reason: Schema.String
}) {}

/** A JWT that is malformed, too long, or lacks the claims zkLogin needs. */
export class InvalidJwt extends Schema.TaggedError<InvalidJwt>()("InvalidJwt", {
  reason: Schema.String
}) {}

/** @internal Internals throw plain errors; the public boundary converts them. */
export const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
