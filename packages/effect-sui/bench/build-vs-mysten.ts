// Head-to-head on testnet, build only: ours (server default, and client path) vs @mysten/sui 3.0.1. Interleaved, median of RUNS.
// Reads only; nothing is signed. The sender must hold testnet SUI: set SUI_FUNDED_ADDRESS.
//   bun packages/effect-sui/bench/build-vs-mysten.ts [runs]
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as SuiGrpc from "@unconfirmed/effect-sui/grpc"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import * as Tx from "@unconfirmed/effect-sui/Tx"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { fundedAddress } from "@unconfirmed/test-support/funded"

const URL = "https://fullnode.testnet.sui.io:443"
const S = fundedAddress() ?? (() => { throw new Error("set SUI_FUNDED_ADDRESS to a testnet address holding SUI") })()
const OTHER = "0x048c21fd5a2ac1a5f7b4dd2fda964ae84d08440d161b61cbb71de353abc06490" // sponsored sender (no funds)
const RUNS = Number(process.argv[2] ?? 7)
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const pause = () => new Promise((r) => setTimeout(r, 400))
const ms = async (f: () => Promise<unknown>) => { await pause(); const t = performance.now(); await f(); return performance.now() - t }
const layer = () => SuiGrpc.layerCore({ url: URL }).pipe(Layer.provideMerge(FetchHttpClient.layer))
const sender = Address.normalize(S), other = Address.normalize(OTHER)

const recipes: Record<string, { ours: Effect.Effect<unknown, any, any>; opts: any; mysten: () => Transaction }> = {
  "split+transfer": {
    ours: Effect.gen(function*() { const [c] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1000n)]); yield* Ptb.transferObjects([c!], yield* Ptb.address(sender)) }),
    opts: { sender },
    mysten: () => { const tx = new Transaction(); tx.setSender(S); const [c] = tx.splitCoins(tx.gas, [1000]); tx.transferObjects([c], S); return tx }
  },
  "moveCall(clock)": {
    ours: Effect.gen(function*() { yield* Ptb.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [yield* Ptb.object("0x6")] }) }),
    opts: { sender },
    mysten: () => { const tx = new Transaction(); tx.setSender(S); tx.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [tx.object("0x6")] }); return tx }
  },
  "Ptb.coin + transfer": {
    ours: Effect.gen(function*() { const c = yield* Ptb.coin({ amount: 1000n }); yield* Ptb.transferObjects([c], yield* Ptb.address(sender)) }),
    opts: { sender },
    mysten: () => { const tx = new Transaction(); tx.setSender(S); tx.transferObjects([tx.coin({ balance: 1000 })], S); return tx }
  },
  "sponsored moveCall(clock)": {
    ours: Effect.gen(function*() { yield* Ptb.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [yield* Ptb.object("0x6")] }) }),
    opts: { sender: other, gasOwner: sender },
    mysten: () => { const tx = new Transaction(); tx.setSender(OTHER); tx.setGasOwner(S); tx.moveCall({ target: "0x2::clock::timestamp_ms", arguments: [tx.object("0x6")] }); return tx }
  }
}

const results: Record<string, number[]> = {}
const rec = (k: string, v: number) => (results[k] ??= []).push(v)
await fetch(URL).catch(() => {})
for (let r = 0; r < RUNS; r++) {
  for (const [name, x] of Object.entries(recipes)) {
    rec(`${name}, cold | ours`, await ms(() => Effect.runPromise(Tx.build(x.ours, x.opts).pipe(Effect.provide(layer())) as any)))
    rec(`${name}, cold | ours client`, await ms(() => Effect.runPromise(Tx.build(x.ours, { ...x.opts, resolve: "client" }).pipe(Effect.provide(layer())) as any)))
    rec(`${name}, cold | mysten`, await ms(() => x.mysten().build({ client: new SuiGrpcClient({ baseUrl: URL, network: "testnet" }) })))
  }
}
// warm: one runtime / one client, caches populated
{
  const c = new SuiGrpcClient({ baseUrl: URL, network: "testnet" })
  const ours = await Effect.runPromise(Effect.gen(function*() {
    const out: Record<string, number[]> = {}
    for (const [name, x] of Object.entries(recipes)) {
      yield* Tx.build(x.ours, x.opts); yield* Tx.build(x.ours, { ...x.opts, resolve: "client" })
      for (let r = 0; r < RUNS; r++) {
        yield* Effect.promise(pause); let t = performance.now(); yield* Tx.build(x.ours, x.opts); (out[`${name}, warm | ours`] ??= []).push(performance.now() - t)
        yield* Effect.promise(pause); t = performance.now(); yield* Tx.build(x.ours, { ...x.opts, resolve: "client" }); (out[`${name}, warm | ours client`] ??= []).push(performance.now() - t)
      }
    }
    return out
  }).pipe(Effect.provide(layer())) as any) as Record<string, number[]>
  Object.assign(results, ours)
  for (const [name, x] of Object.entries(recipes)) {
    await x.mysten().build({ client: c })
    for (let r = 0; r < RUNS; r++) rec(`${name}, warm | mysten`, await ms(() => x.mysten().build({ client: c })))
  }
}
for (const k of Object.keys(results).sort()) console.log(k.padEnd(48), `median ${median(results[k]!).toFixed(0)} ms`, `(min ${Math.min(...results[k]!).toFixed(0)})`)
