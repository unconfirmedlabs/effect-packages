/**
 * Signing in with zkLogin through Enoki, as two Effects around the OAuth
 * redirect your app performs:
 *
 *   const session = yield* ZkLoginFlow.start({ ephemeral, network: "testnet" })
 *   // redirect to ZkLoginFlow.authorizationUrl({ provider: "google", clientId, redirectUrl, nonce: session.nonce })
 *   // ... the provider redirects back with an id_token (JWT)
 *   const { signer } = yield* ZkLoginFlow.complete(session, jwt)
 *   yield* Tx.run(recipe, { signer })   // or Sponsor.run(recipe, { signer, jwt })
 *
 * Across the redirect, persist the session's data (`SessionData`, a Schema:
 * encode it to JSON) and the ephemeral key, then pass both back:
 * `complete({ ...yield* Schema.decodeUnknownEffect(SessionData)(saved), ephemeral }, jwt)`.
 */
import * as Address from "@unconfirmed/sui/Address"
import * as Signer from "@unconfirmed/sui/Signer"
import type { InvalidJwt } from "@unconfirmed/sui-zklogin/Errors"
import * as Jwt from "@unconfirmed/sui-zklogin/Jwt"
import * as Nonce from "@unconfirmed/sui-zklogin/Nonce"
import * as PublicIdentifier from "@unconfirmed/sui-zklogin/PublicIdentifier"
import * as ZkLogin from "@unconfirmed/sui-zklogin/ZkLogin"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EnokiClient, type EnokiError, EnokiNetwork, type ZkLoginZkp } from "./EnokiClient.ts"

/** What to persist across the OAuth redirect (with the ephemeral key, which is the app's to store). */
export const SessionData = Schema.Struct({
  network: Schema.optionalKey(EnokiNetwork),
  nonce: Schema.String,
  randomness: Schema.String,
  maxEpoch: Schema.Number,
  /** Milliseconds since the epoch after which the proof stops working. */
  estimatedExpiration: Schema.Number
})
export type SessionData = typeof SessionData.Type

/** A login in progress: its data and the ephemeral signer the nonce commits to. */
export interface Session extends SessionData {
  readonly ephemeral: Signer.Signer
}

/** The JWT's `nonce` claim is not this session's nonce (a stale token, or one from another login). */
export class JwtNonceMismatch extends Schema.TaggedError<JwtNonceMismatch>()("JwtNonceMismatch", {
  expected: Schema.String,
  received: Schema.optionalKey(Schema.String)
}) {
  override get message() {
    return this.received === undefined
      ? `the JWT has no nonce claim (expected ${this.expected})`
      : `the JWT's nonce ${this.received} is not this session's nonce ${this.expected}`
  }
}

/** Enoki's nonce does not commit to our ephemeral key, `maxEpoch` and randomness. */
export class InvalidEnokiNonce extends Schema.TaggedError<InvalidEnokiNonce>()("InvalidEnokiNonce", {
  reason: Schema.String
}) {}

/**
 * Ask Enoki for a nonce committing to the ephemeral key. The nonce is
 * recomputed locally from the returned `maxEpoch` and randomness; a nonce
 * that doesn't match is refused (it would bind the login to someone else's key).
 */
export const start = (options: {
  readonly ephemeral: Signer.Signer
  readonly network?: EnokiNetwork
  readonly additionalEpochs?: number
}): Effect.Effect<Session, EnokiError | InvalidEnokiNonce, EnokiClient> =>
  Effect.gen(function*() {
    const enoki = yield* EnokiClient
    const n = yield* enoki.createZkLoginNonce({
      ephemeralPublicKey: options.ephemeral.publicKey,
      ...(options.network !== undefined && { network: options.network }),
      ...(options.additionalEpochs !== undefined && { additionalEpochs: options.additionalEpochs })
    })
    const expected = yield* Nonce.generate(options.ephemeral.publicKey, n.maxEpoch, n.randomness).pipe(
      Effect.mapError((e) => new InvalidEnokiNonce({ reason: e.reason }))
    )
    if (expected !== n.nonce) {
      return yield* new InvalidEnokiNonce({ reason: `Enoki returned nonce ${n.nonce}, expected ${expected}` })
    }
    return {
      ephemeral: options.ephemeral,
      ...(options.network !== undefined && { network: options.network }),
      nonce: n.nonce,
      randomness: n.randomness,
      maxEpoch: n.maxEpoch,
      estimatedExpiration: n.estimatedExpiration
    } satisfies Session
  })

export interface Completed {
  readonly signer: Signer.Signer
  readonly address: Address.Address
  readonly salt: string
  readonly proof: ZkLoginZkp
}

/**
 * With the JWT from the OAuth redirect: check that it carries this session's
 * nonce (locally, before spending a prover call), look up the user's address
 * and salt, get the ZK proof, and build the zkLogin `Signer`. Legacy accounts
 * are detected by matching the proof against the address Enoki reports.
 */
export const complete = (
  session: Session,
  jwt: string
): Effect.Effect<Completed, EnokiError | Signer.InvalidKey | InvalidJwt | JwtNonceMismatch, EnokiClient> =>
  Effect.gen(function*() {
    const claims = yield* Jwt.decode(jwt)
    if (claims.nonce !== session.nonce) {
      return yield* new JwtNonceMismatch({ expected: session.nonce, ...(claims.nonce !== undefined && { received: claims.nonce }) })
    }
    const enoki = yield* EnokiClient
    const [account, proof] = yield* Effect.all([
      enoki.getZkLogin({ jwt }),
      enoki.createZkLoginZkp({
        jwt,
        ephemeralPublicKey: session.ephemeral.publicKey,
        randomness: session.randomness,
        maxEpoch: session.maxEpoch,
        ...(session.network !== undefined && { network: session.network })
      })
    ], { concurrency: "unbounded" })
    // The signer derives the address from the proof; pick the derivation that matches Enoki's.
    const current = yield* ZkLogin.signer({ ephemeral: session.ephemeral, inputs: proof, maxEpoch: session.maxEpoch })
    const expected = yield* Effect.try({
      try: () => Address.normalize(account.address),
      catch: () => new Signer.InvalidKey({ scheme: "ZkLogin", reason: `Enoki returned an invalid address ${account.address}` })
    })
    const legacyAddress = current.address !== expected &&
      PublicIdentifier.toAddress(current.publicKey.bytes, { legacyAddress: true }) === expected
    const signer = yield* ZkLogin.signer({
      ephemeral: session.ephemeral,
      inputs: proof,
      maxEpoch: session.maxEpoch,
      legacyAddress,
      address: expected
    })
    return { signer, address: signer.address, salt: account.salt, proof }
  })

export type AuthProvider = "google" | "facebook" | "twitch"

/** The OAuth URL to send the user to (implicit flow, `id_token`), as `@mysten/enoki`'s `EnokiFlow` builds it. */
export const authorizationUrl = (options: {
  readonly provider: AuthProvider
  readonly clientId: string
  readonly redirectUrl: string
  readonly nonce: string
  readonly extraParams?: Readonly<Record<string, string>>
}): string => {
  const { scope, ...extra } = options.extraParams ?? {}
  const params = new URLSearchParams({
    ...extra,
    nonce: options.nonce,
    client_id: options.clientId,
    redirect_uri: options.redirectUrl,
    response_type: "id_token",
    scope: ["openid", ...(scope ? [scope] : [])].join(" ")
  })
  switch (options.provider) {
    case "google":
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
    case "facebook":
      return `https://www.facebook.com/v17.0/dialog/oauth?${params}`
    case "twitch":
      params.set("force_verify", "true")
      return `https://id.twitch.tv/oauth2/authorize?${params}`
  }
}
