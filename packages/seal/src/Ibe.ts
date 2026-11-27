/**
 * Boneh-Franklin identity-based encryption on BLS12-381, as Seal uses it
 * (C3, C4, C8, C10, C17).
 *
 * A key server holds a master key `s` and publishes `G2·s`. The derived (user
 * secret) key for a full id is `gid·s`. Encrypting picks a randomness `r`,
 * publishes `nonce = G2·r`, and masks share `i` with
 * `kdf(e(gid·r, pk_i), nonce, gid, objectId_i, index_i)`; the holder of the
 * derived key recomputes the same pairing as `e(usk_i, nonce)`.
 *
 * On its own this is "BasicIdent", not CCA-secure: the envelope binds it to
 * the DEM key (`Kdf.deriveKey`) and checks the nonce against the recovered `r`.
 */
import type { Address } from "@unconfirmed/sui/Address"
import * as Result from "effect/Result"
import * as Bls from "./Bls.ts"
import * as Kdf from "./Kdf.ts"

/** Where a share goes: `(key server object id, share index)` of the object's `services` (I3). */
export interface Service {
  readonly objectId: Address
  readonly index: number
}

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!
  return out
}

const mask = (gt: Uint8Array, nonce: Uint8Array, gid: Uint8Array, service: Service): Uint8Array =>
  Kdf.kdf(gt, nonce, gid, service.objectId, service.index)

/**
 * Encrypt one share per service (C4). `shares`, `publicKeys` and `services` are parallel arrays;
 * shares are XOR-masked so they keep their length (32 bytes for Seal's base key).
 * `r` must be non-zero (`Bls.scalarFromEntropy` always is).
 */
export const encryptShares = (
  r: Bls.Scalar,
  shares: ReadonlyArray<Uint8Array>,
  publicKeys: ReadonlyArray<Bls.G2>,
  fullId: Uint8Array,
  services: ReadonlyArray<Service>
): { readonly nonce: Uint8Array; readonly encryptedShares: ReadonlyArray<Uint8Array> } => {
  const nonce = Bls.g2ToBytes(Bls.g2Multiply(Bls.g2Generator, r))
  const gid = Kdf.gid(fullId)
  const gidBytes = Bls.g1ToBytes(gid)
  const gidR = Bls.g1Multiply(gid, r)
  const encryptedShares = shares.map((share, i) =>
    xor(share, mask(Bls.pairingBytes(gidR, publicKeys[i]!), nonce, gidBytes, services[i]!))
  )
  return { nonce, encryptedShares }
}

/** Decrypt one share with the server's derived key (C4): the mask is `e(usk, nonce)`. */
export const decryptShare = (
  nonce: Bls.G2,
  userSecretKey: Bls.G1,
  encryptedShare: Uint8Array,
  fullId: Uint8Array,
  service: Service
): Uint8Array => {
  const gid = Bls.g1ToBytes(Kdf.gid(fullId))
  return xor(encryptedShare, mask(Bls.pairingBytes(userSecretKey, nonce), Bls.g2ToBytes(nonce), gid, service))
}

/** Every share, from the randomness and every service's public key (for the consistency check, C10). */
export const decryptAllShares = (
  r: Bls.Scalar,
  encryptedShares: ReadonlyArray<Uint8Array>,
  publicKeys: ReadonlyArray<Bls.G2>,
  fullId: Uint8Array,
  services: ReadonlyArray<Service>
): ReadonlyArray<Uint8Array> => {
  const nonce = Bls.g2ToBytes(Bls.g2Multiply(Bls.g2Generator, r))
  const gid = Kdf.gid(fullId)
  const gidBytes = Bls.g1ToBytes(gid)
  const gidR = Bls.g1Multiply(gid, r)
  return encryptedShares.map((share, i) =>
    xor(share, mask(Bls.pairingBytes(gidR, publicKeys[i]!), nonce, gidBytes, services[i]!))
  )
}

/** `e(usk, G2) == e(gid, pk)` (C3), with one final exponentiation. A key at infinity never verifies. */
export const verifyUserSecretKey = (userSecretKey: Bls.G1, fullId: Uint8Array, publicKey: Bls.G2): boolean =>
  !userSecretKey.is0() && !publicKey.is0() &&
  Bls.pairingsEqual([userSecretKey, Bls.g2Generator], [Kdf.gid(fullId), publicKey])

/** `G2·r == nonce` (C8): the check that detects wrong keys after combining shares. */
export const verifyNonce = (nonce: Bls.G2, r: Bls.Scalar): boolean => Bls.g2Multiply(Bls.g2Generator, r).equals(nonce)

const popMessage = (publicKey: Uint8Array, objectId: Address): Uint8Array =>
  Kdf.concat([Kdf.DST_POP, publicKey, Kdf.addressBytes(objectId)])

/**
 * A key server's proof of possession (C17): a min-sig BLS signature over
 * `DST_POP ‖ pk (96) ‖ object id (32)`. False for malformed points, including infinity.
 */
export const verifyProofOfPossession = (pop: Uint8Array, publicKey: Uint8Array, objectId: Address): boolean => {
  const sig = Bls.g1FromBytes(pop)
  const pk = Bls.g2FromBytes(publicKey)
  if (Result.isFailure(sig) || Result.isFailure(pk)) return false
  return Bls.pairingsEqual([sig.success, Bls.g2Generator], [Bls.hashToG1(popMessage(publicKey, objectId)), pk.success])
}

// -----------------------------------------------------------------------------
// A key server's side, for tests and local servers
// -----------------------------------------------------------------------------

/** `G2·s`, 96 bytes. */
export const publicKey = (masterKey: Bls.Scalar): Uint8Array => Bls.g2ToBytes(Bls.g2Multiply(Bls.g2Generator, masterKey))

/** The derived key `gid·s` (C3). */
export const extract = (masterKey: Bls.Scalar, fullId: Uint8Array): Bls.G1 => Bls.g1Multiply(Kdf.gid(fullId), masterKey)

/** `hashToG1(DST_POP ‖ pk ‖ object id)·s`, 48 bytes (C17). */
export const proofOfPossession = (masterKey: Bls.Scalar, objectId: Address): Uint8Array =>
  Bls.g1ToBytes(Bls.g1Multiply(Bls.hashToG1(popMessage(publicKey(masterKey), objectId)), masterKey))
