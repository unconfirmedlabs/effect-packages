/**
 * The package's error classes (§4.12), all pure `Schema.TaggedError`s. They
 * live in one module so that every flow (read, write, relay, quilts,
 * gateways) shares the same classes. `NodeError` is the exception: it belongs
 * to `StorageNode.ts`, next to the mapping that produces it.
 *
 * Each `extends` is marked `/* @__PURE__ *\/` so that Bun and esbuild drop
 * the classes a program never uses (a class whose base is a call is otherwise
 * kept for its possible side effects); Rolldown drops this module only when
 * nothing from it is used. The unused classes weigh about 1.3 KB minified
 * (`scripts/bundle-report.ts`, aggregator-only program), too little to be
 * worth one module per class (§6.5).
 */
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Schema from "effect/Schema"
import { BlobId, InvalidBlobId } from "./BlobId.ts"
import { BlobStatusType } from "./Status.ts"

export { InvalidBlobId }

/** A summary of one quorum member's typed failure, never the raw object. */
export const Failure = /* @__PURE__ */ Schema.Struct({
  node: Schema.String,
  weight: Schema.Number,
  kind: Schema.String,
  message: Schema.String
})
export type Failure = typeof Failure.Type
const Failures = /* @__PURE__ */ Schema.Array(Failure)

// -----------------------------------------------------------------------------
// Pure core
// -----------------------------------------------------------------------------

/** A node's metadata does not belong to the blob id, or does not fit this committee. */
export class InvalidMetadata extends /* @__PURE__ */ Schema.TaggedError<InvalidMetadata>()("InvalidMetadata", {
  blobId: BlobId,
  reason: Schema.String
}) {
  override get message(): string {
    return `invalid metadata for blob ${this.blobId}: ${this.reason}`
  }
}

/** A sliver's header or length does not fit the blob. */
export class InvalidSliver extends /* @__PURE__ */ Schema.TaggedError<InvalidSliver>()("InvalidSliver", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

export class BlobTooLarge extends /* @__PURE__ */ Schema.TaggedError<BlobTooLarge>()("BlobTooLarge", {
  size: Schema.Number,
  max: Schema.Number
}) {
  override get message(): string {
    return `blob of ${this.size} bytes exceeds the maximum ${this.max}`
  }
}

/** A certificate's signers are out of range, duplicated, too light, or its message or signature is wrong. */
export class CertificateInvalid extends /* @__PURE__ */ Schema.TaggedError<CertificateInvalid>()("CertificateInvalid", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

export class BlobNotFound extends /* @__PURE__ */ Schema.TaggedError<BlobNotFound>()("BlobNotFound", {
  blobId: BlobId
}) {
  override get message(): string {
    return `blob ${this.blobId} not found`
  }
}

export class BlobBlocked extends /* @__PURE__ */ Schema.TaggedError<BlobBlocked>()("BlobBlocked", {
  blobId: BlobId
}) {
  override get message(): string {
    return `blob ${this.blobId} is blocked`
  }
}

/** Marked invalid on chain. */
export class InvalidBlob extends /* @__PURE__ */ Schema.TaggedError<InvalidBlob>()("InvalidBlob", {
  blobId: BlobId
}) {
  override get message(): string {
    return `blob ${this.blobId} is marked invalid`
  }
}

/** The slivers match the metadata, but the decoded bytes do not hash to the blob id: the writer encoded it wrongly. */
export class InconsistentBlob extends /* @__PURE__ */ Schema.TaggedError<InconsistentBlob>()("InconsistentBlob", {
  blobId: BlobId
}) {
  override get message(): string {
    return `blob ${this.blobId} is inconsistently encoded`
  }
}

export class NoMetadata extends /* @__PURE__ */ Schema.TaggedError<NoMetadata>()("NoMetadata", {
  blobId: BlobId,
  failures: Failures
}) {
  override get message(): string {
    return `no metadata for blob ${this.blobId}: ${this.failures.length} failed`
  }
}

export class NotEnoughSlivers extends /* @__PURE__ */ Schema.TaggedError<NotEnoughSlivers>()("NotEnoughSlivers", {
  blobId: BlobId,
  weight: Schema.Number,
  required: Schema.Number,
  failures: Failures
}) {
  override get message(): string {
    return `not enough slivers for blob ${this.blobId}: weight ${this.weight} of ${this.required}, ${this.failures.length} failed`
  }
}

export class StatusUnverified extends /* @__PURE__ */ Schema.TaggedError<StatusUnverified>()("StatusUnverified", {
  blobId: BlobId,
  groups: Schema.Array(Schema.Struct({ status: BlobStatusType, weight: Schema.Number }))
}) {
  override get message(): string {
    return `status of blob ${this.blobId} unverified: ${this.groups.map((g) => `${g.status._tag} ${g.weight}`).join(", ") || "no answers"}`
  }
}

/** The blob was certified in an epoch later than the client's committee: refresh. */
export class BehindCurrentEpoch extends /* @__PURE__ */ Schema.TaggedError<BehindCurrentEpoch>()("BehindCurrentEpoch", {
  clientEpoch: Schema.Number,
  certifiedEpoch: Schema.Number
}) {
  override get message(): string {
    return `blob certified in epoch ${this.certifiedEpoch}, client is at ${this.clientEpoch}`
  }
}

// -----------------------------------------------------------------------------
// Chain state
// -----------------------------------------------------------------------------

export class CommitteeMismatch extends /* @__PURE__ */ Schema.TaggedError<CommitteeMismatch>()("CommitteeMismatch", {
  stakingEpoch: Schema.Number,
  systemEpoch: Schema.Number,
  reason: Schema.String
}) {
  override get message(): string {
    return `staking epoch ${this.stakingEpoch}, system epoch ${this.systemEpoch}: ${this.reason}`
  }
}

export class UnsupportedSystemVersion extends /* @__PURE__ */ Schema.TaggedError<UnsupportedSystemVersion>()("UnsupportedSystemVersion", {
  objectId: Address.Address,
  version: Schema.BigInt
}) {
  override get message(): string {
    return `unsupported system version ${this.version} of ${this.objectId}`
  }
}

// -----------------------------------------------------------------------------
// Write
// -----------------------------------------------------------------------------

export class NotEnoughConfirmations extends /* @__PURE__ */ Schema.TaggedError<NotEnoughConfirmations>()("NotEnoughConfirmations", {
  blobId: BlobId,
  weight: Schema.Number,
  required: Schema.Number,
  failures: Failures
}) {
  override get message(): string {
    return `not enough confirmations for blob ${this.blobId}: weight ${this.weight} of ${this.required}, ${this.failures.length} failed`
  }
}

/** Resumed with bytes that are not the saved step's blob. */
export class ResumeMismatch extends /* @__PURE__ */ Schema.TaggedError<ResumeMismatch>()("ResumeMismatch", {
  expected: BlobId,
  actual: BlobId
}) {
  override get message(): string {
    return `resumed with blob ${this.actual}, expected ${this.expected}`
  }
}

export class RegistrationFailed extends /* @__PURE__ */ Schema.TaggedError<RegistrationFailed>()("RegistrationFailed", {
  blobObjectId: Address.Address,
  reason: Schema.String
}) {
  override get message(): string {
    return `registration of ${this.blobObjectId} failed: ${this.reason}`
  }
}

export class CertificateStale extends /* @__PURE__ */ Schema.TaggedError<CertificateStale>()("CertificateStale", {
  certificateEpoch: Schema.Number,
  epoch: Schema.Number
}) {
  override get message(): string {
    return `certificate from epoch ${this.certificateEpoch}, current epoch ${this.epoch}`
  }
}

// -----------------------------------------------------------------------------
// Encoder, relay, quilts, gateways
// -----------------------------------------------------------------------------

export class EncoderError extends /* @__PURE__ */ Schema.TaggedError<EncoderError>()("EncoderError", {
  operation: Schema.String,
  message: Schema.String
}) {}

/** `status` is absent when the request never got an HTTP answer. */
export class RelayError extends /* @__PURE__ */ Schema.TaggedError<RelayError>()("RelayError", {
  status: Schema.optionalKey(Schema.Number),
  message: Schema.String
}) {}

export class TipTooHigh extends /* @__PURE__ */ Schema.TaggedError<TipTooHigh>()("TipTooHigh", {
  tip: Schema.BigInt,
  max: Schema.BigInt
}) {
  override get message(): string {
    return `relay tip ${this.tip} exceeds the maximum ${this.max}`
  }
}

export class QuiltError extends /* @__PURE__ */ Schema.TaggedError<QuiltError>()("QuiltError", {
  reason: Schema.String
}) {
  override get message(): string {
    return this.reason
  }
}

/** `status` is absent when the request never got an HTTP answer. */
export class GatewayError extends /* @__PURE__ */ Schema.TaggedError<GatewayError>()("GatewayError", {
  status: Schema.optionalKey(Schema.Number),
  message: Schema.String
}) {}
