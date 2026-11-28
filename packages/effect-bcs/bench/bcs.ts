/**
 * BCS throughput against @mysten/bcs (through @mysten/sui/bcs).
 *
 *   bun packages/effect-bcs/bench/bcs.ts                 every case
 *   bun packages/effect-bcs/bench/bcs.ts --only Coin     cases whose name contains "Coin"
 *   bun packages/effect-bcs/bench/bcs.ts --runs 21       timed runs per case (default 15)
 *
 * Each case is warmed up, then timed `runs` times (a full GC before each side); the table
 * shows the median (and min) per run in milliseconds. Not part of `bun test`.
 */
import * as Option from "effect/Option"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as T from "@unconfirmed/effect-sui/TransactionData"
import * as TypeTag from "@unconfirmed/effect-sui/TypeTag"
import { bcs as m } from "@mysten/sui/bcs"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const RUNS = Number(arg("--runs") ?? 15)
const ONLY = arg("--only")

let sink: unknown
const measure = (f: () => unknown) => {
  // Start each side from a collected heap, so one side's garbage isn't billed to the other.
  sink = undefined
  Bun.gc(true)
  for (let i = 0; i < 5; i++) sink = f()
  const times: Array<number> = []
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    sink = f()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return { median: times[times.length >> 1]!, min: times[0]! }
}

const rows: Array<[string, string, string, string]> = []
const bench = (name: string, ours: () => unknown, mysten: () => unknown) => {
  if (ONLY && !name.includes(ONLY)) return
  const a = measure(ours)
  const b = measure(mysten)
  const fmt = (r: { median: number; min: number }) => `${r.median.toFixed(2)} (${r.min.toFixed(2)})`
  rows.push([name, fmt(a), fmt(b), (b.median / a.median).toFixed(2) + "x"])
  console.log(rows[rows.length - 1]!.join("  |  "))
}
const loop = (n: number, f: () => unknown) => () => {
  let out: unknown
  for (let i = 0; i < n; i++) out = f()
  return out
}

const A = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Bcs.Address
const D = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" as Bcs.Digest

// --- TransactionData ----------------------------------------------------------
const data: T.TransactionData = {
  _tag: "V1",
  kind: {
    _tag: "ProgrammableTransaction",
    inputs: [
      { _tag: "Pure", bytes: new Uint8Array(8) },
      { _tag: "Pure", bytes: new Uint8Array(32) },
      { _tag: "Object", value: { _tag: "ImmOrOwnedObject", objectId: A(5), version: 7n, digest: D } },
      { _tag: "Object", value: { _tag: "SharedObject", objectId: A(6), initialSharedVersion: 1n, mutability: { _tag: "Immutable" } } }
    ],
    commands: [
      { _tag: "SplitCoins", coin: { _tag: "GasCoin" }, amounts: [{ _tag: "Input", value: 0 }] },
      {
        _tag: "MoveCall",
        package: A(2),
        module: "coin",
        function: "join",
        typeArguments: [TypeTag.parse("0x2::sui::SUI")],
        arguments: [{ _tag: "Input", value: 2 }, { _tag: "NestedResult", value: [0, 0] }]
      },
      { _tag: "TransferObjects", objects: [{ _tag: "Result", value: 0 }], address: { _tag: "Input", value: 1 } }
    ]
  },
  sender: A(1),
  gasData: { payment: [{ objectId: A(9), version: 3n, digest: D }], owner: A(1), price: 1000n, budget: 5_000_000n },
  expiration: { _tag: "None" }
}
const txBytes = T.encode(data)
const mtx = m.TransactionData.parse(txBytes)
bench("TransactionData decode x2000", loop(2000, () => T.decode(txBytes)), loop(2000, () => m.TransactionData.parse(txBytes)))
bench(
  "TransactionData encode x2000",
  loop(2000, () => T.encode(data)),
  loop(2000, () => m.TransactionData.serialize(mtx).toBytes())
)

// --- Coin ---------------------------------------------------------------------
const Coin = Bcs.struct({ id: Bcs.Address, balance: Bcs.u64 })
const MCoin = m.struct("Coin", { id: m.Address, balance: m.u64() })
const coin = Bcs.encodeSync(Coin)({ id: A(3), balance: 5n })
const coinDecode = Bcs.decode(Coin)
const coinEncode = Bcs.encode(Coin)
const coinValue = { id: A(3), balance: 5n }
const mcoinValue = { id: A(3), balance: "5" }
bench("Coin decode x20000", loop(20000, () => coinDecode(coin)), loop(20000, () => MCoin.parse(coin)))
bench("Coin encode x20000", loop(20000, () => coinEncode(coinValue)), loop(20000, () => MCoin.serialize(mcoinValue).toBytes()))

// --- A nested object ------------------------------------------------------------
const Kind = Bcs.enum({ Plain: null, Weighted: Bcs.u32, Tagged: Bcs.struct({ label: Bcs.string, score: Bcs.u64 }) })
const MKind = m.enum("Kind", { Plain: null, Weighted: m.u32(), Tagged: m.struct("T", { label: m.string(), score: m.u64() }) })
const Entry = Bcs.struct({
  owner: Bcs.Address,
  name: Bcs.string,
  amount: Bcs.u64,
  kind: Kind,
  note: Bcs.option(Bcs.string),
  tags: Bcs.vector(Bcs.string),
  meta: Bcs.struct({ created: Bcs.u64, flags: Bcs.vector(Bcs.bool), ratio: Bcs.option(Bcs.u128) })
})
const MEntry = m.struct("Entry", {
  owner: m.Address,
  name: m.string(),
  amount: m.u64(),
  kind: MKind,
  note: m.option(m.string()),
  tags: m.vector(m.string()),
  meta: m.struct("Meta", { created: m.u64(), flags: m.vector(m.bool()), ratio: m.option(m.u128()) })
})
const Registry = Bcs.struct({ id: Bcs.Address, entries: Bcs.vector(Entry), version: Bcs.u64 })
const MRegistry = m.struct("Registry", { id: m.Address, entries: m.vector(MEntry), version: m.u64() })
const registry = {
  id: A(77),
  version: 3n,
  entries: Array.from({ length: 20 }, (_, i) => ({
    owner: A(i + 1),
    name: `entry number ${i} — ünïcödé`,
    amount: BigInt(i) * 1_000_000_007n,
    kind: i % 3 === 0
      ? { _tag: "Plain" as const }
      : i % 3 === 1
      ? { _tag: "Weighted" as const, value: i }
      : { _tag: "Tagged" as const, label: "x".repeat(i), score: BigInt(i) },
    note: i % 2 ? Option.some(`note ${i}`) : Option.none(),
    tags: ["a", "bb", "ccc"].slice(0, i % 4),
    meta: { created: 1_700_000_000_000n + BigInt(i), flags: [true, false, i % 2 === 0], ratio: i % 2 ? Option.none() : Option.some(BigInt(i) << 70n) }
  }))
}
const regBytes = Bcs.encodeSync(Registry)(registry)
const mreg = MRegistry.parse(regBytes)
const regDecode = Bcs.decode(Registry)
const regEncode = Bcs.encode(Registry)
bench("nested object (20 entries) decode x1000", loop(1000, () => regDecode(regBytes)), loop(1000, () => MRegistry.parse(regBytes)))
bench("nested object (20 entries) encode x1000", loop(1000, () => regEncode(registry)), loop(1000, () => MRegistry.serialize(mreg).toBytes()))

// --- Addresses ------------------------------------------------------------------
const Addrs = Bcs.vector(Bcs.Address)
const MAddrs = m.vector(m.Address)
const addrs = Array.from({ length: 10_000 }, (_, i) => A(i * 7919))
const addrBytes = Bcs.encodeSync(Addrs)(addrs)
bench("vector<Address> 10k decode", () => Bcs.decodeSync(Addrs)(addrBytes), () => MAddrs.parse(addrBytes))
bench("vector<Address> 10k encode", () => Bcs.encodeSync(Addrs)(addrs), () => MAddrs.serialize(addrs).toBytes())

// --- Integers ---------------------------------------------------------------------
for (const [name, ours, theirs, max] of [
  ["u64", Bcs.u64, m.u64(), 1n << 64n],
  ["u128", Bcs.u128, m.u128(), 1n << 128n],
  ["u256", Bcs.u256, m.u256(), 1n << 256n]
] as const) {
  const V = Bcs.vector(ours as Bcs.BcsSchema<bigint>)
  const MV = m.vector(theirs as any)
  const values = Array.from({ length: 100_000 }, (_, i) => (BigInt(i) * 0x9e3779b97f4a7c15n * 0x9e3779b97f4a7c15n) % max)
  const bytes = Bcs.encodeSync(V)(values)
  bench(`vector<${name}> 100k decode`, () => Bcs.decodeSync(V)(bytes), () => MV.parse(bytes))
  bench(`vector<${name}> 100k encode`, () => Bcs.encodeSync(V)(values), () => MV.serialize(values).toBytes())
}

// --- Bytes ------------------------------------------------------------------------
const blob = new Uint8Array(1_000_000).map((_, i) => i * 31)
const blobBytes = Bcs.encodeSync(Bcs.byteVector)(blob)
const U8s = Bcs.vector(Bcs.u8)
const MU8s = m.vector(m.u8())
bench("vector<u8> 1MB decode", () => Bcs.decodeSync(U8s)(blobBytes), () => MU8s.parse(blobBytes))
bench("byteVector 1MB decode", () => Bcs.decodeSync(Bcs.byteVector)(blobBytes), () => MU8s.parse(blobBytes))
const blobArray = Array.from(blob)
bench("vector<u8> 1MB encode", () => Bcs.encodeSync(U8s)(blobArray), () => MU8s.serialize(blobArray).toBytes())

console.log(`\n| Case | Ours ms | Mysten ms | Mysten/ours |\n|---|---|---|---|`)
for (const r of rows) console.log(`| ${r.join(" | ")} |`)
void sink
