/**
 * README examples (Seal), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Approval from "@unconfirmed/seal/Approval"
import * as Config from "@unconfirmed/seal/Config"
import * as Seal from "@unconfirmed/seal/Seal"
import * as SealGrpc from "@unconfirmed/seal/SealGrpc"
import { signer } from "./shared.ts"

declare const packageId: string
declare const data: Uint8Array

export const seal = Effect.gen(function*() {
  // #region readme
  // Configuration, key servers read from chain, the key server HTTP client, and the two chain reads Seal needs
  // (Objects, Packages) over gRPC-web; needs an HttpClient.
  const layer = SealGrpc.layer({
    servers: [Config.testnet.mysten1, Config.testnet.mysten2, Config.testnet.committee],
    grpc: { baseUrl: "https://fullnode.testnet.sui.io:443" }
  }).pipe(Layer.provideMerge(FetchHttpClient.layer))
  // A program that also builds transactions: Seal.layer({ servers }).pipe(Layer.provideMerge(SuiGrpc.layer({ baseUrl })), ...).
  // SuiGrpc.layer ships every service's RPCs (about 60 KB more than Seal needs).

  const id = Bcs.encodeSync(Bcs.Address)(signer.address)                       // account_based: the id is the user's address
  const { encryptedObject } = yield* Seal.encrypt({ packageId, id, data, threshold: 2 })   // or dem: "Hmac256Ctr", aad

  const session = yield* Seal.session({ packageId, signer })                   // a key Signer or a wallet's WalletSigner
  const approval = yield* Approval.fromRecipe(Approval.call({ target: `${packageId}::account_based::seal_approve`, id }))
  const plaintext = yield* Seal.decrypt({ data: encryptedObject, session, approval })      // one prompt, one round of requests
  // #endregion
})
