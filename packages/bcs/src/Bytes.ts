/**
 * Byte helpers every package needs: equality, concatenation, hex. A leaf
 * module with no imports and only top-level functions, so each one costs a
 * program only when it is used.
 */

/** Same length and the same bytes (not constant-time: never compare secrets with it). */
export const equal = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** `parts` joined into one new array. */
export const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Lowercase hex, no `0x`. */
export const toHex = (bytes: Uint8Array): string => {
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0")
  return out
}

/** Bytes of an even-length hex string without `0x`. Callers validate the digits first: this does not. */
export const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
