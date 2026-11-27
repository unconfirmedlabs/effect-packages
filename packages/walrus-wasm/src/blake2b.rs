//! BLAKE2b-256 (unkeyed, RFC 7693) over two equal-length messages at once.
//!
//! Each 64-bit state word holds both messages, one per lane. With `simd128`
//! a word is one `v128` and every operation is a single instruction for both
//! messages (the 32-, 24- and 16-bit rotations are byte shuffles); without it
//! a word is `[u64; 2]` and the code is plain scalar BLAKE2b run twice. The
//! Merkle trees hash millions of equal-length inputs (`0x00 ‖ symbol` leaves,
//! `0x01 ‖ left ‖ right` inner nodes), so pairs are always available.
//!
//! Tested against `fastcrypto::hash::Blake2b256` (the hash `walrus-core` uses)
//! in `cargo test` (scalar lanes) and, through the encoder parity tests, in the
//! `simd128` build.

const IV: [u64; 8] = [
    0x6a09e667f3bcc908,
    0xbb67ae8584caa73b,
    0x3c6ef372fe94f82b,
    0xa54ff53a5f1d36f1,
    0x510e527fade682d1,
    0x9b05688c2b3e6c1f,
    0x1f83d9abfb41bd6b,
    0x5be0cd19137e2179,
];

/// Parameter block word 0 for a 32-byte digest, no key, fanout 1, depth 1.
const PARAM0: u64 = 0x0101_0000 ^ 32;

pub const BLOCK: usize = 128;

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod lanes {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    pub struct X2(v128);

    impl X2 {
        #[inline(always)]
        pub fn splat(a: u64) -> Self {
            X2(u64x2_splat(a))
        }
        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            X2(i64x2_add(self.0, o.0))
        }
        #[inline(always)]
        pub fn xor(self, o: Self) -> Self {
            X2(v128_xor(self.0, o.0))
        }
        #[inline(always)]
        pub fn rotr32(self) -> Self {
            X2(i32x4_shuffle::<1, 0, 3, 2>(self.0, self.0))
        }
        #[inline(always)]
        pub fn rotr24(self) -> Self {
            X2(i8x16_shuffle::<3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10>(self.0, self.0))
        }
        #[inline(always)]
        pub fn rotr16(self) -> Self {
            X2(i8x16_shuffle::<2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9>(self.0, self.0))
        }
        #[inline(always)]
        pub fn rotr63(self) -> Self {
            X2(v128_or(u64x2_shr(self.0, 63), i64x2_add(self.0, self.0)))
        }
        #[inline(always)]
        pub fn lanes(self) -> [u64; 2] {
            [u64x2_extract_lane::<0>(self.0), u64x2_extract_lane::<1>(self.0)]
        }
        /// The 16 message words of a 128-byte block of each message.
        #[inline(always)]
        pub fn block(a: &[u8; 128], b: &[u8; 128]) -> [X2; 16] {
            let mut m = [X2::splat(0); 16];
            for k in 0..8 {
                // SAFETY: `16 * k + 16 <= 128`; `v128_load` has no alignment requirement.
                let (va, vb) = unsafe {
                    (
                        v128_load(a.as_ptr().add(16 * k) as *const v128),
                        v128_load(b.as_ptr().add(16 * k) as *const v128),
                    )
                };
                m[2 * k] = X2(i64x2_shuffle::<0, 2>(va, vb));
                m[2 * k + 1] = X2(i64x2_shuffle::<1, 3>(va, vb));
            }
            m
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod lanes {
    #[derive(Clone, Copy)]
    pub struct X2([u64; 2]);

    impl X2 {
        #[inline(always)]
        pub fn splat(a: u64) -> Self {
            X2([a, a])
        }
        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            X2([self.0[0].wrapping_add(o.0[0]), self.0[1].wrapping_add(o.0[1])])
        }
        #[inline(always)]
        pub fn xor(self, o: Self) -> Self {
            X2([self.0[0] ^ o.0[0], self.0[1] ^ o.0[1]])
        }
        #[inline(always)]
        pub fn rotr32(self) -> Self {
            X2([self.0[0].rotate_right(32), self.0[1].rotate_right(32)])
        }
        #[inline(always)]
        pub fn rotr24(self) -> Self {
            X2([self.0[0].rotate_right(24), self.0[1].rotate_right(24)])
        }
        #[inline(always)]
        pub fn rotr16(self) -> Self {
            X2([self.0[0].rotate_right(16), self.0[1].rotate_right(16)])
        }
        #[inline(always)]
        pub fn rotr63(self) -> Self {
            X2([self.0[0].rotate_right(63), self.0[1].rotate_right(63)])
        }
        #[inline(always)]
        pub fn lanes(self) -> [u64; 2] {
            self.0
        }
        /// The 16 message words of a 128-byte block of each message.
        #[inline(always)]
        pub fn block(a: &[u8; 128], b: &[u8; 128]) -> [X2; 16] {
            let w = |x: &[u8; 128], i: usize| u64::from_le_bytes(x[8 * i..8 * i + 8].try_into().expect("8 bytes"));
            let mut m = [X2([0, 0]); 16];
            for (i, word) in m.iter_mut().enumerate() {
                *word = X2([w(a, i), w(b, i)]);
            }
            m
        }
    }
}

use lanes::X2;

#[inline(always)]
fn g(v: &mut [X2; 16], a: usize, b: usize, c: usize, d: usize, x: X2, y: X2) {
    v[a] = v[a].add(v[b]).add(x);
    v[d] = v[d].xor(v[a]).rotr32();
    v[c] = v[c].add(v[d]);
    v[b] = v[b].xor(v[c]).rotr24();
    v[a] = v[a].add(v[b]).add(y);
    v[d] = v[d].xor(v[a]).rotr16();
    v[c] = v[c].add(v[d]);
    v[b] = v[b].xor(v[c]).rotr63();
}

const SIGMA: [[usize; 16]; 12] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

/// One round, kept out of line: a fully unrolled compression is a function
/// too large for JavaScriptCore's optimizing WebAssembly tier (Bun, Safari),
/// which then runs it in its baseline tier at a fraction of the speed. V8 is
/// indifferent.
#[inline(never)]
fn round(v: &mut [X2; 16], m: &[X2; 16], s: &[usize; 16]) {
    g(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
}

/// One compression of a block of each message; `t` is the byte count so far,
/// including this block.
#[inline(always)]
fn compress(h: &mut [X2; 8], a: &[u8; BLOCK], b: &[u8; BLOCK], t: u64, last: bool) {
    let m = X2::block(a, b);
    let mut v = [X2::splat(0); 16];
    v[..8].copy_from_slice(h);
    for i in 0..8 {
        v[8 + i] = X2::splat(IV[i]);
    }
    v[12] = v[12].xor(X2::splat(t));
    // `t` never exceeds 2^64 here, so its high word (v[13]) stays as is.
    if last {
        v[14] = v[14].xor(X2::splat(u64::MAX));
    }
    for s in &SIGMA {
        round(&mut v, &m, s);
    }
    for i in 0..8 {
        h[i] = h[i].xor(v[i]).xor(v[i + 8]);
    }
}

/// BLAKE2b-256 of two messages of the same length.
pub fn hash2(a: &[u8], b: &[u8]) -> [[u8; 32]; 2] {
    assert_eq!(a.len(), b.len(), "hash2 needs equal lengths");
    let len = a.len();
    let mut h: [X2; 8] = core::array::from_fn(|i| X2::splat(IV[i]));
    h[0] = h[0].xor(X2::splat(PARAM0));

    // Every block but the last is full; the last holds 1..=128 bytes (0 for an
    // empty message), zero-padded.
    let full = if len == 0 { 0 } else { (len - 1) / BLOCK };
    for i in 0..full {
        let r = i * BLOCK..(i + 1) * BLOCK;
        let (ba, bb) = (a[r.clone()].try_into().expect("block"), b[r].try_into().expect("block"));
        compress(&mut h, ba, bb, ((i + 1) * BLOCK) as u64, false);
    }
    let tail = full * BLOCK;
    let mut la = [0u8; BLOCK];
    let mut lb = [0u8; BLOCK];
    la[..len - tail].copy_from_slice(&a[tail..]);
    lb[..len - tail].copy_from_slice(&b[tail..]);
    compress(&mut h, &la, &lb, len as u64, true);

    let mut out = [[0u8; 32]; 2];
    for i in 0..4 {
        let [x, y] = h[i].lanes();
        out[0][8 * i..8 * i + 8].copy_from_slice(&x.to_le_bytes());
        out[1][8 * i..8 * i + 8].copy_from_slice(&y.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use fastcrypto::hash::{Blake2b256, HashFunction};

    fn reference(data: &[u8]) -> [u8; 32] {
        Blake2b256::digest(data).digest
    }

    #[test]
    fn matches_fastcrypto() {
        let mut seed = 0x9e3779b97f4a7c15u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed as u8
        };
        for len in (0..300).chain([383, 384, 385, 1000, 4097, 65535]) {
            let a: Vec<u8> = (0..len).map(|_| next()).collect();
            let b: Vec<u8> = (0..len).map(|_| next()).collect();
            let [ha, hb] = hash2(&a, &b);
            assert_eq!(ha, reference(&a), "len {len}");
            assert_eq!(hb, reference(&b), "len {len}");
        }
    }
}
