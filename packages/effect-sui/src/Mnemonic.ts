/**
 * BIP39 mnemonics and Sui's key derivation paths, matching the Sui CLI,
 * wallets and `@mysten/sui`.
 *
 * | Scheme    | Derivation  | Path                             | Module     |
 * |-----------|-------------|----------------------------------|------------|
 * | Ed25519   | SLIP-0010   | `m/44'/784'/{a}'/{c}'/{i}'`      | `Mnemonic` |
 * | Secp256k1 | BIP32       | `m/54'/784'/{a}'/{c}/{i}`        | `Bip32`    |
 * | Secp256r1 | BIP32       | `m/74'/784'/{a}'/{c}/{i}`        | `Bip32`    |
 * | ML-DSA-65 | SLIP-0010   | `m/94'/784'/{a}'/{c}'/{i}'`      | `Mnemonic` |
 *
 * This module never imports `@scure/bip32`, so Ed25519 or ML-DSA-65 use alone
 * doesn't load it; the Secp256k1/r1 derivations are in `Bip32`. The package
 * root re-exports both.
 *
 * Every function answers 32-byte secret keys, so this package doesn't depend on
 * the scheme packages; compose with theirs:
 *
 *   const m = yield* Mnemonic.generate()
 *   const signer = yield* Mnemonic.ed25519Signer(m)                          // Ed25519 is core
 *   const k1 = yield* Secp256k1.fromSecretKey(yield* Bip32.secp256k1SecretKey(m, { account: 1 }))
 *
 * Derivation takes the mnemonic or its seed (`toSeed`); pass the seed when
 * deriving many keys, since every mnemonic -> seed is 2048 rounds of PBKDF2.
 */
import { hmac } from "@noble/hashes/hmac.js"
import { sha512 } from "@noble/hashes/sha2.js"
import { generateMnemonic, validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import * as Ed25519 from "./Ed25519.ts"
import type * as Signer from "./Signer.ts"
import * as Effect from "effect/Effect"
import {
  type Derived,
  ED25519,
  format,
  HARDENED,
  type InvalidMnemonic,
  type InvalidPath,
  MLDSA65,
  normalize,
  type Path,
  type PathIndex,
  resolve,
  type Rule,
  SECP256K1,
  SECP256R1,
  seedOf,
  type Source
} from "./internal/mnemonic.ts"

export { InvalidMnemonic, InvalidPath, normalize, parse, type Path, type PathIndex, type Source, toSeed } from "./internal/mnemonic.ts"

// -----------------------------------------------------------------------------
// Mnemonics
// -----------------------------------------------------------------------------

export type WordCount = 12 | 15 | 18 | 21 | 24

/** A fresh English mnemonic (12 words by default, as the Sui CLI does). */
export const generate = (words: WordCount = 12): Effect.Effect<string> =>
  Effect.sync(() => generateMnemonic(wordlist, (words / 3) * 32))

/** Whether a mnemonic (after `normalize`) has valid English words and checksum. */
export const isValid = (mnemonic: string): boolean => validateMnemonic(normalize(mnemonic), wordlist)

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

export const ed25519Path = (i: PathIndex = {}): string => format(ED25519, i)
export const secp256k1Path = (i: PathIndex = {}): string => format(SECP256K1, i)
export const secp256r1Path = (i: PathIndex = {}): string => format(SECP256R1, i)
export const mldsa65Path = (i: PathIndex = {}): string => format(MLDSA65, i)

// -----------------------------------------------------------------------------
// Derivation (SLIP-0010)
// -----------------------------------------------------------------------------

/** SLIP-0010, hardened only: the node secret is the key (Ed25519 seed, FIPS 204 keygen seed). */
const slip10 = (curve: string, seed: Uint8Array, indices: ReadonlyArray<number>): Uint8Array => {
  let I = hmac(sha512, new TextEncoder().encode(curve), seed)
  for (const index of indices) {
    const data = new Uint8Array(37)
    data.set(I.subarray(0, 32), 1)
    new DataView(data.buffer).setUint32(33, (index | HARDENED) >>> 0)
    const next = hmac(sha512, I.subarray(32), data)
    I.fill(0)
    data.fill(0)
    I = next
  }
  const key = I.slice(0, 32)
  I.fill(0)
  return key
}

const deriveSlip10 = (rule: Rule, curve: string, source: Source, path: Path | undefined): Derived =>
  Effect.flatMap(resolve(rule, path), ({ indices }) =>
    Effect.flatMap(seedOf(source), (seed) => Effect.sync(() => slip10(curve, seed, indices))))

/** The Ed25519 secret key at a path (default `m/44'/784'/0'/0'/0'`). */
export const ed25519SecretKey = (source: Source, path?: Path): Derived => deriveSlip10(ED25519, "ed25519 seed", source, path)

/** The ML-DSA-65 secret key (keygen seed) at a path (default `m/94'/784'/0'/0'/0'`). Use with `MlDsa65.fromSecretKey`. */
export const mldsa65SecretKey = (source: Source, path?: Path): Derived => deriveSlip10(MLDSA65, "ML-DSA-65 seed", source, path)

/** An Ed25519 signer at a path (default `m/44'/784'/0'/0'/0'`). */
export const ed25519Signer = (source: Source, path?: Path): Effect.Effect<Signer.Signer, InvalidMnemonic | InvalidPath> =>
  Effect.flatMap(ed25519SecretKey(source, path), (sk) => Effect.orDie(Ed25519.fromSecretKey(sk)))
