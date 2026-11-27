/**
 * The Walrus Merkle tree (E5, `crates/walrus-core/src/merkle.rs`): Blake2b-256,
 * leaf hash `H(0x00 ‖ leaf)`, inner hash `H(0x01 ‖ left ‖ right)`, an odd
 * level padded with the empty node (32 zero bytes).
 */
import { blake2b } from "@noble/hashes/blake2.js"

export const DIGEST_LENGTH = 32

/** The empty node: 32 zero bytes. */
export const empty = (): Uint8Array => new Uint8Array(DIGEST_LENGTH)

export const leafHash = (leaf: Uint8Array): Uint8Array => {
  const input = new Uint8Array(1 + leaf.length)
  input.set(leaf, 1)
  return blake2b(input, { dkLen: DIGEST_LENGTH })
}

export const innerHash = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const input = new Uint8Array(1 + 2 * DIGEST_LENGTH)
  input[0] = 1
  input.set(left, 1)
  input.set(right, 1 + DIGEST_LENGTH)
  return blake2b(input, { dkLen: DIGEST_LENGTH })
}

/** The root over already-hashed leaves. */
export const rootOfLeafHashes = (hashes: ReadonlyArray<Uint8Array>): Uint8Array => {
  if (hashes.length === 0) return empty()
  let level = hashes.slice()
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(empty())
    const next: Array<Uint8Array> = []
    for (let i = 0; i < level.length; i += 2) next.push(innerHash(level[i]!, level[i + 1]!))
    level = next
  }
  return level[0]!
}

/** The root over raw leaves (each is hashed with `leafHash`). `[]` is 32 zero bytes. */
export const root = (leaves: ReadonlyArray<Uint8Array>): Uint8Array => rootOfLeafHashes(leaves.map(leafHash))
