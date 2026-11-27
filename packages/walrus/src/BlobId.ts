/**
 * Blob ids (E5, E6): 32 bytes, shown as 43 characters of URL-safe base64
 * without padding, and passed to Move as the `u256` read little-endian.
 */
import { blake2b } from "@noble/hashes/blake2.js"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import type * as Brand from "effect/Brand"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

/** 43-char URL-safe base64 (no padding) of 32 bytes. */
export type BlobId = string & Brand.Brand<"BlobId">

export const LENGTH = 32

/** `InvalidBlobId` lives here (not in `Errors.ts`) so that `Errors.ts` can import `BlobId` without a cycle. */
export class InvalidBlobId extends /* @__PURE__ */ Schema.TaggedError<InvalidBlobId>()("InvalidBlobId", {
  input: Schema.String
}) {
  override get message(): string {
    return `invalid blob id ${JSON.stringify(this.input.length > 64 ? this.input.slice(0, 64) + "…" : this.input)}`
  }
}

// 32 bytes = 256 bits = 42 full sextets + 4 bits, so the last character carries
// 4 data bits and 2 zero bits: it must be one of A,E,I,...,w,0,4,8 (index % 4 === 0).
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/

const isBlobId = (s: string): boolean => PATTERN.test(s)

/** Decoding checks the length, the alphabet and that the unused trailing bits are zero (canonical form). */
export const BlobId: Schema.Codec<BlobId, string> = /* @__PURE__ */ Schema.String.pipe(
  Schema.check(Schema.makeFilter((s: string) => isBlobId(s) || "expected 43 characters of URL-safe base64 (32 bytes)")),
  Schema.brand("BlobId")
) as any

const encode64 = (bytes: Uint8Array): string => {
  let out = ""
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!
  }
  return out
}

const decode64 = (s: string): Uint8Array => {
  const out = new Uint8Array(LENGTH)
  let acc = 0
  let bits = 0
  let o = 0
  for (const c of s) {
    acc = (acc << 6) | ALPHABET.indexOf(c)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

export const fromBytes = (bytes: Uint8Array): Result.Result<BlobId, InvalidBlobId> =>
  bytes.length === LENGTH
    ? Result.succeed(encode64(bytes) as BlobId)
    : Result.fail(new InvalidBlobId({ input: `${bytes.length} bytes` }))

/** Parse text someone handed you. */
export const fromString = (s: string): Result.Result<BlobId, InvalidBlobId> =>
  isBlobId(s) ? Result.succeed(s as BlobId) : Result.fail(new InvalidBlobId({ input: s }))

export const toBytes = (id: BlobId): Uint8Array => decode64(id)

/** Little-endian, as on chain (E6). */
export const fromU256 = (n: bigint): BlobId => {
  const bytes = new Uint8Array(LENGTH)
  let v = n
  for (let i = 0; i < LENGTH; i++) {
    bytes[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return encode64(bytes) as BlobId
}

export const toU256 = (id: BlobId): bigint => {
  const bytes = decode64(id)
  let n = 0n
  for (let i = LENGTH - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!)
  return n
}

/** `blake2b256(encodingType u8 || unencodedLength u64 LE || merkleRoot)` (E5). */
export const derive = (encodingType: number, unencodedLength: bigint, merkleRoot: Uint8Array): BlobId => {
  const input = new Uint8Array(1 + 8 + merkleRoot.length)
  input[0] = encodingType
  new DataView(input.buffer).setBigUint64(1, unencodedLength, true)
  input.set(merkleRoot, 9)
  return encode64(blake2b(input, { dkLen: 32 })) as BlobId
}

/** The blob id as its 32 raw BCS bytes (the layout of `BlobMetadataWithId.blob_id` and of a confirmation). */
export const Bcs32: Bcs.BcsSchema<BlobId, Uint8Array> = /* @__PURE__ */ Bcs.transform(
  Bcs.bytes(LENGTH),
  Schema.toType(BlobId),
  { decode: (b: Uint8Array) => encode64(b) as BlobId, encode: (id: BlobId) => decode64(id) }
)
