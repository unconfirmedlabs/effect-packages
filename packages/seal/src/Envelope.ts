/**
 * Encryption and decryption with no I/O: seal a payload to a set of key
 * servers given their public keys, and open an encrypted object given derived
 * keys.
 *
 * `seal` (byte-compatible with `@mysten/seal`'s `encrypt` under the same
 * randomness): split a base key (C11), encrypt one share per recipient under
 * the full id (C4), encrypt `r` under the randomness key (C8), derive the DEM
 * key (C7) and encrypt the payload with it (C12–C14). The returned key is the
 * DEM key (C15).
 *
 * `open`: decrypt the first `threshold` shares whose server has a key, combine
 * them, recover `r` and check `G2·r = nonce` (what detects wrong keys or a
 * corrupt object), optionally check share consistency (C10), then the DEM.
 * Keys are assumed verified (`Keys.fetch` verifies them): unverified keys can
 * only produce `InvalidCiphertext` or `DecryptionFailed`, never a wrong
 * plaintext, except in `Plain` mode, where a wrong key comes out silently.
 */
import { bytesToHex } from "@noble/hashes/utils.js"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Bls from "./Bls.ts"
import { xor } from "./bytes.ts"
import * as Dem from "./Dem.ts"
import * as EncryptedObject from "./EncryptedObject.ts"
import * as Entropy from "./Entropy.ts"
import { CryptoUnavailable, DecryptionFailed, InvalidCiphertext, InvalidEncryption, NotEnoughKeys } from "./Errors.ts"
import * as Ibe from "./Ibe.ts"
import { isCanonical } from "./ids.ts"
import * as Kdf from "./Kdf.ts"
import * as Shamir from "./Shamir.ts"

export { CryptoUnavailable, DecryptionFailed, InvalidCiphertext, InvalidEncryption, NotEnoughKeys }

type Address = EncryptedObject.EncryptedObject["packageId"]

/** One entry per share: repeat a server to give it weight. */
export interface Recipient {
  readonly objectId: Address
  /** The server's 96-byte G2 public key. */
  readonly publicKey: Uint8Array
}

/**
 * Everything random about one encryption. **Never reuse one**: the DEM key is
 * a function of `(baseKey, r, id, recipients, threshold)`, so sealing two
 * payloads with the same randomness to the same id and recipients reuses the
 * AES-GCM key under Seal's fixed IV (or the HMAC-CTR keystream). Draw a fresh
 * value with `randomness` for every `seal`.
 */
export interface Randomness {
  /** 32 bytes. */
  readonly baseKey: Uint8Array
  /** `32 × (threshold − 1)` bytes, laid out as `Shamir.split` takes them. */
  readonly coefficients: Uint8Array
  /** Non-zero and below the group order. */
  readonly r: Bls.Scalar
}

const KEY_BYTES = 32
/** Shares and the threshold are `u8`s; indices run `1..=n` (I5). */
export const MAX_SHARES = 255

/** `32 + 32(t − 1) + 48` bytes of `Entropy`: base key, coefficients, then the 48 bytes mapped to `r`. */
export const randomness = (threshold: number): Effect.Effect<Randomness> =>
  Effect.gen(function*() {
    const baseKey = yield* Entropy.bytes(KEY_BYTES)
    const coefficients = yield* Entropy.bytes(KEY_BYTES * Math.max(0, threshold - 1))
    const r = Bls.scalarFromEntropy(yield* Entropy.bytes(48))
    return { baseKey, coefficients, r }
  })

/**
 * Decode public keys, each distinct byte string once: a server of weight `w`
 * appears `w` times, and handing `Ibe` the same point object lets it pair once.
 */
const decodePublicKeys = (
  keys: ReadonlyArray<Uint8Array>
): Result.Result<ReadonlyArray<Bls.G2>, { readonly index: number; readonly reason: string }> => {
  const decoded = new Map<string, Bls.G2>()
  const out: Array<Bls.G2> = []
  for (const [index, bytes] of keys.entries()) {
    const k = bytesToHex(bytes)
    let point = decoded.get(k)
    if (point === undefined) {
      const pk = Bls.g2FromBytes(bytes)
      if (Result.isFailure(pk)) return Result.fail({ index, reason: pk.failure.reason })
      decoded.set(k, point = pk.success)
    }
    out.push(point)
  }
  return Result.succeed(out)
}

const isByteCount = (n: number, min: number) => Number.isInteger(n) && n >= min && n <= MAX_SHARES

export interface SealOptions {
  /** The policy package's first version (I1). */
  readonly packageId: Address
  readonly id: Uint8Array
  readonly recipients: ReadonlyArray<Recipient>
  readonly threshold: number
  readonly input: Dem.Input
  readonly randomness: Randomness
}

export interface Sealed {
  readonly object: EncryptedObject.EncryptedObject
  readonly bytes: Uint8Array
  /** The DEM key (C15): it decrypts this object; keep it secret or drop it. */
  readonly key: Uint8Array
}

const failEncryption = (reason: string) => Result.fail(new InvalidEncryption({ reason }))

interface Prepared {
  readonly publicKeys: ReadonlyArray<Bls.G2>
  readonly shares: ReadonlyArray<Shamir.Share>
}

const prepare = (o: SealOptions): Result.Result<Prepared, InvalidEncryption> => {
  const n = o.recipients.length
  if (!isByteCount(n, 1)) return failEncryption(`need 1 to ${MAX_SHARES} recipients, got ${n}`)
  if (!isByteCount(o.threshold, 1) || o.threshold > n) {
    return failEncryption(`threshold ${o.threshold} out of range for ${n} recipients`)
  }
  if (!isCanonical(o.packageId)) return failEncryption(`invalid package id ${o.packageId}`)
  if (!(o.id instanceof Uint8Array)) return failEncryption("id must be bytes")
  for (const [i, recipient] of o.recipients.entries()) {
    if (!isCanonical(recipient.objectId)) return failEncryption(`recipient ${i}: invalid object id ${recipient.objectId}`)
  }
  const decoded = decodePublicKeys(o.recipients.map((r) => r.publicKey))
  if (Result.isFailure(decoded)) {
    return failEncryption(`recipient ${decoded.failure.index}: invalid public key: ${decoded.failure.reason}`)
  }
  const publicKeys = decoded.success
  const { baseKey, coefficients, r } = o.randomness
  if (baseKey.length !== KEY_BYTES) return failEncryption(`base key must be ${KEY_BYTES} bytes, got ${baseKey.length}`)
  if (r <= 0n || r >= Bls.ORDER) return failEncryption("r must be a non-zero scalar below the group order")
  const shares = Shamir.split(baseKey, o.threshold, n, coefficients)
  if (Result.isFailure(shares)) return failEncryption(shares.failure.reason)
  return Result.succeed({ publicKeys, shares: shares.success })
}

/**
 * Encrypt `input` to `recipients` (one share each, indices `1..n` in order), any `threshold` of
 * which can decrypt. Checks `1 ≤ threshold ≤ n ≤ 255`, ids, public keys and randomness sizes.
 * `randomness` must be fresh for every call (`randomness(threshold)`): see `Randomness`.
 */
export const seal = (o: SealOptions): Effect.Effect<Sealed, InvalidEncryption | CryptoUnavailable> =>
  Effect.suspend((): Effect.Effect<Sealed, InvalidEncryption | CryptoUnavailable> => {
    const prepared = prepare(o)
    if (Result.isFailure(prepared)) return Effect.fail(prepared.failure)
    const { publicKeys, shares } = prepared.success
    const { baseKey, r } = o.randomness
    const objectIds = o.recipients.map((x) => x.objectId)
    const services = o.recipients.map((x, i) => ({ objectId: x.objectId, index: shares[i]!.index }))
    const fullId = EncryptedObject.fullId(o)
    const { nonce, encryptedShares } = Ibe.encryptShares(r, shares.map((s) => s.share), publicKeys, fullId, services)
    const randomnessKey = Kdf.deriveKey("EncryptedRandomness", baseKey, encryptedShares, o.threshold, objectIds)
    const encryptedRandomness = xor(Bls.scalarToBytes(r), randomnessKey)
    const key = Kdf.deriveKey("Dem", baseKey, encryptedShares, o.threshold, objectIds)
    return Effect.map(Dem.encrypt(o.input, key), (ciphertext): Sealed => {
      const object: EncryptedObject.EncryptedObject = {
        version: 0,
        packageId: o.packageId,
        id: o.id,
        services: services.map((s) => [s.objectId, s.index] as const),
        threshold: o.threshold,
        encryptedShares: { _tag: "BonehFranklinBLS12381", nonce, encryptedShares, encryptedRandomness },
        ciphertext
      }
      return { object, bytes: EncryptedObject.serialize(object), key }
    })
  })

export interface OpenOptions {
  readonly object: EncryptedObject.EncryptedObject
  /** Verified derived keys by server (48-byte G1). */
  readonly keys: ReadonlyMap<Address, Uint8Array>
  /** One 96-byte G2 public key per `services` entry: turns on the consistency check (C10). */
  readonly publicKeys?: ReadonlyArray<Uint8Array> | undefined
  /** Also accept a little-endian `r` (C9). */
  readonly legacyNonce?: boolean | undefined
}

const failCiphertext = (reason: string) => Result.fail(new InvalidCiphertext({ reason }))

/** Everything up to the DEM key, synchronously. */
const recoverKey = (o: OpenOptions): Result.Result<Uint8Array, InvalidCiphertext | NotEnoughKeys> => {
  const valid = EncryptedObject.validate(o.object)
  if (Result.isFailure(valid)) return Result.fail(valid.failure)
  const object = valid.success
  const { threshold } = object
  const ibe = object.encryptedShares
  const services = object.services.map(([objectId, index]) => ({ objectId, index }))
  const objectIds = services.map((s) => s.objectId)

  const usable = services.flatMap((s, i) => (o.keys.has(s.objectId) ? [i] : []))
  if (usable.length < threshold) {
    return Result.fail(new NotEnoughKeys({ required: threshold, available: usable.length }))
  }
  const nonce = Bls.g2FromBytes(ibe.nonce)
  if (Result.isFailure(nonce)) return failCiphertext(`invalid nonce: ${nonce.failure.reason}`)
  const fullId = EncryptedObject.fullId(object)

  // `threshold` shares determine the polynomial; more would only cost pairings (a wrong key among
  // them is caught by the nonce check either way). One pairing per server, however many shares it
  // holds, and `gid` once.
  const used = usable.slice(0, threshold)
  const gts = new Map<Address, Uint8Array>()
  for (const i of used) {
    const server = services[i]!.objectId
    if (gts.has(server)) continue
    const usk = Bls.g1FromBytes(o.keys.get(server)!)
    if (Result.isFailure(usk)) return failCiphertext(`invalid derived key for ${server}: ${usk.failure.reason}`)
    gts.set(server, Ibe.decap(nonce.success, usk.success))
  }
  const nonceBytes = Bls.g2ToBytes(nonce.success)
  const gidBytes = Bls.g1ToBytes(Kdf.gid(fullId))
  const shares = used.map((i): Shamir.Share => {
    const service = services[i]!
    return {
      index: service.index,
      share: Ibe.unmask(gts.get(service.objectId)!, nonceBytes, gidBytes, ibe.encryptedShares[i]!, service)
    }
  })
  const baseKey = Shamir.combine(shares)
  if (Result.isFailure(baseKey)) return failCiphertext(baseKey.failure.reason)

  const randomnessKey = Kdf.deriveKey("EncryptedRandomness", baseKey.success, ibe.encryptedShares, threshold, objectIds)
  const rBytes = xor(ibe.encryptedRandomness, randomnessKey)
  const candidates = o.legacyNonce === true ? ["be", "le"] as const : ["be"] as const
  let r: Bls.Scalar | undefined
  for (const endian of candidates) {
    const s = Bls.scalarFromBytes(rBytes, endian)
    if (Result.isSuccess(s) && Ibe.verifyNonce(nonce.success, s.success)) {
      r = s.success
      break
    }
  }
  if (r === undefined) return failCiphertext("the randomness does not match the nonce (wrong keys or a corrupt object)")

  if (o.publicKeys !== undefined) {
    if (o.publicKeys.length !== services.length) {
      return failCiphertext(`expected ${services.length} public keys for the consistency check, got ${o.publicKeys.length}`)
    }
    const decoded = decodePublicKeys(o.publicKeys)
    if (Result.isFailure(decoded)) return failCiphertext(`public key ${decoded.failure.index}: ${decoded.failure.reason}`)
    const publicKeys = decoded.success
    const polynomial = Shamir.interpolate(shares)
    if (Result.isFailure(polynomial)) return failCiphertext(polynomial.failure.reason)
    const all = Ibe.decryptAllShares(r, ibe.encryptedShares, publicKeys, fullId, services)
    for (const [i, share] of all.entries()) {
      const expected = polynomial.success(services[i]!.index)
      if (expected.some((b, j) => b !== share[j])) return failCiphertext("inconsistent shares")
    }
  }
  return Result.succeed(Kdf.deriveKey("Dem", baseKey.success, ibe.encryptedShares, threshold, objectIds))
}

/**
 * Decrypt with derived keys of servers holding at least `threshold` of the object's shares
 * (`NotEnoughKeys` otherwise). Wrong keys, a mismatched nonce or a non-canonical `r` are
 * `InvalidCiphertext`; a bad tag or mac `DecryptionFailed`. `Plain` objects return the DEM key.
 */
export const open = (
  o: OpenOptions
): Effect.Effect<Uint8Array, NotEnoughKeys | InvalidCiphertext | DecryptionFailed | CryptoUnavailable> =>
  Effect.suspend((): Effect.Effect<Uint8Array, NotEnoughKeys | InvalidCiphertext | DecryptionFailed | CryptoUnavailable> => {
    const key = recoverKey(o)
    return Result.isFailure(key) ? Effect.fail(key.failure) : Dem.decrypt(o.object.ciphertext, key.success)
  })
