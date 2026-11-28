/**
 * The upload relay (§1.6, §4.8): tip arithmetic and config decoding, request
 * parity with `@mysten/walrus`'s `UploadRelayClient`, the auth input as input
 * 0 (72 bytes) of the resolved register transaction, `verifyCertificate`
 * rejections, and `Write.run` with `via: "relay"` against a fake relay that
 * checks the auth input and the tip the way the real one does (R3) and signs
 * with `@noble/curves` keys, over a fake chain that applies `certify_blob`'s
 * checks (M4, T2).
 */
import { bls12_381 } from "@noble/curves/bls12-381.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { WalrusClient } from "@mysten/walrus"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Base64Url from "effect/encoding/Base64Url"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Objects from "@unconfirmed/effect-sui/Objects"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import * as Resolve from "@unconfirmed/effect-sui/Resolve"
import * as Testing from "@unconfirmed/effect-sui/Testing"
import * as TransactionData from "@unconfirmed/effect-sui/TransactionData"
import type * as T from "@unconfirmed/effect-sui/TransactionData"
import type * as Transactions from "@unconfirmed/effect-sui/Transactions"
import * as TypeTag from "@unconfirmed/effect-sui/TypeTag"
import * as BlobId from "../src/BlobId.ts"
import type * as Certificate from "../src/Certificate.ts"
import * as Committee from "../src/Committee.ts"
import * as Encoder from "../src/Encoder.ts"
import * as blob from "../src/generated/walrus/blob.ts"
import * as Messages from "../src/Messages.ts"
import * as Recipes from "../src/Recipes.ts"
import * as StorageNode from "../src/StorageNode.ts"
import * as System from "../src/System.ts"
import * as UploadRelay from "../src/UploadRelay.ts"
import * as Write from "../src/Write.ts"
import { mystenUtils } from "./oracle.ts"
import { type Outcome, type Recorded, scripted } from "./support.ts"

const relayClientModule = "../../../node_modules/@mysten/walrus/dist/upload-relay/client.mjs"
const { UploadRelayClient } = (await import(relayClientModule)) as {
  UploadRelayClient: new(o: { host: string; fetch: (url: string, init?: RequestInit) => Promise<Response> }) => {
    tipConfig: () => Promise<unknown>
    writeBlob: (o: Record<string, unknown>) => Promise<{ blobId: string; certificate: { signers: number[]; serializedMessage: Uint8Array; signature: Uint8Array } }>
  }
}

const N = 10
const HOST = "https://relay.test"
const TIP_ADDRESS = Address.normalize("0x4b6a7439159cf10533147fc3d678cf10b714f2bc998f6cb1f1b0b9594cdc52b6")
const TYPE_ORIGIN = Address.normalize("0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66")
const BLOB_TYPE = `${TYPE_ORIGIN}::blob::Blob`
const WAL_TYPE = `${TYPE_ORIGIN}::wal::WAL`
const OWNER = Address.normalize("0xa11ce")
const sigs = bls12_381.longSignatures
const keys = Array.from({ length: 6 }, (_, i) => sigs.keygen(new Uint8Array(48).fill(i + 1)))
const sign = (i: number, message: Uint8Array) => sigs.sign(sigs.hash(message), keys[i]!.secretKey)
const aggregate = (signers: ReadonlyArray<number>, message: Uint8Array) =>
  sigs.Signature.toBytes(sigs.aggregateSignatures(signers.map((i) => sign(i, message))))

/** f = 3, n − f = 7: nodes 0 and 1 (4 + 3 shards) are exactly enough; any one light node short of them is not. */
const SHARDS = [[0, 1, 2, 3], [4, 5, 6], [7], [8], [9]]
const BLOB = Uint8Array.from({ length: 1000 }, (_, i) => (i * 31 + 7) & 0xff)
const NONCE = new Uint8Array(32).fill(9)
const CONST_TIP = { send_tip: { address: TIP_ADDRESS, kind: { const: 105 } } }

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected success, got ${String(exit.cause)}`)
}
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isFailure(exit)) {
    const e = exit.cause.reasons.find((r) => r._tag === "Fail")
    if (e && e._tag === "Fail") return e.error
  }
  throw new Error(`expected a typed failure, got ${Exit.isSuccess(exit) ? "success" : String(exit.cause)}`)
}

const relayLayer = (route: (req: Recorded) => Outcome, options: Partial<UploadRelay.UploadRelayOptions> = {}) => {
  const http = scripted(route)
  return { layer: UploadRelay.layer({ url: HOST, maxTip: 1_000_000n, ...options }).pipe(Layer.provide(http.layer)), requests: http.requests }
}
const withRelay = <A, E>(layer: Layer.Layer<UploadRelay.UploadRelay>, f: (r: UploadRelay.UploadRelayService) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.exit(Effect.provide(Effect.flatMap(Effect.service(UploadRelay.UploadRelay), f), layer)))

// -----------------------------------------------------------------------------
// Tip
// -----------------------------------------------------------------------------

describe("tip", () => {
  test("tipAmount: no tip, a constant, and linear in encoded KiB (R1), as @mysten/walrus computes it", () => {
    expect(UploadRelay.tipAmount({ _tag: "NoTip" }, 1000, 1000)).toBe(0n)
    expect(UploadRelay.tipAmount({ _tag: "SendTip", address: TIP_ADDRESS, kind: { _tag: "Const", amount: 105n } }, 1000, 1000)).toBe(105n)
    for (const [len, n] of [[0, 10], [1000, 1000], [5_000_000, 1000], [777, 7]] as const) {
      const linear: UploadRelay.TipConfig = { _tag: "SendTip", address: TIP_ADDRESS, kind: { _tag: "Linear", base: 1000n, perEncodedKib: 3n } }
      const mysten = 1000n + 3n * ((BigInt(mystenUtils.encodedBlobLength(len, n)) + 1023n) / 1024n)
      expect(UploadRelay.tipAmount(linear, len, n)).toBe(mysten)
    }
    // 32 bytes at n = 1000: 66,034,000 encoded bytes (E4) = 64,486 KiB.
    expect(UploadRelay.tipAmount({ _tag: "SendTip", address: TIP_ADDRESS, kind: { _tag: "Linear", base: 0n, perEncodedKib: 1n } }, 32, 1000))
      .toBe(64_487n)
  })

  test("parseTipConfig: every shape, numbers as JSON numbers or strings; rejects garbage", () => {
    expect(Result.getOrThrow(UploadRelay.parseTipConfig("no_tip"))).toEqual({ _tag: "NoTip" })
    expect(Result.getOrThrow(UploadRelay.parseTipConfig(CONST_TIP))).toEqual({
      _tag: "SendTip",
      address: TIP_ADDRESS,
      kind: { _tag: "Const", amount: 105n }
    })
    expect(Result.getOrThrow(UploadRelay.parseTipConfig({
      send_tip: { address: "0x2", kind: { linear: { base: "18446744073709551615", encoded_size_mul_per_kib: 2 } } }
    }))).toEqual({ _tag: "SendTip", address: Address.normalize("0x2"), kind: { _tag: "Linear", base: (1n << 64n) - 1n, perEncodedKib: 2n } })
    for (
      const bad of [
        "tip",
        { send_tip: { address: "0x2", kind: { const: -1 } } },
        { send_tip: { address: "0x2", kind: { const: 1.5 } } },
        { send_tip: { address: "0x2", kind: { const: "18446744073709551616" } } },
        { send_tip: { address: "nope", kind: { const: 1 } } },
        { send_tip: { address: "0x2", kind: { quadratic: 1 } } },
        null
      ]
    ) expect(Result.isFailure(UploadRelay.parseTipConfig(bad))).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// HTTP: parity with UploadRelayClient
// -----------------------------------------------------------------------------

const BLOB_ID = Result.getOrThrow(BlobId.fromBytes(new Uint8Array(32).fill(3)))
const MESSAGE = Messages.confirmationMessage(7, BLOB_ID, { _tag: "Permanent" })
const SIGNATURE = new Uint8Array(96).map((_, i) => i)
/** As the testnet relay answers: `blob_id` is serde's `[u8; 32]`, the signature URL-safe base64. */
const RESPONSE = {
  blob_id: [...BlobId.toBytes(BLOB_ID)],
  confirmation_certificate: { signers: [4, 0, 2], serialized_message: [...MESSAGE], signature: Base64Url.encode(SIGNATURE) }
}

/** What `UploadRelayClient` sends, through a capturing `fetch`. */
const mystenRequest = async (o: Record<string, unknown>) => {
  const seen: Array<{ url: string; method: string; body: Uint8Array | undefined }> = []
  const client = new UploadRelayClient({
    host: HOST,
    fetch: async (url, init) => {
      seen.push({ url, method: init?.method ?? "GET", body: init?.body as Uint8Array | undefined })
      return new Response(JSON.stringify(url.includes("tip-config") ? CONST_TIP : RESPONSE), { status: 200 })
    }
  })
  const result = o.tipConfig ? await client.tipConfig() : await client.writeBlob(o)
  return { request: seen[0]!, result }
}

describe("http", () => {
  const cases = [
    {
      name: "deletable, with a tip",
      ours: { blobId: BLOB_ID, nonce: NONCE, txDigest: "EmcFpdozbobqH61w76T4UehhC4UGaAv32uZpv6c4CNyg", deletableBlobObject: Address.normalize("0xb10b") },
      mysten: {
        blobId: BLOB_ID,
        nonce: NONCE,
        txDigest: "EmcFpdozbobqH61w76T4UehhC4UGaAv32uZpv6c4CNyg",
        deletable: true,
        blobObjectId: Address.normalize("0xb10b"),
        requiresTip: true,
        encodingType: "RS2"
      }
    },
    {
      name: "permanent, no tip",
      ours: { blobId: BLOB_ID },
      mysten: { blobId: BLOB_ID, deletable: false, requiresTip: false, encodingType: "RS2" }
    }
  ]
  for (const c of cases) {
    test(`upload request equals UploadRelayClient.writeBlob's: ${c.name}`, async () => {
      const { request, result } = await mystenRequest({ ...c.mysten, blob: BLOB })
      const relay = relayLayer(() => ({ body: RESPONSE }))
      const certificate = value(await withRelay(relay.layer, (r) => r.upload({ ...c.ours, blob: BLOB })))
      const ours = relay.requests[0]!
      expect(ours.method).toBe(request.method)
      expect(ours.url).toBe(request.url)
      expect(ours.body).toEqual(request.body)
      // The only header difference: we label the body (axum's `Bytes` extractor ignores it).
      expect(ours.headers["content-type"]).toBe("application/octet-stream")
      const r = result as Awaited<ReturnType<InstanceType<typeof UploadRelayClient>["writeBlob"]>>
      expect(certificate.signers).toEqual([...r.certificate.signers].sort((a, b) => a - b))
      expect(certificate.serializedMessage).toEqual(r.certificate.serializedMessage)
      expect(certificate.signature).toEqual(r.certificate.signature)
      expect(certificate.epoch).toBe(7)
    })
  }

  test("tipConfig: the same request and value as UploadRelayClient.tipConfig, fetched once", async () => {
    const { request, result } = await mystenRequest({ tipConfig: true })
    const relay = relayLayer(() => ({ body: CONST_TIP }))
    const config = value(await withRelay(relay.layer, (r) => Effect.andThen(r.tipConfig, r.tipConfig)))
    expect(relay.requests.length).toBe(1)
    expect(relay.requests[0]!.url).toBe(request.url)
    expect(relay.requests[0]!.method).toBe(request.method)
    expect(result).toEqual({ address: TIP_ADDRESS, kind: { const: 105 } })
    expect(config).toEqual({ _tag: "SendTip", address: TIP_ADDRESS, kind: { _tag: "Const", amount: 105n } })
  })

  test("a failed tipConfig is not cached", async () => {
    let calls = 0
    const relay = relayLayer(() => (++calls === 1 ? { status: 503, body: "busy" } : { body: JSON.stringify("no_tip") }))
    const first = await withRelay(relay.layer, (r) => Effect.zip(Effect.exit(r.tipConfig), r.tipConfig))
    expect(Exit.isFailure(value(first)[0])).toBe(true)
    expect(value(first)[1]).toEqual({ _tag: "NoTip" })
  })

  test("errors are typed RelayErrors: HTTP status, transport, timeout, bad bodies; blob_id may also come as text", async () => {
    value(await withRelay(relayLayer(() => ({ body: { ...RESPONSE, blob_id: BLOB_ID } })).layer, (r) => r.upload({ blob: BLOB, blobId: BLOB_ID })))
    const upload = (route: (req: Recorded) => Outcome, options?: Partial<UploadRelay.UploadRelayOptions>) =>
      withRelay(relayLayer(route, options).layer, (r) => r.upload({ blob: BLOB, blobId: BLOB_ID })).then(failure)
    const e402 = await upload(() => ({ status: 402, body: "insufficient tip" }))
    expect(e402._tag).toBe("RelayError")
    expect(e402.status).toBe(402)
    expect(e402.message).toContain("insufficient tip")
    const net = await upload(() => "network-error")
    expect(net._tag === "RelayError" && net.status).toBe(undefined)
    const slow = await upload(() => "hang", { requestTimeout: "20 millis" })
    expect(slow.message).toContain("no answer within")
    for (
      const body of [
        "not json",
        { ...RESPONSE, blob_id: Result.getOrThrow(BlobId.fromBytes(new Uint8Array(32).fill(4))) },
        { ...RESPONSE, blob_id: [...new Uint8Array(32).fill(4)] },
        { ...RESPONSE, blob_id: [1, 2, 3] },
        { ...RESPONSE, confirmation_certificate: { ...RESPONSE.confirmation_certificate, signature: "***" } },
        { ...RESPONSE, confirmation_certificate: { ...RESPONSE.confirmation_certificate, serialized_message: [1, 0, 3, 300] } },
        { ...RESPONSE, confirmation_certificate: { ...RESPONSE.confirmation_certificate, serialized_message: [9, 9, 9, 9, 9, 9, 9, 9] } },
        { ...RESPONSE, confirmation_certificate: { ...RESPONSE.confirmation_certificate, signers: [1, 1] } }
      ]
    ) {
      const e = await upload(() => ({ body }))
      expect(e._tag).toBe("RelayError")
      expect(e.status).toBe(200)
    }
  })
})

// -----------------------------------------------------------------------------
// Auth input and tip in the transaction
// -----------------------------------------------------------------------------

const STATE: System.SystemState = {
  systemObjectId: Address.normalize("0x5a5"),
  initialSharedVersion: 1n,
  epoch: 5,
  nShards: N,
  packageId: Address.normalize("0xfeed"),
  typeOrigin: TYPE_ORIGIN,
  storagePrice: 10n,
  writePrice: 20n,
  members: SHARDS.map((shards, i) => ({ nodeId: Address.normalize(`0x${(i + 1).toString(16)}`), weight: shards.length, publicKey: keys[i]!.publicKey.toBytes(false) }))
}
const systemLayer = (state: () => System.SystemState = () => STATE) =>
  Layer.succeed(System.System, System.System.of({ state: Effect.sync(state), refresh: Effect.sync(state), walType: Effect.succeed(WAL_TYPE) }))

/** `@mysten/walrus`'s auth payload for the same blob and nonce (`client.mjs`, `addAuthPayload`). */
const mystenAuthPayload = async (bytes: Uint8Array, nonce: Uint8Array) => {
  let captured: Uint8Array | undefined
  const add = (WalrusClient.prototype as any).addAuthPayload.call(undefined, { size: bytes.length, blobDigest: sha256(bytes), nonce })
  await add({ pure: (b: Uint8Array) => (captured = b) })
  return captured!
}

const D = "11111111111111111111111111111111" as T.ObjectDigest
/** The intents' owner holds SUI and WAL in its address balance; there are no objects. */
const chainLayer = Testing.layer({
  addressBalances: [{ owner: OWNER, amount: 10n ** 12n }, { owner: OWNER, amount: 10n ** 12n, coinType: WAL_TYPE }]
})

describe("authAndTip", () => {
  const registerRecipe = Effect.gen(function*() {
    yield* UploadRelay.authAndTip({ blob: BLOB, nonce: NONCE })
    const b = yield* Recipes.registerBlob({ blobId: BLOB_ID, rootHash: new Uint8Array(32), unencodedLength: BLOB.length, epochs: 1, deletable: true })
    yield* Ptb.transferObjects([b], yield* Ptb.address(OWNER))
  })

  test("the auth input is input 0 of the resolved register transaction: 72 bytes, equal to @mysten/walrus's payload; the tip goes to the tip address", async () => {
    const relay = relayLayer(() => ({ body: CONST_TIP }))
    const data = value(
      await Effect.runPromise(Effect.exit(
        Effect.gen(function*() {
          const { draft } = yield* Ptb.build(registerRecipe)
          const plan = yield* Resolve.balances({ sender: OWNER, draft })
          return yield* Resolve.finish({ ...plan, gasPrice: 1000n, gasBudget: 10_000_000n, gasPayment: [{ objectId: Address.normalize("0x6a5"), version: 1n, digest: D }] })
        }).pipe(Effect.provide(Layer.mergeAll(relay.layer, systemLayer(), chainLayer)))
      ))
    )
    // Through the wire form, as the relay reads it (`SenderSignedData` → `ptb.inputs.first()`).
    const decoded = Result.getOrThrow(TransactionData.decode(TransactionData.encode(data)))
    const kind = decoded.kind
    expect(kind._tag).toBe("ProgrammableTransaction")
    if (kind._tag !== "ProgrammableTransaction") return
    const { inputs, commands } = kind
    const first = inputs[0]!
    expect(first._tag).toBe("Pure")
    const bytes = (first as Extract<T.CallArg, { _tag: "Pure" }>).bytes
    expect(bytes.length).toBe(72)
    expect(bytes).toEqual(await mystenAuthPayload(BLOB, NONCE))
    expect(bytes).toEqual(Bcs.encodeSync(UploadRelay.AuthPackage)(UploadRelay.authPackage(BLOB, NONCE)))
    // The tip: a 105-MIST piece of a SUI coin redeemed from the address balance, transferred to the tip address.
    const tipTransfer = commands.find((c) =>
      c._tag === "TransferObjects" && c.address._tag === "Input" &&
      (inputs[c.address.value] as any).bytes?.length === 32 && Address.fromBytes((inputs[c.address.value] as any).bytes) === TIP_ADDRESS
    )
    expect(tipTransfer).toBeDefined()
    const amounts = inputs.filter((i): i is Extract<T.CallArg, { _tag: "Pure" }> => i._tag === "Pure" && i.bytes.length === 8)
      .map((i) => Bcs.decodeSync(Bcs.u64)(i.bytes))
    expect(amounts).toContain(105n)
    expect(inputs.some((i) => i._tag === "FundsWithdrawal")).toBe(true)
  })

  test("no tip: nothing is added; a tip above maxTip is TipTooHigh", async () => {
    const none = relayLayer(() => ({ body: JSON.stringify("no_tip") }))
    const built = value(
      await Effect.runPromise(Effect.exit(
        Ptb.build(UploadRelay.authAndTip({ blob: BLOB, nonce: NONCE })).pipe(Effect.provide(Layer.merge(none.layer, systemLayer())))
      ))
    )
    expect(built.draft.inputs.length).toBe(0)
    expect(built.draft.commands.length).toBe(0)
    const capped = relayLayer(() => ({ body: CONST_TIP }), { maxTip: 104n })
    const e = failure(
      await Effect.runPromise(Effect.exit(
        Ptb.build(UploadRelay.authAndTip({ blob: BLOB, nonce: NONCE })).pipe(Effect.provide(Layer.merge(capped.layer, systemLayer())))
      ))
    )
    expect(e).toMatchObject({ _tag: "TipTooHigh", tip: 105n, max: 104n })
  })

  const authWith = async (layer: Layer.Layer<UploadRelay.UploadRelay>) =>
    Effect.runPromise(Effect.exit(
      Ptb.build(UploadRelay.authAndTip({ blob: BLOB, nonce: NONCE })).pipe(Effect.provide(Layer.merge(layer, systemLayer())))
    ))

  test("an untyped caller without maxTip pays no tip at all (TipTooHigh, max 0)", async () => {
    const unbounded = scripted(() => ({ body: CONST_TIP }))
    const layer = UploadRelay.layer({ url: HOST } as UploadRelay.UploadRelayOptions).pipe(Layer.provide(unbounded.layer))
    expect(failure(await authWith(layer))).toMatchObject({ _tag: "TipTooHigh", tip: 105n, max: 0n })
    // maxTip 0n still works with a relay that wants no tip.
    const free = relayLayer(() => ({ body: JSON.stringify("no_tip") }), { maxTip: 0n })
    value(await authWith(free.layer))
  })

  test("tipAddress pins the recipient: another address in the tip config is a RelayError", async () => {
    const other = relayLayer(() => ({ body: CONST_TIP }), { tipAddress: "0xbad" })
    const e = failure(await authWith(other.layer))
    expect(e).toMatchObject({ _tag: "RelayError" })
    expect(String((e as { message: string }).message)).toContain("differs")
    const same = relayLayer(() => ({ body: CONST_TIP }), { tipAddress: TIP_ADDRESS.replace(/^0x0+/, "0x") })
    value(await authWith(same.layer))
  })
})

// -----------------------------------------------------------------------------
// verifyCertificate
// -----------------------------------------------------------------------------

const committeeAt = (epoch: number): Committee.Committee => {
  const nodes = SHARDS.map((shards, i): Committee.StorageNode => ({
    index: i,
    nodeId: STATE.members[i]!.nodeId,
    name: `node-${i}`,
    url: `https://node-${i}.test`,
    publicKey: keys[i]!.publicKey.toBytes(false),
    shards
  }))
  return { epoch, nShards: N, nodes, nodeOfShard: (s) => nodes.find((n) => n.shards.includes(s))! }
}

describe("verifyCertificate", () => {
  const committee = committeeAt(7)
  const cert = (signers: ReadonlyArray<number>, o: { message?: Uint8Array; signature?: Uint8Array } = {}): Certificate.Certificate => ({
    epoch: 7,
    signers,
    serializedMessage: o.message ?? MESSAGE,
    signature: o.signature ?? aggregate(signers, o.message ?? MESSAGE)
  })
  const verify = (c: Certificate.Certificate, expected = MESSAGE, com = committee) =>
    Effect.runPromise(Effect.exit(Effect.provide(UploadRelay.verifyCertificate(c, expected, com), Encoder.layer())))
  const reason = async (c: Certificate.Certificate, expected?: Uint8Array) => {
    const e = failure(await verify(c, expected))
    if (e._tag !== "CertificateInvalid") throw new Error(`expected CertificateInvalid, got ${e._tag}`)
    return e.reason
  }

  test("accepts exactly n − f shards from two heavy nodes, and every signer", async () => {
    value(await verify(cert([0, 1])))
    value(await verify(cert([0, 1, 2, 3, 4])))
    // 48-byte compressed keys work too (M5).
    const compressed = { ...committee, nodes: committee.nodes.map((n, i) => ({ ...n, publicKey: keys[i]!.publicKey.toBytes(true) })) }
    value(await verify(cert([0, 1]), MESSAGE, compressed))
  })

  test("rejects too little weight, duplicate or unknown signers, another message, and signatures that do not verify", async () => {
    // Four of five nodes holding six shards (item 5).
    expect(await reason(cert([1, 2, 3, 4]))).toContain("hold 6 shards, need 7")
    expect(await reason(cert([0, 0, 1]))).toContain("duplicate signer 0")
    expect(await reason({ ...cert([0, 1]), signers: [0, 1, 5] })).toContain("signer 5 is not a committee member")
    const others = [
      Messages.confirmationMessage(6, BLOB_ID, { _tag: "Permanent" }),
      Messages.confirmationMessage(7, Result.getOrThrow(BlobId.fromBytes(new Uint8Array(32).fill(4))), { _tag: "Permanent" }),
      Messages.confirmationMessage(7, BLOB_ID, { _tag: "Deletable", objectId: Address.normalize("0xb10b") })
    ]
    for (const m of others) expect(await reason(cert([0, 1], { message: m }))).toContain("message differs")
    // A signer left out of the aggregate, another message, garbage, wrong length.
    expect(await reason({ ...cert([0, 1]), signers: [0, 1, 2] })).toContain("does not verify")
    expect(await reason(cert([0, 1], { signature: aggregate([0, 1], new Uint8Array([1, 2, 3])) }))).toContain("does not verify")
    expect(await reason(cert([0, 1], { signature: new Uint8Array(96).fill(0xff) }))).toMatch(/malformed signature|does not verify/)
    expect(await reason(cert([0, 1], { signature: new Uint8Array(48) }))).toContain("48 bytes")
  })
})

// -----------------------------------------------------------------------------
// Write via the relay
// -----------------------------------------------------------------------------

class Aborted extends Schema.TaggedError<Aborted>()("Aborted", { reason: Schema.String }) {}

type OnChainBlob = blob.Blob
const encodeBlob = Bcs.encodeSync(blob.Blob)

interface RelayWorldOptions {
  /** The relay's `/v1/tip-config` answer. Default: a constant 105 MIST. */
  readonly tipConfig?: unknown
  /** Tamper with the certificate the relay returns. */
  readonly tamper?: (c: { signers: number[]; serialized_message: number[]; signature: string }) => void
  readonly maxTip?: bigint
}

const relayWorld = (options: RelayWorldOptions = {}) => {
  let epoch = 5
  const state = (): System.SystemState => ({ ...STATE, epoch })
  const committee = () => committeeAt(epoch)
  const chain = new Map<string, { owner: Address.Address; blob: OnChainBlob }>()
  const executed: Array<string> = []
  const transactions = new Map<string, Ptb.Draft>()
  let nextId = 0x1000

  const suiObject = (id: string): Objects.SuiObject => {
    const entry = chain.get(id)!
    return {
      objectId: id as Address.Address,
      version: 1n,
      digest: "" as T.ObjectDigest,
      owner: { _tag: "AddressOwner", address: entry.owner },
      type: BLOB_TYPE,
      contents: encodeBlob(entry.blob),
      previousTransaction: undefined
    }
  }
  const objects = Layer.succeed(Objects.Objects, {
    get: (id) => Effect.suspend(() => chain.has(id) ? Effect.succeed(suiObject(id)) : Effect.fail(new Objects.ObjectNotFound({ objectId: id }))),
    listOwned: (owner) => Stream.suspend(() => Stream.fromIterable([...chain.entries()].filter(([, e]) => e.owner === owner).map(([id]) => suiObject(id))))
  })

  const pureAt = (draft: Ptb.Draft, a: T.Argument | undefined) => {
    if (a?._tag !== "Input") throw new Error("not an input")
    const input = draft.inputs[a.value]!
    if (input._tag !== "Pure") throw new Error("not pure")
    return input.bytes
  }
  const commandOf = (a: T.Argument) => (a._tag === "Result" ? a.value : a._tag === "NestedResult" ? a.value[0] : -1)

  const apply = (draft: Ptb.Draft): Array<Transactions.ChangedObject> | Aborted => {
    const index = (fn: string) => draft.commands.findIndex((c) => c._tag === "MoveCall" && c.function === fn)
    const call = (i: number) => draft.commands[i] as Extract<T.Command, { _tag: "MoveCall" }>
    const created: Array<Transactions.ChangedObject> = []
    const r = index("register_blob")
    if (r >= 0) {
      const register = call(r)
      const epochs = Bcs.decodeSync(Bcs.u32)(pureAt(draft, call(index("reserve_space")).arguments[2]))
      const transfer = draft.commands.find((c): c is Extract<T.Command, { _tag: "TransferObjects" }> =>
        c._tag === "TransferObjects" && c.objects.some((o) => commandOf(o) === r)
      )!
      const id = Address.normalize(`0x${(nextId++).toString(16)}`)
      chain.set(id, {
        owner: Bcs.decodeSync(Bcs.Address)(pureAt(draft, transfer.address)),
        blob: {
          id,
          registered_epoch: epoch,
          blob_id: Bcs.decodeSync(Bcs.u256)(pureAt(draft, register.arguments[2])),
          size: Bcs.decodeSync(Bcs.u64)(pureAt(draft, register.arguments[4])),
          encoding_type: 1,
          certified_epoch: Option.none(),
          storage: { id: Address.normalize(`0x${(nextId++).toString(16)}`), start_epoch: epoch, end_epoch: epoch + epochs, storage_size: 1n },
          deletable: Bcs.decodeSync(Bcs.bool)(pureAt(draft, register.arguments[6]))
        }
      })
      created.push({
        objectId: id,
        type: BLOB_TYPE,
        operation: "Created",
        version: 1n,
        digest: undefined,
        owner: undefined,
        inputVersion: undefined,
        inputDigest: undefined,
        inputOwner: undefined
      })
    }
    const c = index("certify_blob")
    if (c >= 0) {
      const certify = call(c)
      const a = certify.arguments[1]!
      const id = Address.normalize((draft.inputs[(a as { value: number }).value] as unknown as { objectId: string }).objectId)
      const entry = chain.get(id)
      if (!entry) return new Aborted({ reason: "no such blob" })
      const signature = Bcs.decodeSync(Bcs.byteVector)(pureAt(draft, certify.arguments[2]))
      const bitmap = Bcs.decodeSync(Bcs.byteVector)(pureAt(draft, certify.arguments[3]))
      const message = Bcs.decodeSync(Bcs.byteVector)(pureAt(draft, certify.arguments[4]))
      if (Option.isSome(entry.blob.certified_epoch)) return new Aborted({ reason: "already certified" })
      if (new DataView(message.buffer, message.byteOffset + 3, 4).getUint32(0, true) !== epoch) return new Aborted({ reason: "wrong epoch" })
      const signers = committee().nodes.filter((n) => (bitmap[n.index >> 3]! >> (n.index & 7)) & 1)
      const weight = signers.reduce((w, n) => w + n.shards.length, 0)
      if (3 * weight < 2 * N + 1) return new Aborted({ reason: `weight ${weight} below quorum` })
      const key = sigs.aggregatePublicKeys(signers.map((n) => n.publicKey))
      if (!sigs.verify(sigs.Signature.fromBytes(signature), sigs.hash(message), key)) return new Aborted({ reason: "bad signature" })
      chain.set(id, { ...entry, blob: { ...entry.blob, certified_epoch: Option.some(epoch) } })
    }
    return created
  }

  const executor: Write.Executor<Aborted, never> = {
    sender: OWNER,
    execute: (recipe) =>
      Effect.gen(function*() {
        const { draft } = yield* Ptb.build(recipe)
        const names = draft.commands.flatMap((c) => c._tag === "MoveCall" ? [c.function] : [])
        executed.push(names.includes("register_blob") ? "register" : names.includes("certify_blob") ? "certify" : names.length === 0 ? "auth" : names.join(","))
        const result = apply(draft)
        if (result instanceof Aborted) return yield* result
        const digest = `tx${executed.length}`
        transactions.set(digest, draft)
        const effects: Transactions.Effects = {
          digest,
          status: { _tag: "Success" },
          gasUsed: { computationCost: 0n, storageCost: 0n, storageRebate: 0n, nonRefundableStorageFee: 0n },
          changedObjects: result
        }
        return effects
      })
  }

  /** The relay's own checks (R3): input 0 is the hashed auth package of this blob and nonce; the tip reaches the tip address. */
  const checkAuth = (req: Recorded, query: URLSearchParams, body: Uint8Array): string | undefined => {
    const draft = transactions.get(query.get("tx_id") ?? "")
    if (!draft) return "unknown transaction"
    const first = draft.inputs[0]
    if (first?._tag !== "Pure") return "missing auth package"
    const nonce = Result.getOrThrow(Base64Url.decode(query.get("nonce") ?? ""))
    if (Buffer.compare(first.bytes, Bcs.encodeSync(UploadRelay.AuthPackage)(UploadRelay.authPackage(body, nonce))) !== 0) return "auth mismatch"
    const tip = draft.commands.find((c): c is Extract<T.Command, { _tag: "TransferObjects" }> =>
      c._tag === "TransferObjects" && Address.fromBytes(pureAt(draft, c.address)) === TIP_ADDRESS
    )
    const coin = tip && draft.commands[commandOf(tip.objects[0]!)]
    if (coin?._tag !== "BalanceIntent" || coin.coinType !== TypeTag.normalizeString(TypeTag.SUI) || coin.amount < 105n) return "no tip"
    void req
    return undefined
  }

  const tipConfig = options.tipConfig ?? CONST_TIP
  const relayRequests: Array<Recorded> = []
  const relay = relayLayer((req) => {
    if (req.path === "/v1/tip-config") return { body: JSON.stringify(tipConfig) }
    relayRequests.push(req)
    const query = new URL(req.url).searchParams
    const body = req.body!
    if (tipConfig !== "no_tip") {
      const problem = checkAuth(req, query, body)
      if (problem) return { status: 401, body: problem }
    }
    const blobId = query.get("blob_id")! as BlobId.BlobId
    const object = query.get("deletable_blob_object")
    const message = Messages.confirmationMessage(epoch, blobId, object ? { _tag: "Deletable", objectId: Address.normalize(object) } : { _tag: "Permanent" })
    const signers = [0, 1, 2, 3, 4]
    const c = { signers, serialized_message: [...message], signature: Base64Url.encode(aggregate(signers, message)) }
    options.tamper?.(c)
    return { body: { blob_id: [...BlobId.toBytes(blobId)], confirmation_certificate: c } }
  }, options.maxTip !== undefined ? { maxTip: options.maxTip } : {})

  // Storage nodes must not be touched on the relay path.
  const nodeRequests = scripted(() => ({ status: 500 }))
  const layer = Layer.mergeAll(
    systemLayer(state),
    Layer.succeed(Committee.Committees, {
      get: Effect.sync(() => ({ current: committee(), previous: undefined, transitioning: false })),
      refresh: Effect.sync(() => ({ current: committee(), previous: undefined, transitioning: false }))
    }),
    StorageNode.layer().pipe(Layer.provide(nodeRequests.layer)),
    objects,
    Encoder.layer(),
    relay.layer
  )
  return {
    chain,
    executed,
    executor,
    transactions,
    relayRequests,
    nodeRequests: nodeRequests.requests,
    setEpoch: (e: number) => (epoch = e),
    run: <A, E>(effect: Effect.Effect<A, E, Write.WriteServices | UploadRelay.UploadRelay>) =>
      Effect.runPromise(Effect.exit(Effect.provide(effect, layer)))
  }
}

const relayOpts = (world: ReturnType<typeof relayWorld>, extra: Partial<Write.WriteOptions<Aborted, never, never, never, "relay">> = {}) => ({
  epochs: 2,
  deletable: true,
  executor: world.executor,
  via: "relay" as const,
  ...extra
})

describe("Write via relay", () => {
  test("a full write: auth input first in the register transaction, tip paid, certificate verified and certified; no node traffic", async () => {
    const world = relayWorld()
    const steps: Array<Write.Step> = []
    const certified = value(await world.run(Write.run(BLOB, relayOpts(world, { onStep: (s) => Effect.sync(() => steps.push(s)) }))))
    expect(steps.map((s) => s._tag)).toEqual(["Encoded", "Registered", "Uploaded", "Certified"])
    expect(world.executed).toEqual(["register", "certify"])
    const encoded = steps[0] as Write.Encoded
    expect(encoded.relayNonce?.length).toBe(32)
    expect(encoded.blobId).toBe(BlobId.derive(1, 1000n, encoded.rootHash))
    const registered = steps[1] as Write.Registered
    const draft = world.transactions.get(registered.digest!)!
    expect(draft.inputs[0]).toEqual({ _tag: "Pure", bytes: Bcs.encodeSync(UploadRelay.AuthPackage)(UploadRelay.authPackage(BLOB, encoded.relayNonce!)) })
    const query = new URL(world.relayRequests[0]!.url).searchParams
    expect(query.get("tx_id")).toBe(registered.digest!)
    expect(query.get("nonce")).toBe(Base64Url.encode(encoded.relayNonce!))
    expect(query.get("deletable_blob_object")).toBe(registered.blobObjectId)
    expect(world.relayRequests[0]!.body).toEqual(BLOB)
    expect(world.nodeRequests.length).toBe(0)
    expect(Option.getOrUndefined(world.chain.get(certified.blobObjectId)!.blob.certified_epoch)).toBe(5)
    // The saved steps round-trip through JSON, nonce included.
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(Write.Step)(encoded)))
    expect(Schema.decodeUnknownSync(Write.Step)(json)).toEqual(encoded)
  })

  test("a relay certificate that does not verify is CertificateInvalid and nothing is certified", async () => {
    const world = relayWorld({ tamper: (c) => void (c.signers = [0, 1, 2, 3]) })
    const e = failure(await world.run(Write.run(BLOB, relayOpts(world))))
    expect(e).toMatchObject({ _tag: "CertificateInvalid", reason: "aggregate signature does not verify" })
    expect(world.executed).toEqual(["register"])
  })

  test("a reused registration gets a transaction with only the auth input and the tip", async () => {
    const world = relayWorld()
    const encoded = value(await world.run(Write.encodeForRelay(BLOB)))
    // Registered directly (no relay), then forgotten: the crash case.
    const first = value(await world.run(Write.register(encoded, { epochs: 2, deletable: true, executor: world.executor })))
    const certified = value(await world.run(Write.run(BLOB, relayOpts(world))))
    expect(certified.blobObjectId).toBe(first.blobObjectId)
    expect(world.executed).toEqual(["register", "auth", "certify"])
    const auth = world.transactions.get("tx2")!
    expect(auth.inputs[0]!._tag).toBe("Pure")
    expect(auth.commands.map((c) => c._tag)).toEqual(["BalanceIntent", "TransferObjects"])
    expect(new URL(world.relayRequests[0]!.url).searchParams.get("tx_id")).toBe("tx2")
  })

  test("resume from a saved Registered: a fresh auth transaction, then the relay", async () => {
    const world = relayWorld()
    const steps = value(await world.run(Stream.runCollect(Stream.take(Write.stream(BLOB, relayOpts(world)), 2))))
    const registered = Array.from(steps)[1]!
    expect(registered._tag).toBe("Registered")
    const certified = value(await world.run(Write.run(BLOB, relayOpts(world, { resume: registered }))))
    expect(world.executed).toEqual(["register", "auth", "certify"])
    expect(certified._tag).toBe("Certified")
    expect(new URL(world.relayRequests[0]!.url).searchParams.get("tx_id")).toBe("tx2")
  })

  test("resume with other bytes is ResumeMismatch, without touching the relay", async () => {
    const world = relayWorld()
    const steps = value(await world.run(Stream.runCollect(Stream.take(Write.stream(BLOB, relayOpts(world)), 2))))
    for (const step of steps) {
      const e = failure(await world.run(Write.run(BLOB.map((b) => b ^ 1), relayOpts(world, { resume: step }))))
      expect(e._tag).toBe("ResumeMismatch")
    }
    expect(world.relayRequests.length).toBe(0)
  })

  test("a stale relay certificate: a fresh auth transaction and a new upload in the new epoch", async () => {
    const world = relayWorld()
    const steps = Array.from(value(await world.run(Stream.runCollect(Stream.take(Write.stream(BLOB, relayOpts(world)), 3)))))
    expect(steps[2]!._tag).toBe("Uploaded")
    world.setEpoch(6)
    const certified = value(await world.run(Write.run(BLOB, relayOpts(world, { resume: steps[2]! }))))
    expect(certified.certifiedEpoch).toBe(6)
    expect(world.executed).toEqual(["register", "auth", "certify"])
    expect(world.relayRequests.length).toBe(2)
  })

  test("a relay without a tip: no auth input, no nonce or tx_id", async () => {
    const world = relayWorld({ tipConfig: "no_tip" })
    const steps: Array<Write.Step> = []
    value(await world.run(Write.run(BLOB, relayOpts(world, { onStep: (s) => Effect.sync(() => steps.push(s)) }))))
    expect(world.executed).toEqual(["register", "certify"])
    const draft = world.transactions.get((steps[1] as Write.Registered).digest!)!
    expect(draft.inputs[0]!._tag).not.toBe("Pure")
    const query = new URL(world.relayRequests[0]!.url).searchParams
    expect(query.has("nonce") || query.has("tx_id")).toBe(false)
  })

  test("a tip above maxTip is TipTooHigh before anything is registered", async () => {
    const world = relayWorld({ maxTip: 10n })
    const e = failure(await world.run(Write.run(BLOB, relayOpts(world))))
    expect(e).toMatchObject({ _tag: "TipTooHigh", tip: 105n, max: 10n })
    expect(world.executed).toEqual([])
  })
})
