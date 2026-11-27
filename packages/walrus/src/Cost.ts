/**
 * What storing a blob costs in WAL (C7, E4): `units × storage price × epochs`
 * for the space plus `units × write price` once, where `units` is the encoded
 * length in MiB, rounded up.
 */
import * as Encoding from "./Encoding.ts"

/** Prices in FROST per storage unit: `storage` per epoch, `write` once. Throws `RangeError` above `maxBlobSize`. */
export const cost = (
  unencodedLength: number,
  epochs: number,
  prices: { readonly storage: bigint; readonly write: bigint },
  n: number
): {
  readonly encodedLength: number
  readonly units: number
  readonly storage: bigint
  readonly write: bigint
  readonly total: bigint
} => {
  const encodedLength = Encoding.encodedLength(unencodedLength, n)
  const units = Encoding.storageUnits(encodedLength)
  const storage = BigInt(units) * prices.storage * BigInt(epochs)
  const write = BigInt(units) * prices.write
  return { encodedLength, units, storage, write, total: storage + write }
}
