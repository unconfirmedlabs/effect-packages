/**
 * @internal Byte helpers shared by the modules of this package. A leaf: it
 * imports nothing, so any module may use it without pulling in curve or HTTP
 * code.
 */

/** UTF-8 bytes of `s`. */
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

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

/** `a ⊕ b` over `a.length` bytes (`b` at least as long). */
export const xor = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!
  return out
}
