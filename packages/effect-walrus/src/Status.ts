/**
 * A storage node's view of a blob (S1, `GET /v1/blobs/{id}/status`), its
 * total order (the Rust `Ord`, `crates/walrus-storage-node-client/src/api.rs:138-200`)
 * and a canonical grouping key.
 */
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

/** A Sui event id. `eventSeq` is a decimal string (the node serialises the `u64` as a string). */
export interface EventId {
  readonly txDigest: string
  readonly eventSeq: string
}

export interface DeletableCounts {
  readonly countDeletableTotal: number
  readonly countDeletableCertified: number
}

export type BlobStatus =
  | { readonly _tag: "Nonexistent" }
  | { readonly _tag: "Invalid"; readonly event: EventId }
  | {
    readonly _tag: "Permanent"
    readonly endEpoch: number
    readonly isCertified: boolean
    readonly statusEvent: EventId
    readonly deletableCounts: DeletableCounts
    readonly initialCertifiedEpoch: number | null
  }
  | {
    readonly _tag: "Deletable"
    readonly initialCertifiedEpoch: number | null
    readonly deletableCounts: DeletableCounts
  }

const Epoch = /* @__PURE__ */ Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 32 - 1 }))
const EventIdSchema = /* @__PURE__ */ Schema.Struct({ txDigest: Schema.String, eventSeq: Schema.String.check(Schema.isPattern(/^\d+$/)) })
const DeletableCountsSchema = /* @__PURE__ */ Schema.Struct({ countDeletableTotal: Epoch, countDeletableCertified: Epoch })

/** The decoded shape as a plain schema (for embedding in errors and other schemas). */
export const BlobStatusType: Schema.Codec<BlobStatus> = /* @__PURE__ */ Schema.Union([
  Schema.TaggedStruct("Nonexistent", {}),
  Schema.TaggedStruct("Invalid", { event: EventIdSchema }),
  Schema.TaggedStruct("Permanent", {
    endEpoch: Epoch,
    isCertified: Schema.Boolean,
    statusEvent: EventIdSchema,
    deletableCounts: DeletableCountsSchema,
    initialCertifiedEpoch: Schema.NullOr(Epoch)
  }),
  Schema.TaggedStruct("Deletable", {
    initialCertifiedEpoch: Schema.NullOr(Epoch),
    deletableCounts: DeletableCountsSchema
  })
]) as any

// -----------------------------------------------------------------------------
// The node's JSON
// -----------------------------------------------------------------------------

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

// Normalise the node's JSON into the decoded shape. Never throws: anything it
// cannot place is passed on as is and rejected by `BlobStatusType`.
const eventFromJson = (u: unknown): unknown =>
  isRecord(u)
    ? { txDigest: u.txDigest, eventSeq: typeof u.eventSeq === "number" ? String(u.eventSeq) : u.eventSeq }
    : u
const countsFromJson = (u: unknown): unknown =>
  isRecord(u)
    ? { countDeletableTotal: u.count_deletable_total, countDeletableCertified: u.count_deletable_certified }
    : u
const optionalEpoch = (u: unknown): unknown => (u === undefined ? null : u)

const fromJson = (u: unknown): unknown => {
  if (u === "nonexistent") return { _tag: "Nonexistent" }
  if (!isRecord(u)) return u
  const keys = Object.keys(u)
  if (keys.length !== 1) return u
  const v = u[keys[0]!]
  if (!isRecord(v)) return u
  switch (keys[0]) {
    case "invalid":
      return { _tag: "Invalid", event: eventFromJson(v.event) }
    case "permanent":
      return {
        _tag: "Permanent",
        endEpoch: v.endEpoch,
        isCertified: v.isCertified,
        statusEvent: eventFromJson(v.statusEvent),
        deletableCounts: countsFromJson(v.deletableCounts),
        initialCertifiedEpoch: optionalEpoch(v.initialCertifiedEpoch)
      }
    case "deletable":
      return {
        _tag: "Deletable",
        initialCertifiedEpoch: optionalEpoch(v.initialCertifiedEpoch),
        deletableCounts: countsFromJson(v.deletableCounts)
      }
    default:
      return u
  }
}

const eventToJson = (e: EventId) => ({ txDigest: e.txDigest, eventSeq: e.eventSeq })
const countsToJson = (c: DeletableCounts) => ({
  count_deletable_total: c.countDeletableTotal,
  count_deletable_certified: c.countDeletableCertified
})

/** The node's JSON for a status, as the node writes it (camelCase, snake_case counts). */
export const toJson = (s: BlobStatus): unknown => {
  switch (s._tag) {
    case "Nonexistent":
      return "nonexistent"
    case "Invalid":
      return { invalid: { event: eventToJson(s.event) } }
    case "Permanent":
      return {
        permanent: {
          endEpoch: s.endEpoch,
          isCertified: s.isCertified,
          statusEvent: eventToJson(s.statusEvent),
          deletableCounts: countsToJson(s.deletableCounts),
          initialCertifiedEpoch: s.initialCertifiedEpoch
        }
      }
    case "Deletable":
      return {
        deletable: {
          initialCertifiedEpoch: s.initialCertifiedEpoch,
          deletableCounts: countsToJson(s.deletableCounts)
        }
      }
  }
}

/** From the node's JSON, including the snake_case counts. A missing `initialCertifiedEpoch` is `null`. */
export const BlobStatus: Schema.Codec<BlobStatus, unknown> = /* @__PURE__ */ Schema.Unknown.pipe(
  Schema.decodeTo(
    BlobStatusType as any,
    SchemaTransformation.transform<unknown, unknown>({ decode: fromJson, encode: (s) => toJson(s as BlobStatus) }) as any
  )
) as any

// -----------------------------------------------------------------------------
// Order, grouping, projection
// -----------------------------------------------------------------------------

const cmp = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0)
const cmpBool = (a: boolean, b: boolean): number => cmp(a ? 1 : 0, b ? 1 : 0)
/** Rust `Option` order (None < Some), then reversed: a smaller epoch ranks higher, and `null` highest. */
const cmpReverseOptionalEpoch = (a: number | null, b: number | null): number => {
  const forward = a === null ? (b === null ? 0 : -1) : b === null ? 1 : cmp(a, b)
  return forward === 0 ? 0 : -forward
}
const cmpCounts = (a: DeletableCounts, b: DeletableCounts): number =>
  cmp(a.countDeletableCertified, b.countDeletableCertified) || cmp(a.countDeletableTotal, b.countDeletableTotal)

const rank = { Nonexistent: 0, Deletable: 1, Permanent: 2, Invalid: 3 } as const

/**
 * The Rust `Ord` (`api.rs:138-200`): `Nonexistent < Deletable < Permanent < Invalid`;
 * two `Invalid` are equal; `Deletable` by (counts, reversed initial epoch);
 * `Permanent` by (certified, end epoch, counts, reversed initial epoch).
 * Counts compare certified first, then total.
 */
export const order = (a: BlobStatus, b: BlobStatus): number => {
  if (a._tag !== b._tag) return cmp(rank[a._tag], rank[b._tag])
  switch (a._tag) {
    case "Nonexistent":
    case "Invalid":
      return 0
    case "Deletable": {
      const o = b as Extract<BlobStatus, { _tag: "Deletable" }>
      return cmpCounts(a.deletableCounts, o.deletableCounts) ||
        cmpReverseOptionalEpoch(a.initialCertifiedEpoch, o.initialCertifiedEpoch)
    }
    case "Permanent": {
      const o = b as Extract<BlobStatus, { _tag: "Permanent" }>
      return cmpBool(a.isCertified, o.isCertified) ||
        cmp(a.endEpoch, o.endEpoch) ||
        cmpCounts(a.deletableCounts, o.deletableCounts) ||
        cmpReverseOptionalEpoch(a.initialCertifiedEpoch, o.initialCertifiedEpoch)
    }
  }
}

const canonicalEvent = (e: EventId) => `{"txDigest":${JSON.stringify(e.txDigest)},"eventSeq":${JSON.stringify(e.eventSeq)}}`
const canonicalCounts = (c: DeletableCounts) =>
  `{"countDeletableTotal":${c.countDeletableTotal},"countDeletableCertified":${c.countDeletableCertified}}`

/** Grouping key: fixed field order, no whitespace. Two statuses have the same key iff they are equal. */
export const canonical = (s: BlobStatus): string => {
  switch (s._tag) {
    case "Nonexistent":
      return `{"_tag":"Nonexistent"}`
    case "Invalid":
      return `{"_tag":"Invalid","event":${canonicalEvent(s.event)}}`
    case "Permanent":
      return `{"_tag":"Permanent","endEpoch":${s.endEpoch},"isCertified":${s.isCertified},"statusEvent":${
        canonicalEvent(s.statusEvent)
      },"deletableCounts":${canonicalCounts(s.deletableCounts)},"initialCertifiedEpoch":${s.initialCertifiedEpoch}}`
    case "Deletable":
      return `{"_tag":"Deletable","initialCertifiedEpoch":${s.initialCertifiedEpoch},"deletableCounts":${
        canonicalCounts(s.deletableCounts)
      }}`
  }
}

/** The epoch in which the blob was first certified, if it is certified. */
export const certifiedEpoch = (s: BlobStatus): number | undefined =>
  (s._tag === "Permanent" || s._tag === "Deletable") && s.initialCertifiedEpoch !== null
    ? s.initialCertifiedEpoch
    : undefined
