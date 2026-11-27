//! Walrus Merkle trees (`walrus_core::merkle::MerkleTree<Blake2b256>`), hashed
//! two nodes at a time with [`crate::blake2b::hash2`].
//!
//! Leaf hash `blake2b256(0x00 ‖ data)`, inner hash `blake2b256(0x01 ‖ left ‖
//! right)`; a level with an odd number of nodes gets a 32-byte zero sibling;
//! the root of zero leaves is the zero node. Tested against `walrus-core` in
//! `cargo test`.

use crate::blake2b::hash2;

pub type Hash = [u8; 32];

/// Leaf hashes of `count` items of one length, `item(i)` for `i < count`.
pub fn leaf_hashes<'a>(count: usize, item: impl Fn(usize) -> &'a [u8], out: &mut [Hash]) {
    debug_assert_eq!(out.len(), count);
    if count == 0 {
        return;
    }
    let len = item(0).len();
    let mut a = vec![0u8; 1 + len];
    let mut b = vec![0u8; 1 + len];
    let mut i = 0;
    while i < count {
        a[1..].copy_from_slice(item(i));
        let j = if i + 1 < count { i + 1 } else { i };
        b[1..].copy_from_slice(item(j));
        let [ha, hb] = hash2(&a, &b);
        out[i] = ha;
        if j != i {
            out[j] = hb;
        }
        i += 2;
    }
}

/// The root over the given leaf hashes; `level` is used as the work area.
pub fn root(level: &mut Vec<Hash>) -> Hash {
    if level.is_empty() {
        return [0; 32];
    }
    let mut a = [0u8; 65];
    let mut b = [0u8; 65];
    a[0] = 1;
    b[0] = 1;
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push([0; 32]);
        }
        let parents = level.len() / 2;
        // Parent `k` reads children `2k` and `2k + 1`, at or after `k + 1` for `k >= 1`, so the
        // parents can overwrite the start of the level (both children are copied out first).
        let mut k = 0;
        while k < parents {
            a[1..33].copy_from_slice(&level[2 * k]);
            a[33..].copy_from_slice(&level[2 * k + 1]);
            let second = k + 1 < parents;
            if second {
                b[1..33].copy_from_slice(&level[2 * k + 2]);
                b[33..].copy_from_slice(&level[2 * k + 3]);
            } else {
                b.copy_from_slice(&a);
            }
            let [ha, hb] = hash2(&a, &b);
            level[k] = ha;
            if second {
                level[k + 1] = hb;
            }
            k += 2;
        }
        level.truncate(parents);
    }
    level[0]
}

#[cfg(test)]
mod tests {
    use super::*;
    use fastcrypto::hash::Blake2b256;
    use walrus_core::merkle::{MerkleTree, Node};

    #[test]
    fn matches_walrus_core() {
        for count in 0..40usize {
            for len in [0usize, 1, 2, 31, 127, 128, 300] {
                let items: Vec<Vec<u8>> =
                    (0..count).map(|i| (0..len).map(|j| (i * 31 + j * 7) as u8).collect()).collect();
                let expected = match MerkleTree::<Blake2b256>::build(items.iter()).root() {
                    Node::Digest(d) => d,
                    Node::Empty => [0; 32],
                };
                let mut level = vec![[0u8; 32]; count];
                leaf_hashes(count, |i| &items[i], &mut level);
                assert_eq!(root(&mut level), expected, "count {count}, len {len}");
            }
        }
    }
}
