/**
 * The registry: only installed schemes verify; requirements surface on the layer.
 */
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Ed25519, SignatureScheme, Signer, Verify } from "../src/index.ts"

const { SignatureSchemes } = SignatureScheme
const msg = new TextEncoder().encode("hi")

describe("SignatureSchemes", () => {
  test("only installed schemes verify: names the signer; uninstalled is UnsupportedScheme; tampered is InvalidSignature", async () => {
    const r = await Effect.runPromise(
      Effect.gen(function*() {
        const s = yield* Ed25519.generate
        const { signature } = yield* Signer.signPersonalMessage(s, msg)
        const v = yield* Verify.personalMessage(msg, signature, { address: s.address })
        const tampered = yield* Effect.flip(Verify.personalMessage(new TextEncoder().encode("ho"), signature))
        const uninstalled = yield* Effect.flip(Verify.personalMessage(msg, signature).pipe(Effect.provide(SignatureSchemes.layer())))
        return { named: v.address === s.address, tampered: tampered._tag, uninstalled: uninstalled._tag }
      }).pipe(Effect.provide(SignatureSchemes.layer(Ed25519.scheme)))
    )
    expect(r).toEqual({ named: true, tampered: "InvalidSignature", uninstalled: "UnsupportedScheme" })
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

test("Ed25519.verifyRaw checks a signature over the message itself (RFC 8032, test 2), as Move's ed25519_verify", async () => {
  const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"))
  const publicKey = hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
  const signature = hex(
    "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
  )
  const message = hex("72")
  // The intent-message path signs blake2b256(message), so the same signature does not verify there.
  const viaScheme = await Effect.runPromise(Effect.exit(Ed25519.scheme.verifyMember!(publicKey, signature, message, undefined as never)))
  expect([Ed25519.verifyRaw(publicKey, message, signature), Ed25519.verifyRaw(publicKey, hex("73"), signature), viaScheme._tag])
    .toEqual([true, false, "Failure"])
})
