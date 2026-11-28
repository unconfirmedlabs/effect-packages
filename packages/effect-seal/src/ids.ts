/**
 * @internal Object id validation, in one place. A leaf: it imports only a
 * type.
 *
 * Two rules, by what the id is for:
 *
 * - `strictId`: `0x` + exactly 64 hex digits, either case. For ids that are
 *   signed or bound into a ciphertext (package ids, user addresses), where an
 *   unprefixed form would be signed as given and then refused by every key
 *   server.
 * - `normalizeObjectId`: exactly 64 hex digits, `0x` optional, either case.
 *   For key server ids, which only name an object to read.
 *
 * Both answer the canonical form (`0x` + 64 lower-case digits) or
 * `undefined`. A truncated paste (`0x2`) is refused by both, never padded.
 */
import type { Address } from "@unconfirmed/effect-sui/Address"

/** The canonical form: what every normalised id looks like. */
export const CANONICAL = /^0x[0-9a-f]{64}$/

const STRICT = /^0x[0-9a-fA-F]{64}$/
const LENIENT = /^(0x)?[0-9a-fA-F]{64}$/

/** Already canonical. */
export const isCanonical = (u: unknown): u is Address => typeof u === "string" && CANONICAL.test(u)

/** `0x` + 64 hex digits, either case → canonical; anything else → `undefined`. */
export const strictId = (s: string): Address | undefined => (STRICT.test(s) ? (s.toLowerCase() as Address) : undefined)

/** 64 hex digits, `0x` optional, either case → canonical; anything else → `undefined`. */
export const normalizeObjectId = (s: string): Address | undefined =>
  LENIENT.test(s) ? (("0x" + s.replace(/^0x/, "").toLowerCase()) as Address) : undefined
