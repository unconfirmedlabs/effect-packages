/**
 * README examples (Testing your code), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Effect from "effect/Effect"
import type { Address } from "@unconfirmed/effect-sui/Address"
import * as Testing from "@unconfirmed/effect-sui/Testing"
import * as Transactions from "@unconfirmed/effect-sui/Transactions"
import * as Tx from "@unconfirmed/effect-sui/Tx"
import { recipe as bump, signer } from "./shared.ts"

declare const pkg: string
declare const counterId: Address
const Counter = Bcs.struct({ id: Bcs.Address, value: Bcs.u64 })
const Bumped = Bcs.struct({ value: Bcs.u64 })

// #region readme
const layer = Testing.layer({
  objects: [{ objectId: counterId, type: `${pkg}::counter::Counter`, contents: Bcs.encodeSync(Counter)({ id: counterId, value: 1n }) }],
  packages: [{ packageId: pkg, functions: { "counter::bump": { isEntry: true, parameters: [{ reference: "Mutable", typeName: `${pkg}::counter::Counter` }] } } }],
  // Transactions aren't run: the responder says what one did (default: success, no gas, nothing changed)
  respond: ({ mode }) => (mode === "execute" ? { events: [{ type: `${pkg}::counter::Bumped`, contents: Bcs.encodeSync(Bumped)({ value: 2n }) }] } : {})
})

const program = Effect.gen(function*() {
  const node = yield* Testing.Node                                          // the handle: seed and inspect mid-test
  yield* node.setAddressBalance({ owner: signer.address, amount: 1_000_000_000n })  // gas, or node.putCoin
  const effects = yield* Tx.run(bump, { signer, include: ["events"] })     // resolves against the node, then executes
  const landed = yield* Transactions.waitFor(effects.digest)               // in checkpoint 1, at the node's clock
  const reads = (yield* node.requests).filter((r) => r.method === "Objects.get")   // one entry per batch
  return { effects, landed, reads }
})
// #endregion

export const runTest = () => Effect.runPromise(Effect.provide(program, layer))
