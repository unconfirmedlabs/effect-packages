/**
 * `@unconfirmed/walrus-wasm` against `@mysten/walrus-wasm` 0.3.1, raw WASM
 * calls (no Effect), median wall time of a few runs after one warm-up.
 *
 *   bun packages/walrus/scripts/bench-wasm.ts [--quick]
 *   node packages/walrus/scripts/bench-wasm.ts [--quick]     (Node 23.6+ strips the types)
 *
 * Operations, as `Encoder` uses them:
 * - encode: blob → slivers and metadata.
 * - blobId: `compute_metadata`.
 * - decode: from the first `n − 2f` primary slivers (systematic) and from the
 *   last `n − 2f` (repair).
 * - roots: the Merkle roots of `n − 2f` primary slivers (a strict read's blame
 *   pass): ours `sliver_roots`, Mysten's the crafted-blob method (one encode
 *   of a `rows × columns × symbolSize` blob).
 * - BLS: verify one signature; aggregate `n − f` = 667 signatures; verify the
 *   aggregate against 667 keys.
 */
import * as Mysten from "@mysten/walrus-wasm"
import * as Ours from "@unconfirmed/walrus-wasm"
import { bls12_381 } from "@noble/curves/bls12-381.js"

const quick = process.argv.includes("--quick")
const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.versions.node}`

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

const time = (runs: number, f: () => unknown): number => {
  f()
  const t: Array<number> = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    f()
    t.push(performance.now() - start)
  }
  t.sort((a, b) => a - b)
  return t[Math.floor(t.length / 2)]!
}

const maxFaulty = (n: number) => Math.floor((n - 1) / 3)
const uleb = (x: number) => (x < 0x80 ? 1 : x < 0x4000 ? 2 : x < 0x200000 ? 3 : 4)

const rows: Array<[string, string, string, number, number]> = []
const record = (n: string, size: string, op: string, ours: number, mysten: number) => {
  rows.push([n, size, op, ours, mysten])
  console.error(`${n.padStart(5)} ${size.padStart(6)} ${op.padEnd(18)} ours ${ours.toFixed(1).padStart(8)} ms  mysten ${mysten.toFixed(1).padStart(8)} ms  ×${(mysten / ours).toFixed(1)}`)
}

const sizes: Array<[string, number]> = [["1 KB", 1024], ["1 MB", 1 << 20], ["10 MB", 10 << 20]]
for (const n of quick ? [10, 1000] : [10, 100, 1000]) {
  const f = maxFaulty(n)
  const R = n - 2 * f
  const C = n - f
  for (const [label, size] of sizes) {
    if (size > R * C * 65534) {
      console.error(`${n} ${label}: over the maximum blob size (${R * C * 65534} bytes)`)
      continue
    }
    const runs = n === 1000 || size > 1 << 20 ? 3 : 7
    const data = bytes(size, n + size)
    const symbol = Math.ceil(Math.max(size, 1) / (R * C) / 2) * 2
    const pBytes = uleb(C * symbol) + C * symbol + 4
    const sBytes = uleb(R * symbol) + R * symbol + 4
    const ours = new Ours.BlobEncoder(n)
    const mysten = new Mysten.BlobEncoder(n)
    const mystenEncode = (blob: Uint8Array) => {
      const p = Array.from({ length: n }, () => new Uint8Array(pBytes))
      const s = Array.from({ length: n }, () => new Uint8Array(sBytes))
      return [mysten.encode(blob, p, s), p] as const
    }

    record(`${n}`, label, "encode", time(runs, () => ours.encode(data)), time(runs, () => mystenEncode(data)))
    record(`${n}`, label, "blobId", time(runs, () => ours.compute_metadata(data)), time(runs, () => mysten.compute_metadata(data)))

    const encoded = ours.encode(data)
    const primary = Array.from({ length: n }, (_, p) => encoded.slice(p * pBytes, (p + 1) * pBytes))
    const zeroId = new Array<number>(32).fill(0)
    for (const [kind, slivers] of [["decode systematic", primary.slice(0, R)], ["decode repair", primary.slice(n - R)]] as const) {
      const out = new Uint8Array(size)
      record(
        `${n}`,
        label,
        kind,
        time(runs, () => ours.decode(BigInt(size), [...slivers])),
        time(runs, () => mysten.decode(zeroId, BigInt(size), [...slivers], out))
      )
    }

    // n − 2f primary slivers, systematic and repair mixed.
    const check = Array.from({ length: R }, (_, i) => primary[(i * 7) % n]!)
    const crafted = () => {
      const blob = new Uint8Array(R * C * symbol)
      check.forEach((s, r) => blob.set(s.subarray(uleb(C * symbol), uleb(C * symbol) + C * symbol), r * C * symbol))
      return mystenEncode(blob)
    }
    record(`${n}`, label, `roots (${R} slivers)`, time(runs, () => ours.sliver_roots(true, check)), time(runs, crafted))
    ours.free()
    mysten.free()
  }
}

{
  const sigs = bls12_381.longSignatures
  const message = new Uint8Array(70).fill(7)
  const count = 667
  const keys = Array.from({ length: count }, (_, i) => sigs.keygen(bytes(48, i + 1)))
  const signatures = keys.map((k) => sigs.Signature.toBytes(sigs.sign(sigs.hash(message), k.secretKey)))
  const publicKeys = keys.map((k) => k.publicKey.toBytes(false))
  const aggregate = Ours.bls12381_min_pk_aggregate(signatures)
  record("—", "—", "BLS verify", time(9, () => Ours.bls12381_min_pk_verify(signatures[0]!, publicKeys[0]!, message)), time(9, () => Mysten.bls12381_min_pk_verify(signatures[0]!, publicKeys[0]!, message)))
  record("—", "—", `BLS aggregate ${count}`, time(5, () => Ours.bls12381_min_pk_aggregate(signatures)), time(5, () => Mysten.bls12381_min_pk_aggregate(signatures)))
  record("—", "—", `BLS verify agg. ${count}`, time(5, () => Ours.bls12381_min_pk_verify_aggregate(publicKeys, message, aggregate)), time(5, () => Mysten.bls12381_min_pk_verify_aggregate(publicKeys, message, aggregate)))
}

console.log(`\n${runtime}, ${new Date().toISOString().slice(0, 10)}, median ms (ours / @mysten/walrus-wasm 0.3.1, speed-up)\n`)
console.log("| n | blob | operation | ours | Mysten | × |")
console.log("|---|---|---|---|---|---|")
for (const [n, size, op, ours, mysten] of rows) {
  console.log(`| ${n} | ${size} | ${op} | ${ours.toFixed(1)} | ${mysten.toFixed(1)} | ${(mysten / ours).toFixed(1)} |`)
}
