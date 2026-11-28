/**
 * Hashing and intent messages: what every signature scheme ultimately signs.
 */
import { blake2b } from "@noble/hashes/blake2.js"
import { base58 } from "@scure/base"
import * as Bcs from "@unconfirmed/bcs/Bcs"

export const blake2b256 = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 })

export const IntentScope = {
  TransactionData: 0,
  TransactionEffects: 1,
  CheckpointSummary: 2,
  PersonalMessage: 3
} as const
export type IntentScope = (typeof IntentScope)[keyof typeof IntentScope]

/** `[scope, version=0, appId=Sui(0)] || bytes`. */
export const intentMessage = (scope: IntentScope, bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(3 + bytes.length)
  out[0] = scope
  out.set(bytes, 3)
  return out
}

export const transactionIntent = (txBytes: Uint8Array) => intentMessage(IntentScope.TransactionData, txBytes)

/** A personal message is signed as BCS `vector<u8>`, so it can never be mistaken for a transaction. */
export const personalMessageIntent = (message: Uint8Array) =>
  intentMessage(IntentScope.PersonalMessage, Bcs.encodeSync(Bcs.byteVector)(message))

/** The transaction digest: `base58(blake2b256("TransactionData::" || bcs))`. */
export const transactionDigest = (txBytes: Uint8Array): string => {
  const prefix = new TextEncoder().encode("TransactionData::")
  const input = new Uint8Array(prefix.length + txBytes.length)
  input.set(prefix)
  input.set(txBytes, prefix.length)
  return base58.encode(blake2b256(input))
}
