/**
 * Seal's identities and key derivations (C1, C2, C5, C7).
 *
 * - `fullId`: `package id ‖ inner id` (I1).
 * - `gid`: the identity hashed to G1 with Seal's prefix.
 * - `kdf`: the key that masks one share (C5).
 * - `deriveKey`: the randomness key and the DEM key from the base key (C7).
 */
import { sha3_256 } from "@noble/hashes/sha3.js"
import { hexToBytes } from "@noble/hashes/utils.js"
import type { Address } from "@unconfirmed/sui/Address"
import * as Bls from "./Bls.ts"
import { concat, utf8 } from "./bytes.ts"

/** `H1(id)` (C1). */
export const DST_ID: Uint8Array = /* @__PURE__ */ utf8("SUI-SEAL-IBE-BLS12381-00")
/** The share KDF (C1, C5). */
export const DST_KDF: Uint8Array = /* @__PURE__ */ utf8("SUI-SEAL-IBE-BLS12381-H2-00")
/** Key derivation from the base key (C1, C7). */
export const DST_DERIVE_KEY: Uint8Array = /* @__PURE__ */ utf8("SUI-SEAL-IBE-BLS12381-H3-00")
/** Proof of possession (C1, C17). */
export const DST_POP: Uint8Array = /* @__PURE__ */ utf8("SUI-SEAL-IBE-BLS12381-POP-00")

/** @internal The 32 bytes of a normalised address. */
export const addressBytes = (address: Address): Uint8Array => hexToBytes(address.slice(2))

/** @internal */
export { concat }

/** `package id (32 bytes) ‖ inner id` (I1). `packageId` must be the policy package's first version. */
export const fullId = (packageId: Address, id: Uint8Array): Uint8Array => concat([addressBytes(packageId), id])

/** `hashToG1(DST_ID ‖ fullId)` (C2). */
export const gid = (fullId: Uint8Array): Bls.G1 => Bls.hashToG1(concat([DST_ID, fullId]))

/**
 * `sha3_256(DST_KDF ‖ gt (576) ‖ nonce (96) ‖ gid (48) ‖ object id (32) ‖ index (1))` (C5).
 * `gt` is in fastcrypto's layout (`Bls.pairingBytes`); `index` is a u8.
 */
export const kdf = (gt: Uint8Array, nonce: Uint8Array, gid: Uint8Array, objectId: Address, index: number): Uint8Array =>
  sha3_256
    .create()
    .update(DST_KDF)
    .update(gt)
    .update(nonce)
    .update(gid)
    .update(addressBytes(objectId))
    .update(Uint8Array.of(index))
    .digest()

/**
 * `sha3_256(DST_DERIVE_KEY ‖ baseKey ‖ purpose ‖ threshold (1) ‖ every encrypted share ‖ every object id)` (C7),
 * purpose `0x00` for the randomness key and `0x01` for the DEM key. Object ids are listed with
 * multiplicity, in `services` order.
 */
export const deriveKey = (
  purpose: "EncryptedRandomness" | "Dem",
  baseKey: Uint8Array,
  encryptedShares: ReadonlyArray<Uint8Array>,
  threshold: number,
  objectIds: ReadonlyArray<Address>
): Uint8Array => {
  const hash = sha3_256
    .create()
    .update(DST_DERIVE_KEY)
    .update(baseKey)
    .update(Uint8Array.of(purpose === "EncryptedRandomness" ? 0 : 1))
    .update(Uint8Array.of(threshold))
  for (const share of encryptedShares) hash.update(share)
  for (const id of objectIds) hash.update(addressBytes(id))
  return hash.digest()
}
