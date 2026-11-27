/**
 * The Sui CLI's active signer (`~/.sui/sui_config`), for funded live runs
 * (`WALRUS_LIVE`, `SEAL_LIVE`). Never prints key material.
 */
import * as Effect from "effect/Effect"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as PrivateKey from "@unconfirmed/sui/PrivateKey"
import type * as Signer from "@unconfirmed/sui/Signer"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

/** The signer for the CLI's `active_address`, from `client.yaml` and `sui.keystore`. */
export const loadCliSigner = async (): Promise<Signer.Signer> => {
  try {
    const dir = `${homedir()}/.sui/sui_config`
    const active = /active_address:\s*"?(0x[0-9a-fA-F]{64})/.exec(readFileSync(`${dir}/client.yaml`, "utf-8"))![1]!.toLowerCase()
    const keys = await Effect.runPromise(PrivateKey.decodeKeystore(readFileSync(`${dir}/sui.keystore`, "utf-8")))
    for (const key of keys) {
      const signer = key.scheme === "ED25519"
        ? await Effect.runPromise(Ed25519.fromSecretKey(key.secretKey))
        : key.scheme === "Secp256k1"
        ? await Effect.runPromise((await import("@unconfirmed/sui-secp256k1")).fromSecretKey(key.secretKey))
        : key.scheme === "Secp256r1"
        ? await Effect.runPromise((await import("@unconfirmed/sui-secp256r1")).fromSecretKey(key.secretKey))
        : undefined
      if (signer?.address === active) return signer
    }
  } catch {
    // fall through to the fixed message: no key material in assertion output
  }
  throw new Error("could not load the Sui CLI signer for the active address")
}
