/**
 * README examples (Move codegen config), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import { defineConfig } from "@unconfirmed/sui-codegen/Config"

// #region readme
export default defineConfig({
  output: "./src/generated",
  packages: [
    { path: "./move/counter", packageId: "0x…" },                  // local: runs `sui move summary`
    { id: "0x…", network: "testnet", name: "deepbook" },           // on-chain, over gRPC GetPackage
    { path: "./move/counter", package: "sui", modules: ["coin"] }  // framework modules, same summaries
  ]
})
// #endregion
