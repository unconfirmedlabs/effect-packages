import { describe, expect, test } from "bun:test"
import * as Schema from "effect/Schema"
import { Status } from "../src/index.ts"

const decode = Schema.decodeUnknownSync(Status.BlobStatus)
const event = { txDigest: "4pXKY2vB5yJb3bTzZDdb6RWrkkRFcQc1Zw2WpXn1TfZq", eventSeq: "3" }

// Shapes as nodes send them (N6, S1); the counts are snake_case.
const nonexistent = "nonexistent"
const invalid = { invalid: { event } }
const permanent = {
  permanent: {
    endEpoch: 600,
    isCertified: true,
    statusEvent: event,
    deletableCounts: { count_deletable_total: 2, count_deletable_certified: 1 },
    initialCertifiedEpoch: 590
  }
}
const deletable = {
  deletable: {
    initialCertifiedEpoch: null,
    deletableCounts: { count_deletable_total: 1, count_deletable_certified: 0 }
  }
}

describe("decoding", () => {
  test("every shape, and back to the node's JSON", () => {
    expect(decode(nonexistent)).toEqual({ _tag: "Nonexistent" })
    expect(decode(invalid)).toEqual({ _tag: "Invalid", event })
    expect(decode(permanent)).toEqual({
      _tag: "Permanent",
      endEpoch: 600,
      isCertified: true,
      statusEvent: event,
      deletableCounts: { countDeletableTotal: 2, countDeletableCertified: 1 },
      initialCertifiedEpoch: 590
    })
    expect(decode(deletable)).toEqual({
      _tag: "Deletable",
      initialCertifiedEpoch: null,
      deletableCounts: { countDeletableTotal: 1, countDeletableCertified: 0 }
    })
    for (const json of [nonexistent, invalid, permanent, deletable]) {
      expect(Schema.encodeSync(Status.BlobStatus)(decode(json))).toEqual(json)
    }
  })

  test("a missing initialCertifiedEpoch is null; a numeric eventSeq becomes a string", () => {
    const { initialCertifiedEpoch: _, ...rest } = permanent.permanent
    const s = decode({ permanent: { ...rest, statusEvent: { txDigest: event.txDigest, eventSeq: 3 } } })
    expect(s).toMatchObject({ _tag: "Permanent", initialCertifiedEpoch: null, statusEvent: event })
  })

  test("rejects other shapes", () => {
    const bad: ReadonlyArray<unknown> = [
      "Nonexistent",
      "stored",
      null,
      42,
      {},
      { nonexistent: {} },
      { permanent: { ...permanent.permanent, endEpoch: "600" } },
      { permanent: permanent.permanent, deletable: deletable.deletable },
      { deletable: { initialCertifiedEpoch: null, deletableCounts: { countDeletableTotal: 1, countDeletableCertified: 0 } } },
      { invalid: { event: { txDigest: "x" } } },
      { invalid: { event: { txDigest: "x", eventSeq: "-1" } } }
    ]
    for (const u of bad) expect(() => decode(u)).toThrow()
  })
})

describe("order (api.rs:138-200)", () => {
  const ev = (seq: string) => ({ txDigest: event.txDigest, eventSeq: seq })
  const counts = (total: number, certified: number) => ({ countDeletableTotal: total, countDeletableCertified: certified })
  const N: Status.BlobStatus = { _tag: "Nonexistent" }
  const I = (seq = "1"): Status.BlobStatus => ({ _tag: "Invalid", event: ev(seq) })
  const D = (total: number, certified: number, epoch: number | null): Status.BlobStatus => ({
    _tag: "Deletable",
    initialCertifiedEpoch: epoch,
    deletableCounts: counts(total, certified)
  })
  const P = (o: { certified: boolean; end: number; total?: number; cert?: number; epoch: number | null; seq?: string }): Status.BlobStatus => ({
    _tag: "Permanent",
    endEpoch: o.end,
    isCertified: o.certified,
    statusEvent: ev(o.seq ?? "1"),
    deletableCounts: counts(o.total ?? 0, o.cert ?? 0),
    initialCertifiedEpoch: o.epoch
  })

  // [a, b, sign of order(a, b)]
  const table: ReadonlyArray<readonly [string, Status.BlobStatus, Status.BlobStatus, -1 | 0 | 1]> = [
    ["nonexistent = nonexistent", N, N, 0],
    ["nonexistent < deletable", N, D(0, 0, null), -1],
    ["nonexistent < invalid", N, I(), -1],
    ["deletable < permanent", D(9, 9, 1), P({ certified: false, end: 1, epoch: null }), -1],
    ["permanent < invalid", P({ certified: true, end: 99, epoch: 1 }), I(), -1],
    ["deletable < invalid", D(0, 0, null), I(), -1],
    ["invalid = invalid, whatever the event", I("1"), I("2"), 0],
    // Deletable: (counts: certified then total, Reverse(initial epoch))
    ["deletable: more certified wins over more total", D(1, 1, 5), D(5, 0, null), 1],
    ["deletable: same certified, more total", D(3, 1, 5), D(2, 1, 5), 1],
    ["deletable: same counts, smaller epoch ranks higher", D(1, 1, 4), D(1, 1, 5), 1],
    ["deletable: same counts, None ranks above Some", D(1, 0, null), D(1, 0, 3), 1],
    ["deletable: equal", D(1, 1, 4), D(1, 1, 4), 0],
    // Permanent: (is_certified, end_epoch, counts, Reverse(initial epoch))
    ["permanent: certified beats a later end epoch", P({ certified: true, end: 1, epoch: 1 }), P({ certified: false, end: 9, epoch: null }), 1],
    ["permanent: later end epoch", P({ certified: true, end: 9, epoch: 1 }), P({ certified: true, end: 8, epoch: 1 }), 1],
    ["permanent: more certified deletables", P({ certified: true, end: 9, cert: 1, total: 1, epoch: 1 }), P({ certified: true, end: 9, total: 4, epoch: 1 }), 1],
    ["permanent: smaller initial epoch", P({ certified: true, end: 9, epoch: 1 }), P({ certified: true, end: 9, epoch: 2 }), 1],
    ["permanent: None above Some", P({ certified: false, end: 9, epoch: null }), P({ certified: false, end: 9, epoch: 2 }), 1],
    ["permanent: the status event does not order", P({ certified: true, end: 9, epoch: 1, seq: "1" }), P({ certified: true, end: 9, epoch: 1, seq: "2" }), 0]
  ]

  test("as the Rust node orders them, both ways round", () => {
    const wrong = table.filter(([, a, b, sign]) => Math.sign(Status.order(a, b)) !== sign || Math.sign(Status.order(b, a)) !== (sign === 0 ? 0 : -sign))
    expect(wrong.map(([name]) => name)).toEqual([])
  })
})

describe("canonical and certifiedEpoch", () => {
  test("canonical is insensitive to key order and tells different statuses apart", () => {
    const shuffled = {
      permanent: {
        initialCertifiedEpoch: 590,
        deletableCounts: { count_deletable_certified: 1, count_deletable_total: 2 },
        statusEvent: { eventSeq: "3", txDigest: event.txDigest },
        isCertified: true,
        endEpoch: 600
      }
    }
    expect(Status.canonical(decode(shuffled))).toBe(Status.canonical(decode(permanent)))
    expect(Status.canonical(decode(permanent))).not.toContain(" ")
    expect(JSON.parse(Status.canonical(decode(permanent)))).toEqual(decode(permanent))
    const keys = [nonexistent, invalid, permanent, deletable].map((j) => Status.canonical(decode(j)))
    expect(new Set(keys).size).toBe(4)
    const later = { permanent: { ...permanent.permanent, endEpoch: 601 } }
    expect(Status.canonical(decode(later))).not.toBe(Status.canonical(decode(permanent)))
  })

  test("certifiedEpoch", () => {
    expect(Status.certifiedEpoch(decode(permanent))).toBe(590)
    expect(Status.certifiedEpoch(decode(deletable))).toBeUndefined()
    expect(Status.certifiedEpoch(decode(nonexistent))).toBeUndefined()
    expect(Status.certifiedEpoch(decode(invalid))).toBeUndefined()
    expect(Status.certifiedEpoch(decode({ deletable: { ...deletable.deletable, initialCertifiedEpoch: 3 } }))).toBe(3)
  })
})
