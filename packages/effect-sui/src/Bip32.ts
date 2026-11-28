/**
 * Secp256k1 and Secp256r1 keys from a mnemonic (BIP32). A module of its own so
 * `@scure/bip32` loads only for these: Ed25519 and ML-DSA-65 (SLIP-0010) are in
 * `Mnemonic`.
 *
 *   const k1 = yield* Secp256k1.fromSecretKey(yield* Bip32.secp256k1SecretKey(m, { account: 1 }))
 *
 * Secp256r1 follows `@mysten/sui` and the Sui CLI: it derives with BIP32's
 * secp256k1 arithmetic and uses the resulting scalar as a P-256 key.
 */
import { HDKey } from "@scure/bip32"
import * as Effect from "effect/Effect"
import { type Derived, type Path, resolve, type Rule, SECP256K1, SECP256R1, seedOf, type Source } from "./internal/core.ts"

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

/** The Secp256k1 secret key at a path (default `m/54'/784'/0'/0/0`). Use with `Secp256k1.fromSecretKey`. */
export const secp256k1SecretKey = (source: Source, path?: Path): Derived => deriveBip32(SECP256K1, source, path)

/** The Secp256r1 secret key at a path (default `m/74'/784'/0'/0/0`). Use with `Secp256r1.fromSecretKey`. */
export const secp256r1SecretKey = (source: Source, path?: Path): Derived => deriveBip32(SECP256R1, source, path)
