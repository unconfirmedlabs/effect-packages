//! RS2 blob encoding with the metadata hashes computed by [`crate::merkle`].
//!
//! This follows `walrus_core::encoding::BlobEncoder::encode_with_metadata`
//! (walrus-core 1.62.0, `crates/walrus-core/src/encoding/blob_encoding.rs`)
//! step for step, with the same `ReedSolomonEncoder`s, and differs only in
//! where bytes go: slivers are written straight into their BCS `SliverData`
//! slots of the output, and symbols are hashed two at a time. `cargo test`
//! checks blob ids, metadata and every sliver against `walrus-core` for many
//! sizes and shard counts; the JS parity tests check them against
//! `@mysten/walrus-wasm`.

use core::num::NonZeroU16;

use walrus_core::EncodingType;
use walrus_core::encoding::{EncodingConfigEnum, EncodingFactory, Primary, ReedSolomonEncoder, Secondary};
use walrus_core::merkle::Node;
use walrus_core::metadata::{SliverPairMetadata, VerifiedBlobMetadataWithId};

use crate::merkle::{self, Hash};

pub type Error = String;

fn uleb_len(mut x: usize) -> usize {
    let mut n = 1;
    while x >= 0x80 {
        x >>= 7;
        n += 1;
    }
    n
}

fn write_uleb(buf: &mut [u8], mut x: usize) {
    let mut i = 0;
    while x >= 0x80 {
        buf[i] = (x as u8) | 0x80;
        x >>= 7;
        i += 1;
    }
    buf[i] = x as u8;
}

/// The bytes of a BCS `SliverData` with `data_len` data bytes.
pub fn sliver_bcs_len(data_len: usize) -> usize {
    uleb_len(data_len) + data_len + 4
}

pub struct Encoded {
    /// `n` BCS primary slivers then `n` BCS secondary slivers, in sliver-pair
    /// order; empty when slivers were not asked for.
    pub slivers: Vec<u8>,
    pub metadata: VerifiedBlobMetadataWithId,
}

fn rs(symbol_size: NonZeroU16, source: NonZeroU16, n: NonZeroU16) -> Result<ReedSolomonEncoder, Error> {
    ReedSolomonEncoder::new(symbol_size, source, n).map_err(|e| e.to_string())
}

/// Encode `blob`; with `slivers == false` only the metadata is computed
/// (`walrus-core`'s `compute_metadata`, which yields the same hashes).
pub fn encode(config: &EncodingConfigEnum, blob: &[u8], slivers: bool) -> Result<Encoded, Error> {
    let n16 = config.n_shards();
    let rows16 = config.n_source_symbols::<Primary>();
    let cols16 = config.n_source_symbols::<Secondary>();
    let symbol16 = config.symbol_size_for_blob_from_usize(blob.len()).map_err(|e| e.to_string())?;
    let (n, rows, cols, s) = (
        usize::from(n16.get()),
        usize::from(rows16.get()),
        usize::from(cols16.get()),
        usize::from(symbol16.get()),
    );

    // A primary sliver is a row of `cols` symbols, a secondary sliver a column of `rows` symbols.
    let p_data = cols * s;
    let s_data = rows * s;
    let p_bcs = sliver_bcs_len(p_data);
    let s_bcs = sliver_bcs_len(s_data);

    // Where the data of primary sliver `i` and secondary sliver `j` start. Without slivers, only
    // the secondary slivers (all `n` columns) are kept, back to back.
    let p_off = |i: usize| i * p_bcs + uleb_len(p_data);
    let s_off = |j: usize| {
        if slivers {
            n * p_bcs + (n - 1 - j) * s_bcs + uleb_len(s_data)
        } else {
            j * s_data
        }
    };
    let mut out = vec![0u8; if slivers { n * (p_bcs + s_bcs) } else { n * s_data }];

    // The blob is the `rows × cols` source matrix in row-major order, zero-padded.
    let symbol_at = |row: usize, col: usize| {
        let start = (s * (cols * row + col)).min(blob.len());
        &blob[start..(start + s).min(blob.len())]
    };
    let row_at = |row: usize| {
        let start = (s * cols * row).min(blob.len());
        &blob[start..(start + p_data).min(blob.len())]
    };

    // Systematic secondary slivers: the columns of the source matrix.
    for row in 0..rows {
        for col in 0..cols {
            let src = symbol_at(row, col);
            let at = s_off(col) + row * s;
            out[at..at + src.len()].copy_from_slice(src);
        }
    }

    // Non-systematic secondary slivers: encode each row along the secondary axis. With slivers the
    // row is also systematic primary sliver `row`.
    let mut secondary = rs(symbol16, cols16, n16)?;
    let mut scratch = vec![0u8; p_data];
    for row in 0..rows {
        let src = row_at(row);
        let data: &[u8] = if slivers {
            let at = p_off(row);
            out[at..at + src.len()].copy_from_slice(src);
            &out[at..at + p_data]
        } else {
            scratch[..src.len()].copy_from_slice(src);
            scratch[src.len()..].fill(0);
            &scratch
        };
        let symbols = secondary.encode_all_ref(data).map_err(|e| e.to_string())?.data();
        for col in cols..n {
            let at = s_off(col) + row * s;
            out[at..at + s].copy_from_slice(&symbols[col * s..(col + 1) * s]);
        }
    }
    drop(secondary);

    // Encode every column along the primary axis: hash all `n × n` symbols, and fill the
    // non-systematic primary slivers from the systematic columns.
    let mut primary = rs(symbol16, rows16, n16)?;
    let mut hashes: Vec<Hash> = vec![[0; 32]; n * n];
    let mut column_hashes: Vec<Hash> = vec![[0; 32]; n];
    for col in 0..n {
        let at = s_off(col);
        let symbols = primary
            .encode_all_ref(&out[at..at + s_data])
            .map_err(|e| e.to_string())?
            .data();
        merkle::leaf_hashes(n, |row| &symbols[row * s..(row + 1) * s], &mut column_hashes);
        for (row, h) in column_hashes.iter().enumerate() {
            hashes[row * n + col] = *h;
        }
        if slivers && col < cols {
            for row in rows..n {
                let at = p_off(row) + col * s;
                out[at..at + s].copy_from_slice(&symbols[row * s..(row + 1) * s]);
            }
        }
    }
    drop(primary);

    // BCS framing: `uleb128(len) ‖ data ‖ symbol_size u16 ‖ index u16`.
    if slivers {
        let s16 = symbol16.get().to_le_bytes();
        for pair in 0..n {
            let base = pair * p_bcs;
            write_uleb(&mut out[base..], p_data);
            let tail = base + p_bcs - 4;
            out[tail..tail + 2].copy_from_slice(&s16);
            out[tail + 2..tail + 4].copy_from_slice(&(pair as u16).to_le_bytes());

            let base = n * p_bcs + pair * s_bcs;
            write_uleb(&mut out[base..], s_data);
            let tail = base + s_bcs - 4;
            out[tail..tail + 2].copy_from_slice(&s16);
            out[tail + 2..tail + 4].copy_from_slice(&((n - 1 - pair) as u16).to_le_bytes());
        }
    }

    // Pair `p`: the root over row `p` (primary sliver `p`) and over column `n − 1 − p`
    // (secondary sliver `n − 1 − p`).
    let mut level: Vec<Hash> = Vec::with_capacity(n + 1);
    let mut pairs = Vec::with_capacity(n);
    for pair in 0..n {
        level.clear();
        level.extend_from_slice(&hashes[pair * n..(pair + 1) * n]);
        let primary_hash = Node::Digest(merkle::root(&mut level));
        level.clear();
        let col = n - 1 - pair;
        level.extend((0..n).map(|row| hashes[row * n + col]));
        let secondary_hash = Node::Digest(merkle::root(&mut level));
        pairs.push(SliverPairMetadata { primary_hash, secondary_hash });
    }
    drop(hashes);

    let metadata = VerifiedBlobMetadataWithId::new_verified_from_metadata(
        pairs,
        EncodingType::RS2,
        u64::try_from(blob.len()).expect("usize fits u64"),
    );
    if !slivers {
        out = Vec::new();
    }
    Ok(Encoded { slivers: out, metadata })
}

/// The Merkle root of each sliver's symbols after expanding it along the other
/// axis (`SliverData::get_merkle_root`). `data[i]` is the data of sliver `i`;
/// every one must hold the axis' source-symbol count of `symbol_size` symbols.
pub fn sliver_roots(
    config: &EncodingConfigEnum,
    primary: bool,
    symbol_size: NonZeroU16,
    data: &[&[u8]],
) -> Result<Vec<u8>, Error> {
    let n16 = config.n_shards();
    let n = usize::from(n16.get());
    let s = usize::from(symbol_size.get());
    // A primary sliver (a row) is expanded with the secondary encoding, and vice versa.
    let source = if primary {
        config.n_source_symbols::<Secondary>()
    } else {
        config.n_source_symbols::<Primary>()
    };
    let mut encoder = rs(symbol_size, source, n16)?;
    let mut level: Vec<Hash> = vec![[0; 32]; n];
    let mut out = Vec::with_capacity(32 * data.len());
    for (i, d) in data.iter().enumerate() {
        let symbols = encoder
            .encode_all_ref(d)
            .map_err(|e| format!("sliver {i}: {e}"))?
            .data();
        level.resize(n, [0; 32]);
        merkle::leaf_hashes(n, |k| &symbols[k * s..(k + 1) * s], &mut level);
        out.extend_from_slice(&merkle::root(&mut level));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fastcrypto::hash::Blake2b256;
    use walrus_core::encoding::{EncodingConfig, SliverData};
    use walrus_core::metadata::BlobMetadataApi;

    fn config(n: u16) -> EncodingConfigEnum {
        EncodingConfig::new(NonZeroU16::new(n).unwrap()).get_for_type(EncodingType::RS2)
    }

    fn blob(len: usize, seed: u64) -> Vec<u8> {
        let mut x = seed | 1;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect()
    }

    #[test]
    fn matches_walrus_core() {
        for n in [4u16, 5, 7, 10, 13, 31, 100] {
            let cfg = config(n);
            let rows = usize::from(cfg.n_source_symbols::<Primary>().get());
            let cols = usize::from(cfg.n_source_symbols::<Secondary>().get());
            let full = rows * cols * 2;
            for len in [0, 1, 2, 3, 100, full - 1, full, full + 1, 3 * full + 5, 40_000] {
                let data = blob(len, u64::from(n) * 1000 + len as u64);
                let (pairs, expected) = cfg.encode_with_metadata(data.clone()).unwrap();
                let ours = encode(&cfg, &data, true).unwrap();
                assert_eq!(ours.metadata.blob_id(), expected.blob_id(), "n {n} len {len}");
                assert_eq!(
                    bcs::to_bytes(ours.metadata.metadata()).unwrap(),
                    bcs::to_bytes(expected.metadata()).unwrap()
                );
                let mut want = Vec::new();
                for p in &pairs {
                    want.extend(bcs::to_bytes(&p.primary).unwrap());
                }
                for p in &pairs {
                    want.extend(bcs::to_bytes(&p.secondary).unwrap());
                }
                assert!(ours.slivers == want, "slivers differ: n {n} len {len}");

                let meta_only = encode(&cfg, &data, false).unwrap();
                assert_eq!(meta_only.metadata.blob_id(), expected.blob_id());
                assert!(meta_only.slivers.is_empty());

                // Sliver roots equal the metadata hashes and walrus-core's own roots.
                let symbol = cfg.symbol_size_for_blob_from_usize(len).unwrap();
                let prim: Vec<&[u8]> = pairs.iter().map(|p| p.primary.symbols.data().as_slice()).collect();
                let sec: Vec<&[u8]> = pairs.iter().map(|p| p.secondary.symbols.data().as_slice()).collect();
                let pr = sliver_roots(&cfg, true, symbol, &prim).unwrap();
                let sr = sliver_roots(&cfg, false, symbol, &sec).unwrap();
                let BlobMetadata::V1(v1) = expected.metadata();
                for (i, p) in pairs.iter().enumerate() {
                    let h = &v1.hashes[i];
                    assert_eq!(Node::Digest(pr[32 * i..32 * i + 32].try_into().unwrap()), h.primary_hash);
                    assert_eq!(Node::Digest(sr[32 * i..32 * i + 32].try_into().unwrap()), h.secondary_hash);
                    let core: &SliverData<Primary> = &p.primary;
                    assert_eq!(core.get_merkle_root::<Blake2b256>(&cfg).unwrap(), h.primary_hash);
                }
                let _ = v1.compute_root_hash();
            }
        }
    }

    use walrus_core::metadata::BlobMetadata;
}
