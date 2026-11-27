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
 *   add --only <text> to measure only the programs whose name contains it
 *
 * Comments are stripped under every bundler so the columns compare code only:
 * esbuild `legalComments: "none"`, Rolldown `comments: false` (by default it
 * keeps every `@__PURE__` annotation), and for Bun, which has no option and
 * keeps only legal comments, `stripLegal`.
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
  "ours: Quorum.run over three members": `
    ${E("Effect")}
    ${style === "named" ? `import { Quorum } from "@unconfirmed/quorum"` : `import * as Quorum from "@unconfirmed/quorum/Quorum"`}
    Effect.runPromise(Quorum.run([1, 2, 3], { weight: () => 1, threshold: 2, run: (n) => Effect.succeed(n) })).then(console.log)`,
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
    const layer = ObjectsGrpc.layer.pipe(Layer.provide(GrpcWeb.layer({ url: "https://fullnode.testnet.sui.io:443" })), Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.flatMap(Effect.service(Objects.Objects), (o) => o.get(Address.normalize("0x6"))).pipe(Effect.provide(layer))).then(console.log)`,
  "ours: build + resolve + sign + execute": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Ed25519", "Ptb", "Tx")}
    import * as SuiGrpc from "@unconfirmed/sui/grpc"
    const layer = SuiGrpc.layerCore({ url: "https://fullnode.testnet.sui.io:443" }).pipe(Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Tx.run(Effect.gen(function*() { yield* Ptb.transferObjects([Ptb.gas], yield* Ptb.address(signer.address)) }), { signer })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  "ours: the same with SuiGrpc.layer (all nine)": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Ed25519", "Ptb", "Tx")}
    import * as SuiGrpc from "@unconfirmed/sui/grpc"
    const layer = SuiGrpc.layer({ url: "https://fullnode.testnet.sui.io:443" }).pipe(Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Tx.run(Effect.gen(function*() { yield* Ptb.transferObjects([Ptb.gas], yield* Ptb.address(signer.address)) }), { signer })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  "ours: hand-written moveCall": `
    ${E("Effect")}
    ${I("@unconfirmed/sui", "Ptb")}
    Effect.runPromise(Ptb.build(Effect.gen(function*() { yield* Ptb.moveCall({ target: "0x1::blob::burn", arguments: [yield* Ptb.object("0x6")] }) }))).then(console.log)`,
  "ours: one generated call (walrus blob.burn)": `
    ${E("Effect")}
    ${I("@unconfirmed/sui", "Ptb")}
    import * as blob from "@unconfirmed/walrus/generated/walrus/blob"
    Effect.runPromise(Ptb.build(blob.burn({ arguments: ["0x6"] }))).then(console.log)`,
  "ours: Tx.run over GraphQL": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Ed25519", "Ptb", "Tx")}
    import * as SuiGraphQL from "@unconfirmed/sui-graphql"
    const layer = SuiGraphQL.layer({ url: "https://graphql.testnet.sui.io/graphql" }).pipe(Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Tx.run(Effect.gen(function*() { yield* Ptb.transferObjects([Ptb.gas], yield* Ptb.address(signer.address)) }), { signer })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  "ours: Lifecycle.run (gRPC, KeyValueStore journal)": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("effect/persistence", "KeyValueStore")}
    ${I("@unconfirmed/sui", "Ed25519", "Ptb")}
    ${I("@unconfirmed/sui-lifecycle", "JournalKeyValueStore", "Lifecycle")}
    import * as SuiGrpc from "@unconfirmed/sui/grpc"
    const layer = Layer.mergeAll(SuiGrpc.layer({ url: "https://fullnode.testnet.sui.io:443" }), JournalKeyValueStore.layer().pipe(Layer.provide(KeyValueStore.layerMemory))).pipe(Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Lifecycle.run(Effect.gen(function*() { yield* Ptb.transferObjects([Ptb.gas], yield* Ptb.address(signer.address)) }), { signer })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  // The browser setup the README recommends: the durable journal over IndexedDB, sender locks over Web Locks.
  "ours: Lifecycle.run, browser (IndexedDB, Web Locks)": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Ed25519", "Ptb")}
    ${I("@unconfirmed/sui-lifecycle", "JournalKeyValueStore", "Lifecycle")}
    import * as KeyValueStoreIndexedDb from "@unconfirmed/sui-lifecycle/KeyValueStoreIndexedDb"
    import * as SenderLockWebLocks from "@unconfirmed/sui-lifecycle/SenderLockWebLocks"
    import * as SuiGrpc from "@unconfirmed/sui/grpc"
    const layer = Layer.mergeAll(SuiGrpc.layer({ url: "https://fullnode.testnet.sui.io:443" }), JournalKeyValueStore.layer().pipe(Layer.provide(KeyValueStoreIndexedDb.layer())), SenderLockWebLocks.layer).pipe(Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Lifecycle.run(Effect.gen(function*() { yield* Ptb.transferObjects([Ptb.gas], yield* Ptb.address(signer.address)) }), { signer })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  "ours: the same over OPFS": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Ed25519", "Ptb")}
    ${I("@unconfirmed/sui-lifecycle", "JournalKeyValueStore", "Lifecycle")}
    import * as KeyValueStoreOpfs from "@unconfirmed/sui-lifecycle/KeyValueStoreOpfs"
    import * as SenderLockWebLocks from "@unconfirmed/sui-lifecycle/SenderLockWebLocks"
    import * as SuiGrpc from "@unconfirmed/sui/grpc"
    const layer = Layer.mergeAll(SuiGrpc.layer({ url: "https://fullnode.testnet.sui.io:443" }), JournalKeyValueStore.layer().pipe(Layer.provide(KeyValueStoreOpfs.layer())), SenderLockWebLocks.layer).pipe(Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Lifecycle.run(Effect.gen(function*() { yield* Ptb.transferObjects([Ptb.gas], yield* Ptb.address(signer.address)) }), { signer })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  "walrus: read via aggregator": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/walrus", "Aggregator")}
    const layer = Aggregator.layer({ url: Aggregator.TESTNET_URL }).pipe(Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Aggregator.blob(process.argv[2]).pipe(Effect.provide(layer))).then(console.log)`,
  "walrus: Bft + Encoding only": `
    ${I("@unconfirmed/walrus", "Bft", "Encoding")}
    console.log(Bft.minCorrect(1000), Encoding.encodedLength(1, 1000))`,
  "walrus: read a blob (nodes)": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/walrus", "Read", "Walrus")}
    import * as SuiGrpc from "@unconfirmed/sui/grpc"
    const layer = Walrus.layer({ network: "testnet" }).pipe(Layer.provide(SuiGrpc.layer({ url: "https://fullnode.testnet.sui.io:443" })), Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Read.blob(process.argv[2]).pipe(Effect.provide(layer))).then(console.log)`,
  "walrus: write a blob (nodes)": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Ed25519")}
    ${I("@unconfirmed/walrus", "Walrus", "Write")}
    import * as SuiGrpc from "@unconfirmed/sui/grpc"
    const layer = Walrus.layer({ network: "testnet" }).pipe(Layer.provideMerge(SuiGrpc.layer({ url: "https://fullnode.testnet.sui.io:443" })), Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Write.run(new Uint8Array(32), { epochs: 1, deletable: true, executor: Write.viaTx(signer) })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  "walrus: write a blob (relay)": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Ed25519")}
    ${I("@unconfirmed/walrus", "UploadRelay", "Walrus", "Write")}
    import * as SuiGrpc from "@unconfirmed/sui/grpc"
    const layer = Layer.mergeAll(Walrus.layer({ network: "testnet" }), UploadRelay.layer({ url: UploadRelay.TESTNET_URL })).pipe(Layer.provideMerge(SuiGrpc.layer({ url: "https://fullnode.testnet.sui.io:443" })), Layer.provide(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      return yield* Write.run(new Uint8Array(32), { epochs: 1, deletable: true, executor: Write.viaTx(signer), via: "relay" })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  "seal: parse an encrypted object": `
    ${I("@unconfirmed/seal", "EncryptedObject")}
    console.log(EncryptedObject.parse(new Uint8Array(process.argv.length)))`,
  "seal: encrypt with pinned keys": `
    ${E("Effect")}
    ${I("@unconfirmed/seal", "Envelope")}
    const objectId = "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75"
    const publicKey = new Uint8Array(96)
    Effect.runPromise(Effect.flatMap(Envelope.randomness(1), (randomness) => Envelope.seal({
      packageId: objectId, id: new Uint8Array([1]), recipients: [{ objectId, publicKey }], threshold: 1,
      input: { _tag: "AesGcm256", data: new Uint8Array(32) }, randomness
    }))).then(console.log)`,
  // Seal needs only Objects and Packages from the chain (SealGrpc.layer); SuiGrpc.layer would add every RPC's codec.
  "seal: encrypt + decrypt": `
    ${E("Effect")}; ${E("Layer")}
    ${I("effect/http", "FetchHttpClient")}
    ${I("@unconfirmed/sui", "Ed25519")}
    ${I("@unconfirmed/seal", "Approval", "Config", "Seal", "SealGrpc")}
    const packageId = "0x58dce5d91278bceb65d44666ffa225ab397fc3ae9d8398c8c779c5530bd978c2"
    const layer = SealGrpc.layer({ servers: [Config.testnet.mysten1, Config.testnet.mysten2, Config.testnet.committee], grpc: { url: "https://fullnode.testnet.sui.io:443" } }).pipe(Layer.provideMerge(FetchHttpClient.layer))
    Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Ed25519.generate
      const id = new Uint8Array(32)
      const { encryptedObject } = yield* Seal.encrypt({ packageId, id, data: new Uint8Array(32), threshold: 2 })
      const session = yield* Seal.session({ packageId, signer })
      const approval = yield* Approval.fromRecipe(Approval.call({ target: packageId + "::account_based::seal_approve", id }))
      return yield* Seal.decrypt({ data: encryptedObject, session, approval })
    }).pipe(Effect.provide(layer))).then(console.log)`,
  "zklogin: Nonce.generate": `
    ${E("Effect")}
    ${I("@unconfirmed/sui-zklogin", "Nonce")}
    Effect.runPromise(Nonce.generate({ flag: 0, bytes: new Uint8Array(32) }, 10, 1n)).then(console.log)`,
  "zklogin: ZkLoginAddress.fromJwt": `
    ${E("Effect")}
    ${I("@unconfirmed/sui-zklogin", "ZkLoginAddress")}
    Effect.runPromise(ZkLoginAddress.fromJwt(process.argv[2], 1n)).then(console.log)`,
  "zklogin: ZkLogin.signer (no Poseidon)": `
    ${E("Effect")}
    ${I("@unconfirmed/sui", "Ed25519")}
    ${I("@unconfirmed/sui-zklogin", "ZkLogin")}
    Effect.runPromise(Effect.flatMap(Ed25519.generate, (ephemeral) => ZkLogin.signer({ ephemeral, inputs: JSON.parse(process.argv[2]), maxEpoch: 10n }))).then(console.log)`,
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
    signer.signAndExecuteTransaction({ transaction: tx, client }).then(console.log)`,
  "mysten: walrus readBlob": `
    import { SuiGrpcClient } from "@mysten/sui/grpc"
    import { walrus } from "@mysten/walrus"
    const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" }).$extend(walrus())
    client.walrus.readBlob({ blobId: process.argv[2] }).then(console.log)`,
  "mysten: walrus writeBlob": `
    import { SuiGrpcClient } from "@mysten/sui/grpc"
    import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
    import { walrus } from "@mysten/walrus"
    const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" }).$extend(walrus())
    client.walrus.writeBlob({ blob: new Uint8Array(32), deletable: true, epochs: 1, signer: Ed25519Keypair.generate() }).then(console.log)`,
  "mysten: seal encrypt + decrypt": `
    import { SealClient, SessionKey } from "@mysten/seal"
    import { SuiGrpcClient } from "@mysten/sui/grpc"
    import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
    import { Transaction } from "@mysten/sui/transactions"
    const packageId = "0x58dce5d91278bceb65d44666ffa225ab397fc3ae9d8398c8c779c5530bd978c2"
    const suiClient = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
    const client = new SealClient({ suiClient, serverConfigs: [
      { objectId: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75", weight: 1 },
      { objectId: "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8", weight: 1 },
      { objectId: "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98", weight: 1, aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com" }
    ] })
    ;(async () => {
      const signer = Ed25519Keypair.generate()
      const { encryptedObject } = await client.encrypt({ threshold: 2, packageId, id: "00".repeat(32), data: new Uint8Array(32) })
      const sessionKey = await SessionKey.create({ address: signer.toSuiAddress(), packageId, ttlMin: 10, signer, suiClient })
      const tx = new Transaction()
      tx.moveCall({ target: packageId + "::account_based::seal_approve", arguments: [tx.pure.vector("u8", new Uint8Array(32))] })
      const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true })
      console.log(await client.decrypt({ data: encryptedObject, sessionKey, txBytes }))
    })()`
}

/** What a Walrus program must or must not ship: the WASM glue and the quorum code (§3). */
const markers = (code: string) =>
  [code.includes("walrus_wasm_bg.wasm") ? "wasm glue" : "", code.includes("QuorumFailed") ? "quorum" : ""].filter(Boolean).join(" + ") || "neither"

/** What a Seal program ships (seal.md §6.5): BLS12-381 (noble's hash-to-curve DST), the quorum code, the HTTP client. */
const sealMarkers = (code: string) =>
  [
    code.includes("BLS12381G1_XMD") ? "bls12-381" : "",
    code.includes("QuorumFailed") ? "quorum" : "",
    code.includes("effect/HttpClient") ? "HttpClient" : ""
  ].filter(Boolean).join(" + ") || "none of bls12-381, quorum, HttpClient"

/** Acceptance (seal.md §6.5): what each Seal program must not contain, under every bundler. */
const sealForbidden: Record<string, ReadonlyArray<string>> = {
  "seal: parse an encrypted object": ["bls12-381", "quorum"],
  "seal: encrypt with pinned keys": ["HttpClient", "quorum"]
}
const violations: Array<string> = []

const bucket = (path: string) => {
  if (/[/\\]effect@|node_modules[/\\]effect[/\\]/.test(path)) return "effect"
  if (/@noble[/\\]curves[/\\](bls12-381|abstract[/\\](bls|tower|hash-to-curve))/.test(path)) return "noble bls12-381"
  if (/@noble[/\\]curves[/\\](abstract[/\\]weierstrass|secp256k1|nist)/.test(path)) return "secp curves"
  if (/@noble|@scure/.test(path)) return "noble/scure"
  if (/walrus-wasm/.test(path)) return "walrus-wasm glue"
  if (/packages[/\\]walrus[/\\]src[/\\]generated/.test(path)) return "walrus generated"
  if (/packages[/\\]walrus/.test(path)) return "walrus"
  if (/packages[/\\]seal/.test(path)) return "seal"
  if (/packages[/\\]quorum/.test(path)) return "quorum"
  if (/packages[/\\]sui-multisig/.test(path)) return "sui-multisig"
  if (/packages[/\\]sui-secp/.test(path)) return "sui-secp*"
  if (/packages[/\\]sui-graphql/.test(path)) return "sui-graphql"
  if (/packages[/\\]sui-lifecycle/.test(path)) return "sui-lifecycle"
  if (/packages[/\\]sui[/\\]src[/\\]grpc/.test(path)) return "sui/grpc"
  if (/packages[/\\]sui[/\\]src/.test(path)) return "sui core"
  if (/packages[/\\]bcs/.test(path)) return "bcs"
  if (/@mysten/.test(path)) return "@mysten"
  return "other"
}

/** Bun's minified output keeps `/*! ... *\/` legal comments between statements; drop them. */
const stripLegal = (code: string) => code.replace(/(?<=^|[;}\n])\/\*![^*]*\*+(?:[^/*][^*]*\*+)*\//g, "")

const kb = (n: number) => (n / 1024).toFixed(1)
const dir = `${import.meta.dir}/.bundle-probe`
const detail = process.argv.includes("--detail")

console.log(`import style: ${style}\n`)
console.log(`${"program".padEnd(44)} ${"bun".padStart(14)} ${"esbuild".padStart(14)} ${"rolldown".padStart(14)}`)
const only = process.argv.indexOf("--only")
const filter = only === -1 ? undefined : process.argv[only + 1]
for (const [name, source] of Object.entries(programs)) {
  if (filter !== undefined && !name.includes(filter)) continue
  const entry = `${dir}/entry.ts`
  await Bun.write(entry, source)

  const bun = await Bun.build({ entrypoints: [entry], minify: true, target: "browser" })
  // Every JS output counts (Bun only splits when asked to, but sum them anyway).
  const bunCode = (await Promise.all(bun.outputs.filter((o) => o.kind === "entry-point" || o.kind === "chunk").map((o) => o.text()))).map(stripLegal).join("\n")

  const es = await esbuild.build({ entryPoints: [entry], bundle: true, minify: true, platform: "browser", format: "esm", write: false, logLevel: "silent", legalComments: "none" })
  const esCode = es.outputFiles.map((f) => f.text).join("\n")

  const rd = await rolldown({ input: entry, platform: "browser", logLevel: "silent" })
  const { output } = await rd.generate({ format: "esm", minify: true, comments: false })
  // Every JS chunk counts: a dynamic import (the WASM glue) is split into its own chunk by Rolldown only.
  const chunks = output.filter((o) => o.type === "chunk")
  const rdCode = chunks.map((c) => c.code).join("\n")

  const cell = (code: string) => `${kb(code.length)}/${kb(gzipSync(code).length)}`.padStart(14)
  const ships = name.startsWith("walrus")
    ? [...new Set([bunCode, esCode, rdCode].map(markers))].join(" | ")
    : name.includes("seal")
    ? [...new Set([bunCode, esCode, rdCode].map(sealMarkers))].join(" | ")
    : ""
  for (const [bundler, code] of [["bun", bunCode], ["esbuild", esCode], ["rolldown", rdCode]] as const) {
    for (const marker of sealForbidden[name] ?? []) {
      if (sealMarkers(code).split(" + ").includes(marker)) violations.push(`${name} (${bundler}) contains ${marker}`)
    }
  }
  console.log(`${name.padEnd(44)} ${cell(bunCode)} ${cell(esCode)} ${cell(rdCode)}  ${ships}`)

  if (detail) {
    const sizes = new Map<string, number>()
    for (const [id, m] of chunks.flatMap((c) => Object.entries(c.modules))) {
      if (id.includes(".bundle-probe")) continue
      sizes.set(bucket(id), (sizes.get(bucket(id)) ?? 0) + m.renderedLength)
    }
    const total = [...sizes.values()].reduce((a, b) => a + b, 0)
    console.log(`${"".padEnd(44)} rolldown, unminified by package: ${[...sizes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((100 * v) / total)}%`).join(", ")}`)
  }
}
await Bun.$`rm -rf ${dir}`
console.log("\nKB minified / KB minified+gzip, JS only (all chunks)")
{
  // Our programs ship @unconfirmed/walrus-wasm's glue; @mysten/walrus ships @mysten/walrus-wasm's.
  const asset = async (path: string) => {
    const file = Bun.file(`${import.meta.dir}/../${path}`)
    return (await file.exists()) ? `${kb(file.size)} KB / ${kb(gzipSync(await file.bytes()).length)} KB gzip` : "missing"
  }
  console.log(
    `Walrus programs that encode, decode or verify also load one WASM asset, not counted above: ` +
      `${await asset("packages/walrus-wasm/web/walrus_wasm_bg.wasm")} (SIMD build), or ` +
      `${await asset("packages/walrus-wasm/web/walrus_wasm_nosimd_bg.wasm")} (scalar fallback, engines without WebAssembly SIMD); ` +
      `@mysten/walrus-wasm: ${await asset("node_modules/@mysten/walrus-wasm/web/walrus_wasm_bg.wasm")}`
  )
}
if (violations.length > 0) {
  console.error(`\nSeal containment checks failed:\n${violations.map((v) => `  ${v}`).join("\n")}`)
  process.exitCode = 1
} else {
  console.log("Seal containment checks (seal.md §6.5): passed under all three bundlers")
}
