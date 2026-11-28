import { defineConfig } from "@unconfirmed/effect-sui-codegen/Config"

// Used by codegen.test.ts to exercise the CLI. Output goes to the git-ignored `.mysten/`.
export default defineConfig({
  output: "../../.mysten/cli",
  packages: [
    { path: "./fixture", summarize: false },
    { path: "./fixture", package: "std", modules: ["option"], summarize: false }
  ]
})
