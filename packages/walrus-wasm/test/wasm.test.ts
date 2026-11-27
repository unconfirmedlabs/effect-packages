/**
 * The committed builds: the SIMD build (`nodejs/`, what Bun and Node load)
 * and the scalar web build (`web/walrus_wasm_nosimd_bg.wasm`, loaded here
 * through the web glue) give byte-identical results, equal to
 * `@mysten/walrus-wasm` 0.3.1. The full encoder parity suite is in
 * `packages/walrus/test/parity.encoder.test.ts`.
 */
import * as Mysten from "@mysten/walrus-wasm"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as Simd from "../index.js"
import * as Scalar from "../web/walrus_wasm.js"

Scalar.initSync({ module: readFileSync(new URL("../web/walrus_wasm_nosimd_bg.wasm", import.meta.url)) })

const bytes = (length: number, seed: number): Uint8Array => {
  const out = new Uint8Array(length)
  let x = seed >>> 0 || 1
  for (let i = 0; i < length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

/** Mysten's `encode` into exactly sized buffers, laid out like ours: `primary ‖ secondary ‖ blob id ‖ root`. */
const mystenEncode = (n: number, data: Uint8Array, primaryBytes: number, secondaryBytes: number) => {
  const primary = Array.from({ length: n }, () => new Uint8Array(primaryBytes))
  const secondary = Array.from({ length: n }, () => new Uint8Array(secondaryBytes))
  const encoder = new Mysten.BlobEncoder(n)
  try {
    const [metadata, root] = encoder.encode(data, primary, secondary) as [{ blob_id: Array<number> }, { Digest: Array<number> }]
    return { primary, secondary, blobId: new Uint8Array(metadata.blob_id), root: new Uint8Array(root.Digest) }
  } finally {
    encoder.free()
  }
}

describe("builds", () => {
  test("Bun loads the SIMD build; the scalar build has no SIMD", () => {
    expect(Simd.simd()).toBe(true)
    expect(Simd.simdSupported()).toBe(true)
    expect(Scalar.simd()).toBe(false)
  })

  for (const [n, length] of [[4, 0], [10, 1], [10, 12_345], [100, 1_000_000]] as const) {
    test(`n = ${n}, ${length} bytes: SIMD = scalar = Mysten`, () => {
      const data = bytes(length, n * 31 + length)
      const simd = new Simd.BlobEncoder(n)
      const scalar = new Scalar.BlobEncoder(n)
      try {
        const a = simd.encode(data)
        const b = scalar.encode(data)
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
        const meta = simd.compute_metadata(data)
        expect(meta).toEqual(scalar.compute_metadata(data))
        expect(meta).toEqual(a.slice(a.length - 64))

        // Sliver framing: uleb128(len) ‖ data ‖ symbol size ‖ index; then theirs, byte for byte.
        const first = a[0]! < 0x80 ? 1 : a[1]! < 0x80 ? 2 : a[2]! < 0x80 ? 3 : 4
        let primaryData = 0
        for (let i = first - 1; i >= 0; i--) primaryData = primaryData * 128 + (a[i]! & 0x7f)
        const primaryBytes = first + primaryData + 4
        const rest = a.length - 64 - n * primaryBytes
        const metadataBytes = 1 + 1 + 8 + (n < 128 ? 1 : 2) + n * 66
        const secondaryBytes = (rest - metadataBytes) / n
        const theirs = mystenEncode(n, data, primaryBytes, secondaryBytes)
        theirs.primary.forEach((s, p) => expect(a.subarray(p * primaryBytes, (p + 1) * primaryBytes)).toEqual(s))
        const base = n * primaryBytes
        theirs.secondary.forEach((s, p) => expect(a.subarray(base + p * secondaryBytes, base + (p + 1) * secondaryBytes)).toEqual(s))
        expect(meta.slice(0, 32)).toEqual(theirs.blobId)
        expect(meta.slice(32)).toEqual(theirs.root)

        // Roots, both builds, all slivers of both axes, equal what the metadata commits to (via the blob id above).
        const primary = theirs.primary
        const secondary = theirs.secondary
        expect(simd.sliver_roots(true, primary)).toEqual(scalar.sliver_roots(true, primary))
        expect(simd.sliver_roots(false, secondary)).toEqual(scalar.sliver_roots(false, secondary))
        const hashes = a.subarray(base + n * secondaryBytes + 1 + 1 + 8 + (n < 128 ? 1 : 2), a.length - 64)
        const roots = simd.sliver_roots(true, primary)
        const sroots = simd.sliver_roots(false, secondary)
        for (let p = 0; p < n; p++) {
          expect(hashes.subarray(p * 66 + 1, p * 66 + 33)).toEqual(roots.subarray(32 * p, 32 * p + 32))
          expect(hashes.subarray(p * 66 + 34, p * 66 + 66)).toEqual(sroots.subarray(32 * p, 32 * p + 32))
        }

        // Decode from the last n - 2f primary slivers (repair ones), both builds.
        const need = n - 2 * Math.floor((n - 1) / 3)
        expect(simd.decode(BigInt(length), primary.slice(n - need))).toEqual(data)
        expect(scalar.decode(BigInt(length), primary.slice(n - need))).toEqual(data)
      } finally {
        simd.free()
        scalar.free()
      }
    })
  }
})

describe("errors are thrown, not traps", () => {
  test("shard counts below 4", () => {
    expect(() => new Simd.BlobEncoder(3)).toThrow(/at least 4/)
  })

  test("too few slivers, a malformed sliver, a wrong-length sliver", () => {
    const e = new Simd.BlobEncoder(10)
    try {
      const out = e.encode(bytes(100, 1))
      expect(() => e.decode(100n, [])).toThrow()
      expect(() => e.decode(100n, [new Uint8Array([1, 2, 3])])).toThrow(/BCS/)
      expect(() => e.sliver_roots(true, [out.subarray(0, 10)])).toThrow()
      expect(e.sliver_roots(true, [])).toEqual(new Uint8Array(0))
    } finally {
      e.free()
    }
  })
})

describe("BLS", () => {
  test("malformed input throws; verify agrees with Mysten", () => {
    expect(() => Simd.bls12381_min_pk_verify(new Uint8Array(96), new Uint8Array(96), new Uint8Array(1))).toThrow()
    expect(() => Simd.bls12381_min_pk_aggregate([new Uint8Array(5)])).toThrow()
    expect(() => Mysten.bls12381_min_pk_aggregate([new Uint8Array(5)])).toThrow()
  })
})

describe("SIMD feature probe", () => {
  test("the web entry's probe validates here", async () => {
    // `web.js` imports the web glue (same module instance as `Scalar` above); only the probe is exercised.
    const web = await import("../web.js")
    expect(web.simdSupported()).toBe(true)
  })
})
