/**
 * `Encoder` (§6.1): round trips, typed WASM errors, `sliverRoots` (direct
 * per-sliver roots; parity with the old crafted-blob method is in
 * `parity.encoder.test.ts`), BLS against `@noble/curves`, and the layer's
 * lifecycle. Everything runs at `n = 10`; `n = 1000` is in
 * `parity.encoder.test.ts`.
 */
import { BlobEncoder } from "@unconfirmed/effect-walrus/wasm"
import { bls12_381 } from "@noble/curves/bls12-381.js"
import { afterAll, describe, expect, spyOn, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import { BlobId, Encoder, Encoding, Errors, Messages } from "../src/index.ts"
import { bytes, rng } from "./oracle.ts"

const scope = Effect.runSync(Scope.make())
const encoder = await Effect.runPromise(Encoder.make().pipe(Scope.provide(scope)))
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

/** The typed failure of `effect`, which must be an `EncoderError` for `operation`. */
const encoderError = async (effect: Effect.Effect<unknown, Errors.EncoderError>, operation: string, pattern?: RegExp) => {
  const error = await Effect.runPromise(Effect.flip(effect))
  expect(error).toBeInstanceOf(Errors.EncoderError)
  expect(error.operation).toBe(operation)
  if (pattern) expect(error.message).toMatch(pattern)
  return error
}

/** Metadata response bytes (blob id ‖ BCS metadata) as a node would send them. */
const response = (e: Encoder.EncodedBlob) => new Uint8Array([...BlobId.toBytes(e.blobId), ...e.metadata])

const n = 10
const { primary: P, secondary: S } = Encoding.sourceSymbols(n) // 4, 7

/** Pick `k` distinct indices in `[0, max)`. */
const pick = (next: (max: number) => number, k: number, max: number): Array<number> => {
  const out = new Set<number>()
  while (out.size < k) out.add(next(max))
  return [...out]
}

/** Flip one byte inside a BCS sliver's symbol data. */
const corrupt = (sliver: Uint8Array, at: number): Uint8Array => {
  const copy = sliver.slice()
  const { data } = Result.getOrThrow(Messages.parseSliver(copy))
  data[at % data.length]! ^= 0x5a
  return copy
}

describe("encode / decode", () => {
  // Byte parity with Mysten's encoder is in parity.encoder.test.ts; this checks our own reading of the output.
  test("the metadata proves the blob id, every sliver header checks, and any n − 2f slivers decode", async () => {
    const length = 100_000
    const blob = bytes(length, 3)
    const e = await run(encoder.encode(n, blob))
    const m = Result.getOrThrow(Messages.verifyMetadata(e.blobId, response(e), n))
    expect([m.unencodedLength, m.bytes]).toEqual([length, e.metadata])
    // sliver headers: primary pair p is sliver p, secondary pair p is sliver n - 1 - p
    const { symbolSize } = Encoding.sliverBytes(length, n)
    expect(e.primary.every((s, p) => Result.isSuccess(Messages.checkSliver(s, { index: p, symbolSize, symbols: S })))).toBe(true)
    expect(e.secondary.every((s, p) => Result.isSuccess(Messages.checkSliver(s, { index: n - 1 - p, symbolSize, symbols: P })))).toBe(true)
    const next = rng(7)
    for (let i = 0; i < 3; i++) {
      expect(await run(encoder.decode(n, length, pick(next, P, n).map((p) => e.primary[p]!)))).toEqual(blob)
    }
  })
})

describe("typed errors", () => {
  const blob = bytes(2000, 9)
  const encodedP = run(encoder.encode(n, blob))

  test("decode: too few, duplicate or malformed slivers, a bad length; failures, never defects", async () => {
    const e = await encodedP
    await encoderError(encoder.decode(n, blob.length, e.primary.slice(0, P - 1)), "decode")
    await encoderError(encoder.decode(n, blob.length, [e.primary[0]!, e.primary[1]!, e.primary[2]!, e.primary[2]!]), "decode")
    await encoderError(encoder.decode(n, blob.length, [...e.primary.slice(0, P - 1), e.primary[P - 1]!.slice(0, 10)]), "decode", /BCS/)
    await encoderError(encoder.decode(n, -1, []), "decode", /invalid blob length/)
    await encoderError(encoder.decode(n, 1.5, []), "decode", /invalid blob length/)
    await encoderError(encoder.decode(n, Encoding.maxBlobSize(n) + 1, []), "decode", /exceeds/)
    const exit = await Effect.runPromiseExit(encoder.decode(n, 10, [new Uint8Array([1, 2, 3])]))
    expect(Exit.isFailure(exit) && exit.cause.reasons.every((r) => r._tag === "Fail")).toBe(true)
  })

  test("encode and blobId: bad shard counts, a blob over the maximum size", async () => {
    for (const shards of [3, 4.5, 65_536]) {
      await encoderError(encoder.encode(shards, blob), "encode", /nShards/)
      await encoderError(encoder.blobId(shards, blob), "blobId", /nShards/)
    }
    const tooLarge = new Uint8Array(Encoding.maxBlobSize(n) + 1)
    await encoderError(encoder.encode(n, tooLarge), "encode", /exceeds/)
    await encoderError(encoder.blobId(n, tooLarge), "blobId", /exceeds/)
  })
})

describe("sliverRoots", () => {
  {
    const length = 2000
    test("equals the metadata hashes, and differs exactly for corrupted slivers", async () => {
      const e = await run(encoder.encode(n, bytes(length, length)))
      const m = Result.getOrThrow(Messages.verifyMetadata(e.blobId, response(e), n))
      const { symbolSize } = Encoding.sliverBytes(length, n)
      const next = rng(length + 1)

      // primary: systematic (< P) and repair pairs mixed, any number per call
      for (const k of [1, 2, P, P + 3]) {
        const pairs = pick(next, k, n)
        const roots = await run(encoder.sliverRoots(n, "primary", symbolSize, pairs.map((p) => e.primary[p]!)))
        expect(roots).toEqual(pairs.map((p) => m.hashes[p]!.primary))
      }
      // secondary
      for (const k of [1, 3, S, n]) {
        const pairs = pick(next, k, n)
        const roots = await run(encoder.sliverRoots(n, "secondary", symbolSize, pairs.map((p) => e.secondary[p]!)))
        expect(roots).toEqual(pairs.map((p) => m.hashes[p]!.secondary))
      }

      // corrupted: exactly the corrupted ones mismatch
      const pPairs = [1, 5, 8, 9]
      const pBad = new Set([5, 9])
      const pRoots = await run(
        encoder.sliverRoots(n, "primary", symbolSize, pPairs.map((p) => (pBad.has(p) ? corrupt(e.primary[p]!, next(1 << 20)) : e.primary[p]!)))
      )
      expect(pPairs.map((p, i) => Buffer.from(pRoots[i]!).equals(m.hashes[p]!.primary))).toEqual(pPairs.map((p) => !pBad.has(p)))

      const sPairs = [0, 2, 3, 4, 6, 7, 9]
      const sBad = new Set([0, 6])
      const sRoots = await run(
        encoder.sliverRoots(n, "secondary", symbolSize, sPairs.map((p) => (sBad.has(p) ? corrupt(e.secondary[p]!, next(1 << 20)) : e.secondary[p]!)))
      )
      expect(sPairs.map((p, i) => Buffer.from(sRoots[i]!).equals(m.hashes[p]!.secondary))).toEqual(sPairs.map((p) => !sBad.has(p)))
    })
  }

  test("argument checks", async () => {
    const e = await run(encoder.encode(n, bytes(2000, 1)))
    const { symbolSize } = Encoding.sliverBytes(2000, n)
    expect(await run(encoder.sliverRoots(n, "primary", symbolSize, []))).toEqual([])
    await encoderError(encoder.sliverRoots(n, "primary", symbolSize + 2, e.primary.slice(0, 1)), "sliverRoots", /symbol size/)
    await encoderError(encoder.sliverRoots(n, "primary", 3, e.primary.slice(0, 1)), "sliverRoots", /even/)
    await encoderError(encoder.sliverRoots(n, "primary", 0, e.primary.slice(0, 1)), "sliverRoots", /even/)
    // a secondary sliver on the primary axis has the wrong number of symbols
    await encoderError(encoder.sliverRoots(n, "primary", symbolSize, e.secondary.slice(0, 1)), "sliverRoots", /data bytes/)
    await encoderError(encoder.sliverRoots(n, "primary", symbolSize, [e.primary[0]!.slice(1)]), "sliverRoots", /sliver 0/)
    await encoderError(encoder.sliverRoots(0, "primary", symbolSize, []), "sliverRoots", /nShards/)
  })

  test("needs no crafted blob: a 20,000-byte-symbol sliver at n = 1000", async () => {
    // The crafted-blob method would have encoded 334 × 667 × 20,000 = 4.46 GB here and failed.
    const big = 1000
    const symbolSize = 20_000
    const len = Encoding.sourceSymbols(big).secondary * symbolSize
    const uleb: Array<number> = []
    for (let v = len; ; v = Math.floor(v / 128)) {
      if (v < 128) {
        uleb.push(v)
        break
      }
      uleb.push((v & 0x7f) | 0x80)
    }
    const sliver = new Uint8Array(uleb.length + len + 4)
    sliver.set(uleb, 0)
    new DataView(sliver.buffer).setUint16(uleb.length + len, symbolSize, true)
    const [root] = await run(encoder.sliverRoots(big, "primary", symbolSize, [sliver]))
    expect(root!.length).toBe(32)
  }, 60_000)
})

describe("BLS", () => {
  const sigs = bls12_381.longSignatures
  const keys = [1, 2, 3].map((i) => sigs.keygen(new Uint8Array(48).fill(i)))
  const message = Messages.confirmationMessage(594, BlobId.derive(1, 1n, new Uint8Array(32)), { _tag: "Permanent" })
  const sign = (secretKey: Uint8Array, msg = message) => sigs.Signature.toBytes(sigs.sign(sigs.hash(msg), secretKey))
  const compressed = (k: (typeof keys)[number]) => k.publicKey.toBytes(true)
  const uncompressed = (k: (typeof keys)[number]) => k.publicKey.toBytes(false)

  test("verify with 48- and 96-byte keys", async () => {
    const k = keys[0]!
    const sig = sign(k.secretKey)
    expect(sig.length).toBe(96)
    expect(compressed(k).length).toBe(48)
    expect(uncompressed(k).length).toBe(96)
    expect(await run(encoder.blsVerify(sig, compressed(k), message))).toBe(true)
    expect(await run(encoder.blsVerify(sig, uncompressed(k), message))).toBe(true)
    expect(await run(encoder.blsVerify(sig, uncompressed(keys[1]!), message))).toBe(false)
    expect(await run(encoder.blsVerify(sig, uncompressed(k), message.slice(1)))).toBe(false)
  })

  test("malformed keys and signatures are typed errors", async () => {
    const k = keys[0]!
    await encoderError(encoder.blsVerify(new Uint8Array(96), uncompressed(k), message), "blsVerify")
    await encoderError(encoder.blsVerify(sign(k.secretKey), new Uint8Array(10), message), "blsVerify")
    await encoderError(encoder.blsAggregate([new Uint8Array(5)]), "blsAggregate")
    await encoderError(encoder.blsVerifyAggregate([new Uint8Array(3)], message, sign(k.secretKey)), "blsVerifyAggregate")
  })

  test("aggregate equals @noble/curves, and verifies", async () => {
    const signatures = keys.map((k) => sign(k.secretKey))
    const aggregate = await run(encoder.blsAggregate(signatures))
    expect(aggregate).toEqual(sigs.Signature.toBytes(sigs.aggregateSignatures(signatures.map((s) => sigs.Signature.fromBytes(s)))))
    expect(await run(encoder.blsVerifyAggregate(keys.map(uncompressed), message, aggregate))).toBe(true)
    expect(await run(encoder.blsVerifyAggregate(keys.map(compressed), message, aggregate))).toBe(true)
    expect(await run(encoder.blsVerifyAggregate(keys.slice(0, 2).map(uncompressed), message, aggregate))).toBe(false)
  })
})

describe("layer", () => {
  test("provides the service; frees every BlobEncoder when the scope closes; later calls fail", async () => {
    const free = spyOn(BlobEncoder.prototype, "free")
    try {
      const service = await Effect.runPromise(
        Effect.gen(function*() {
          const svc = yield* Encoder.Encoder
          yield* svc.encode(4, bytes(10))
          yield* svc.encode(7, bytes(10))
          yield* svc.blobId(7, bytes(20)) // reuses the n = 7 instance
          expect(free).toHaveBeenCalledTimes(0)
          return svc
        }).pipe(Effect.provide(Encoder.layer()))
      )
      expect(free).toHaveBeenCalledTimes(2)
      await encoderError(service.encode(4, bytes(10)), "encode", /closed/)
    } finally {
      free.mockRestore()
    }
  })

  test("a trap drops the poisoned BlobEncoder; the next call builds a fresh one", async () => {
    const trap = spyOn(BlobEncoder.prototype, "compute_metadata").mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError("unreachable")
    })
    try {
      const service = Effect.service(Encoder.Encoder)
      const id = await Effect.runPromise(
        Effect.gen(function*() {
          const svc = yield* service
          const error = yield* Effect.flip(svc.blobId(5, bytes(10)))
          expect(error.message).toBe("unreachable")
          return yield* svc.blobId(5, bytes(10))
        }).pipe(Effect.provide(Encoder.layer()))
      )
      expect(id.rootHash.length).toBe(32)
      expect(trap).toHaveBeenCalledTimes(2)
    } finally {
      trap.mockRestore()
    }
  })
})
