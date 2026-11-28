/**
 * Failure handling against scripted core services (see world.ts).
 */
import { describe, expect, test } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Fiber, Layer, Option, Schedule } from "effect"
import { TestClock } from "effect/testing"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as AddressAlias from "@unconfirmed/effect-sui/AddressAlias"
import * as Ed25519 from "@unconfirmed/effect-sui/Ed25519"
import * as Ptb from "@unconfirmed/effect-sui/Ptb"
import { RpcError } from "@unconfirmed/effect-sui/RpcError"
import * as Journal from "../../src/lifecycle/Journal.ts"
import { JournalEntry } from "../../src/lifecycle/JournalEntry.ts"
import * as Lifecycle from "../../src/lifecycle/Lifecycle.ts"
import * as Outcome from "../../src/lifecycle/Outcome.ts"
import type { SignedTransaction } from "../../src/lifecycle/SignedTransaction.ts"
import * as SubmitConfig from "../../src/lifecycle/SubmitConfig.ts"
import { COIN, consumer, evidence, land, layer, makeWorld, OBJ, ownedObject, signedTx, type World } from "./world.ts"

const fast = SubmitConfig.layer({
  resubmit: Schedule.spaced(0),
  lookupTimeout: 0,
  reconcileRecheck: 0,
  awaitVisibility: false
})

/** An Evidence backend (over the world) whose history reaches genesis, so a miss is evidence. */
const fullHistory = (world: World) => evidence(world)

const runIn = <A, E>(
  world: World,
  effect: Effect.Effect<A, E, Lifecycle.Services>,
  extra: Layer.Layer<never> | ((world: World) => Layer.Layer<never>) = Layer.empty
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(layer(world), Journal.layerMemory, fast, typeof extra === "function" ? extra(world) : extra)))
  )

const journalTag = (digest: string) =>
  Effect.flatMap(Effect.service(Journal.Journal), (j) => j.get(digest)).pipe(
    Effect.map(Option.match({ onNone: () => "none", onSome: (e) => e._tag }))
  )

const put = (make: (now: DateTime.Utc) => JournalEntry) =>
  Effect.flatMap(Effect.service(Journal.Journal), (j) => Effect.flatMap(DateTime.now, (now) => j.put(make(now))))

const unknownEntry = (signed: SignedTransaction) =>
  put((at) => JournalEntry.cases.Unknown.make({ digest: signed.digest, signed, lastError: "x", attempts: 1, at }))

describe("outcome", () => {
  test("tags outside the taxonomy are unknown unless the caller says they were pre-submit", () => {
    expect(Outcome.outcome(new Cause.TimeoutError())).toBe("unknown")
    const rpc = new RpcError({ method: "X", code: "UNAVAILABLE", message: "" })
    expect(Outcome.outcome(rpc)).toBe("unknown")
    expect(Outcome.outcome(rpc, { phase: "beforeSubmit" })).toBe("not_applied")
    expect(Outcome.outcome(new Outcome.SubmissionUnknown({ digest: "D", reason: "" }), { phase: "beforeSubmit" })).toBe(
      "unknown"
    )
    expect(Outcome.outcome(new Outcome.JournalError({ message: "" }))).toBe("not_applied")
    expect(Outcome.outcome(new Outcome.DigestMismatch({ digest: "a", computed: "b" }))).toBe("unknown")
  })
})

describe("submit", () => {
  test("transport error before execution: re-sends the same bytes, then Executed", async () => {
    const world = makeWorld({ script: ["failBefore", "failBefore", "land"] })
    const { signed, effects, tag } = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        const effects = yield* Lifecycle.submit(signed)
        return { signed, effects, tag: yield* journalTag(signed.digest) }
      })
    )
    expect(effects.status._tag).toBe("Success")
    expect(world.sent).toEqual([signed.digest, signed.digest, signed.digest])
    expect(tag).toBe("Executed")
  })

  test("transport error after execution, retries exhausted: reconcile finds it", async () => {
    const world = makeWorld({ script: ["failAfter"] })
    const effects = await runIn(
      world,
      Effect.flatMap(signedTx(), Lifecycle.submit).pipe(SubmitConfig.with({ resubmitAttempts: 1 }))
    )
    expect(effects.status._tag).toBe("Success")
    expect(world.executeCalls).toBe(1)
  })

  test("NOT_FOUND then found: reconcile keeps asking until lookupTimeout (TestClock)", async () => {
    const world = makeWorld({ script: ["failAfter"], hideFor: 3 })
    const effects = await runIn(
      world,
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          Effect.flatMap(signedTx(), Lifecycle.submit).pipe(
            SubmitConfig.with({ resubmitAttempts: 1, lookupTimeout: "5 seconds", lookupInterval: "500 millis" })
          )
        )
        yield* TestClock.adjust("2 seconds")
        return yield* Fiber.join(fiber)
      }),
      TestClock.layer()
    )
    expect(effects.status._tag).toBe("Success")
    expect(world.getCalls).toBe(4)
  })

  test("executeTimeout: an execute with no answer is re-sent after the timeout (TestClock)", async () => {
    const world = makeWorld({ script: ["hang", "land"] })
    const effects = await runIn(
      world,
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          Effect.flatMap(signedTx(), Lifecycle.submit).pipe(SubmitConfig.with({ executeTimeout: "3 seconds" }))
        )
        yield* TestClock.adjust("2 seconds")
        const before = world.executeCalls
        yield* TestClock.adjust("2 seconds")
        return { before, effects: yield* Fiber.join(fiber) }
      }),
      TestClock.layer()
    )
    expect(effects.before).toBe(1)
    expect(effects.effects.status._tag).toBe("Success")
    expect(world.executeCalls).toBe(2)
  })

  test("Move abort is ExecutionFailed (applied) and journalled Failed", async () => {
    const world = makeWorld({ script: ["abort"] })
    const { error, tag } = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        const error = yield* Effect.flip(Lifecycle.submit(signed))
        return { error, tag: yield* journalTag(signed.digest) }
      })
    )
    expect(error._tag).toBe("ExecutionFailed")
    expect(Outcome.outcome(error)).toBe("applied")
    expect(error._tag === "ExecutionFailed" && error.abort?.code).toBe(7n)
    expect(tag).toBe("Failed")
  })

  test("INVALID_ARGUMENT on the first send is NotApplied refused", async () => {
    const world = makeWorld({ script: ["refuse"] })
    const { error, tag } = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        const error = yield* Effect.flip(Lifecycle.submit(signed))
        return { error, tag: yield* journalTag(signed.digest) }
      })
    )
    expect(error._tag === "NotApplied" && error.evidence).toBe("refused")
    expect(Outcome.outcome(error)).toBe("not_applied")
    expect(world.getCalls).toBe(0)
    expect(tag).toBe("NotApplied")
  })

  test("submit of bytes the journal already holds is a re-send: INVALID_ARGUMENT reconciles, not refused", async () => {
    const world = makeWorld({ script: ["refuse"] })
    const { error, tag } = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        yield* unknownEntry(signed)
        const error = yield* Effect.flip(Lifecycle.submit(signed))
        return { error, tag: yield* journalTag(signed.digest) }
      })
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(tag).toBe("Unknown")
  })

  test("resubmit: INVALID_ARGUMENT on a re-send reconciles, and finds what the earlier send landed", async () => {
    const world = makeWorld({ script: ["refuse"] })
    const effects = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        land(world, signed.digest)
        return yield* Lifecycle.resubmit(signed)
      })
    )
    expect(effects.status._tag).toBe("Success")
  })

  test("a lock conflict reported as INVALID_ARGUMENT reaches the conflict path, not refused", async () => {
    const world = makeWorld({ script: ["lockConflictInvalid"] })
    world.objects.set(OBJ, ownedObject(OBJ, 9n, "OtherDigest"))
    world.objects.set(COIN, ownedObject(COIN, 3n))
    consumer(world, "OtherDigest", OBJ, 5n)
    const error = await runIn(world, Effect.flip(Effect.flatMap(signedTx(), Lifecycle.submit)))
    expect(error._tag === "NotApplied" && error.evidence).toBe("inputConsumed")
  })

  test("lock conflict: the winner becomes readable during the rechecks -> NotApplied inputConsumed", async () => {
    const world = makeWorld({ script: ["lockConflict"] })
    world.objects.set(OBJ, ownedObject(OBJ, 9n, "OtherDigest"))
    world.objects.set(COIN, ownedObject(COIN, 3n))
    let asked = 0
    world.onGet = (digest) =>
      Effect.sync(() => {
        if (digest === "OtherDigest" && ++asked === 3) consumer(world, "OtherDigest", OBJ, 5n)
      })
    const error = await runIn(world, Effect.flip(Effect.flatMap(signedTx(), Lifecycle.submit)))
    expect(error._tag === "NotApplied" && error.evidence).toBe("inputConsumed")
    expect(asked).toBe(3)
  })

  test("unreachable, window open: SubmissionUnknown carries the bytes; resubmit lands them", async () => {
    const world = makeWorld({ script: ["failBefore", "failBefore", "failBefore", "failBefore", "failBefore"] })
    world.objects.set(OBJ, ownedObject(OBJ, 5n))
    world.objects.set(COIN, ownedObject(COIN, 3n))
    const { error, tag, again, after } = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        const error = yield* Effect.flip(Lifecycle.submit(signed))
        const tag = yield* journalTag(signed.digest)
        if (error._tag !== "SubmissionUnknown") throw new Error(error._tag)
        const again = yield* Lifecycle.resubmit(error)
        return { error, tag, again, after: yield* journalTag(signed.digest) }
      })
    )
    expect(Outcome.outcome(error)).toBe("unknown")
    expect(error._tag === "SubmissionUnknown" && error.signed?.bytes.length).toBeGreaterThan(0)
    expect(world.executeCalls).toBe(6)
    expect(tag).toBe("Unknown")
    expect(again.status._tag).toBe("Success")
    expect(after).toBe("Executed")
  })

  test("resubmit refuses on a journal NotApplied, without sending", async () => {
    const world = makeWorld()
    const error = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        yield* put((at) => JournalEntry.cases.NotApplied.make({ digest: signed.digest, evidence: "inputConsumed", at }))
        return yield* Effect.flip(Lifecycle.resubmit(signed))
      })
    )
    expect(error._tag === "NotApplied" && error.evidence).toBe("inputConsumed")
    expect(world.executeCalls).toBe(0)
  })

  test("an interrupt between the answer and its journal write still journals the answer", async () => {
    const world = makeWorld()
    const tag = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        const inner = Journal.makeMemory()
        const writing = yield* Deferred.make<void>()
        const slow: Journal.JournalService = {
          ...inner,
          put: (e) =>
            e._tag === "Executed"
              ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.sleep(20)), Effect.andThen(inner.put(e)))
              : inner.put(e)
        }
        const fiber = yield* Effect.forkChild(Lifecycle.submit(signed).pipe(Effect.provideService(Journal.Journal, slow)))
        yield* Deferred.await(writing)
        yield* Fiber.interrupt(fiber)
        return yield* Effect.map(inner.get(signed.digest), Option.map((e) => e._tag))
      })
    )
    expect(tag).toEqual(Option.some("Executed"))
  })

  test("a SignedTransaction whose digest is not its bytes' fails DigestMismatch before anything is sent", async () => {
    const world = makeWorld()
    const errors = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        const other = yield* signedTx({ nonce: 2 })
        const forged = { ...signed, digest: other.digest }
        return [
          yield* Effect.flip(Lifecycle.submit(forged)),
          yield* Effect.flip(Lifecycle.resubmit(forged)),
          yield* Effect.flip(Lifecycle.reconcile(forged))
        ]
      })
    )
    expect(errors.map((e) => e._tag)).toEqual(["DigestMismatch", "DigestMismatch", "DigestMismatch"])
    expect(world.executeCalls).toBe(0)
    expect(world.getCalls).toBe(0)
  })

  test("resubmit: a journal failure after bytes may be out is SubmissionUnknown, never JournalError", async () => {
    const world = makeWorld()
    const error = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        const inner = Journal.makeMemory()
        yield* inner.put(JournalEntry.cases.Unknown.make({ digest: signed.digest, signed, lastError: "x", attempts: 1, at: yield* DateTime.now }))
        const broken: Journal.JournalService = {
          ...inner,
          put: () => Effect.fail(new Outcome.JournalError({ message: "disk full" }))
        }
        return yield* Effect.flip(Lifecycle.resubmit(signed).pipe(Effect.provideService(Journal.Journal, broken)))
      })
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(Outcome.outcome(error)).toBe("unknown")
    expect(world.executeCalls).toBe(0)
  })

  test("a settled entry written meanwhile (another process) is never downgraded to Unknown", async () => {
    const world = makeWorld({ script: ["failBefore"] })
    const tag = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx({ pinned: false })
        const journal = yield* Journal.Journal
        world.onGet = () => Effect.ignore(journal.put(JournalEntry.cases.Executed.make({ digest: signed.digest, at: DateTime.nowUnsafe() })))
        const error = yield* Effect.flip(Lifecycle.submit(signed).pipe(SubmitConfig.with({ resubmitAttempts: 1 })))
        expect(error._tag).toBe("SubmissionUnknown")
        return yield* journalTag(signed.digest)
      })
    )
    expect(tag).toBe("Executed")
  })

  test("submit over a settled entry never writes Signed and never re-sends", async () => {
    const world = makeWorld()
    const tag = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        land(world, signed.digest)
        yield* put((at) => JournalEntry.cases.Executed.make({ digest: signed.digest, at }))
        const effects = yield* Lifecycle.submit(signed)
        expect(effects.digest).toBe(signed.digest)
        return yield* journalTag(signed.digest)
      })
    )
    expect(tag).toBe("Executed")
    expect(world.executeCalls).toBe(0)
  })

  test("resubmit with a journal Executed/Failed on a lagging node never concludes NotApplied", async () => {
    const world = makeWorld({ epoch: 20n })
    const [executed, failed] = await runIn(
      world,
      Effect.gen(function*() {
        const a = yield* signedTx({ epoch: 10n, pinned: false })
        const b = yield* signedTx({ epoch: 10n, pinned: false, nonce: 2 })
        yield* put((at) => JournalEntry.cases.Executed.make({ digest: a.digest, at }))
        yield* put((at) => JournalEntry.cases.Failed.make({ digest: b.digest, description: "MoveAbort", at }))
        return [yield* Effect.flip(Lifecycle.resubmit(a)), yield* Effect.flip(Lifecycle.resubmit(b))]
      }),
      fullHistory
    )
    expect(executed._tag).toBe("SubmissionUnknown")
    expect(executed._tag === "SubmissionUnknown" && executed.reason).toContain("journal records this transaction as executed")
    expect(failed._tag).toBe("ExecutionFailed")
    expect(world.executeCalls).toBe(0)
  })
})

describe("reconcile", () => {
  test("expired: window closed, missed twice around a recheck, full history -> NotApplied expired", async () => {
    const world = makeWorld({ epoch: 20n })
    const { error, tag } = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx({ epoch: 10n })
        yield* put((at) => JournalEntry.cases.Signed.make({ digest: signed.digest, signed, at }))
        const error = yield* Effect.flip(Lifecycle.reconcile(signed))
        return { error, tag: yield* journalTag(signed.digest) }
      }),
      fullHistory
    )
    expect(error._tag === "NotApplied" && error.evidence).toBe("expired")
    expect(world.getCalls).toBe(3)
    expect(tag).toBe("NotApplied")
  })

  test("without an Evidence service the expiry rule is off, and says so", async () => {
    const world = makeWorld({ epoch: 20n })
    const error = await runIn(world, Effect.flip(Effect.flatMap(signedTx({ epoch: 10n, pinned: false }), Lifecycle.reconcile)))
    expect(error._tag).toBe("SubmissionUnknown")
    expect(error._tag === "SubmissionUnknown" && error.reason).toContain("expiry rule is off")
  })

  test("an Evidence backend that does not report its history cannot vouch for a miss", async () => {
    const world = makeWorld({ epoch: 20n })
    const error = await runIn(
      world,
      Effect.flip(Effect.flatMap(signedTx({ epoch: 10n, pinned: false }), Lifecycle.reconcile)),
      evidence(world, { lowest: Option.none() })
    )
    expect(error._tag === "SubmissionUnknown" && error.reason).toContain("does not report how much history")
  })

  test("expired on a pruning node that cannot say where the window starts: SubmissionUnknown", async () => {
    const world = makeWorld({ epoch: 20n })
    const error = await runIn(
      world,
      Effect.flip(Effect.flatMap(signedTx({ epoch: 10n, pinned: false }), Lifecycle.reconcile)),
      evidence(world, { lowest: Option.some(5000n) })
    )
    expect(error._tag).toBe("SubmissionUnknown")
  })

  test("a lagging Transactions index never turns a late landing into expired (CT-3)", async () => {
    // Chain says epoch 12 (window 10..11 closed); the transaction landed at the
    // end of epoch 11; the Evidence backend serves it, `Transactions` (an
    // indexer behind) does not yet.
    const world = makeWorld({ epoch: 12n })
    const result = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx({ epoch: 10n, pinned: false })
        land(world, signed.digest)
        world.hideFor = 4
        const first = yield* Effect.flip(Lifecycle.reconcile(signed))
        const later = yield* Lifecycle.reconcile(signed)
        return { first, later }
      }),
      fullHistory
    )
    expect(result.first._tag).toBe("SubmissionUnknown")
    expect(result.first._tag === "SubmissionUnknown" && result.first.reason).toContain("Evidence backend serves this transaction")
    expect(Outcome.outcome(result.first)).toBe("unknown")
    expect(result.later.status._tag).toBe("Success")
  })

  test("an Evidence backend still inside the window blocks expired, whatever Chain says", async () => {
    const world = makeWorld({ epoch: 20n, evidenceEpoch: 11n })
    const error = await runIn(world, Effect.flip(Effect.flatMap(signedTx({ epoch: 10n, pinned: false }), Lifecycle.reconcile)), fullHistory)
    expect(error._tag === "SubmissionUnknown" && error.reason).toContain("has not yet reached the end of its window")
  })

  test("a transaction that becomes readable between the rounds settles as executed", async () => {
    const world = makeWorld({ epoch: 20n })
    const effects = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx({ epoch: 10n, pinned: false })
        world.onGet = () =>
          Effect.sync(() => {
            if (world.getCalls === 2) land(world, signed.digest)
          })
        return yield* Lifecycle.reconcile(signed)
      }),
      fullHistory
    )
    expect(effects.status._tag).toBe("Success")
  })

  test("positive evidence vetoes expiry: a pinned object names this digest", async () => {
    const world = makeWorld({ epoch: 20n })
    const error = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx({ epoch: 10n })
        world.objects.set(OBJ, ownedObject(OBJ, 9n, signed.digest))
        return yield* Effect.flip(Lifecycle.reconcile(signed))
      }),
      fullHistory
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(error._tag === "SubmissionUnknown" && error.reason).toContain("so it applied")
  })

  test("a moved input whose consumer took a later version proves nothing", async () => {
    const world = makeWorld()
    world.objects.set(OBJ, ownedObject(OBJ, 9n, "OtherDigest"))
    consumer(world, "OtherDigest", OBJ, 7n)
    const error = await runIn(world, Effect.flip(Effect.flatMap(signedTx(), Lifecycle.reconcile)))
    expect(error._tag).toBe("SubmissionUnknown")
  })

  test("a consumed Receiving input proves nothing", async () => {
    const world = makeWorld()
    world.objects.set(OBJ, ownedObject(OBJ, 9n, "OtherDigest"))
    world.objects.set(COIN, ownedObject(COIN, 3n))
    consumer(world, "OtherDigest", OBJ, 5n)
    const error = await runIn(world, Effect.flip(Effect.flatMap(signedTx({ receiving: true }), Lifecycle.reconcile)))
    expect(error._tag).toBe("SubmissionUnknown")
  })

  test("bytes for another chain are never judged by this one", async () => {
    const world = makeWorld({ epoch: 20n, chainId: "11111111111111111111111111111111" })
    const error = await runIn(world, Effect.flip(Effect.flatMap(signedTx({ epoch: 10n }), Lifecycle.reconcile)), fullHistory)
    expect(error._tag === "SubmissionUnknown" && error.reason).toContain("built for chain")
  })

  test("found: Executed; a bare unknown digest is SubmissionUnknown without bytes", async () => {
    const world = makeWorld()
    const result = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        land(world, signed.digest)
        const found = yield* Lifecycle.reconcile(signed)
        const missing = yield* Effect.flip(Lifecycle.reconcile("UnknownDigest"))
        return { found, missing }
      })
    )
    expect(result.found.status._tag).toBe("Success")
    expect(result.missing._tag === "SubmissionUnknown" && result.missing.signed).toBeUndefined()
  })

  test("a bare digest uses the signed bytes the journal holds (CT-18)", async () => {
    const world = makeWorld({ epoch: 20n })
    const result = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx({ epoch: 10n, pinned: false })
        yield* put((at) => JournalEntry.cases.Signed.make({ digest: signed.digest, signed, at }))
        const byDigest = yield* Effect.flip(Lifecycle.reconcile(signed.digest))
        return byDigest
      }),
      fullHistory
    )
    expect(result._tag === "NotApplied" && result.evidence).toBe("expired")
  })

  test("pinned objects are read concurrently (CT-16)", async () => {
    const world = makeWorld()
    world.objects.set(OBJ, ownedObject(OBJ, 5n))
    world.objects.set(COIN, ownedObject(COIN, 3n))
    await runIn(world, Effect.flip(Effect.flatMap(signedTx(), Lifecycle.reconcile)))
    expect(world.objectsMaxInFlight).toBe(2)
  })
})

describe("review fixes: submit, resubmit, reconcileAll", () => {
  test("submit with an unreadable journal is SubmissionUnknown and sends nothing (CT-10)", async () => {
    const world = makeWorld()
    const result = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        const broken = { ...Journal.makeMemory(), get: () => Effect.fail(new Outcome.JournalError({ message: "store down" })) }
        return yield* Effect.flip(Lifecycle.submit(signed).pipe(Effect.provideService(Journal.Journal, broken)))
      })
    )
    expect(result._tag).toBe("SubmissionUnknown")
    expect(Outcome.outcome(result)).toBe("unknown")
    expect(world.executeCalls).toBe(0)
  })

  test("a first submit to the wrong chain sends nothing; resubmit on the right chain sends (CT-11)", async () => {
    const world = makeWorld({ chainId: "11111111111111111111111111111111", script: ["refuse"] })
    const result = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx()
        const first = yield* Effect.flip(Lifecycle.submit(signed))
        const tag = yield* journalTag(signed.digest)
        world.chainId = (yield* Effect.promise(() => import("./world.ts"))).CHAIN_ID
        world.script = []
        const second = yield* Lifecycle.resubmit(signed)
        return { first, tag, second }
      })
    )
    expect(result.first._tag === "SubmissionUnknown" && result.first.reason).toContain("nothing was sent")
    expect(result.tag).toBe("none")
    expect(result.second.status._tag).toBe("Success")
    expect(world.executeCalls).toBe(1)
  })

  test("resubmit({ retryRefused: true }) re-sends bytes recorded as refused", async () => {
    const world = makeWorld({ script: ["refuse"] })
    const result = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx({ pinned: false })
        const refused = yield* Effect.flip(Lifecycle.submit(signed))
        const kept = yield* Effect.flip(Lifecycle.resubmit(signed))
        const sentBefore = world.executeCalls
        const retried = yield* Lifecycle.resubmit(signed, { retryRefused: true })
        return { refused, kept, sentBefore, retried, tag: yield* journalTag(signed.digest) }
      })
    )
    expect(result.refused._tag === "NotApplied" && result.refused.evidence).toBe("refused")
    expect(result.kept._tag).toBe("NotApplied")
    expect(result.sentBefore).toBe(1)
    expect(result.retried.status._tag).toBe("Success")
    expect(result.tag).toBe("Executed")
  })

  test("reconcileAll runs entries concurrently with one lookup each (CT-5)", async () => {
    const world = makeWorld()
    const started = Date.now()
    const out = await Effect.runPromise(
      Effect.gen(function*() {
        for (let i = 0; i < 20; i++) {
          const signed = yield* signedTx({ nonce: i, pinned: false })
          yield* put((at) => JournalEntry.cases.Signed.make({ digest: signed.digest, signed, at }))
        }
        return yield* Lifecycle.reconcileAll({ concurrency: 4 })
      }).pipe(
        Effect.provide(Layer.mergeAll(
          layer(world),
          Journal.layerMemory,
          // The defaults: 5 s of polling per digest for a just-sent transaction.
          SubmitConfig.layer({ awaitVisibility: false })
        ))
      )
    )
    expect(out.map((r) => r._tag)).toEqual(Array.from({ length: 20 }, () => "SubmissionUnknown"))
    expect(world.getCalls).toBe(20)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("reconcileAll keeps when an unknown entry was first sent and why (CT-25)", async () => {
    const world = makeWorld()
    const entry = await runIn(
      world,
      Effect.gen(function*() {
        const signed = yield* signedTx({ pinned: false })
        const first = DateTime.makeUnsafe(1_000)
        yield* put(() =>
          JournalEntry.cases.Unknown.make({ digest: signed.digest, signed, lastError: "RpcError UNAVAILABLE", attempts: 3, at: first })
        )
        yield* Lifecycle.reconcileAll()
        return Option.getOrThrow(yield* Effect.flatMap(Effect.service(Journal.Journal), (j) => j.get(signed.digest)))
      })
    )
    expect(entry._tag).toBe("Unknown")
    if (entry._tag !== "Unknown") return
    expect(DateTime.toEpochMillis(entry.at)).toBe(1_000)
    expect(entry.lastError).toBe("RpcError UNAVAILABLE")
    expect(entry.attempts).toBe(3)
  })
})

describe("run", () => {
  test("a signer that is neither sender nor gas owner is Tx.SignerMismatch before any network call; as an alias signer it runs", async () => {
    const world = makeWorld()
    const account = Address.normalize("0xa11ce")
    const recipe = Effect.gen(function*() {
      const coin = yield* Ptb.coin({ amount: 1n, useGasCoin: false })
      yield* Ptb.transferObjects([coin], yield* Ptb.address(account))
    })
    const { refused, calls, unresolved, effects } = await Effect.runPromise(
      Effect.gen(function*() {
        const key = yield* Ed25519.generate
        const refused = yield* Effect.flip(Lifecycle.run(recipe, { signer: key, sender: account }))
        const calls = world.infoCalls + world.executeCalls + world.getCalls
        const { entries: unresolved } = yield* Effect.flatMap(Effect.service(Journal.Journal), (j) => j.listUnresolved)
        const effects = yield* Lifecycle.run(recipe, { signer: AddressAlias.signer(account, key), sender: account })
        return { refused, calls, unresolved, effects }
      }).pipe(Effect.provide(Layer.mergeAll(layer(world), Journal.layerMemory, fast)))
    )
    expect(refused).toMatchObject({ _tag: "SignerMismatch", sender: account, gasOwner: account })
    expect(calls).toBe(0)
    expect(unresolved).toEqual([])
    expect(world.sent).toEqual([effects.digest])
  })
})
