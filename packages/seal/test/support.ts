/**
 * Test support.
 *
 * - `seeded(seed)`: a deterministic `Entropy` source. Each call returns the
 *   next `length` bytes of `shake256(seed ‖ u64le(call number))`, so a run is
 *   reproducible and two calls never return the same bytes.
 * - `hex` / `unhex` / `b64`: small codecs for vectors.
 *
 * (`fakeKeyServers` arrives with work package S4.)
 */
import { shake256 } from "@noble/hashes/sha3.js"
import { base64 } from "@scure/base"

export const seeded = (seed: number | string | Uint8Array = 1): ((length: number) => Uint8Array) => {
  const seedBytes = typeof seed === "number"
    ? new TextEncoder().encode(`seed:${seed}`)
    : typeof seed === "string"
    ? new TextEncoder().encode(seed)
    : seed
  let counter = 0n
  return (length: number) => {
    const input = new Uint8Array(seedBytes.length + 8)
    input.set(seedBytes)
    new DataView(input.buffer).setBigUint64(seedBytes.length, counter++, true)
    return shake256(input, { dkLen: length })
  }
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

export const unhex = (s: string): Uint8Array => {
  const h = s.replace(/^0x/, "")
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16)
  return out
}

export const b64 = (s: string): Uint8Array => base64.decode(s)
export const toB64 = (bytes: Uint8Array): string => base64.encode(bytes)

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
