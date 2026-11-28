/**
 * Storage certificates (M2, M3): the aggregate of the signers' BLS signatures
 * over one identical confirmation message.
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { CertificateInvalid } from "./Errors.ts"
import * as Messages from "./Messages.ts"

export interface Certificate {
  /** The epoch in `serializedMessage`. */
  readonly epoch: number
  /** Committee member indices (positions in `System…committee.members`), ascending. */
  readonly signers: ReadonlyArray<number>
  readonly serializedMessage: Uint8Array
  /** 96-byte BLS12-381 min-pk aggregate signature. */
  readonly signature: Uint8Array
}

/** JSON form: byte fields in base64, so `Schema.encode(Certificate)` gives plain JSON (for saved write steps). */
export const Certificate: Schema.Codec<
  Certificate,
  { readonly epoch: number; readonly signers: ReadonlyArray<number>; readonly serializedMessage: string; readonly signature: string }
> = /* @__PURE__ */ Schema.Struct({
  epoch: Schema.Number,
  signers: Schema.Array(Schema.Number),
  serializedMessage: Schema.Uint8ArrayFromBase64,
  signature: Schema.Uint8ArrayFromBase64
}) as any

/**
 * Assemble a certificate from its wire parts (a relay's response, R4, or an
 * aggregate the client built), reading the epoch out of the message. Checks
 * the message is a blob confirmation and the signers are distinct; sorts them ascending.
 */
export const fromParts = (parts: {
  readonly signers: ReadonlyArray<number>
  readonly serializedMessage: Uint8Array
  readonly signature: Uint8Array
}): Result.Result<Certificate, CertificateInvalid> => {
  const fail = (reason: string) => Result.fail(new CertificateInvalid({ reason }))
  const m = parts.serializedMessage
  if (m.length < 7) return fail("message too short")
  const { type, version, appId } = Messages.BLOB_CERT_INTENT
  if (m[0] !== type || m[1] !== version || m[2] !== appId) return fail("message is not a blob confirmation")
  for (let i = 0; i < parts.signers.length; i++) {
    const s = parts.signers[i]!
    if (!Number.isInteger(s) || s < 0 || s > 0xffff) return fail(`invalid signer index ${s}`)
  }
  const signers = [...parts.signers].sort((a, b) => a - b)
  if (signers.some((s, i) => i > 0 && s === signers[i - 1])) return fail("duplicate signer")
  const epoch = new DataView(m.buffer, m.byteOffset + 3, 4).getUint32(0, true)
  return Result.succeed({
    epoch,
    signers,
    serializedMessage: m,
    signature: parts.signature
  })
}

/**
 * The signers as the on-chain bitmap (M3): bit `i % 8` of byte `⌊i / 8⌋`,
 * `⌈members / 8⌉` bytes. Throws `RangeError` on an index `>= members`
 * (a certificate that reaches this point has been verified, so that is a bug).
 */
export const signersBitmap = (signers: ReadonlyArray<number>, members: number): Uint8Array => {
  const bitmap = new Uint8Array(Math.ceil(members / 8))
  for (const s of signers) {
    if (!Number.isInteger(s) || s < 0 || s >= members) throw new RangeError(`signer ${s} out of range for ${members} members`)
    bitmap[s >> 3]! |= 1 << (s & 7)
  }
  return bitmap
}
