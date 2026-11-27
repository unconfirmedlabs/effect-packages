/**
 * End to end on devnet: faucet -> build -> resolve (budget by dry run) -> sign
 * (effect/crypto Ed25519) -> execute. Opt in with SUI_LIVE=1.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schedule, Schema } from "effect"
import { SecureRandom, Signature } from "effect/crypto"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import * as Signer from "../src/crypto/Signer.ts"
import { GrpcWeb } from "../src/grpc/GrpcWeb.ts"
import { SuiClient } from "../src/sui/SuiClient.ts"
import * as T from "../src/sui/Types.ts"
import * as Ptb from "../src/tx/Ptb.ts"
import * as Tx from "../src/tx/Tx.ts"

const live = process.env.SUI_LIVE === "1" ? describe : describe.skip

const FaucetResponse = Schema.Struct({
  status: Schema.Literal("Success"),
  coins_sent: Schema.Array(Schema.Struct({ id: Schema.String, amount: Schema.Number }))
})

const faucet = (recipient: T.Address) =>
  HttpClientRequest.post("https://faucet.devnet.sui.io/v2/gas").pipe(
    HttpClientRequest.bodyJsonUnsafe({ FixedAmountRequest: { recipient } }),
    (req) => Effect.flatMap(Effect.service(HttpClient.HttpClient), (http) => http.execute(req)),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(FaucetResponse))
  )

const layer = Layer.mergeAll(
  SuiClient.layer.pipe(Layer.provide(GrpcWeb.layer({ baseUrl: "https://fullnode.devnet.sui.io:443" }))),
  Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
).pipe(Layer.provideMerge(FetchHttpClient.layer))

live("devnet", () => {
  test("faucet, build, resolve, sign, execute", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* SuiClient
        const signer = yield* Signer.ed25519(crypto.getRandomValues(new Uint8Array(32)))
        const funded = yield* faucet(signer.address)
        const coinId = T.address(funded.coins_sent[0]!.id)

        // The faucet's transfer may not be visible yet: retry exactly the typed "not found".
        const coin = yield* client.getObject(coinId).pipe(
          Effect.retry({
            while: (e) => e._tag === "ObjectNotFound",
            schedule: Schedule.spaced("500 millis"),
            times: 20
          })
        )

        const { draft } = yield* Ptb.build(
          Effect.gen(function*() {
            const [a] = yield* Ptb.splitCoins(Ptb.gas, [yield* Ptb.u64(1_000n)])
            yield* Ptb.transferObjects([a!], yield* Ptb.address(signer.address))
          })
        )
        const data = yield* Tx.resolve(draft, { sender: signer.address, gas: { payment: [coin.ref] } })
        return { data, executed: yield* Tx.execute(data, signer) }
      }).pipe(Effect.provide(layer))
    )
    console.log("executed", result.executed.digest, "budget", result.data.gasData.budget)
    expect(result.executed.digest.length).toBeGreaterThan(40)
  }, 60_000)
})
