//! Walrus RS2 erasure coding, sliver Merkle roots and BLS12-381 min-pk for
//! `@unconfirmed/effect-walrus`, built on `walrus-core` so that encoding is the
//! network's own.
//!
//! The interface passes bytes only: every result is a `Uint8Array` with a
//! fixed layout (documented per function), so nothing goes through
//! `serde-wasm-bindgen` and the JS side slices the slivers out of one buffer.

use core::num::NonZeroU16;

use fastcrypto::bls12381::min_pk::{
    BLS12381AggregateSignature, BLS12381PublicKey, BLS12381Signature,
};
use fastcrypto::traits::{AggregateAuthenticator, ToFromBytes, VerifyingKey};
use js_sys::Uint8Array;
use walrus_core::encoding::{
    EncodingAxis, EncodingConfig, EncodingConfigEnum, EncodingFactory, Primary, Secondary,
    SliverData,
};
use walrus_core::metadata::VerifiedBlobMetadataWithId;
use walrus_core::merkle::Node;
use walrus_core::metadata::{BlobMetadata, BlobMetadataApi};
use walrus_core::EncodingType;
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::JsError;

mod blake2b;
mod encode;
mod merkle;

/// The smallest shard count `walrus-core` supports (it panics below).
const MIN_SHARDS: u16 = 4;

fn digest(node: &Node, what: &str) -> Result<[u8; 32], JsError> {
    match node {
        Node::Digest(d) => Ok(*d),
        Node::Empty => Err(JsError::new(&format!("{what} is empty"))),
    }
}

fn bcs_error(what: &str, e: bcs::Error) -> JsError {
    JsError::new(&format!("{what}: {e}"))
}

/// Whether this is the `simd128` build (Reed-Solomon engine and hashing).
#[wasm_bindgen]
pub fn simd() -> bool {
    cfg!(target_feature = "simd128")
}

/// An RS2 encoder for one shard count.
#[wasm_bindgen]
pub struct BlobEncoder {
    config: EncodingConfigEnum,
    n_shards: u16,
}

#[wasm_bindgen]
impl BlobEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new(n_shards: u16) -> Result<BlobEncoder, JsError> {
        if n_shards < MIN_SHARDS {
            return Err(JsError::new(&format!(
                "n_shards must be at least {MIN_SHARDS}, got {n_shards}"
            )));
        }
        let config = EncodingConfig::new(NonZeroU16::new(n_shards).expect("checked above"))
            .get_for_type(EncodingType::RS2);
        Ok(Self { config, n_shards })
    }

    /// Encode `data`.
    ///
    /// Returns `primary slivers ‖ secondary slivers ‖ metadata ‖ blob_id (32)
    /// ‖ root_hash (32)`: `n` BCS `SliverData` of each axis in sliver-pair
    /// order (pair `p` carries secondary sliver `n − 1 − p`; all slivers of one
    /// axis have the same length), then BCS `BlobMetadata` (the metadata `PUT`
    /// body).
    pub fn encode(&self, data: &[u8]) -> Result<Vec<u8>, JsError> {
        let encoded = encode::encode(&self.config, data, true).map_err(|e| JsError::new(&e))?;
        let mut out = encoded.slivers;
        bcs::serialize_into(&mut out, encoded.metadata.metadata()).map_err(|e| bcs_error("metadata", e))?;
        Self::append_id_and_root(&mut out, &encoded.metadata)?;
        Ok(out)
    }

    /// The blob id and root hash of `data` without the slivers: `blob_id (32)
    /// ‖ root_hash (32)`.
    pub fn compute_metadata(&self, data: &[u8]) -> Result<Vec<u8>, JsError> {
        let encoded = encode::encode(&self.config, data, false).map_err(|e| JsError::new(&e))?;
        let mut out = Vec::with_capacity(64);
        Self::append_id_and_root(&mut out, &encoded.metadata)?;
        Ok(out)
    }

    /// Decode a blob of `blob_size` bytes from BCS `SliverData<Primary>`
    /// slivers (at least `n − 2f` distinct ones). Verifies nothing.
    pub fn decode(&self, blob_size: u64, slivers: Vec<Uint8Array>) -> Result<Vec<u8>, JsError> {
        let parsed = parse_slivers::<Primary>(&slivers)?;
        Ok(self.config.decode(blob_size, parsed)?)
    }

    /// The Merkle root (the metadata hash) of each BCS `SliverData`, as
    /// `32 × slivers.length` bytes in order: primary slivers when `primary`,
    /// else secondary. Each sliver is expanded along the other axis and its
    /// `n` symbols hashed, exactly as `SliverData::verify` does; the root
    /// depends only on the sliver's symbols, not on its index.
    pub fn sliver_roots(&self, primary: bool, slivers: Vec<Uint8Array>) -> Result<Vec<u8>, JsError> {
        if primary {
            self.roots::<Primary>(&slivers)
        } else {
            self.roots::<Secondary>(&slivers)
        }
    }

    /// The shard count this encoder was built for.
    #[wasm_bindgen(getter)]
    pub fn n_shards(&self) -> u16 {
        self.n_shards
    }
}

impl BlobEncoder {
    fn append_id_and_root(out: &mut Vec<u8>, metadata: &VerifiedBlobMetadataWithId) -> Result<(), JsError> {
        let root = match metadata.metadata() {
            BlobMetadata::V1(inner) => inner.compute_root_hash(),
        };
        out.extend_from_slice(metadata.blob_id().as_ref());
        out.extend_from_slice(&digest(&root, "root hash")?);
        Ok(())
    }

    fn roots<T: EncodingAxis>(&self, slivers: &[Uint8Array]) -> Result<Vec<u8>, JsError> {
        let parsed = parse_slivers::<T>(slivers)?;
        let Some(first) = parsed.first() else {
            return Ok(Vec::new());
        };
        let symbol_size = first.symbols.symbol_size();
        let expected = usize::from(self.config.n_source_symbols::<T::OrthogonalAxis>().get());
        for (i, sliver) in parsed.iter().enumerate() {
            let symbols = sliver.symbols.len();
            if symbols != expected {
                return Err(JsError::new(&format!("sliver {i}: {symbols} symbols, expected {expected}")));
            }
            if sliver.symbols.symbol_size() != symbol_size {
                return Err(JsError::new(&format!(
                    "sliver {i}: symbol size {}, expected {symbol_size}",
                    sliver.symbols.symbol_size()
                )));
            }
        }
        let data: Vec<&[u8]> = parsed.iter().map(|s| s.symbols.data().as_slice()).collect();
        encode::sliver_roots(&self.config, T::IS_PRIMARY, symbol_size, &data).map_err(|e| JsError::new(&e))
    }
}

fn parse_slivers<T: EncodingAxis>(slivers: &[Uint8Array]) -> Result<Vec<SliverData<T>>, JsError> {
    slivers
        .iter()
        .enumerate()
        .map(|(i, buffer)| {
            let bytes = buffer.to_vec();
            bcs::from_bytes::<SliverData<T>>(&bytes).map_err(|e| {
                JsError::new(&format!(
                    "BCS deserialization failed at index {i} (buffer size {}): {e}",
                    bytes.len()
                ))
            })
        })
        .collect()
}

fn byte_vectors(values: &[Uint8Array]) -> Vec<Vec<u8>> {
    values.iter().map(Uint8Array::to_vec).collect()
}

/// Verify a BLS12-381 min-pk signature. The key may be compressed (48 bytes)
/// or uncompressed (96 bytes).
#[wasm_bindgen]
pub fn bls12381_min_pk_verify(
    signature: &[u8],
    public_key: &[u8],
    msg: &[u8],
) -> Result<bool, JsError> {
    let signature = BLS12381Signature::from_bytes(signature)?;
    let public_key = BLS12381PublicKey::from_bytes(public_key)?;
    Ok(public_key.verify(msg, &signature).is_ok())
}

/// Aggregate 96-byte signatures.
#[wasm_bindgen]
pub fn bls12381_min_pk_aggregate(signatures: Vec<Uint8Array>) -> Result<Vec<u8>, JsError> {
    let signatures = byte_vectors(&signatures)
        .iter()
        .map(|sig| BLS12381Signature::from_bytes(sig))
        .collect::<Result<Vec<_>, _>>()?;
    let aggregate = BLS12381AggregateSignature::aggregate(&signatures)?;
    Ok(aggregate.as_bytes().to_vec())
}

/// Verify an aggregate signature over one message.
#[wasm_bindgen]
pub fn bls12381_min_pk_verify_aggregate(
    public_keys: Vec<Uint8Array>,
    msg: &[u8],
    signature: &[u8],
) -> Result<bool, JsError> {
    let public_keys = byte_vectors(&public_keys)
        .iter()
        .map(|pk| BLS12381PublicKey::from_bytes(pk))
        .collect::<Result<Vec<_>, _>>()?;
    let signature = BLS12381AggregateSignature::from_bytes(signature)?;
    Ok(signature.verify(&public_keys, msg).is_ok())
}
