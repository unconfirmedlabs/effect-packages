/**
 * Chain state against real full nodes (read-only, no funds). Opt in with SUI_LIVE=1.
 *
 * - The generated schemas decode testnet's and mainnet's System, Staking, both
 *   inner states and every StakingPool of the committees; C5 holds on both.
 * - Our values equal `@mysten/walrus`'s `systemState()` / `stakingState()`.
 * - Mainnet's package exposes the same signatures as testnet's (from which
 *   the bindings were generated) for every call the recipes make.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { walrus } from "@mysten/walrus"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Result from "effect/Result"
import * as Address from "@unconfirmed/sui/Address"
import * as SuiGrpc from "@unconfirmed/sui/grpc"
import type * as P from "@unconfirmed/sui/grpc/generated/proto"
import * as Rpc from "@unconfirmed/sui/grpc/generated/rpc"
import { GrpcWeb } from "@unconfirmed/sui/grpc/GrpcWeb"
import * as Committee from "../src/Committee.ts"
import * as Config from "../src/Config.ts"
import * as System from "../src/System.ts"

const live = process.env.SUI_LIVE === "1"
const suite = live ? describe : describe.skip

const NETWORKS = {
  testnet: { config: Config.testnet, url: process.env.SUI_TESTNET_URL ?? "https://fullnode.testnet.sui.io:443" },
  mainnet: { config: Config.mainnet, url: process.env.SUI_MAINNET_URL ?? "https://fullnode.mainnet.sui.io:443" }
} as const

const chain = (network: keyof typeof NETWORKS) =>
  SuiGrpc.layer({ baseUrl: NETWORKS[network].url }).pipe(Layer.provide(FetchHttpClient.layer))

const walrusLayer = (network: keyof typeof NETWORKS) =>
  Layer.mergeAll(System.layer, Committee.layer()).pipe(
    Layer.provideMerge(Config.layer(NETWORKS[network].config)),
    Layer.provideMerge(chain(network))
  )

const loadAll = (network: keyof typeof NETWORKS) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const system = yield* Effect.service(System.System)
      const state = yield* system.state
      const walType = yield* system.walType
      const committees = yield* (yield* Effect.service(Committee.Committees)).get
      return { state, walType, committees }
    }).pipe(Effect.provide(walrusLayer(network)))
  )

const hex = (b: Uint8Array | ReadonlyArray<number>) => Buffer.from(b).toString("hex")

suite("live chain state", () => {
  for (const network of ["testnet", "mainnet"] as const) {
    test(`${network}: System and Committees decode; C5 holds`, async () => {
      const { committees, state, walType } = await loadAll(network)
      expect(state.nShards).toBe(1000)
      expect(committees.current.nShards).toBe(1000)
      expect(committees.current.epoch).toBe(state.epoch)
      expect(walType).toMatch(/^0x[0-9a-f]{64}::wal::WAL$/)
      expect(Result.isSuccess(Committee.checkAgainstSystem(committees.current, state))).toBe(true)
      expect(committees.current.nodes.map((n) => hex(n.publicKey))).toEqual(state.members.map((m) => hex(m.publicKey)))
      if (committees.previous !== undefined) expect(committees.previous.epoch).toBe(state.epoch - 1)
    }, 60_000)
  }

  test("testnet: equal to @mysten/walrus systemState() / stakingState()", async () => {
    const ours = await loadAll("testnet")
    const client = new SuiGrpcClient({ network: "testnet", baseUrl: NETWORKS.testnet.url }).$extend(walrus())
    const [theirSystem, theirStaking, theirSystemObject] = await Promise.all([
      client.walrus.systemState(),
      client.walrus.stakingState(),
      client.walrus.systemObject()
    ])
    // The two reads can straddle an epoch change: then there is nothing to compare.
    if (Number(theirSystem.committee.epoch) !== ours.state.epoch) return console.warn("epoch changed between reads; skipped")
    expect(ours.state.epoch).toBe(Number(theirSystem.committee.epoch))
    expect(ours.state.nShards).toBe(Number(theirSystem.committee.n_shards))
    expect(ours.state.storagePrice).toBe(BigInt(theirSystem.storage_price_per_unit_size))
    expect(ours.state.writePrice).toBe(BigInt(theirSystem.write_price_per_unit_size))
    expect(ours.state.packageId).toBe(Address.normalize(theirSystemObject.package_id))
    expect(ours.state.members.map((m) => [m.nodeId, m.weight, hex(m.publicKey)])).toEqual(
      theirSystem.committee.members.map((m: any) => [Address.normalize(m.node_id), Number(m.weight), hex(m.public_key.bytes)])
    )
    const current = ours.committees.current
    expect(current.epoch).toBe(Number(theirStaking.epoch))
    expect(ours.committees.transitioning).toBe(theirStaking.epoch_state.$kind === "EpochChangeSync")
    expect(current.nodes.map((n) => [n.nodeId, [...n.shards]])).toEqual(
      theirStaking.committee[0].contents.map((e: any) => [Address.normalize(e.key), e.value.map(Number)])
    )
    expect(ours.committees.previous?.nodes.map((n) => n.nodeId)).toEqual(
      theirStaking.previous_committee[0].contents.map((e: any) => Address.normalize(e.key))
    )
  }, 60_000)

  test("mainnet exposes the testnet signatures for every call the recipes make", async () => {
    const CALLS = [
      ["system", "reserve_space"],
      ["system", "register_blob"],
      ["system", "certify_blob"],
      ["system", "delete_blob"],
      ["system", "extend_blob"],
      ["blob", "burn"],
      ["blob", "add_metadata"],
      ["blob", "insert_or_update_metadata_pair"],
      ["metadata", "new"],
      ["storage_resource", "destroy"]
    ] as const
    const FRAMEWORK = new Set([Address.normalize("0x1"), Address.normalize("0x2"), Address.normalize("0x3")])
    const PRIM: Record<number, string> = { 1: "address", 2: "bool", 3: "u8", 4: "u16", 5: "u32", 6: "u64", 7: "u128", 8: "u256" }
    // Package-specific addresses (Walrus, WAL) differ between networks: compare by module and name.
    const body = (b: P.OpenSignatureBody | undefined): string => {
      if (b === undefined) return "?"
      if (PRIM[b.type ?? 0] !== undefined) return PRIM[b.type!]!
      if (b.type === 9) return `vector<${body(b.type_parameter_instantiation?.[0])}>`
      if (b.type === 11) return `T${b.type_parameter}`
      const [address, module, name] = b.type_name!.split("::") as [string, string, string]
      const args = (b.type_parameter_instantiation ?? []).map(body)
      return `${FRAMEWORK.has(Address.normalize(address)) ? Address.normalize(address) : "_"}::${module}::${name}${args.length ? `<${args.join(", ")}>` : ""}`
    }
    const sig = (s: P.OpenSignature) => `${s.reference === 1 ? "&" : s.reference === 2 ? "&mut " : ""}${body(s.body)}`
    const signatures = (network: keyof typeof NETWORKS, packageId: string) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const grpc = yield* GrpcWeb
          return yield* Effect.forEach(CALLS, ([module, name]) =>
            Effect.map(grpc.unary(Rpc.MovePackageService_GetFunction, { package_id: packageId, module_name: module, name }), (r) => {
              const f = r.function!
              return `${f.visibility} ${module}::${name}<${f.type_parameters?.length ?? 0}>(${(f.parameters ?? []).map(sig).join(", ")}): (${
                (f.returns ?? []).map(sig).join(", ")
              })`
            }))
        }).pipe(Effect.provide(GrpcWeb.layer({ baseUrl: NETWORKS[network].url })), Effect.provide(FetchHttpClient.layer))
      )
    const [testnet, mainnet] = await Promise.all([loadAll("testnet"), loadAll("mainnet")])
    const [a, b] = await Promise.all([signatures("testnet", testnet.state.packageId), signatures("mainnet", mainnet.state.packageId)])
    expect(b).toEqual(a)
    expect(a[0]).toBe("2 system::reserve_space<0>(&mut _::system::System, u64, u32, &mut 0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<_::wal::WAL>, &mut 0x0000000000000000000000000000000000000000000000000000000000000002::tx_context::TxContext): (_::storage_resource::Storage)")
  }, 60_000)
})
