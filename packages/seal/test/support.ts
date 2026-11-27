/**
 * Test support.
 *
 * - `seeded(seed)`: a deterministic `Entropy` source. Each call returns the
 *   next `length` bytes of `shake256(seed ‖ u64le(call number))`, so a run is
 *   reproducible and two calls never return the same bytes.
 * - `hex` / `unhex` / `b64`: small codecs for vectors.
 * - Hand-built key requests (R1, R4): `personalMessageText`, `requestMessage`,
 *   `approvalPtb`, `testRequest`. Built from the doc, independently of
 *   `SessionKey` / `Approval` (S5), so the fake servers can check those later.
 * - `fakeKeyServers(servers)`: in-memory key servers behind an `HttpClient`
 *   (H1–H10 with real crypto, R1–R4 checked), for `KeyServerApi.layer`.
 * - `recorded` / `synthesized`: the bodies under `fixtures/key-server/`.
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { shake256 } from "@noble/hashes/sha3.js"
import { base64 } from "@scure/base"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import { SignatureSchemes } from "@unconfirmed/sui/SignatureScheme"
import * as Signer from "@unconfirmed/sui/Signer"
import * as TransactionData from "@unconfirmed/sui/TransactionData"
import * as Verify from "@unconfirmed/sui/Verify"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Bls from "../src/Bls.ts"
import * as ElGamal from "../src/ElGamal.ts"
import * as Ibe from "../src/Ibe.ts"
import * as KeyServerApi from "../src/KeyServerApi.ts"

export const seeded = (seed: number | string | Uint8Array = 1): ((length: number) => Uint8Array) => {
  const seedBytes = typeof seed === "number"
    ? new TextEncoder().encode(`seed:${seed}`)
    : typeof seed === "string"
    ? new TextEncoder().encode(seed)
    : seed
  let counter = 0n
  return (length: number) => {
    const input = new Uint8Array(seedBytes.length + 8)
    input.set(seedBytes)
    new DataView(input.buffer).setBigUint64(seedBytes.length, counter++, true)
    return shake256(input, { dkLen: length })
  }
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

export const unhex = (s: string): Uint8Array => {
  const h = s.replace(/^0x/, "")
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16)
  return out
}

export const b64 = (s: string): Uint8Array => base64.decode(s)
export const toB64 = (bytes: Uint8Array): string => base64.encode(bytes)

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

// -----------------------------------------------------------------------------
// Hand-built key requests (R1, R4, P1)
// -----------------------------------------------------------------------------

/** `YYYY-MM-DD HH:MM:SS`, UTC, truncated to seconds (R1). */
const utcSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ")

/** R1: the text the user signs as a personal message. `packageName` is the MVR name or the first package id (`0x` + 64 hex). */
export const personalMessageText = (packageName: string, ttlMin: number, creationTime: number, sessionVk: Uint8Array): string =>
  `Accessing keys of package ${packageName} for ${ttlMin} mins from ${utcSeconds(creationTime)} UTC, session key ${toB64(sessionVk)}`

const RequestFormat = /* @__PURE__ */ Bcs.struct({ ptb: Bcs.byteVector, encKey: Bcs.byteVector, encVerificationKey: Bcs.byteVector })

/** R4: what the session key signs, BCS `{ ptb, enc_key, enc_verification_key }` (three `vector<u8>`). */
export const requestMessage = (ptb: Uint8Array, encKey: Uint8Array, encVerificationKey: Uint8Array): Uint8Array =>
  Bcs.encodeSync(RequestFormat)({ ptb, encKey, encVerificationKey })

/**
 * A BCS `ProgrammableTransaction` with one `seal_approve*` call per id (P1):
 * input `i` is the pure `vector<u8>` id of call `i`; `objects` are appended as
 * further inputs and passed to every call after the id.
 */
export const approvalPtb = (o: {
  readonly packageId: string
  readonly ids: ReadonlyArray<Uint8Array>
  readonly module?: string
  readonly function?: string
  readonly objects?: ReadonlyArray<TransactionData.CallArg>
}): Uint8Array => {
  const ids = o.ids.map((id): TransactionData.CallArg => ({ _tag: "Pure", bytes: Bcs.encodeSync(Bcs.byteVector)(id) }))
  const objects = o.objects ?? []
  const ptb: TransactionData.ProgrammableTransaction = {
    inputs: [...ids, ...objects],
    commands: o.ids.map((_, i): TransactionData.Command => ({
      _tag: "MoveCall",
      package: Address.normalize(o.packageId),
      module: o.module ?? "account_based",
      function: o.function ?? "seal_approve",
      typeArguments: [],
      arguments: [
        { _tag: "Input", value: i },
        ...objects.map((_, j): TransactionData.Argument => ({ _tag: "Input", value: ids.length + j }))
      ]
    }))
  }
  return Bcs.encodeSync(TransactionData.ProgrammableTransaction)(ptb)
}

export interface TestRequestOptions {
  /** The user's 32-byte Ed25519 secret. */
  readonly userSecret: Uint8Array
  /** The session's 32-byte Ed25519 secret. */
  readonly sessionSecret: Uint8Array
  /** The first version of the policy package (named in the certificate). */
  readonly packageId: string
  readonly ptb: Uint8Array
  /** ms since the epoch. */
  readonly creationTime: number
  readonly ttlMin?: number
  readonly mvrName?: string
  /** The ElGamal secret; default from `seeded("elgamal")`. */
  readonly encSecret?: Bls.Scalar
  /** Sign a different package name than the certificate implies (to provoke `InvalidSignature`). */
  readonly signedName?: string
}

/** A complete `fetch_key` request signed as R1 and R4 say, and the ElGamal key pair to open the answer. */
export const testRequest = (o: TestRequestOptions) =>
  Effect.gen(function*() {
    const user = yield* Ed25519.fromSecretKey(o.userSecret)
    const sessionVk = ed25519.getPublicKey(o.sessionSecret)
    const ttlMin = o.ttlMin ?? 10
    const name = o.signedName ?? o.mvrName ?? Address.normalize(o.packageId)
    const message = utf8(personalMessageText(name, ttlMin, o.creationTime, sessionVk))
    const { signature } = yield* Signer.signPersonalMessage(user, message)
    const enc = ElGamal.keyPair(o.encSecret ?? Bls.scalarFromEntropy(seeded("elgamal")(48)))
    const request: KeyServerApi.FetchKeyRequest = {
      ptb: o.ptb,
      encKey: enc.publicKey,
      encVerificationKey: enc.verificationKey,
      requestSignature: ed25519.sign(requestMessage(o.ptb, enc.publicKey, enc.verificationKey), o.sessionSecret),
      certificate: {
        user: user.address,
        sessionVk,
        creationTime: o.creationTime,
        ttlMin,
        signature,
        ...(o.mvrName !== undefined && { mvrName: o.mvrName })
      }
    }
    return { request, enc, user: user.address, personalMessage: message }
  })

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

export interface FixtureResponse {
  readonly server: string
  readonly method: string
  readonly path: string
  readonly note?: string
  readonly status: number
  readonly contentType: string | null
  readonly keyServerVersion: string | null
  readonly body: string
}

const fixtures = new URL("./fixtures/key-server/", import.meta.url)
/** Missing files read as empty, so the recorder can import this module before the first recording. */
const fixture = async (name: string) => {
  const file = Bun.file(new URL(name, fixtures))
  return (await file.exists()) ? await file.json() : { source: "", recordedAt: "", responses: {} }
}

/** Recorded from live servers by `scripts/record-key-server.ts` (throwaway keys only). */
export const recorded = (await fixture("recorded.json")) as {
  readonly source: string
  readonly recordedAt: string
  readonly responses: Readonly<Record<string, FixtureResponse>>
}

/** Bodies that cannot be recorded without a permissioned server, a broken fullnode or a rate limit. */
export const synthesized = (await fixture("synthesized.json")) as {
  readonly source: string
  readonly responses: Readonly<Record<string, FixtureResponse>>
}

// -----------------------------------------------------------------------------
// The key server's own errors (`crates/key-server/src/errors.rs`)
// -----------------------------------------------------------------------------

export interface ErrorBody {
  readonly error: string
  readonly message: string
}

/** `errors.rs` `IntoResponse`: the status for each error name. */
export const statusOf = (error: string): number => {
  switch (error) {
    case "InvalidPTB":
    case "InvalidPackage":
    case "NoAccess":
    case "InvalidCertificate":
    case "InvalidSignature":
    case "InvalidSessionSignature":
    case "InvalidParameter":
    case "InvalidMVRName":
      return 403
    case "InvalidSDKType":
    case "InvalidSDKVersion":
    case "InvalidServiceId":
    case "UnsupportedPackageId":
    case "MissingRequiredHeader":
      return 400
    case "DeprecatedSDKVersion":
      return 426
    default:
      return 503
  }
}

/** Each error with the server's wording, word for word. */
export const keyServerErrors = {
  invalidPtb: (inner: string): ErrorBody => ({ error: "InvalidPTB", message: `Invalid PTB: ${inner}` }),
  invalidPackage: (): ErrorBody => ({ error: "InvalidPackage", message: "Invalid package ID" }),
  noAccess: (inner = "Simulation did not report a successful execution"): ErrorBody => ({ error: "NoAccess", message: `Access denied: ${inner}` }),
  invalidCertificate: (): ErrorBody => ({ error: "InvalidCertificate", message: "Invalid certificate time or ttl" }),
  invalidSignature: (): ErrorBody => ({ error: "InvalidSignature", message: "Invalid user signature" }),
  invalidSessionSignature: (): ErrorBody => ({ error: "InvalidSessionSignature", message: "Invalid session key signature" }),
  invalidSdkType: (): ErrorBody => ({ error: "InvalidSDKType", message: "Invalid SDK type" }),
  invalidSdkVersion: (): ErrorBody => ({ error: "InvalidSDKVersion", message: "Invalid SDK version" }),
  deprecatedSdkVersion: (): ErrorBody => ({ error: "DeprecatedSDKVersion", message: "Deprecated SDK version" }),
  missingRequiredHeader: (header: string): ErrorBody => ({ error: "MissingRequiredHeader", message: `Missing required header: ${header}` }),
  invalidParameter: (inner: string): ErrorBody => ({ error: "InvalidParameter", message: `Invalid parameter to PTB: ${inner}` }),
  invalidMvrName: (): ErrorBody => ({ error: "InvalidMVRName", message: "Invalid MVR name" }),
  invalidServiceId: (): ErrorBody => ({ error: "InvalidServiceId", message: "Invalid service ID" }),
  unsupportedPackageId: (): ErrorBody => ({ error: "UnsupportedPackageId", message: "Unsupported package ID" }),
  failure: (): ErrorBody => ({ error: "Failure", message: "Internal server error, please try again later" })
} as const

// -----------------------------------------------------------------------------
// Fake key servers
// -----------------------------------------------------------------------------

export interface FakeRequest {
  readonly method: string
  readonly url: string
  /** The URL's origin, i.e. the server a request went to. */
  readonly origin: string
  readonly path: string
  /** Lower-case names. */
  readonly headers: Readonly<Record<string, string>>
  /** The body as text, `undefined` for a `GET`. */
  readonly body: string | undefined
}

export interface Reply {
  readonly status: number
  /** A string as is; anything else as JSON. */
  readonly body?: unknown
  readonly contentType?: string
  readonly headers?: Readonly<Record<string, string>>
}

/** What an intercept does instead of (or before) normal processing. */
export type Intercept =
  | Reply
  /** Never answers: drive with `TestClock` past `requestTimeout`. */
  | "hang"
  | "network-error"
  /** Answer with keys derived from another master key. */
  | "wrong-key"
  /** Answer with a key for another id (under the requested id). */
  | "wrong-id"
  /** Leave the last id out of the answer. */
  | "missing-key"
  /** Wait, then do `then` (default: normal processing). */
  | { readonly delay: Duration.Input; readonly then?: Intercept }

/** `fetch_key` context for policies: what the real server would hand to the dry run. */
export interface PolicyInput {
  readonly user: Address.Address
  /** The first version of the package (the namespace, I1). */
  readonly packageId: Address.Address
  /** The package the PTB calls (any version). */
  readonly calledPackage: Address.Address
  /** The inner ids, one per command. */
  readonly ids: ReadonlyArray<Uint8Array>
  readonly functions: ReadonlyArray<string>
}

/** `true` serves the keys; an `ErrorBody` (e.g. `keyServerErrors.noAccess(...)`) refuses with that error. */
export type Policy = (input: PolicyInput) => true | ErrorBody

/** A Move abort as the server reports it in `NoAccess` (recorded wording). */
export const moveAbort = (packageId: string, module: string, code: number, command = 1, fn = "seal_approve"): string =>
  `MoveAbort(MoveLocation { module: ModuleId { address: ${Address.normalize(packageId).slice(2)}, name: Identifier("${module}") }, function: 1, instruction: 6, function_name: Some("${fn}") }, ${code}) in command ${command}`

/** `account_based::seal_approve`: every id must be the BCS of the user's address (abort code 1 otherwise, as recorded). */
export const accountBased: Policy = ({ ids, packageId, user }) => {
  const bad = ids.findIndex((id) => hex(id) !== user.slice(2))
  return bad === -1 ? true : keyServerErrors.noAccess(moveAbort(packageId, "account_based", 1, bad + 1))
}

export interface FakeKeyServerOptions {
  readonly name?: string
  readonly objectId?: string
  /** Default `https://key-server-<i>.test`. */
  readonly url?: string
  /** Default from `seeded("master-<i>")`. */
  readonly masterKey?: Bls.Scalar
  /** Required on every request, as a gateway would (`401` with the recorded gateway body otherwise). */
  readonly apiKey?: { readonly name: string; readonly value: string }
  /** `Committee`: behaves as the aggregator (no `/v1/service`, strict SDK types). Default `Independent`. */
  readonly type?: "Independent" | "Committee"
  /** Default: allow everything. */
  readonly policy?: Policy
  /** Consulted on every request; `undefined` means normal processing. `count` is 1 for this server's first request. */
  readonly intercept?: (request: FakeRequest, count: number) => Intercept | undefined
  /** `X-KeyServer-Version`; default `"0.6.16"`; `null` omits it. */
  readonly version?: string | null
  /** Permissioned mode: the first-version package ids served. Absent: open mode. */
  readonly packages?: ReadonlyArray<string>
  /** Default 30 (R2). */
  readonly maxTtlMin?: number
}

export interface FakeWorld {
  /** Package versions to first versions (I1). A package not listed (as a key or a value) is `InvalidPackage`; without a table every package is its own first version. */
  readonly packages?: Readonly<Record<string, string>>
  /** MVR names to first-version package ids; a certificate naming another is `InvalidMVRName`. */
  readonly mvr?: Readonly<Record<string, string>>
}

/** A fake server, shaped like `KeyServer.KeyServer` (ready for `KeyServer.layerFromServers`) plus its secrets. */
export interface FakeKeyServer {
  readonly objectId: Address.Address
  readonly name: string
  readonly publicKey: Uint8Array
  readonly type: "Independent" | "Committee"
  readonly url: string
  readonly apiKey: { readonly name: string; readonly value: Redacted.Redacted<string> } | undefined
  readonly masterKey: Bls.Scalar
  /** For `KeyServerApi` calls. */
  readonly endpoint: KeyServerApi.Endpoint
}

/** The mainnet gateway's body without an API key (recorded). */
const GATEWAY_401 = `{\n  "message":"No API key found in request",\n  "request_id":"00000000000000000000000000000000"\n}`

const semver = (s: string): readonly [number, number, number] | undefined => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(s)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}
const atLeast = (v: readonly [number, number, number], min: readonly [number, number, number]) =>
  v[0] !== min[0] ? v[0] > min[0] : v[1] !== min[1] ? v[1] > min[1] : v[2] >= min[2]

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

type Processed = Reply | "hang" | "network-error"

/**
 * In-memory key servers behind one `HttpClient`. Each server has a real
 * master key; `fetch_key` checks headers (H2), the PTB (P1, with the server's
 * wording), the package (I1, permissioned mode), the MVR name, the
 * certificate's TTL and times against `Clock` (R2), the user's personal
 * message signature (R1, R3: Ed25519 and anything else `SignatureSchemes` has,
 * no aliases), the session signature (R4), then the policy, and answers with
 * `Ibe.extract` + `ElGamal.encrypt` per command (H6). `/v1/service` answers
 * the proof of possession (H10). Errors use `errors.rs`'s exact bodies and
 * statuses. Unknown origins are network errors.
 *
 * Returns the `HttpClient` layer, `KeyServerApi.layer` over it (`api`), the
 * servers, and every request seen.
 */
export const fakeKeyServers = (options: ReadonlyArray<FakeKeyServerOptions>, world: FakeWorld = {}) => {
  const servers: Array<FakeKeyServer & { readonly options: FakeKeyServerOptions; readonly pop: Uint8Array; count: number }> = options.map((o, i) => {
    const masterKey = o.masterKey ?? Bls.scalarFromEntropy(seeded(`master-${i}`)(48))
    const objectId = Address.normalize(o.objectId ?? hex(seeded(`object-${i}`)(32)))
    const url = (o.url ?? `https://key-server-${i}.test`).replace(/\/+$/, "")
    const apiKey = o.apiKey && { name: o.apiKey.name, value: Redacted.make(o.apiKey.value) }
    return {
      objectId,
      name: o.name ?? `fake-${i}`,
      publicKey: Ibe.publicKey(masterKey),
      type: o.type ?? "Independent",
      url,
      apiKey,
      masterKey,
      endpoint: { objectId, url, ...(apiKey && { apiKey }) },
      options: o,
      pop: Ibe.proofOfPossession(masterKey, objectId),
      count: 0
    }
  })
  const byOrigin = new Map(servers.map((s) => [new URL(s.url).origin, s]))
  const requests: Array<FakeRequest> = []
  const otherMaster = Bls.scalarFromEntropy(seeded("other-master")(48))
  const entropy = seeded("fake-key-server-elgamal")
  const packages = world.packages && Object.fromEntries(Object.entries(world.packages).map(([k, v]) => [Address.normalize(k), Address.normalize(v)]))
  const firstVersions = packages && new Set(Object.values(packages))
  const schemes = SignatureSchemes.layer(Ed25519.scheme)

  const json = (status: number, body: unknown, version: string | null): Reply => ({
    status,
    body,
    contentType: "application/json",
    headers: version === null ? {} : { "x-keyserver-version": version }
  })

  const handle = (server: (typeof servers)[number], req: FakeRequest, mode: "normal" | "wrong-key" | "wrong-id" | "missing-key"): Effect.Effect<Processed> =>
    Effect.gen(function*() {
      const o = server.options
      const version = o.version === undefined ? "0.6.16" : o.version
      const error = (e: ErrorBody) => json(statusOf(e.error), e, version)
      const path = new URL(req.url).pathname

      // A gateway in front: API key first.
      if (server.apiKey && req.headers[server.apiKey.name.toLowerCase()] !== Redacted.value(server.apiKey.value)) {
        return { status: 401, body: GATEWAY_401, contentType: "application/json; charset=utf-8" }
      }
      // H2: the header middleware.
      const sdkType = req.headers["client-sdk-type"]
      const committee = server.type === "Committee"
      if (committee && sdkType !== "typescript" && sdkType !== "rust" && sdkType !== "python") return error(keyServerErrors.invalidSdkType())
      const sdkVersion = req.headers["client-sdk-version"]
      if (sdkVersion === undefined) return error(keyServerErrors.missingRequiredHeader("Client-Sdk-Version"))
      const v = semver(sdkVersion)
      if (!v) return error(keyServerErrors.invalidSdkVersion())
      const min = sdkType === "typescript" ? (committee ? [0, 10, 0] as const : [0, 4, 5] as const) : undefined
      if (min && !atLeast(v, min)) return error(keyServerErrors.deprecatedSdkVersion())

      if (req.method === "GET" && path === "/v1/service") {
        if (committee) return { status: 400, body: "Unsupported", contentType: "text/plain; charset=utf-8" }
        const id = new URL(req.url).searchParams.get("service_id")
        let normalized: string | undefined
        try {
          normalized = id === null ? undefined : Address.normalize(id)
        } catch {
          normalized = undefined
        }
        if (normalized !== server.objectId) return error(keyServerErrors.invalidServiceId())
        return json(200, { service_id: server.objectId, pop: toB64(server.pop) }, version)
      }
      if (req.method !== "POST" || path !== "/v1/fetch_key") return { status: 404, body: "" }

      // The JSON body (axum's `Json` extractor: 422 with a text body).
      const unprocessable = (what: string): Reply => ({
        status: 422,
        body: `Failed to deserialize the JSON body into the target type: ${what}`,
        contentType: "text/plain; charset=utf-8"
      })
      let body: unknown
      try {
        body = JSON.parse(req.body ?? "")
      } catch {
        return { status: 400, body: "Failed to parse the request body as JSON: EOF while parsing a value", contentType: "text/plain; charset=utf-8" }
      }
      const bytes = (u: unknown): Uint8Array | undefined => {
        try {
          return typeof u === "string" ? base64.decode(u) : undefined
        } catch {
          return undefined
        }
      }
      if (!isRecord(body) || !isRecord(body.certificate)) return unprocessable("missing field `certificate`")
      const cert = body.certificate
      const encKey = bytes(body.enc_key)
      const encVk = bytes(body.enc_verification_key)
      const requestSignature = bytes(body.request_signature)
      const sessionVk = bytes(cert.session_vk)
      const userSignature = bytes(cert.signature)
      if (!encKey || Result.isFailure(Bls.g1FromBytes(encKey))) return unprocessable("enc_key: invalid G1 element")
      if (!encVk || Result.isFailure(Bls.g2FromBytes(encVk))) return unprocessable("enc_verification_key: invalid G2 element")
      if (!requestSignature || requestSignature.length !== 64) return unprocessable("request_signature: invalid signature")
      if (!sessionVk || sessionVk.length !== 32) return unprocessable("certificate.session_vk: invalid public key")
      if (!userSignature) return unprocessable("certificate.signature: invalid signature")
      if (typeof cert.user !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(cert.user)) return unprocessable("certificate.user: invalid address")
      if (typeof cert.creation_time !== "number" || typeof cert.ttl_min !== "number") return unprocessable("certificate: invalid number")
      if (cert.mvr_name !== undefined && cert.mvr_name !== null && typeof cert.mvr_name !== "string") return unprocessable("certificate.mvr_name")
      const user = Address.normalize(cert.user)
      const mvrName = typeof cert.mvr_name === "string" ? cert.mvr_name : undefined

      // P1, with the server's wording (`valid_ptb.rs`).
      if (typeof body.ptb !== "string") return unprocessable("missing field `ptb`")
      const ptbBytes = bytes(body.ptb)
      if (!ptbBytes) return error(keyServerErrors.invalidPtb("Invalid Base64"))
      const decoded = Bcs.decode(TransactionData.ProgrammableTransaction)(ptbBytes)
      if (Result.isFailure(decoded)) return error(keyServerErrors.invalidPtb("Invalid BCS"))
      const ptb = decoded.success
      if (ptb.commands.length > 100) return error(keyServerErrors.invalidPtb("Too many commands in PTB (more than 100)"))
      if (ptb.inputs.length === 0 || ptb.commands.length === 0) return error(keyServerErrors.invalidPtb("Empty PTB input or command"))
      const first = ptb.commands[0]!
      if (first._tag !== "MoveCall") return error(keyServerErrors.invalidPtb("Invalid first command"))
      const calledPackage = first.package
      const ids: Array<Uint8Array> = []
      const functions: Array<string> = []
      for (const cmd of ptb.commands) {
        if (cmd._tag !== "MoveCall") return error(keyServerErrors.invalidPtb("Non MoveCall command"))
        if (cmd.arguments.some((a) => a._tag !== "Input")) return error(keyServerErrors.invalidPtb("Only pure inputs are allowed"))
        const arg0 = cmd.arguments[0]
        if (!arg0) return error(keyServerErrors.invalidPtb("Empty args"))
        if (arg0._tag !== "Input") return error(keyServerErrors.invalidPtb("Invalid index for first argument"))
        const input = ptb.inputs[arg0.value]
        if (!input || input._tag !== "Pure") return error(keyServerErrors.invalidPtb("Invalid first parameter for seal_approve"))
        const id = Bcs.decode(Bcs.byteVector)(input.bytes)
        if (Result.isFailure(id)) return error(keyServerErrors.invalidPtb("Invalid BCS for first parameter for seal_approve"))
        if (!cmd.function.startsWith("seal_approve") || cmd.package !== calledPackage) {
          return error(keyServerErrors.invalidPtb("Invalid function or package id"))
        }
        ids.push(id.success)
        functions.push(cmd.function)
      }

      // I1: the namespace is the first version; then permissioned mode, then the MVR name.
      let packageId: Address.Address = calledPackage
      if (packages) {
        const resolved = packages[calledPackage] ?? (firstVersions!.has(calledPackage) ? calledPackage : undefined)
        if (!resolved) return error(keyServerErrors.invalidPackage())
        packageId = resolved
      }
      if (o.packages && !o.packages.map(Address.normalize).includes(packageId)) return error(keyServerErrors.unsupportedPackageId())
      if (mvrName !== undefined) {
        const target = world.mvr?.[mvrName]
        if (target === undefined || Address.normalize(target) !== packageId) return error(keyServerErrors.invalidMvrName())
      }

      // R2: TTL and times against the server's clock.
      const now = yield* Clock.currentTimeMillis
      const ttlMs = cert.ttl_min * 60_000
      if (cert.ttl_min > (o.maxTtlMin ?? 30)) return error(keyServerErrors.invalidCertificate())
      if (cert.creation_time > now || now - cert.creation_time > ttlMs) return error(keyServerErrors.invalidCertificate())

      // R1, R3: the user's signature over the personal message naming the MVR name or the first version.
      const message = utf8(personalMessageText(mvrName ?? packageId, cert.ttl_min, cert.creation_time, sessionVk))
      const signed = yield* Verify.personalMessage(message, userSignature, { address: user }).pipe(
        Effect.provide(schemes),
        Effect.match({ onFailure: () => false, onSuccess: () => true })
      )
      if (!signed) return error(keyServerErrors.invalidSignature())

      // R4: the session key over BCS { ptb, enc_key, enc_verification_key }.
      let sessionOk = false
      try {
        sessionOk = ed25519.verify(requestSignature, requestMessage(ptbBytes, encKey, encVk), sessionVk)
      } catch {
        sessionOk = false
      }
      if (!sessionOk) return error(keyServerErrors.invalidSessionSignature())

      const verdict = (o.policy ?? (() => true))({ user, packageId, calledPackage, ids, functions })
      if (verdict !== true) return error(verdict)

      // H6: one entry per command, in order.
      const pkgBytes = unhex(packageId)
      const entries = ids.map((inner) => {
        const fullId = new Uint8Array(32 + inner.length)
        fullId.set(pkgBytes)
        fullId.set(inner, 32)
        const keyId = mode === "wrong-id" ? Uint8Array.from([...fullId, 0]) : fullId
        const usk = Ibe.extract(mode === "wrong-key" ? otherMaster : server.masterKey, keyId)
        const k = Bls.scalarFromEntropy(entropy(48))
        const [c0, c1] = Result.getOrThrow(ElGamal.encrypt(encKey, usk, k))
        return { id: Array.from(fullId), encrypted_key: [toB64(c0), toB64(c1)] }
      })
      return json(200, { decryption_keys: mode === "missing-key" ? entries.slice(0, -1) : entries }, version)
    })

  const run = (server: (typeof servers)[number], req: FakeRequest, intercept: Intercept | undefined): Effect.Effect<Processed> => {
    if (intercept === undefined) return handle(server, req, "normal")
    if (intercept === "hang" || intercept === "network-error") return Effect.succeed(intercept)
    if (intercept === "wrong-key" || intercept === "wrong-id" || intercept === "missing-key") return handle(server, req, intercept)
    if ("delay" in intercept) return Effect.andThen(Effect.sleep(intercept.delay), run(server, req, intercept.then))
    return Effect.succeed(intercept)
  }

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function*() {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(request.headers)) headers[k.toLowerCase()] = v
        const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
        const recorded: FakeRequest = { method: request.method, url: url.toString(), origin: url.origin, path: url.pathname + url.search, headers, body }
        requests.push(recorded)
        const server = byOrigin.get(url.origin)
        const outcome: Processed = server
          ? yield* run(server, recorded, server.options.intercept?.(recorded, ++server.count))
          : "network-error"
        if (outcome === "hang") return yield* Effect.never
        if (outcome === "network-error") {
          return yield* Effect.fail(
            new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "connection refused" }) })
          )
        }
        const responseHeaders: Record<string, string> = { ...outcome.headers, ...(outcome.contentType && { "content-type": outcome.contentType }) }
        const payload = outcome.body === undefined ? "" : typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body)
        return HttpClientResponse.fromWeb(request, new Response(payload, { status: outcome.status, headers: responseHeaders }))
      })
    )
  )

  const publicServers: ReadonlyArray<FakeKeyServer> = servers.map(({ options: _o, pop: _p, count: _c, ...s }) => s)
  return {
    layer,
    servers: publicServers,
    requests: requests as ReadonlyArray<FakeRequest>,
    /** `KeyServerApi.layer(options)` over the fake client. */
    api: (apiOptions?: KeyServerApi.KeyServerApiOptions) => KeyServerApi.layer(apiOptions).pipe(Layer.provide(layer))
  }
}
