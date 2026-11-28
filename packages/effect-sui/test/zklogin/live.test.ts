/**
 * Live: the gRPC verifier against testnet (`SUI_LIVE=1`). A real proof needs a
 * real OAuth login and prover, so this sends a well-formed zkLogin signature
 * whose proof is junk and expects the node's verdict as a typed InvalidSignature.
 */
import * as Theirs from "@mysten/sui/zklogin"
import { Ed25519, SignatureScheme, Signer, Verify } from "@unconfirmed/effect-sui"
import { GrpcWeb } from "@unconfirmed/effect-sui/grpc/GrpcWeb"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { live, TESTNET } from "@unconfirmed/test-support/live"
import * as ZkLogin from "../../src/zklogin/ZkLogin.ts"
import * as ZkLoginVerifierGrpc from "../../src/zklogin/ZkLoginVerifierGrpc.ts"
import { claims, inputs } from "@unconfirmed/test-support/zklogin"

const msg = new TextEncoder().encode("zkLogin live")

const registry = SignatureScheme.SignatureSchemes.layer(Ed25519.scheme, ZkLogin.scheme).pipe(
  Layer.provide(ZkLoginVerifierGrpc.layer),
  Layer.provide(GrpcWeb.layer({ url: TESTNET })),
  Layer.provide(FetchHttpClient.layer)
)

const verdict = (kid?: string) =>
  Effect.runPromise(Effect.gen(function*() {
    const ephemeral = yield* Ed25519.fromSecretKey(new Uint8Array(32).fill(9))
    const signer = yield* ZkLogin.signer({
      ephemeral,
      inputs: inputs(String(Theirs.genAddressSeed(42n, "sub", claims.sub, claims.aud)), kid),
      maxEpoch: 100_000n
    })
    const { signature } = yield* Signer.signPersonalMessage(signer, msg)
    return yield* Effect.flip(Verify.personalMessage(msg, signature, { address: signer.address }))
  }).pipe(Effect.provide(registry)))

describe.skipIf(!live)("ZkLoginVerifierGrpc (testnet)", () => {
  test("an unknown JWK is a typed InvalidSignature", async () => {
    const error = await verdict()
    expect(error._tag).toBe("InvalidSignature")
    expect((error as SignatureScheme.InvalidSignature).reason).toContain("jwk")
  }, 30_000)

  test("a current Google key with a junk proof is a typed InvalidSignature", async () => {
    // Use a kid Google currently publishes, so the node gets past the JWK lookup to the proof.
    const certs = (await (await fetch("https://www.googleapis.com/oauth2/v3/certs")).json()) as { keys: Array<{ kid: string }> }
    const error = await verdict(certs.keys[0]!.kid)
    expect(error._tag).toBe("InvalidSignature")
    console.log("node verdict:", (error as SignatureScheme.InvalidSignature).reason)
  }, 30_000)
})
