/**
 * zkLogin addresses: `blake2b256(0x05 || len(iss) || iss || addressSeed)`,
 * i.e. the ordinary address of the public identifier.
 *
 * Every function takes `legacyAddress`: accounts created before Sui padded
 * the seed to 32 bytes live at a different address. Pass `true` only for
 * those; Enoki's `getZkLoginAddresses` reports which one an account is.
 */
import type * as Address from "../Address.ts"
import * as Effect from "effect/Effect"
import { genAddressSeedUnsafe } from "./AddressSeed.ts"
import { type InvalidJwt, InvalidZkLoginInput, reasonOf } from "./Errors.ts"
import * as Jwt from "./Jwt.ts"
import * as PublicIdentifier from "./PublicIdentifier.ts"

export interface AddressOptions {
  readonly legacyAddress?: boolean
}

/** @internal */
export const fromSeedUnsafe = (addressSeed: bigint, iss: string, legacyAddress: boolean): Address.Address =>
  PublicIdentifier.toAddress(PublicIdentifier.encode(addressSeed, iss, legacyAddress))

/** The address for an address seed and issuer. */
export const fromSeed = (
  addressSeed: bigint,
  iss: string,
  options?: AddressOptions
): Effect.Effect<Address.Address, InvalidZkLoginInput> =>
  Effect.try({
    try: () => fromSeedUnsafe(addressSeed, iss, options?.legacyAddress ?? false),
    catch: (e) => new InvalidZkLoginInput({ reason: reasonOf(e) })
  })

export interface ComputeOptions extends AddressOptions {
  readonly claimName: string
  readonly claimValue: string
  readonly userSalt: string | bigint
  readonly iss: string
  readonly aud: string
}

/** The address for a claim (usually `sub`), its audience, issuer and the user's salt. */
export const compute = (options: ComputeOptions): Effect.Effect<Address.Address, InvalidZkLoginInput> =>
  Effect.try({
    try: () =>
      fromSeedUnsafe(
        genAddressSeedUnsafe(options.userSalt, options.claimName, options.claimValue, options.aud),
        options.iss,
        options.legacyAddress ?? false
      ),
    catch: (e) => new InvalidZkLoginInput({ reason: reasonOf(e) })
  })

/** The address a JWT (`sub` claim) and salt sign in as. */
export const fromJwt = (
  jwt: string,
  userSalt: string | bigint,
  options?: AddressOptions
): Effect.Effect<Address.Address, InvalidJwt | InvalidZkLoginInput> =>
  Effect.gen(function*() {
    yield* Jwt.lengthChecks(jwt)
    const claims = yield* Jwt.decode(jwt)
    return yield* compute({
      userSalt,
      claimName: "sub",
      claimValue: claims.sub,
      aud: claims.aud,
      iss: claims.iss,
      ...(options?.legacyAddress !== undefined && { legacyAddress: options.legacyAddress })
    })
  })
