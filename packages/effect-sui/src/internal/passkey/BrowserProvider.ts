/**
 * The browser authenticator: `navigator.credentials` with the same WebAuthn
 * options as `@mysten/sui`'s `BrowserPasskeyProvider` (ES256 only, resident
 * key and user verification required, cross-platform attachment by default,
 * 60 s timeout), so passkeys created by either work with both.
 *
 *   const provider = BrowserProvider.browserProvider("My app", { rp: { id: location.hostname } })
 *
 * Cancelling the prompt (or letting it time out) is `SigningError` reason
 * `"rejected"`; no WebAuthn in this environment is `"unavailable"`.
 * Interrupting the effect aborts the prompt. Requests through one provider
 * are asked one at a time, as WebAuthn allows a single pending prompt.
 */
import * as Signer from "@unconfirmed/sui/Signer"
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import type * as Passkey from "./Passkey.ts"

type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T
type DeepPartialKeys = "rp" | "user" | "authenticatorSelection"

/** As `@mysten/sui`'s `BrowserPasswordProviderOptions`. */
export type BrowserProviderOptions =
  & Pick<DeepPartial<PublicKeyCredentialCreationOptions>, DeepPartialKeys>
  & Omit<Partial<PublicKeyCredentialCreationOptions>, DeepPartialKeys | "pubKeyCredParams" | "challenge">

const CREATE_CHALLENGE = new TextEncoder().encode("Create passkey wallet on Sui")

const credentials = (): CredentialsContainer | undefined =>
  typeof navigator !== "undefined" && navigator.credentials && typeof PublicKeyCredential !== "undefined"
    ? navigator.credentials
    : undefined

const unavailable = () => new Signer.SigningError({ reason: "unavailable", message: "WebAuthn is not available in this environment" })

const toSigningError = (e: unknown): Signer.SigningError => {
  const name = typeof e === "object" && e !== null && "name" in e ? String(e.name) : ""
  const message = e instanceof Error ? e.message : String(e)
  // NotAllowedError: the user cancelled, or the prompt timed out.
  if (name === "NotAllowedError" || name === "AbortError") return new Signer.SigningError({ reason: "rejected", message })
  // NotSupportedError: no ES256 authenticator; SecurityError: insecure context or an rp id this origin can't use.
  if (name === "NotSupportedError" || name === "SecurityError") return new Signer.SigningError({ reason: "unavailable", message })
  return new Signer.SigningError({ reason: "failed", message })
}

const bytes = (b: ArrayBuffer) => new Uint8Array(b)

/** A copy backed by a plain `ArrayBuffer`, as the WebAuthn types require. */
const buffer = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b)

const ask = <A>(
  run: (container: CredentialsContainer, signal: AbortSignal) => Promise<Credential | null>,
  read: (credential: PublicKeyCredential) => A | undefined
): Effect.Effect<A, Signer.SigningError> =>
  Effect.suspend(() => {
    const container = credentials()
    if (!container) return Effect.fail(unavailable())
    return Effect.tryPromise({ try: (signal) => run(container, signal), catch: toSigningError }).pipe(
      Effect.flatMap((credential) => {
        const value = credential === null ? undefined : read(credential as PublicKeyCredential)
        return value === undefined
          ? Effect.fail(new Signer.SigningError({ reason: "failed", message: "the authenticator returned no usable credential" }))
          : Effect.succeed(value)
      })
    )
  })

export const browserProvider = (name: string, options: BrowserProviderOptions = {}): Passkey.Provider => {
  // WebAuthn allows one pending request: a second prompt while one is open fails with NotAllowedError, which
  // reads as the user cancelling. Requests through this provider (e.g. two passkey members of a multisig, which
  // `MultiSig.signer` and `Tx.sign` ask concurrently) wait their turn instead.
  const serial = Semaphore.withPermit(Semaphore.makeUnsafe(1))
  return {
    create: () =>
      serial(ask(
        (container, signal) =>
          container.create({
            signal,
            publicKey: {
              timeout: options.timeout ?? 60_000,
              ...options,
              rp: { name, ...options.rp },
              user: {
                name,
                displayName: name,
                ...options.user,
                id: crypto.getRandomValues(new Uint8Array(10))
              },
              challenge: CREATE_CHALLENGE,
              pubKeyCredParams: [{ alg: -7, type: "public-key" }],
              authenticatorSelection: {
                authenticatorAttachment: "cross-platform",
                residentKey: "required",
                requireResidentKey: true,
                userVerification: "required",
                ...options.authenticatorSelection
              }
            } as PublicKeyCredentialCreationOptions
          }),
        (credential) => {
          const response = credential.response as AuthenticatorAttestationResponse
          const spki = typeof response.getPublicKey === "function" ? response.getPublicKey() : null
          return spki ? { id: bytes(credential.rawId), publicKey: bytes(spki) } : undefined
        }
      )),
    get: (challenge, credentialId) =>
      serial(ask(
        (container, signal) =>
          container.get({
            signal,
            publicKey: {
              challenge: buffer(challenge),
              // Mysten leaves rpId to the browser's default; pass it when the passkey was created for an explicit rp id.
              ...(options.rp?.id !== undefined && { rpId: options.rp.id }),
              userVerification: options.authenticatorSelection?.userVerification || "required",
              timeout: options.timeout ?? 60_000,
              ...(credentialId && { allowCredentials: [{ type: "public-key", id: buffer(credentialId) }] })
            }
          }),
        (credential) => {
          const response = credential.response as AuthenticatorAssertionResponse
          return {
            credentialId: bytes(credential.rawId),
            authenticatorData: bytes(response.authenticatorData),
            clientDataJSON: bytes(response.clientDataJSON),
            signature: bytes(response.signature)
          }
        }
      ))
  }
}
