import { defineConfig } from "@unconfirmed/sui-codegen/Config"

/**
 * Bindings for the Walrus package on testnet (`System.package_id`, version 4).
 * Library code never relies on the generated `Package` default: every call is
 * pointed at the system object's `package_id` (design §5).
 *
 *   bun packages/walrus/scripts/codegen.ts
 */
export default defineConfig({
  output: "./src/generated",
  packages: [
    { id: "0x7d3b2086808a62bbc44d18c6b1d407973d77dd26946735873092c2f5650b4611", network: "testnet", name: "walrus" }
  ]
})
