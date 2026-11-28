/**
 * Signature schemes are plugins.
 *
 * The core knows how to *dispatch* on a signature's flag byte but knows no
 * scheme except the ones you give it. `SignatureSchemes.layer(Ed25519.scheme,
 * Secp256k1.scheme, MultiSig.scheme)` builds the registry; anything not in it
 * is a typed `UnsupportedScheme`, and its code never reaches your bundle.
 *
 * A scheme may need services (zkLogin needs the current epoch and JWKs from
 * the chain). Its requirements surface on the layer: `SignatureSchemes.layer(
 * ZkLogin.scheme)` is a `Layer<SignatureSchemes, never, Chain>`, so the
 * program will not compile until a `Chain` is provided.
 *
 * Composite schemes (multisig) verify their members through the registry they
 * are handed, so a multisig of passkeys works exactly when the passkey scheme
 * is installed.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Address from "./Address.ts"

/** A public key as Sui sees it: the scheme's flag byte and the raw key bytes. */
export interface PublicKey {
  readonly flag: number
  readonly bytes: Uint8Array
}

/** `flag || bytes`, as used in multisig address derivation. */
export const toSuiBytes = (pk: PublicKey): Uint8Array => {
  const out = new Uint8Array(1 + pk.bytes.length)
  out[0] = pk.flag
  out.set(pk.bytes, 1)
  return out
}

export class InvalidSignature extends /* @__PURE__ */ Schema.TaggedError<InvalidSignature>()("InvalidSignature", {
  scheme: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `invalid ${this.scheme} signature: ${this.reason}`
  }
}

export class UnsupportedScheme extends /* @__PURE__ */ Schema.TaggedError<UnsupportedScheme>()("UnsupportedScheme", {
  flag: Schema.Number
}) {
  override get message() {
    return `no signature scheme with flag 0x${this.flag.toString(16).padStart(2, "0")} is installed`
  }
}

/**
 * Verification could not be decided: a scheme that needs a service (zkLogin
 * asks a node) couldn't reach it. Not a verdict on the signature; retry when
 * `retryable`.
 */
export class VerificationUnavailable extends /* @__PURE__ */ Schema.TaggedError<VerificationUnavailable>()("VerificationUnavailable", {
  scheme: Schema.String,
  reason: Schema.String,
  retryable: Schema.Boolean
}) {
  override get message(): string {
    return `cannot verify ${this.scheme} signature: ${this.reason}`
  }
}

/**
 * `InvalidSignature`: the signature is wrong. `UnsupportedScheme`: its scheme
 * isn't installed. `VerificationUnavailable`: no verdict (a service the scheme
 * needs failed).
 */
export type VerifyError = InvalidSignature | UnsupportedScheme | VerificationUnavailable

export interface SignatureScheme<R = never> {
  readonly name: string
  readonly flag: number
  /**
   * Verify a serialized signature's body (everything after the flag byte)
   * over an intent message; answer the signer's public key.
   */
  readonly verify: (
    body: Uint8Array,
    intentMessage: Uint8Array,
    schemes: Registry
  ) => Effect.Effect<PublicKey, VerifyError, R>
  /**
   * Verify a multisig member's signature against its public key. `signature`
   * is the member's `CompressedSignature` payload exactly as Sui stores it:
   * the bare signature for fixed-size schemes (Ed25519, Secp256k1/r1,
   * ML-DSA-65), and the FULL serialized signature, flag byte included
   * (`0x05 || body`, `0x06 || body`), for zkLogin and passkey members.
   */
  readonly verifyMember?: (
    publicKey: Uint8Array,
    signature: Uint8Array,
    intentMessage: Uint8Array,
    schemes: Registry
  ) => Effect.Effect<void, VerifyError, R>
  /** The address of a public key, when it is not `blake2b256(flag || bytes)` (zkLogin). */
  readonly address?: (publicKey: Uint8Array) => Address.Address
  /**
   * Every address a public key may own, when there is more than one (zkLogin's
   * legacy and current derivations). `Verify.*({ address })` accepts any of
   * them. Defaults to `[address(publicKey)]`.
   */
  readonly addresses?: (publicKey: Uint8Array) => ReadonlyArray<Address.Address>
}

export interface Registry {
  readonly get: (flag: number) => Effect.Effect<SignatureScheme, UnsupportedScheme>
  readonly flags: ReadonlyArray<number>
}

type Requirements<S extends ReadonlyArray<SignatureScheme<any>>> = [S[number]] extends [never] ? never
  : S[number] extends SignatureScheme<infer R> ? R
  : never

export class SignatureSchemes extends /* @__PURE__ */ Context.Service<SignatureSchemes, Registry>()(
  "@unconfirmed/sui/SignatureSchemes"
) {
  /**
   * A registry of exactly these schemes. Later entries win on a flag clash.
   * The schemes' requirements are captured when the layer is built.
   */
  static layer<const S extends ReadonlyArray<SignatureScheme<any>>>(
    ...schemes: S
  ): Layer.Layer<SignatureSchemes, never, Requirements<S>> {
    return Layer.effect(
      SignatureSchemes,
      Effect.gen(function*() {
        const context = yield* Effect.context<Requirements<S>>()
        const byFlag = new Map<number, SignatureScheme>()
        for (const s of schemes) {
          const member = s.verifyMember
          byFlag.set(s.flag, {
            name: s.name,
            flag: s.flag,
            ...(s.address && { address: s.address }),
            ...(s.addresses && { addresses: s.addresses }),
            verify: (body, msg, reg) => Effect.provideContext(s.verify(body, msg, reg), context) as Effect.Effect<PublicKey, VerifyError>,
            ...(member && {
              verifyMember: (pk: Uint8Array, sig: Uint8Array, msg: Uint8Array, reg: Registry) =>
                Effect.provideContext(member(pk, sig, msg, reg), context) as Effect.Effect<void, VerifyError>
            })
          })
        }
        return {
          flags: [...byFlag.keys()],
          get: (flag) => {
            const s = byFlag.get(flag)
            return s ? Effect.succeed(s) : Effect.fail(new UnsupportedScheme({ flag }))
          }
        }
      })
    )
  }
}

/** The address of a public key, using its scheme's rule. */
export const addressOf = (pk: PublicKey) =>
  Effect.flatMap(Effect.service(SignatureSchemes), (r) => r.get(pk.flag)).pipe(
    Effect.map((s) => s.address?.(pk.bytes) ?? Address.fromPublicKey(pk.flag, pk.bytes))
  )
