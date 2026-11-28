/**
 * Signed bytes: the one representation of "a transaction that may be on the
 * wire", shared by the journal, `SubmissionUnknown` and every lifecycle
 * function. Everything else (sender, expiration, pinned objects) is read back
 * out of the bytes, so what is reasoned about is what was signed.
 */
import * as Bcs from "@unconfirmed/effect-bcs/Bcs"
import * as Hash from "../Hash.ts"
import * as T from "../TransactionData.ts"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

export const SignedTransaction = Schema.Struct({
  /** `Hash.transactionDigest(bytes)`; identical bytes have one digest and execute at most once. */
  digest: Schema.String,
  bytes: Schema.Uint8ArrayFromBase64,
  signatures: Schema.Array(Schema.Uint8ArrayFromBase64),
  /**
   * The chain id the bytes were built against, for the expiration variants that
   * name none (`None`, `Epoch`). `ValidDuring` / `Validity` carry their own.
   */
  chain: Schema.optionalKey(Schema.String)
})
export type SignedTransaction = typeof SignedTransaction.Type

/** Bundle signed bytes; the digest is computed, never trusted from outside. */
export const make = (
  bytes: Uint8Array,
  signatures: ReadonlyArray<Uint8Array>,
  options?: { readonly chain?: string }
): SignedTransaction => ({
  digest: Hash.transactionDigest(bytes),
  bytes,
  signatures,
  ...(options?.chain !== undefined && { chain: options.chain })
})

const decodeData = T.decode

/** The transaction data inside the bytes, if they parse. */
export const dataOf = (signed: SignedTransaction): Option.Option<T.TransactionData> =>
  Result.match(decodeData(signed.bytes), { onSuccess: Option.some, onFailure: () => Option.none() })

export const expirationOf = (signed: SignedTransaction): T.TransactionExpiration | undefined =>
  Option.match(dataOf(signed), { onNone: () => undefined, onSome: (d) => d.expiration })

/** The last epoch the bytes may execute in, when the expiration says. */
export const maxEpochOf = (expiration: T.TransactionExpiration | undefined): bigint | undefined => {
  switch (expiration?._tag) {
    case "Epoch":
      return expiration.value
    case "ValidDuring":
    case "Validity":
      return Option.getOrUndefined(expiration.maxEpoch)
    default:
      return undefined
  }
}

/** The first epoch the bytes may execute in (genesis when unbounded). */
export const minEpochOf = (expiration: T.TransactionExpiration | undefined): bigint | undefined =>
  expiration?._tag === "ValidDuring" || expiration?._tag === "Validity"
    ? Option.getOrUndefined(expiration.minEpoch)
    : undefined

/** The chain the bytes belong to: the one the expiration names, else the recorded one. */
export const chainOf = (signed: SignedTransaction): string | undefined => {
  const expiration = expirationOf(signed)
  return expiration?._tag === "ValidDuring" || expiration?._tag === "Validity" ? expiration.chain : signed.chain
}

export interface PinnedRef {
  readonly objectId: string
  readonly version: bigint
}

const COIN_RESERVATION_MAGIC = 0xac
const COIN_RESERVATION_MAGIC_OFFSET = 12
const encodeDigest = Bcs.encodeSync(T.ObjectDigest)

/**
 * A synthetic gas ref drawing on an address balance (version 0, a digest
 * whose last 20 bytes are `0xac`). It names no object and pins nothing.
 */
export const isCoinReservation = (ref: T.ObjectRef): boolean => {
  if (ref.version !== 0n) return false
  const bytes = encodeDigest(ref.digest)
  const digest = bytes.subarray(bytes.length - 32)
  return digest.subarray(COIN_RESERVATION_MAGIC_OFFSET).every((b) => b === COIN_RESERVATION_MAGIC)
}

/**
 * The object versions whose consumption by another transaction proves these
 * bytes can never execute: owned inputs and gas coins. `Receiving` inputs are
 * left out — a transaction can still execute after its receiving object was
 * received elsewhere (the receive fails, the transaction runs), so another
 * transaction consuming one proves nothing about ours.
 */
export const pinnedRefsOf = (signed: SignedTransaction): ReadonlyArray<PinnedRef> =>
  Option.match(dataOf(signed), {
    onNone: () => [],
    onSome: (data) => {
      const out: Array<PinnedRef> = []
      for (const input of data.kind.inputs) {
        if (input._tag !== "Object") continue
        const arg = input.value
        if (arg._tag === "ImmOrOwnedObject") {
          out.push({ objectId: arg.objectId, version: arg.version })
        }
      }
      for (const ref of data.gasData.payment) {
        if (!isCoinReservation(ref)) out.push({ objectId: ref.objectId, version: ref.version })
      }
      return out
    }
  })

/**
 * Whether two transactions from the same sender built concurrently could race
 * over these bytes: any owned or receiving input, or any gas payment ref
 * (coins, or a coin reservation). Bytes that pin none of these — address
 * balance gas, pure / shared / withdrawal inputs — cannot.
 */
export const pinsObjects = (data: T.TransactionData): boolean =>
  data.gasData.payment.length > 0 ||
  data.kind.inputs.some((i) => i._tag === "Object" && (i.value._tag === "ImmOrOwnedObject" || i.value._tag === "Receiving"))

/** `undefined` when the digest is the digest of the bytes, else the computed one. */
export const digestMismatch = (signed: SignedTransaction): string | undefined => {
  const computed = Hash.transactionDigest(signed.bytes)
  return computed === signed.digest ? undefined : computed
}
