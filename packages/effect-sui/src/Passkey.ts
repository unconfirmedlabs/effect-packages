/**
 * Passkeys for `@unconfirmed/effect-sui`.
 *
 *   import * as Passkey from "@unconfirmed/effect-sui/Passkey"
 *   SignatureSchemes.layer(Ed25519.scheme, Passkey.scheme)
 *   const signer = yield* Passkey.create(Passkey.browserProvider("My app"))
 */
export * from "./internal/passkey/BrowserProvider.ts"
export * from "./internal/passkey/Passkey.ts"
export * from "./internal/passkey/SoftwareProvider.ts"
