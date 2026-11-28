/** What `Mnemonic` and `Bip32` share: errors, mnemonic -> seed, and path rules. */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
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

/** Trim, lowercase and single-space the words. */
export const normalize = (mnemonic: string): string => mnemonic.trim().toLowerCase().split(/\s+/).join(" ")

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

export const seedOf = (source: Source): Effect.Effect<Uint8Array, InvalidMnemonic> =>
  typeof source === "string"
    ? toSeed(source)
    : source.length < 16 || source.length > 64
    ? Effect.fail(new InvalidMnemonic({ reason: `a seed is 16 to 64 bytes, got ${source.length}` }))
    : Effect.succeed(source)

/** Indices to fill a scheme's path with; each defaults to 0. */
export interface PathIndex {
  readonly account?: number
  readonly change?: number
  readonly index?: number
}

/** A full path string, or indices for the scheme's standard path. */
export type Path = string | PathIndex

export const HARDENED = 0x80000000

export interface Rule {
  readonly scheme: string
  readonly purpose: number
  /** SLIP-0010: every level hardened. BIP32: change and index are not. */
  readonly hardenedTail: boolean
}

export const ED25519: Rule = { scheme: "ED25519", purpose: 44, hardenedTail: true }
export const SECP256K1: Rule = { scheme: "Secp256k1", purpose: 54, hardenedTail: false }
export const SECP256R1: Rule = { scheme: "Secp256r1", purpose: 74, hardenedTail: false }
export const MLDSA65: Rule = { scheme: "MLDSA65", purpose: 94, hardenedTail: true }

const template = (rule: Rule, account: string | number, change: string | number, index: string | number) => {
  const t = rule.hardenedTail ? "'" : ""
  return `m/${rule.purpose}'/784'/${account}'/${change}${t}/${index}${t}`
}

export const format = (rule: Rule, i: PathIndex) => template(rule, i.account ?? 0, i.change ?? 0, i.index ?? 0)

/** Validate a path for a scheme; answer its (unhardened) indices. */
export const resolve = (rule: Rule, path: Path | undefined): Effect.Effect<{ path: string; indices: ReadonlyArray<number> }, InvalidPath> => {
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

export type Derived = Effect.Effect<Uint8Array, InvalidMnemonic | InvalidPath>
