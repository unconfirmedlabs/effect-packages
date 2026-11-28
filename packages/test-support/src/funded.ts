/**
 * Funded testnet accounts for live tests, from environment variables only.
 * Nothing here reads the Sui CLI's config or any file.
 *
 * - `SUI_FUNDED_ADDRESS`: a testnet address holding SUI, for live tests that
 *   only build (nothing is signed). Without it those tests skip.
 * - `SUI_LIVE_PRIVATE_KEY`: a `suiprivkey1…` key (Ed25519, Secp256k1 or
 *   Secp256r1) for the funded runs that spend (`WALRUS_LIVE`, `SEAL_LIVE`).
 *   It is never printed or logged: any problem loading it becomes one fixed
 *   message that does not contain it.
 */
import * as Effect from "effect/Effect"
import * as Ed25519 from "@unconfirmed/effect-sui/Ed25519"
import * as PrivateKey from "@unconfirmed/effect-sui/PrivateKey"
import type * as Signer from "@unconfirmed/effect-sui/Signer"

const ADDRESS = /^0x[0-9a-fA-F]{64}$/

/** `SUI_FUNDED_ADDRESS`, lower-cased, or `undefined` when unset (callers skip). A malformed value is an error, not a skip. */
export const fundedAddress = (): string | undefined => {
  const value = process.env.SUI_FUNDED_ADDRESS?.trim()
  if (value === undefined || value === "") return undefined
  if (!ADDRESS.test(value)) throw new Error("SUI_FUNDED_ADDRESS must be 0x followed by 64 hex digits")
  return value.toLowerCase()
}

/** The signer for `SUI_LIVE_PRIVATE_KEY`. Fails with a fixed message (never the key) when it is unset or unusable. */
export const loadLiveSigner = async (): Promise<Signer.Signer> => {
  const encoded = process.env.SUI_LIVE_PRIVATE_KEY?.trim()
  if (encoded === undefined || encoded === "") {
    throw new Error("set SUI_LIVE_PRIVATE_KEY to a suiprivkey1… key of a funded testnet account to run funded live tests")
  }
  try {
    const key = await Effect.runPromise(PrivateKey.decode(encoded))
    const signer = key.scheme === "ED25519"
      ? await Effect.runPromise(Ed25519.fromSecretKey(key.secretKey))
      : key.scheme === "Secp256k1"
      ? await Effect.runPromise((await import("@unconfirmed/effect-sui/Secp256k1")).fromSecretKey(key.secretKey))
      : key.scheme === "Secp256r1"
      ? await Effect.runPromise((await import("@unconfirmed/effect-sui/Secp256r1")).fromSecretKey(key.secretKey))
      : undefined
    if (signer !== undefined) return signer
  } catch {
    // fall through to the fixed message: no key material in assertion output
  }
  throw new Error("SUI_LIVE_PRIVATE_KEY is not a usable suiprivkey1… key (Ed25519, Secp256k1 or Secp256r1)")
}
