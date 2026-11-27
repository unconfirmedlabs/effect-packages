/**
 * The registry: only installed schemes verify; requirements surface on the layer.
 */
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Ed25519, SignatureScheme, Signer, Verify } from "../src/index.ts"

const { SignatureSchemes } = SignatureScheme
const msg = new TextEncoder().encode("hi")

describe("SignatureSchemes", () => {
  test("verifies an installed scheme and names the signer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const s = yield* Ed25519.generate
        const { signature } = yield* Signer.signPersonalMessage(s, msg)
        const v = yield* Verify.personalMessage(msg, signature, { address: s.address })
        return v.address === s.address
      }).pipe(Effect.provide(SignatureSchemes.layer(Ed25519.scheme)))
    )
    expect(result).toBe(true)
  })

  test("an uninstalled scheme is UnsupportedScheme", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const s = yield* Ed25519.generate
        const { signature } = yield* Signer.signPersonalMessage(s, msg)
        return yield* Verify.personalMessage(msg, signature)
      }).pipe(Effect.flip, Effect.provide(SignatureSchemes.layer()))
    )
    expect(error._tag).toBe("UnsupportedScheme")
  })

  test("a tampered message is InvalidSignature", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const s = yield* Ed25519.generate
        const { signature } = yield* Signer.signPersonalMessage(s, msg)
        return yield* Verify.personalMessage(new TextEncoder().encode("ho"), signature)
      }).pipe(Effect.flip, Effect.provide(SignatureSchemes.layer(Ed25519.scheme)))
    )
    expect(error._tag).toBe("InvalidSignature")
  })

  test("a scheme's requirements become the layer's requirements", async () => {
    // A scheme that needs a service (as zkLogin needs chain state).
    class Jwks extends Context.Service<Jwks, { readonly allow: boolean }>()("test/Jwks") {}
    const needsJwks: SignatureScheme.SignatureScheme<Jwks> = {
      name: "Test",
      flag: 0x42,
      verify: () =>
        Effect.flatMap(Effect.service(Jwks), (j) =>
          j.allow
            ? Effect.succeed({ flag: 0x42, bytes: new Uint8Array(32) })
            : Effect.fail(new SignatureScheme.InvalidSignature({ scheme: "Test", reason: "denied" })))
    }
    const layer = SignatureSchemes.layer(Ed25519.scheme, needsJwks)
    // @ts-expect-error -- Jwks is still required
    const _unprovided: Layer.Layer<SignatureScheme.SignatureSchemes> = layer
    const provided = layer.pipe(Layer.provide(Layer.succeed(Jwks, { allow: true })))
    const v = await Effect.runPromise(
      Verify.signature(new Uint8Array([0x42]), msg).pipe(Effect.provide(provided))
    )
    expect(v.publicKey.flag).toBe(0x42)
  })
})
