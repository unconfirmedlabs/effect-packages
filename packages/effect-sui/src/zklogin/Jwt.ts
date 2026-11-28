/**
 * JWT handling for zkLogin: decode (not verify — the proof does that) with
 * Schema-validated claims, the circuit's length limits, and the
 * `issBase64Details`-style claim extraction the prover outputs.
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { InvalidJwt, reasonOf } from "./Errors.ts"
import { normalizeIssuer } from "./PublicIdentifier.ts"

// -----------------------------------------------------------------------------
// Decoding
// -----------------------------------------------------------------------------

/** The registered claims zkLogin reads; any other claim is kept as `unknown`. */
export const JwtClaims = Schema.StructWithRest(
  Schema.Struct({
    iss: Schema.NonEmptyString,
    sub: Schema.NonEmptyString,
    /** zkLogin needs a single audience; an array is refused. */
    aud: Schema.NonEmptyString,
    exp: Schema.optionalKey(Schema.Number),
    nbf: Schema.optionalKey(Schema.Number),
    iat: Schema.optionalKey(Schema.Number),
    jti: Schema.optionalKey(Schema.String),
    nonce: Schema.optionalKey(Schema.String)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
export type JwtClaims = typeof JwtClaims.Type

export const JwtHeader = Schema.StructWithRest(
  Schema.Struct({
    alg: Schema.optionalKey(Schema.String),
    kid: Schema.optionalKey(Schema.String),
    typ: Schema.optionalKey(Schema.String)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
export type JwtHeader = typeof JwtHeader.Type

/** Decoded claims, with `iss` normalized for address derivation and the token's own value in `rawIss`. */
export type DecodedJwt = JwtClaims & { readonly rawIss: string }

const base64UrlDecode = (s: string): string => {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  switch (b64.length % 4) {
    case 0:
      break
    case 2:
      b64 += "=="
      break
    case 3:
      b64 += "="
      break
    default:
      throw new Error("base64 string is not of the correct length")
  }
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return binary
  }
}

const part = (jwt: string, index: 0 | 1): Result.Result<unknown, InvalidJwt> => {
  const segment = jwt.split(".")[index]
  if (segment === undefined) return Result.fail(new InvalidJwt({ reason: `missing part #${index + 1}` }))
  let text: string
  try {
    text = base64UrlDecode(segment)
  } catch (e) {
    return Result.fail(new InvalidJwt({ reason: `invalid base64 for part #${index + 1} (${reasonOf(e)})` }))
  }
  try {
    return Result.succeed(JSON.parse(text))
  } catch (e) {
    return Result.fail(new InvalidJwt({ reason: `invalid json for part #${index + 1} (${reasonOf(e)})` }))
  }
}

const decodeClaims = Schema.decodeUnknownResult(JwtClaims)
const decodeHeaderSchema = Schema.decodeUnknownResult(JwtHeader)

/** Decode a JWT's payload. The signature is not checked: the zk proof is what binds the token. */
export const decode = (jwt: string): Effect.Effect<DecodedJwt, InvalidJwt> =>
  Effect.fromResult(
    Result.flatMap(part(jwt, 1), (json) =>
      Result.match(decodeClaims(json), {
        onFailure: (e) => Result.fail(new InvalidJwt({ reason: e.message })),
        onSuccess: (claims) => Result.succeed({ ...claims, iss: normalizeIssuer(claims.iss), rawIss: claims.iss })
      }))
  )

/** Decode a JWT's header. */
export const decodeHeader = (jwt: string): Effect.Effect<JwtHeader, InvalidJwt> =>
  Effect.fromResult(
    Result.flatMap(part(jwt, 0), (json) =>
      Result.mapError(decodeHeaderSchema(json), (e) => new InvalidJwt({ reason: e.message })))
  )

// -----------------------------------------------------------------------------
// Circuit limits
// -----------------------------------------------------------------------------

export const MAX_HEADER_LEN_B64 = 279
export const MAX_PADDED_UNSIGNED_JWT_LEN = 64 * 30

/** The header and the SHA-256-padded `header.payload` must fit the circuit. */
export const lengthChecks = (jwt: string): Effect.Effect<void, InvalidJwt> => {
  const [header = "", payload = ""] = jwt.split(".")
  if (header.length > MAX_HEADER_LEN_B64) return Effect.fail(new InvalidJwt({ reason: "Header is too long" }))
  const L = (header.length + 1 + payload.length) * 8
  const K = (512 + 448 - ((L % 512) + 1)) % 512
  const padded = (L + 1 + K + 64) / 8
  return padded > MAX_PADDED_UNSIGNED_JWT_LEN ? Effect.fail(new InvalidJwt({ reason: "JWT is too long" })) : Effect.void
}

// -----------------------------------------------------------------------------
// Claims as the prover reports them
// -----------------------------------------------------------------------------

/** A claim's base64url slice of the payload and its offset mod 4 (`issBase64Details`). */
export interface Claim {
  readonly value: string
  readonly indexMod4: number
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** Decode a base64url slice that started at offset `i` of the full string. */
const decodeBase64UrlSlice = (s: string, i: number): string => {
  if (s.length < 2) throw new Error(`Input (s = ${s}) is not tightly packed because s.length < 2`)
  const bits: Array<number> = []
  for (const ch of s) {
    const index = ALPHABET.indexOf(ch)
    if (index === -1) throw new Error("Invalid base64Url character: " + ch)
    for (let b = 5; b >= 0; b--) bits.push((index >> b) & 1)
  }
  let start = 0
  let end = bits.length
  const first = i % 4
  if (first === 1) start = 2
  else if (first === 2) start = 4
  else if (first === 3) throw new Error(`Input (s = ${s}) is not tightly packed because i%4 = 3 (i = ${i}))`)
  const last = (i + s.length - 1) % 4
  if (last === 2) end -= 2
  else if (last === 1) end -= 4
  else if (last === 0) {
    throw new Error(`Input (s = ${s}) is not tightly packed because (i + s.length - 1)%4 = 0 (i = ${i}))`)
  }
  const used = bits.slice(start, end)
  const bytes = new Uint8Array(used.length / 8)
  for (let k = 0; k < bytes.length; k++) {
    let byte = 0
    for (let b = 0; b < 8; b++) byte = (byte << 1) | used[k * 8 + b]!
    bytes[k] = byte
  }
  return new TextDecoder().decode(bytes)
}

/** @internal */
export const extractClaimValueUnsafe = (claim: Claim, claimName: string): unknown => {
  const extended = decodeBase64UrlSlice(claim.value, claim.indexMod4)
  const last = extended.slice(-1)
  if (last !== "}" && last !== ",") throw new Error("Invalid claim")
  const json = JSON.parse("{" + extended.slice(0, -1) + "}") as Record<string, unknown>
  const keys = Object.keys(json)
  if (keys.length !== 1) throw new Error("Invalid claim")
  if (keys[0] !== claimName) throw new Error(`Invalid field name: found ${keys[0]} expected ${claimName}`)
  return json[claimName]
}

/** The value of a claim from its base64 details, checking the claim's name. */
export const extractClaimValue = (claim: Claim, claimName: string): Effect.Effect<unknown, InvalidJwt> =>
  Effect.try({ try: () => extractClaimValueUnsafe(claim, claimName), catch: (e) => new InvalidJwt({ reason: reasonOf(e) }) })

/** @internal The issuer named by `issBase64Details`. */
export const issuerOfUnsafe = (claim: Claim): string => {
  const iss = extractClaimValueUnsafe(claim, "iss")
  if (typeof iss !== "string") throw new Error("iss claim is not a string")
  return iss
}
