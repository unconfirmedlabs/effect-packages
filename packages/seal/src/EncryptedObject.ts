/**
 * The encrypted object (I2–I5): Seal's BCS layout, byte-compatible with the
 * Rust crate and `@mysten/seal`'s `EncryptedObject`.
 *
 * - `parse` decodes and applies every rule the Move parser enforces (I4):
 *   version 0, `1 ≤ threshold ≤ n`, one encrypted share per service, distinct
 *   non-zero indices, no trailing bytes. `@mysten/seal` checks only the share
 *   count (§1.7).
 * - `serialize` is the inverse; `fullId` and `weights` read the object.
 *
 * No curve code: a program that only parses objects ships no BLS (the full id
 * is built here rather than through `Kdf`, which imports `Bls`).
 */
import { hexToBytes } from "@noble/hashes/utils.js"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Result from "effect/Result"
import type * as Dem from "./Dem.ts"
import { InvalidCiphertext } from "./Errors.ts"
import { isCanonical } from "./ids.ts"

export { InvalidCiphertext }

type Address = Bcs.Address

/** The key encapsulation: one variant, Boneh-Franklin on BLS12-381 (I2). */
export const IbeEncryptions = /* @__PURE__ */ Bcs.enum({
  BonehFranklinBLS12381: /* @__PURE__ */ Bcs.struct({
    nonce: /* @__PURE__ */ Bcs.bytes(96),
    encryptedShares: /* @__PURE__ */ Bcs.vector(/* @__PURE__ */ Bcs.bytes(32)),
    encryptedRandomness: /* @__PURE__ */ Bcs.bytes(32)
  })
})
export type IbeEncryptions = typeof IbeEncryptions.Type

/** The DEM ciphertext (I2). Decodes to exactly `Dem.Ciphertext`. */
export const Ciphertext = /* @__PURE__ */ Bcs.enum({
  Aes256Gcm: /* @__PURE__ */ Bcs.struct({
    blob: Bcs.byteVector,
    aad: /* @__PURE__ */ Bcs.option(Bcs.byteVector)
  }),
  Hmac256Ctr: /* @__PURE__ */ Bcs.struct({
    blob: Bcs.byteVector,
    aad: /* @__PURE__ */ Bcs.option(Bcs.byteVector),
    mac: /* @__PURE__ */ Bcs.bytes(32)
  }),
  Plain: null
})
export type Ciphertext = typeof Ciphertext.Type

/** The struct of I2, without the validity rules of I4 (use `parse`). */
export const EncryptedObjectBcs = /* @__PURE__ */ Bcs.struct({
  version: Bcs.u8,
  packageId: Bcs.Address,
  id: Bcs.byteVector,
  services: /* @__PURE__ */ Bcs.vector(/* @__PURE__ */ Bcs.tuple([Bcs.Address, Bcs.u8])),
  threshold: Bcs.u8,
  encryptedShares: IbeEncryptions,
  ciphertext: Ciphertext
})

export interface EncryptedObject {
  readonly version: 0
  /** The policy package's first version (I1). */
  readonly packageId: Address
  /** The inner id. */
  readonly id: Uint8Array
  /** `(key server object id, share index)`, one per share; a server of weight `w` appears `w` times (I3). */
  readonly services: ReadonlyArray<readonly [Address, number]>
  readonly threshold: number
  readonly encryptedShares: IbeEncryptions
  readonly ciphertext: Dem.Ciphertext
}

// Compile-time check: the BCS ciphertext decodes to exactly `Dem.Ciphertext`.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
type _SameCiphertext = Assert<Same<Ciphertext, Dem.Ciphertext>>

const decodeBcs = /* @__PURE__ */ Bcs.decode(EncryptedObjectBcs)
const encodeBcs = /* @__PURE__ */ Bcs.encodeSync(EncryptedObjectBcs)

// Parsed objects always have canonical ids; hand-built ones (given to `Envelope.open`) are checked too.

const invalid = (reason: string) => Result.fail(new InvalidCiphertext({ reason }))

/**
 * The rules of I4 on a decoded object (`parse` applies them; `Envelope.open` re-applies them to
 * objects built by hand). The share count also bounds `n ≤ 255`.
 */
export const validate = (object: typeof EncryptedObjectBcs.Type): Result.Result<EncryptedObject, InvalidCiphertext> => {
  if (object.version !== 0) return invalid(`unsupported version ${object.version}`)
  if (!isCanonical(object.packageId)) return invalid(`invalid package id ${object.packageId}`)
  const n = object.services.length
  if (!Number.isInteger(object.threshold) || object.threshold < 1 || object.threshold > n) {
    return invalid(`threshold ${object.threshold} out of range for ${n} services`)
  }
  const shares = object.encryptedShares.encryptedShares.length
  if (shares !== n) return invalid(`${shares} encrypted shares for ${n} services`)
  const seen = new Set<number>()
  if (object.encryptedShares.encryptedShares.some((s) => s.length !== 32)) return invalid("encrypted shares must be 32 bytes")
  for (const [server, index] of object.services) {
    if (!isCanonical(server)) return invalid(`invalid key server id ${server}`)
    if (!Number.isInteger(index) || index < 1 || index > 255) return invalid(`share index ${index}`)
    if (seen.has(index)) return invalid(`duplicate share index ${index}`)
    seen.add(index)
  }
  return Result.succeed(object as EncryptedObject)
}

/** Decode and apply every rule of I4. Malformed bytes and rule violations are `InvalidCiphertext`. */
export const parse = (bytes: Uint8Array): Result.Result<EncryptedObject, InvalidCiphertext> => {
  const decoded = decodeBcs(bytes)
  if (Result.isFailure(decoded)) return invalid(`malformed encrypted object: ${decoded.failure.message}`)
  return validate(decoded.success)
}

/** The BCS bytes. An object built by hand with an out-of-range field (a malformed address, a 33-byte share) is a defect. */
export const serialize = (object: EncryptedObject): Uint8Array => encodeBcs(object)

/** `package id (32 bytes) ‖ inner id` (I1), the identity the key servers derive keys for. */
export const fullId = (object: Pick<EncryptedObject, "packageId" | "id">): Uint8Array => {
  const out = new Uint8Array(32 + object.id.length)
  out.set(hexToBytes(object.packageId.slice(2)))
  out.set(object.id, 32)
  return out
}

/** How many shares each server holds, in order of first appearance. */
export const weights = (object: Pick<EncryptedObject, "services">): ReadonlyMap<Address, number> => {
  const out = new Map<Address, number>()
  for (const [server] of object.services) out.set(server, (out.get(server) ?? 0) + 1)
  return out
}
