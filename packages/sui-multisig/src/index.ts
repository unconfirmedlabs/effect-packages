/**
 * Multisig for `@unconfirmed/sui`.
 *
 * Composes with every other scheme instead of knowing about them:
 * - `scheme` verifies each member through the registry it is handed, so a
 *   2-of-3 of Ed25519 + passkey + Ledger verifies exactly when those schemes
 *   are installed, and is a typed `UnsupportedScheme` otherwise.
 * - `signer` combines any `Signer`s (in-memory, hardware, remote, wallet) into
 *   one `Signer`, which then works anywhere a `Signer` does (`Tx.run`, ...).
 *
 *   const pk = yield* MultiSig.publicKey({ members: [{ publicKey: a.publicKey, weight: 1 }, ...], threshold: 2 })
 *   const signer = yield* MultiSig.signer(pk, [a, b])
 */
import * as Bcs from "@unconfirmed/bcs/Bcs"
import * as Address from "@unconfirmed/sui/Address"
import * as Hash from "@unconfirmed/sui/Hash"
import * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Signer from "@unconfirmed/sui/Signer"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

export const FLAG = 0x03
const MAX_MEMBERS = 10

// -----------------------------------------------------------------------------
// BCS (variant order is Sui's: validators hash it)
// -----------------------------------------------------------------------------

/** Member schemes by flag, in the `PublicKey` / `CompressedSignature` enum order. */
const VARIANTS = [
  { flag: 0x00, name: "ED25519", pk: Bcs.bytes(32), sig: Bcs.bytes(64), sigLength: 64 },
  { flag: 0x01, name: "Secp256k1", pk: Bcs.bytes(33), sig: Bcs.bytes(64), sigLength: 64 },
  { flag: 0x02, name: "Secp256r1", pk: Bcs.bytes(33), sig: Bcs.bytes(64), sigLength: 64 },
  { flag: 0x05, name: "ZkLogin", pk: Bcs.byteVector, sig: Bcs.byteVector, sigLength: undefined },
  { flag: 0x06, name: "Passkey", pk: Bcs.bytes(33), sig: Bcs.byteVector, sigLength: undefined },
  { flag: 0x07, name: "MLDSA65", pk: Bcs.bytes(1952), sig: Bcs.bytes(3309), sigLength: 3309 }
] as const

const byFlag = new Map<number, (typeof VARIANTS)[number]>(VARIANTS.map((v) => [v.flag, v]))
const byName = new Map<string, (typeof VARIANTS)[number]>(VARIANTS.map((v) => [v.name, v]))

const PublicKeyBcs = Bcs.enum(Object.fromEntries(VARIANTS.map((v) => [v.name, v.pk])) as Record<string, Schema.Top>)
const CompressedSignatureBcs = Bcs.enum(
  Object.fromEntries(VARIANTS.map((v) => [v.name, v.sig])) as Record<string, Schema.Top>
)

export const MultiSigPublicKeyBcs = Bcs.struct({
  pkMap: Bcs.vector(Bcs.struct({ pubKey: PublicKeyBcs, weight: Bcs.u8 })),
  threshold: Bcs.u16
})

export const MultiSigBcs = Bcs.struct({
  sigs: Bcs.vector(CompressedSignatureBcs),
  bitmap: Bcs.u16,
  multisigPk: MultiSigPublicKeyBcs
})

// -----------------------------------------------------------------------------
// Public key
// -----------------------------------------------------------------------------

export interface Member {
  readonly publicKey: SignatureScheme.PublicKey
  readonly weight: number
}

export interface MultiSigPublicKey {
  readonly members: ReadonlyArray<Member>
  readonly threshold: number
}

export class InvalidMultiSig extends Schema.TaggedError<InvalidMultiSig>()("InvalidMultiSig", {
  reason: Schema.String
}) {}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** Validate a member set and threshold. */
export const publicKey = (input: MultiSigPublicKey): Effect.Effect<MultiSigPublicKey, InvalidMultiSig> => {
  const fail = (reason: string) => Effect.fail(new InvalidMultiSig({ reason }))
  const { members, threshold } = input
  if (members.length === 0 || members.length > MAX_MEMBERS) return fail(`1 to ${MAX_MEMBERS} members, got ${members.length}`)
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 0xffff) return fail(`invalid threshold ${threshold}`)
  let total = 0
  for (const [i, m] of members.entries()) {
    if (!byFlag.has(m.publicKey.flag)) return fail(`member ${i}: flag ${m.publicKey.flag} cannot be a multisig member`)
    if (!Number.isInteger(m.weight) || m.weight < 1 || m.weight > 255) return fail(`member ${i}: invalid weight ${m.weight}`)
    if (members.slice(0, i).some((o) => o.publicKey.flag === m.publicKey.flag && sameBytes(o.publicKey.bytes, m.publicKey.bytes))) {
      return fail(`member ${i}: duplicate public key`)
    }
    total += m.weight
  }
  if (threshold > total) return fail(`threshold ${threshold} exceeds total weight ${total}`)
  return Effect.succeed(input)
}

const toBcs = (pk: MultiSigPublicKey): typeof MultiSigPublicKeyBcs.Type => ({
  pkMap: pk.members.map((m) => ({ pubKey: { _tag: byFlag.get(m.publicKey.flag)!.name, value: m.publicKey.bytes } as any, weight: m.weight })),
  threshold: pk.threshold
})

const fromBcs = (b: typeof MultiSigPublicKeyBcs.Type): MultiSigPublicKey => ({
  members: b.pkMap.map((m) => {
    const pub = m.pubKey as unknown as { _tag: string; value: Uint8Array }
    return { publicKey: { flag: byName.get(pub._tag)!.flag, bytes: pub.value }, weight: m.weight }
  }),
  threshold: b.threshold
})

/** `blake2b256(0x03 || threshold:u16le || (flag || pk || weight)*)`. */
export const address = (pk: MultiSigPublicKey): Address.Address => {
  const parts: Array<number> = [FLAG, pk.threshold & 0xff, pk.threshold >> 8]
  for (const m of pk.members) parts.push(...SignatureScheme.toSuiBytes(m.publicKey), m.weight)
  return Address.fromBytes(Hash.blake2b256(Uint8Array.from(parts)))
}

/** The multisig as a `PublicKey` (flag 0x03, BCS `MultiSigPublicKey`). */
export const toPublicKey = (pk: MultiSigPublicKey): SignatureScheme.PublicKey => ({
  flag: FLAG,
  bytes: Bcs.encodeSync(MultiSigPublicKeyBcs)(toBcs(pk))
})

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

const indices = (bitmap: number) => Array.from({ length: 16 }, (_, i) => i).filter((i) => (bitmap & (1 << i)) !== 0)

const invalid = (reason: string) => new SignatureScheme.InvalidSignature({ scheme: "MultiSig", reason })

export const scheme: SignatureScheme.SignatureScheme = {
  name: "MultiSig",
  flag: FLAG,
  address: (bytes) => address(fromBcs(Bcs.decodeSync(MultiSigPublicKeyBcs)(bytes))),
  verify: (body, intentMessage, registry) =>
    Effect.gen(function*() {
      const parsed = Bcs.decode(MultiSigBcs)(body)
      if (Result.isFailure(parsed)) return yield* invalid(`malformed: ${parsed.failure.message}`)
      const { sigs, bitmap, multisigPk } = parsed.success
      const pk = fromBcs(multisigPk)
      // Validators reject what `publicKey` rejects (threshold 0, zero weights, duplicates, > 10 members).
      const valid = yield* Effect.result(publicKey(pk))
      if (Result.isFailure(valid)) return yield* invalid(`invalid multisig public key: ${valid.failure.reason}`)
      const signers = indices(bitmap)
      if (signers.length !== sigs.length) return yield* invalid("bitmap does not match the signature count")
      let weight = 0
      for (const [i, memberIndex] of signers.entries()) {
        const member = pk.members[memberIndex]
        if (!member) return yield* invalid(`bitmap names member ${memberIndex}, which does not exist`)
        const memberScheme = yield* registry.get(member.publicKey.flag)
        if (!memberScheme.verifyMember) return yield* invalid(`${memberScheme.name} cannot verify as a multisig member`)
        const sig = (sigs[i] as unknown as { value: Uint8Array }).value
        yield* memberScheme.verifyMember(member.publicKey.bytes, sig, intentMessage, registry)
        weight += member.weight
      }
      if (weight < pk.threshold) return yield* invalid(`weight ${weight} is below threshold ${pk.threshold}`)
      return { flag: FLAG, bytes: Bcs.encodeSync(MultiSigPublicKeyBcs)(multisigPk) }
    })
}

// -----------------------------------------------------------------------------
// Signing
// -----------------------------------------------------------------------------

/**
 * A member's serialized signature (`flag || body`) reduced to the compressed
 * form multisig stores: the bare signature for fixed-size schemes, and the
 * whole serialized signature, flag included, for zkLogin and passkey (as Sui
 * and `@mysten/sui` do).
 */
const compress = (serialized: Uint8Array): Effect.Effect<{ flag: number; signature: Uint8Array }, InvalidMultiSig> => {
  const flag = serialized[0]
  const v = flag === undefined ? undefined : byFlag.get(flag)
  if (flag === undefined || !v) return Effect.fail(new InvalidMultiSig({ reason: `flag ${flag} cannot be a multisig member` }))
  return Effect.succeed({ flag, signature: v.sigLength === undefined ? serialized.slice() : serialized.slice(1, 1 + v.sigLength) })
}

const assemble = (pk: MultiSigPublicKey, parts: ReadonlyArray<{ index: number; flag: number; signature: Uint8Array }>) => {
  const sorted = [...parts].sort((a, b) => a.index - b.index)
  const body = Bcs.encodeSync(MultiSigBcs)({
    sigs: sorted.map((p) => ({ _tag: byFlag.get(p.flag)!.name, value: p.signature }) as any),
    bitmap: sorted.reduce((b, p) => b | (1 << p.index), 0),
    multisigPk: toBcs(pk)
  })
  const out = new Uint8Array(1 + body.length)
  out[0] = FLAG
  out.set(body, 1)
  return out
}

/** A partial signature for `combine`, optionally naming the member that made it. */
export type PartialSignature =
  | Uint8Array
  | { readonly signature: Uint8Array; readonly publicKey: SignatureScheme.PublicKey }

/**
 * Combine signatures that members produced separately (multi-party flows).
 * A bare single-key signature (Ed25519, Secp256k1/r1, ML-DSA-65) is matched by
 * the public key it embeds. zkLogin and passkey signatures don't carry a key in
 * that form, so pass them as `{ signature, publicKey }` naming their member.
 */
export const combine = (pk: MultiSigPublicKey, signatures: ReadonlyArray<PartialSignature>) =>
  Effect.forEach(signatures, (entry) =>
    Effect.gen(function*() {
      const serialized = entry instanceof Uint8Array ? entry : entry.signature
      const { flag, signature } = yield* compress(serialized)
      let claimed: SignatureScheme.PublicKey
      if (entry instanceof Uint8Array) {
        if (byFlag.get(flag)!.sigLength === undefined) {
          return yield* new InvalidMultiSig({ reason: `a ${byFlag.get(flag)!.name} signature must name its member: pass { signature, publicKey }` })
        }
        claimed = { flag, bytes: serialized.subarray(1 + signature.length) }
      } else {
        claimed = entry.publicKey
        if (claimed.flag !== flag) return yield* new InvalidMultiSig({ reason: "signature scheme does not match the named member" })
      }
      const index = pk.members.findIndex((m) => m.publicKey.flag === flag && sameBytes(m.publicKey.bytes, claimed.bytes))
      if (index < 0) return yield* new InvalidMultiSig({ reason: "signature from a key that is not a member" })
      return { index, flag, signature }
    })).pipe(
      Effect.flatMap((parts) =>
        new Set(parts.map((p) => p.index)).size === parts.length
          ? Effect.succeed(assemble(pk, parts))
          : Effect.fail(new InvalidMultiSig({ reason: "two signatures from the same member" }))
      )
    )

/** One `Signer` from member signers. They sign concurrently. */
export const signer = (
  pk: MultiSigPublicKey,
  signers: ReadonlyArray<Signer.Signer>
): Effect.Effect<Signer.Signer, InvalidMultiSig> => {
  const members = signers.map((s) =>
    pk.members.findIndex((m) => m.publicKey.flag === s.publicKey.flag && sameBytes(m.publicKey.bytes, s.publicKey.bytes))
  )
  if (members.some((i) => i < 0)) return Effect.fail(new InvalidMultiSig({ reason: "a signer is not a member" }))
  if (new Set(members).size !== members.length) return Effect.fail(new InvalidMultiSig({ reason: "duplicate signer" }))
  const weight = members.reduce((w, i) => w + pk.members[i]!.weight, 0)
  if (weight < pk.threshold) {
    return Effect.fail(new InvalidMultiSig({ reason: `signers' weight ${weight} is below threshold ${pk.threshold}` }))
  }
  return Effect.succeed({
    address: address(pk),
    publicKey: toPublicKey(pk),
    sign: (intentMessage) =>
      Effect.forEach(signers, (s, i) =>
        s.sign(intentMessage).pipe(
          Effect.flatMap((serialized) =>
            compress(serialized).pipe(
              Effect.mapError((e) => new Signer.SigningError({ reason: "failed", message: e.reason }))
            )
          ),
          Effect.map((c) => ({ index: members[i]!, ...c }))
        ), { concurrency: "unbounded" }).pipe(Effect.map((parts) => assemble(pk, parts)))
  })
}
