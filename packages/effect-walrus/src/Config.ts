/**
 * Which Walrus deployment to talk to: its system and staking objects. Every
 * other id (the package calls go to, the type-origin package, the WAL type)
 * is read from these at run time.
 */
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { Address } from "@unconfirmed/sui/Address"

export interface WalrusConfigService {
  readonly systemObjectId: Address
  readonly stakingObjectId: Address
}

export class WalrusConfig extends Context.Service<WalrusConfig, WalrusConfigService>()("@unconfirmed/walrus/WalrusConfig") {}

export const testnet: WalrusConfigService = {
  systemObjectId: "0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af" as Address,
  stakingObjectId: "0xbe46180321c30aab2f8b3501e24048377287fa708018a5b7c2792b35fe339ee3" as Address
}

export const mainnet: WalrusConfigService = {
  systemObjectId: "0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2" as Address,
  stakingObjectId: "0x10b9d30c28448939ce6c4d6c6e0ffce4a7f8a4ada8248bdad09ef8b70e4a3904" as Address
}

export const layer = (config: WalrusConfigService): Layer.Layer<WalrusConfig> => Layer.succeed(WalrusConfig, config)
