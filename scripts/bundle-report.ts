/**
 * What each kind of program actually ships, under several bundlers.
 *
 * Bun and esbuild do not do deep scope analysis; Rolldown does (as do Rollup and
 * Webpack 5+). The Effect docs note that named imports from "effect" need it:
 * https://effect.website/docs/v4/getting-started/importing-effect
 *
 *   bun scripts/bundle-report.ts            namespace imports (the recommended style)
 *   bun scripts/bundle-report.ts --named    named imports from barrels, for comparison
 *   add --detail for per-package attribution (Rolldown)
 */
import * as esbuild from "esbuild"
import { gzipSync } from "node:zlib"
import { rolldown } from "rolldown"

const style = process.argv.includes("--named") ? "named" : "namespace"
/** `import { a, b } from "pkg"` (named) or `import * as a from "pkg/a"` per module (namespace). */
const I = (pkg: string, ...modules: Array<string>) =>
  style === "named"
    ? `import { ${modules.join(", ")} } from "${pkg}"`
    : modules.map((m) => `import * as ${m} from "${pkg}/${m}"`).join("\n")
const E = (m: string) => I("effect", m)

const programs: Record<string, string> = {
  "effect baseline (HttpClient + Schema)": `
    ${E("Effect")}; ${E("Schema")}
    ${I("effect/http", "FetchHttpClient", "HttpClient")}
    const S = Schema.Struct({ a: Schema.BigInt })
    Effect.runPromise(Effect.flatMap(Effect.service(HttpClient.HttpClient), (h) => h.get("https://x")).pipe(Effect.map(() => Schema.decodeUnknownSync(S)({ a: 1n })), Effect.provide(FetchHttpClient.layer))).then(console.log)`,
  "ours: verify, Ed25519 only": `
    ${E("Effect")}
    ${I("@unconfirmed/sui", "Ed25519", "SignatureScheme", "Verify")}
    Effect.runPromise(Verify.personalMessage(new Uint8Array([1]), new Uint8Array(97)).pipe(Effect.provide(SignatureScheme.SignatureSchemes.layer(Ed25519.scheme)))).then(console.log)`,
  "ours: verify, Ed25519 + k1 + r1 + multisig": `
    ${E("Effect")}
    ${I("@unconfirmed/sui", "Ed25519", "SignatureScheme", "Verify")}
    import * as Secp256k1 from "@unconfirmed/sui-secp256k1"
    import * as Secp256r1 from "@unconfirmed/sui-secp256r1"
    import * as MultiSig from "@unconfirmed/sui-multisig"
    Effect.runPromise(Verify.personalMessage(new Uint8Array([1]), new Uint8Array(97)).pipe(Effect.provide(SignatureScheme.SignatureSchemes.layer(Ed25519.scheme, Secp256k1.scheme, Secp256r1.scheme, MultiSig.scheme)))).then(console.log)`,
  "ours: read one object": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Address", "Objects")}
    ${style === "named" ? `import { GrpcWeb, ObjectsGrpc } from "@unconfirmed/sui/grpc"` : `import { GrpcWeb } from "@unconfirmed/sui/grpc/GrpcWeb"\nimport * as ObjectsGrpc from "@unconfirmed/sui/grpc/ObjectsGrpc"`}
    const layer = ObjectsGrpc.layer.pipe(Layer.provide(GrpcWeb.layer({ baseUrl: "https://fullnode.testnet.sui.io:443" })), Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.flatMap(Effect.service(Objects.Objects), (o) => o.get(Address.normalize("0x6"))).pipe(Effect.provide(layer))).then(console.log)`,
  "ours: build + resolve + sign + execute": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Ed25519", "Ptb", "Tx")}
    import * as SuiGrpc from "@unconfirmed/sui/grpc"
    const layer = SuiGrpc.layer({ baseUrl: "https://fullnode.testnet.sui.io:443" }).pipe(Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Tx.run(Effect.gen(function*() { yield* Ptb.transferObjects([Ptb.gas], yield* Ptb.address(signer.address)) }), { signer })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  "mysten: verify a signature": `
    import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
    verifyPersonalMessageSignature(new Uint8Array([1]), "AA==", { offline: true }).then(console.log)`,
  "mysten: read one object": `
    import { SuiGrpcClient } from "@mysten/sui/grpc"
    new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" }).core.getObject({ objectId: "0x6" }).then(console.log)`,
  "mysten: build + sign + execute": `
    import { SuiGrpcClient } from "@mysten/sui/grpc"
    import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
    import { Transaction } from "@mysten/sui/transactions"
    const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
    const signer = Ed25519Keypair.generate()
    const tx = new Transaction(); tx.transferObjects([tx.gas], signer.toSuiAddress())
    signer.signAndExecuteTransaction({ transaction: tx, client }).then(console.log)`
}

const bucket = (path: string) => {
  if (/[/\\]effect@|node_modules[/\\]effect[/\\]/.test(path)) return "effect"
  if (/@noble[/\\]curves[/\\](abstract[/\\]weierstrass|secp256k1|nist)/.test(path)) return "secp curves"
  if (/@noble|@scure/.test(path)) return "noble/scure"
  if (/packages[/\\]sui-multisig/.test(path)) return "sui-multisig"
  if (/packages[/\\]sui-secp/.test(path)) return "sui-secp*"
  if (/packages[/\\]sui[/\\]src[/\\]grpc/.test(path)) return "sui/grpc"
  if (/packages[/\\]sui[/\\]src/.test(path)) return "sui core"
  if (/packages[/\\]bcs/.test(path)) return "bcs"
  if (/@mysten/.test(path)) return "@mysten"
  return "other"
}

const kb = (n: number) => (n / 1024).toFixed(1)
const dir = `${import.meta.dir}/.bundle-probe`
const detail = process.argv.includes("--detail")

console.log(`import style: ${style}\n`)
console.log(`${"program".padEnd(44)} ${"bun".padStart(14)} ${"esbuild".padStart(14)} ${"rolldown".padStart(14)}`)
for (const [name, source] of Object.entries(programs)) {
  const entry = `${dir}/entry.ts`
  await Bun.write(entry, source)

  const bun = await Bun.build({ entrypoints: [entry], minify: true, target: "browser" })
  const bunCode = await bun.outputs[0]!.text()

  const es = await esbuild.build({ entryPoints: [entry], bundle: true, minify: true, platform: "browser", format: "esm", write: false, logLevel: "silent" })
  const esCode = es.outputFiles[0]!.text

  const rd = await rolldown({ input: entry, platform: "browser", logLevel: "silent" })
  const { output } = await rd.generate({ format: "esm", minify: true })
  const chunk = output[0]
  const rdCode = chunk.code

  const cell = (code: string) => `${kb(code.length)}/${kb(gzipSync(code).length)}`.padStart(14)
  console.log(`${name.padEnd(44)} ${cell(bunCode)} ${cell(esCode)} ${cell(rdCode)}`)

  if (detail) {
    const sizes = new Map<string, number>()
    for (const [id, m] of Object.entries(chunk.modules)) {
      if (id.includes(".bundle-probe")) continue
      sizes.set(bucket(id), (sizes.get(bucket(id)) ?? 0) + m.renderedLength)
    }
    const total = [...sizes.values()].reduce((a, b) => a + b, 0)
    console.log(`${"".padEnd(44)} rolldown, unminified by package: ${[...sizes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((100 * v) / total)}%`).join(", ")}`)
  }
}
await Bun.$`rm -rf ${dir}`
console.log("\nKB minified / KB minified+gzip")
