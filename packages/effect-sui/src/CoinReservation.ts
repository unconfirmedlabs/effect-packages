/**
 * Coin reservation refs: a gas-payment entry that funds the gas coin from the
 * gas owner's SUI address balance.
 *
 * When a transaction uses the gas coin (`Ptb.gas`) its payment can't be empty,
 * but the owner may hold SUI in their address balance rather than (or as well
 * as) coin objects. A reservation ref is a synthetic `ObjectRef` that tells
 * validators to draw up to `reserved` MIST from that balance into the gas
 * coin for this epoch:
 *
 * - `objectId`: the owner's SUI accumulator field id (under `0xacc`) XOR the chain id;
 * - `version`: 0;
 * - `digest`: `reserved` (u64 LE) ‖ `epoch` (u32 LE) ‖ twenty `0xac` bytes.
 */
import { base58 } from "@scure/base"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Bytes from "@unconfirmed/effect-bcs/Bytes"
import { type Address, fromBytes, normalize } from "./Address.ts"
import { deriveId } from "./DynamicFields.ts"
import type { ObjectDigest, ObjectRef } from "./TransactionData.ts"

const ACCUMULATOR_ROOT = /* @__PURE__ */ normalize("0xacc")
const SUI_ACCUMULATOR_KEY = "0x2::accumulator::Key<0x2::balance::Balance<0x2::sui::SUI>>"
const MAGIC = new Uint8Array(20).fill(0xac)

/** Is this gas-payment entry a reservation rather than a coin object? */
export const isReservation = (ref: ObjectRef): boolean => {
  try {
    const d = base58.decode(ref.digest)
    return d.length === 32 && d.subarray(12).every((b, i) => b === MAGIC[i])
  } catch {
    return false
  }
}

/** The MIST a reservation ref reserves. */
export const reservedOf = (ref: ObjectRef): bigint => {
  const d = base58.decode(ref.digest)
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(0, true)
}

/**
 * A reservation of `reserved` MIST from `owner`'s SUI address balance, valid
 * in `epoch` on the chain `chainId` (the genesis checkpoint digest).
 * Fails (as a defect) only on an epoch beyond u32, which no chain has reached.
 */
export const make = (options: {
  readonly reserved: bigint
  readonly owner: Address
  readonly chainId: string
  readonly epoch: bigint
}): ObjectRef => {
  if (options.epoch < 0n || options.epoch > 0xffffffffn) throw new Error(`epoch ${options.epoch} exceeds u32`)
  const field = Bytes.fromHex(deriveId(ACCUMULATOR_ROOT, SUI_ACCUMULATOR_KEY, Bcs.encodeSync(Bcs.Address)(options.owner)).slice(2))
  const chain = base58.decode(options.chainId)
  if (chain.length !== 32) throw new Error(`chain id must be 32 bytes, got ${chain.length}`)
  const id = field.map((b, i) => b ^ chain[i]!)

  const digest = new Uint8Array(32)
  const view = new DataView(digest.buffer)
  view.setBigUint64(0, options.reserved, true)
  view.setUint32(8, Number(options.epoch), true)
  digest.set(MAGIC, 12)
  return { objectId: fromBytes(id), version: 0n, digest: base58.encode(digest) as ObjectDigest }
}
