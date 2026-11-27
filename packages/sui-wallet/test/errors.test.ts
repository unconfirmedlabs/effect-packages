/** Error classes render a short `message` from their fields (review X-6). */
import { describe, expect, test } from "bun:test"
import { Wallet } from "../src/index.ts"

describe("error messages", () => {
  test("render their fields", () => {
    expect(new Wallet.WalletNotFound({ name: "Slush" }).message).toBe("wallet Slush not found")
    expect(new Wallet.UnsupportedFeature({ wallet: "Slush", feature: "sui:signTransaction" }).message).toBe(
      "Slush does not support sui:signTransaction"
    )
    expect(new Wallet.UnsupportedChain({ wallet: "Slush", chain: "sui:devnet" }).message).toBe("Slush does not support sui:devnet")
    expect(new Wallet.AccountNotFound({ wallet: "Slush" }).message).toBe("no account connected to Slush")
    expect(String(new Wallet.AccountNotFound({ wallet: "Slush", address: "0x1" }))).toBe(
      "AccountNotFound: account 0x1 not connected to Slush"
    )
  })
})
