/**
 * The zkLogin scheme in the registry (verified through a `ZkLoginVerifier`),
 * multisigs with zkLogin members, and the gRPC verifier's verdict mapping.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import * as Theirs from "@mysten/sui/zklogin"
import { Bcs } from "@unconfirmed/effect-bcs"
import { RpcError } from "@unconfirmed/effect-sui/RpcError"
import { Ed25519, Hash, SignatureScheme, Signer, Verify } from "@unconfirmed/effect-sui"
import * as MultiSig from "@unconfirmed/effect-sui/MultiSig"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import * as GrpcWeb from "@unconfirmed/effect-sui/grpc/GrpcWeb"
import * as ZkLoginVerifierGrpc from "../../src/zklogin/ZkLoginVerifierGrpc.ts"
import * as Signature from "../../src/zklogin/Signature.ts"
import * as ZkLogin from "../../src/zklogin/ZkLogin.ts"
import { ZkLoginVerifier } from "../../src/zklogin/ZkLoginVerifier.ts"
import { claims, inputs } from "@unconfirmed/test-support/zklogin"

const { SignatureSchemes } = SignatureScheme
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"))
const seed = (n: number) => new Uint8Array(32).fill(n)
const msg = new TextEncoder().encode("zkLogin in a multisig")
const zk = inputs(String(Theirs.genAddressSeed(42n, "sub", claims.sub, claims.aud)))

/**
 * A stand-in for the node: accepts a zkLogin signature when its ephemeral
 * (Ed25519) signature verifies over the intent message. Records each request.
 */
const stubVerifier = () => {
  const requests: Array<{ address: string; intentMessage: Uint8Array }> = []
  const layer = Layer.succeed(ZkLoginVerifier, {
    verify: ({ address, intentMessage, signature }) =>
      Effect.gen(function*() {
        requests.push({ address, intentMessage })
        const parsed = yield* Effect.orDie(Signature.parse(signature))
        const user = parsed.userSignature
        yield* Effect.asVoid(Ed25519.scheme.verify(user.subarray(1), intentMessage, undefined as never)).pipe(
          Effect.mapError(() => new SignatureScheme.InvalidSignature({ scheme: "ZkLogin", reason: "stub: bad signature" }))
        )
      })
  })
  return { layer, requests }
}

const setup = Effect.gen(function*() {
  const ephemeral = yield* Ed25519.fromSecretKey(seed(9))
  const zkSigner = yield* ZkLogin.signer({ ephemeral, inputs: zk, maxEpoch: 954n })
  const other = yield* Ed25519.fromSecretKey(seed(1))
  const pk = yield* MultiSig.publicKey({
    members: [{ publicKey: other.publicKey, weight: 1 }, { publicKey: zkSigner.publicKey, weight: 1 }],
    threshold: 1
  })
  return { zkSigner, other, pk }
})

/** The same multisig signed with @mysten/sui (which stores the zkLogin member signature with its flag). */
const theirMultisig = async () => {
  const zkSigner = new Theirs.ZkLoginSigner({
    ephemeralSigner: Ed25519Keypair.fromSecretKey(seed(9)),
    inputs: zk,
    maxEpoch: 954,
    legacyAddress: false
  })
  const pk = MultiSigPublicKey.fromPublicKeys({
    threshold: 1,
    publicKeys: [
      { publicKey: Ed25519Keypair.fromSecretKey(seed(1)).getPublicKey(), weight: 1 },
      { publicKey: zkSigner.getPublicKey(), weight: 1 }
    ]
  })
  const { signature } = await zkSigner.signPersonalMessage(msg)
  return { pk, signature: pk.combinePartialSignatures([signature]) }
}

describe("ZkLogin.scheme", () => {
  test("a zkLogin signature verifies through the verifier and names the zkLogin address", async () => {
    const stub = stubVerifier()
    const result = await Effect.runPromise(Effect.gen(function*() {
      const { zkSigner } = yield* setup
      const { signature } = yield* Signer.signPersonalMessage(zkSigner, msg)
      const v = yield* Verify.personalMessage(msg, signature, { address: zkSigner.address })
      const tampered = yield* Effect.flip(Verify.personalMessage(new TextEncoder().encode("other"), signature))
      return { v, zkSigner, tampered }
    }).pipe(Effect.provide(SignatureSchemes.layer(Ed25519.scheme, ZkLogin.scheme).pipe(Layer.provide(stub.layer)))))
    expect(result.v.address).toBe(result.zkSigner.address)
    expect(result.v.address).toBe(Theirs.computeZkLoginAddressFromSeed(BigInt(zk.addressSeed), claims.iss, false) as any)
    expect(b64(result.v.publicKey.bytes)).toBe(b64(result.zkSigner.publicKey.bytes))
    expect(result.tampered._tag).toBe("InvalidSignature")
    expect(stub.requests[0]!.address).toBe(result.zkSigner.address)
    expect(b64(stub.requests[0]!.intentMessage)).toBe(b64(Hash.personalMessageIntent(msg)))
  })

  test("a zkLogin member of a multisig (MultiSig.signer / combine) matches @mysten bytes and verifies", async () => {
    const stub = stubVerifier()
    const theirs = await theirMultisig()
    const result = await Effect.runPromise(Effect.gen(function*() {
      const { zkSigner, pk } = yield* setup
      const multi = yield* MultiSig.signer(pk, [zkSigner])
      const ours = yield* Signer.signPersonalMessage(multi, msg)
      const a = yield* Verify.personalMessage(msg, ours.signature, { address: multi.address })
      const b = yield* Verify.personalMessage(msg, fromB64(theirs.signature), { address: multi.address })
      const tampered = yield* Effect.flip(Verify.personalMessage(new TextEncoder().encode("x"), fromB64(theirs.signature)))
      // Combined from a separately produced member signature, naming the member.
      const { signature: part } = yield* Signer.signPersonalMessage(zkSigner, msg)
      const combined = yield* MultiSig.combine(pk, [{ signature: part, publicKey: zkSigner.publicKey }])
      return { a, b, multi, tampered, ours: ours.signature, combined }
    }).pipe(
      Effect.provide(SignatureSchemes.layer(Ed25519.scheme, ZkLogin.scheme, MultiSig.scheme).pipe(Layer.provide(stub.layer)))
    ))
    expect(result.multi.address).toBe(theirs.pk.toSuiAddress() as any)
    expect(b64(result.ours)).toBe(theirs.signature)
    expect(b64(result.combined)).toBe(theirs.signature)
    expect(result.a.address).toBe(result.multi.address)
    expect(result.b.address).toBe(result.multi.address)
    expect(result.tampered._tag).toBe("InvalidSignature")
    // The member was checked against its own zkLogin address.
    expect(stub.requests.every((r) => r.address === Theirs.computeZkLoginAddressFromSeed(BigInt(zk.addressSeed), claims.iss, false))).toBe(true)
  })

  test("a member signature from a different zkLogin identity is refused", async () => {
    const stub = stubVerifier()
    const error = await Effect.runPromise(Effect.gen(function*() {
      const { pk } = yield* setup
      const ephemeral = yield* Ed25519.fromSecretKey(seed(9))
      const stranger = yield* ZkLogin.signer({
        ephemeral,
        inputs: inputs(String(Theirs.genAddressSeed(43n, "sub", claims.sub, claims.aud))),
        maxEpoch: 954n
      })
      const sig = yield* Signer.signPersonalMessage(stranger, msg)
      // Splice the stranger's signature into the member slot by hand.
      const bytes = Bcs.encodeSync(MultiSig.MultiSigBcs)({
        sigs: [{ _tag: "ZkLogin", value: sig.signature } as any],
        bitmap: 0b10,
        multisigPk: Bcs.decodeSync(MultiSig.MultiSigPublicKeyBcs)(MultiSig.toPublicKey(pk).bytes)
      })
      return yield* Effect.flip(Verify.personalMessage(msg, Uint8Array.from([0x03, ...bytes])))
    }).pipe(
      Effect.provide(SignatureSchemes.layer(Ed25519.scheme, ZkLogin.scheme, MultiSig.scheme).pipe(Layer.provide(stub.layer)))
    ))
    expect(error._tag).toBe("InvalidSignature")
    expect(stub.requests.length).toBe(0)
  })

  test("a bare-body member signature (no 0x05) is refused, as validators do", async () => {
    const stub = stubVerifier()
    const error = await Effect.runPromise(Effect.gen(function*() {
      const { zkSigner, pk } = yield* setup
      const { signature } = yield* Signer.signPersonalMessage(zkSigner, msg)
      const bytes = Bcs.encodeSync(MultiSig.MultiSigBcs)({
        sigs: [{ _tag: "ZkLogin", value: signature.subarray(1) } as any],
        bitmap: 0b10,
        multisigPk: Bcs.decodeSync(MultiSig.MultiSigPublicKeyBcs)(MultiSig.toPublicKey(pk).bytes)
      })
      return yield* Effect.flip(Verify.personalMessage(msg, Uint8Array.from([0x03, ...bytes])))
    }).pipe(
      Effect.provide(SignatureSchemes.layer(Ed25519.scheme, ZkLogin.scheme, MultiSig.scheme).pipe(Layer.provide(stub.layer)))
    ))
    expect(error._tag).toBe("InvalidSignature")
    expect(stub.requests.length).toBe(0)
  })

  test("a legacy-address account verifies against its legacy address", async () => {
    const stub = stubVerifier()
    const legacySalt = (() => {
      for (let s = 1n; s < 5000n; s++) if (Theirs.genAddressSeed(s, "sub", claims.sub, claims.aud) < 2n ** 248n) return s
      throw new Error("no legacy salt")
    })()
    const legacyInputs = inputs(String(Theirs.genAddressSeed(legacySalt, "sub", claims.sub, claims.aud)))
    const result = await Effect.runPromise(Effect.gen(function*() {
      const ephemeral = yield* Ed25519.fromSecretKey(seed(9))
      const signer = yield* ZkLogin.signer({ ephemeral, inputs: legacyInputs, maxEpoch: 954n, legacyAddress: true })
      const { signature } = yield* Signer.signPersonalMessage(signer, msg)
      const v = yield* Verify.personalMessage(msg, signature, { address: signer.address })
      const other = yield* Effect.flip(Verify.personalMessage(msg, signature, { address: "0x" + "ab".repeat(32) as any }))
      return { signer, v, other }
    }).pipe(Effect.provide(SignatureSchemes.layer(ZkLogin.scheme).pipe(Layer.provide(stub.layer)))))
    const theirLegacy = Theirs.computeZkLoginAddressFromSeed(BigInt(legacyInputs.addressSeed), claims.iss, true)
    expect(result.signer.address).toBe(theirLegacy as any)
    expect(result.v.address).toBe(theirLegacy as any)
    expect(result.other._tag).toBe("InvalidSignature")
    expect(ZkLogin.scheme.addresses!(result.signer.publicKey.bytes)).toEqual([
      Theirs.computeZkLoginAddressFromSeed(BigInt(legacyInputs.addressSeed), claims.iss, false),
      theirLegacy
    ] as any)
  })
})

describe("ZkLoginVerifierGrpc", () => {
  /** A node that accepts everything, recording what it was asked. */
  const permissiveNode = () => {
    const calls: Array<unknown> = []
    const layer = ZkLoginVerifierGrpc.layer.pipe(
      Layer.provide(Layer.succeed(GrpcWeb.GrpcWeb, {
        unary: (_method: unknown, request: unknown) => {
          calls.push(request)
          return Effect.succeed({ is_valid: true } as any)
        },
        serverStream: () => Stream.die("unused")
      } as GrpcWeb.GrpcWeb["Service"]))
    )
    return { layer, calls }
  }

  test("an intent with a non-zero version or app id is refused before asking the node", async () => {
    const node = permissiveNode()
    const tx = new Uint8Array([1, 2, 3])
    const verify = (intentMessage: Uint8Array) =>
      Effect.runPromise(
        Effect.flatMap(Effect.service(ZkLoginVerifier), (v) =>
          v.verify({ signature: new Uint8Array([5]), intentMessage, address: "0x1" as any })).pipe(
            Effect.flip,
            Effect.provide(node.layer)
          )
      ).catch(() => "succeeded")
    for (const bad of [[0, 1, 0], [0, 0, 1], [3, 7, 9]]) {
      const e = await verify(Uint8Array.from([...bad, ...tx]))
      expect((e as SignatureScheme.InvalidSignature)._tag).toBe("InvalidSignature")
    }
    expect(node.calls.length).toBe(0)
    // A proper intent reaches the node, minus its 3 intent bytes.
    await Effect.runPromise(
      Effect.flatMap(Effect.service(ZkLoginVerifier), (v) =>
        v.verify({ signature: new Uint8Array([5]), intentMessage: Uint8Array.from([0, 0, 0, ...tx]), address: "0x1" as any })).pipe(
          Effect.provide(node.layer)
        )
    )
    expect((node.calls[0] as any).message).toEqual({ name: "TransactionData", value: tx })
  })

  test("node verdicts are InvalidSignature; transport failures are VerificationUnavailable", async () => {
    const node = (respond: () => Effect.Effect<any, RpcError>) =>
      ZkLoginVerifierGrpc.layer.pipe(Layer.provide(Layer.succeed(GrpcWeb.GrpcWeb, {
        unary: () => respond(),
        serverStream: () => Stream.die("unused")
      } as GrpcWeb.GrpcWeb["Service"])))
    const verdict = (respond: () => Effect.Effect<any, RpcError>) =>
      Effect.runPromise(Effect.gen(function*() {
        const { zkSigner } = yield* setup
        const { signature } = yield* Signer.signPersonalMessage(zkSigner, msg)
        return yield* Effect.flip(Verify.personalMessage(msg, signature))
      }).pipe(Effect.provide(SignatureSchemes.layer(ZkLogin.scheme).pipe(Layer.provide(node(respond))))))
    const rpc = (code: RpcError["code"]) => () => Effect.fail(new RpcError({ method: "m", code, message: "x" }))

    const rejected = await verdict(() => Effect.succeed({ is_valid: false, reason: "Groth16 proof verify failed" }))
    expect(rejected).toMatchObject({ _tag: "InvalidSignature", reason: "Groth16 proof verify failed" })
    expect((await verdict(rpc("INVALID_ARGUMENT")))._tag).toBe("InvalidSignature")
    expect(await verdict(rpc("UNAVAILABLE"))).toMatchObject({ _tag: "VerificationUnavailable", scheme: "ZkLogin", retryable: true })
    expect(await verdict(rpc("PERMISSION_DENIED"))).toMatchObject({ _tag: "VerificationUnavailable", retryable: false })
  })
})
