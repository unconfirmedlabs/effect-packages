/**
 * README examples (Passkeys), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import * as Effect from "effect/Effect"
import * as Passkey from "@unconfirmed/effect-sui/Passkey"
import * as Ed25519 from "@unconfirmed/effect-sui/Ed25519"
import * as Tx from "@unconfirmed/effect-sui/Tx"
import * as MultiSig from "@unconfirmed/effect-sui/MultiSig"
import { recipe, SignatureSchemes } from "./shared.ts"

export const passkeys = Effect.gen(function*() {
  // #region readme
  const provider = Passkey.browserProvider("My app", { rp: { id: location.hostname } })
  const signer = yield* Passkey.create(provider)    // first visit: creates a passkey; store signer.publicKey.bytes
  const again = yield* Passkey.recover(provider)    // returning user: two prompts, the public key common to both
  yield* Tx.run(recipe, { signer })                 // a passkey signer is just a Signer (also inside MultiSig.signer)

  SignatureSchemes.layer(Ed25519.scheme, Passkey.scheme, MultiSig.scheme)   // verify passkeys, alone or as members
  // #endregion
})
