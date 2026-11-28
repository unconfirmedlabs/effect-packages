// End to end on devnet: build + sign + execute, ours (Tx.run) vs Mysten (signAndExecuteTransaction).
// Separate funded accounts (faucet) so the two SDKs never contend for the same gas coins.
//   bun packages/effect-sui/bench/execute-vs-mysten.ts [runs]
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as SuiGrpc from "@unconfirmed/effect-sui/grpc"
import * as Ed25519 from "@unconfirmed/effect-sui/Ed25519"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import * as Tx from "@unconfirmed/effect-sui/Tx"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { faucet } from "@unconfirmed/test-support/live"

const URL = "https://fullnode.devnet.sui.io:443"
const RUNS = Number(process.argv[2] ?? 7)
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

const log: string[] = []
const http = Layer.effect(HttpClient.HttpClient, Effect.map(Effect.service(HttpClient.HttpClient), HttpClient.tapRequest((r) => Effect.sync(() => { log.push(r.url.split("/").pop()!) })))).pipe(Layer.provide(FetchHttpClient.layer))
const layer = SuiGrpc.layerCore({ url: URL }).pipe(Layer.provideMerge(http))

const ours = await Effect.runPromise(Ed25519.generate)
const mineKey = new Ed25519Keypair()
const mine = mineKey.toSuiAddress()
await Effect.runPromise(Effect.all([faucet(ours.address), faucet(mine as any)], { concurrency: 2 }).pipe(Effect.provide(layer)) as any)
await new Promise((r) => setTimeout(r, 3000))

const split = (to: string) => Effect.gen(function*() {
  const [c] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1000n)])
  yield* Ptb.transferObjects([c!], yield* Ptb.address(to))
})
const client = new SuiGrpcClient({ baseUrl: URL, network: "devnet" })
const a: number[] = [], b: number[] = []
for (let i = 0; i < RUNS; i++) {
  log.length = 0
  let t = performance.now()
  const fx = await Effect.runPromise(Tx.run(split(ours.address), { signer: ours }).pipe(Effect.provide(layer)) as any) as any
  a.push(performance.now() - t)
  if (i === 0) console.log("ours requests:", log.join(", "), fx.status._tag)
  t = performance.now()
  const tx = new Transaction(); const [c] = tx.splitCoins(tx.gas, [1000]); tx.transferObjects([c], mine)
  const r = await client.signAndExecuteTransaction({ transaction: tx, signer: mineKey, include: { effects: true } })
  b.push(performance.now() - t)
  if (i === 0) console.log("mysten:", (r as any).$kind ?? Object.keys(r))
  await new Promise((r) => setTimeout(r, 1500)) // let the owned-object index catch up for both
}
console.log(`Tx.run split+transfer (devnet)            ours median ${median(a).toFixed(0)} ms (min ${Math.min(...a).toFixed(0)})`)
console.log(`signAndExecuteTransaction split+transfer  mysten median ${median(b).toFixed(0)} ms (min ${Math.min(...b).toFixed(0)})`)
