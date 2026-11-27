/**
 * BIP39 mnemonics and Sui's key derivation paths, matching the Sui CLI,
 * wallets and `@mysten/sui`.
 *
 * | Scheme    | Derivation  | Path                             |
 * |-----------|-------------|----------------------------------|
 * | Ed25519   | SLIP-0010   | `m/44'/784'/{a}'/{c}'/{i}'`      |
 * | Secp256k1 | BIP32       | `m/54'/784'/{a}'/{c}/{i}`        |
 * | Secp256r1 | BIP32       | `m/74'/784'/{a}'/{c}/{i}`        |
 * | ML-DSA-65 | SLIP-0010   | `m/94'/784'/{a}'/{c}'/{i}'`      |
 *
 * Every function answers 32-byte secret keys, so this package doesn't depend on
 * the scheme packages; compose with theirs:
 *
 *   const m = yield* Mnemonic.generate()
 *   const signer = yield* Mnemonic.ed25519Signer(m)                          // Ed25519 is core
 *   const k1 = yield* Secp256k1.fromSecretKey(yield* Mnemonic.secp256k1SecretKey(m, { account: 1 }))
 *
 * Derivation takes the mnemonic or its seed (`toSeed`); pass the seed when
 * deriving many keys, since every mnemonic -> seed is 2048 rounds of PBKDF2.
 *
 * Secp256r1 follows `@mysten/sui` and the Sui CLI: it derives with BIP32's
 * secp256k1 arithmetic and uses the resulting scalar as a P-256 key.
 */
import { hmac } from "@noble/hashes/hmac.js"
import { sha512 } from "@noble/hashes/sha2.js"
import { HDKey } from "@scure/bip32"
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import type * as Signer from "@unconfirmed/sui/Signer"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class InvalidMnemonic extends Schema.TaggedError<InvalidMnemonic>()("InvalidMnemonic", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

export class InvalidPath extends Schema.TaggedError<InvalidPath>()("InvalidPath", {
  scheme: Schema.String,
  path: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `invalid ${this.scheme} path ${this.path}: ${this.reason}`
  }
}

// -----------------------------------------------------------------------------
// Mnemonics
// -----------------------------------------------------------------------------

export type WordCount = 12 | 15 | 18 | 21 | 24

/** A fresh English mnemonic (12 words by default, as the Sui CLI does). */
export const generate = (words: WordCount = 12): Effect.Effect<string> =>
  Effect.sync(() => generateMnemonic(wordlist, (words / 3) * 32))

/** Trim, lowercase and single-space the words. */
export const normalize = (mnemonic: string): string => mnemonic.trim().toLowerCase().split(/\s+/).join(" ")

/** Whether a mnemonic (after `normalize`) has valid English words and checksum. */
export const isValid = (mnemonic: string): boolean => validateMnemonic(normalize(mnemonic), wordlist)

/** Normalize and validate. */
export const parse = (mnemonic: string): Effect.Effect<string, InvalidMnemonic> => {
  const m = normalize(mnemonic)
  const words = m === "" ? 0 : m.split(" ").length
  if (![12, 15, 18, 21, 24].includes(words)) return Effect.fail(new InvalidMnemonic({ reason: `expected 12, 15, 18, 21 or 24 words, got ${words}` }))
  return validateMnemonic(m, wordlist)
    ? Effect.succeed(m)
    : Effect.fail(new InvalidMnemonic({ reason: "unknown word or bad checksum" }))
}

/** The 64-byte BIP39 seed (empty passphrase by default, as Sui uses). */
export const toSeed = (mnemonic: string, passphrase = ""): Effect.Effect<Uint8Array, InvalidMnemonic> =>
  Effect.flatMap(parse(mnemonic), (m) => Effect.sync(() => mnemonicToSeedSync(m, passphrase)))

/** A mnemonic, or a seed from `toSeed` (16 to 64 bytes). */
export type Source = string | Uint8Array

const seedOf = (source: Source): Effect.Effect<Uint8Array, InvalidMnemonic> =>
  typeof source === "string"
    ? toSeed(source)
    : source.length < 16 || source.length > 64
    ? Effect.fail(new InvalidMnemonic({ reason: `a seed is 16 to 64 bytes, got ${source.length}` }))
    : Effect.succeed(source)

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

/** Indices to fill a scheme's path with; each defaults to 0. */
export interface PathIndex {
  readonly account?: number
  readonly change?: number
  readonly index?: number
}

/** A full path string, or indices for the scheme's standard path. */
export type Path = string | PathIndex

const HARDENED = 0x80000000

interface Rule {
  readonly scheme: string
  readonly purpose: number
  /** SLIP-0010: every level hardened. BIP32: change and index are not. */
  readonly hardenedTail: boolean
}

const ED25519: Rule = { scheme: "ED25519", purpose: 44, hardenedTail: true }
const SECP256K1: Rule = { scheme: "Secp256k1", purpose: 54, hardenedTail: false }
const SECP256R1: Rule = { scheme: "Secp256r1", purpose: 74, hardenedTail: false }
const MLDSA65: Rule = { scheme: "MLDSA65", purpose: 94, hardenedTail: true }

const template = (rule: Rule, account: string | number, change: string | number, index: string | number) => {
  const t = rule.hardenedTail ? "'" : ""
  return `m/${rule.purpose}'/784'/${account}'/${change}${t}/${index}${t}`
}

const format = (rule: Rule, i: PathIndex) => template(rule, i.account ?? 0, i.change ?? 0, i.index ?? 0)

/** Validate a path for a scheme; answer its (unhardened) indices. */
const resolve = (rule: Rule, path: Path | undefined): Effect.Effect<{ path: string; indices: ReadonlyArray<number> }, InvalidPath> => {
  const p = path === undefined ? format(rule, {}) : typeof path === "string" ? path : format(rule, path)
  const t = rule.hardenedTail ? "'" : ""
  const shape = new RegExp(`^m/${rule.purpose}'/784'/(\\d+)'/(\\d+)${t}/(\\d+)${t}$`)
  const match = shape.exec(p)
  if (!match) {
    return Effect.fail(new InvalidPath({ scheme: rule.scheme, path: p, reason: `expected ${template(rule, "{account}", "{change}", "{index}")}` }))
  }
  const tail = match.slice(1).map(Number)
  if (tail.some((n) => !Number.isSafeInteger(n) || n >= HARDENED)) {
    return Effect.fail(new InvalidPath({ scheme: rule.scheme, path: p, reason: `indices must be below 2^31` }))
  }
  return Effect.succeed({ path: p, indices: [rule.purpose, 784, ...tail] })
}

export const ed25519Path = (i: PathIndex = {}): string => format(ED25519, i)
export const secp256k1Path = (i: PathIndex = {}): string => format(SECP256K1, i)
export const secp256r1Path = (i: PathIndex = {}): string => format(SECP256R1, i)
export const mldsa65Path = (i: PathIndex = {}): string => format(MLDSA65, i)

// -----------------------------------------------------------------------------
// Derivation
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

type Derived = Effect.Effect<Uint8Array, InvalidMnemonic | InvalidPath>

// Plain functions, not factory calls, so bundlers drop @scure/bip32 (and secp256k1) when only SLIP-0010 is used.
const deriveSlip10 = (rule: Rule, curve: string, source: Source, path: Path | undefined): Derived =>
  Effect.flatMap(resolve(rule, path), ({ indices }) =>
    Effect.flatMap(seedOf(source), (seed) => Effect.sync(() => slip10(curve, seed, indices))))

const deriveBip32 = (rule: Rule, source: Source, path: Path | undefined): Derived =>
  Effect.flatMap(resolve(rule, path), ({ path }) =>
    Effect.flatMap(seedOf(source), (seed) =>
      Effect.sync(() => {
        // A child that is not a valid key has probability ~2^-127; a defect, as in @scure/bip32.
        const master = HDKey.fromMasterSeed(seed)
        const child = master.derive(path)
        try {
          if (!child.privateKey) throw new Error(`no private key at ${path}`)
          return child.privateKey.slice()
        } finally {
          // Zero the nodes' keys and chain codes, as the SLIP-0010 path zeroes its intermediates.
          // (`derive` makes the nodes in between internally; they are out of reach.)
          child.wipePrivateData()
          master.wipePrivateData()
        }
      })))

/** The Ed25519 secret key at a path (default `m/44'/784'/0'/0'/0'`). */
export const ed25519SecretKey = (source: Source, path?: Path): Derived => deriveSlip10(ED25519, "ed25519 seed", source, path)

/** The Secp256k1 secret key at a path (default `m/54'/784'/0'/0/0`). Use with `Secp256k1.fromSecretKey`. */
export const secp256k1SecretKey = (source: Source, path?: Path): Derived => deriveBip32(SECP256K1, source, path)

/** The Secp256r1 secret key at a path (default `m/74'/784'/0'/0/0`). Use with `Secp256r1.fromSecretKey`. */
export const secp256r1SecretKey = (source: Source, path?: Path): Derived => deriveBip32(SECP256R1, source, path)

/** The ML-DSA-65 secret key (keygen seed) at a path (default `m/94'/784'/0'/0'/0'`). Use with `MlDsa65.fromSecretKey`. */
export const mldsa65SecretKey = (source: Source, path?: Path): Derived => deriveSlip10(MLDSA65, "ML-DSA-65 seed", source, path)

/** An Ed25519 signer at a path (default `m/44'/784'/0'/0'/0'`). */
export const ed25519Signer = (source: Source, path?: Path): Effect.Effect<Signer.Signer, InvalidMnemonic | InvalidPath> =>
  Effect.flatMap(ed25519SecretKey(source, path), (sk) => Effect.orDie(Ed25519.fromSecretKey(sk)))
