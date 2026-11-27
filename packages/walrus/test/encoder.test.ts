/**
 * `Encoder` (§6.1): round trips, typed WASM errors, `sliverRoots` by the
 * crafted-blob method (W6), BLS against `@noble/curves`, and the layer's
 * lifecycle. Every WASM call costs about 2.5 s at `n = 1000` (W5), so
 * everything runs at `n = 10` except one slow test.
 */
import { BlobEncoder } from "@mysten/walrus-wasm"
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
  for (const length of [0, 1, 32, 100_000]) {
    test(`round trip, ${length} bytes`, async () => {
      const blob = bytes(length, length + 3)
      const e = await run(encoder.encode(n, blob))
      expect(e.nShards).toBe(n)
      expect(e.unencodedLength).toBe(length)
      expect(e.primary.length).toBe(n)
      expect(e.secondary.length).toBe(n)

      // the metadata proves the blob id, and the root over its leaves is the root hash
      const m = Result.getOrThrow(Messages.verifyMetadata(e.blobId, response(e), n))
      expect(m.unencodedLength).toBe(length)
      expect(m.bytes).toEqual(e.metadata)

      // blobId (compute_metadata) agrees with encode
      expect(await run(encoder.blobId(n, blob))).toEqual({ blobId: e.blobId, rootHash: e.rootHash })

      // sliver headers: primary pair p is sliver p, secondary pair p is sliver n - 1 - p
      const { symbolSize } = Encoding.sliverBytes(length, n)
      e.primary.forEach((s, p) => expect(Messages.checkSliver(s, { index: p, symbolSize, symbols: S })).toEqual(Result.void))
      e.secondary.forEach((s, p) => expect(Messages.checkSliver(s, { index: n - 1 - p, symbolSize, symbols: P })).toEqual(Result.void))

      // decode from all, and from exactly n - 2f, systematic or repair
      expect(await run(encoder.decode(n, length, e.primary))).toEqual(blob)
      const next = rng(length + 7)
      for (let i = 0; i < 3; i++) {
        const subset = pick(next, P, n).map((p) => e.primary[p]!)
        expect(await run(encoder.decode(n, length, subset))).toEqual(blob)
      }
    })
  }

  test("n = 4 (the smallest the WASM accepts) and n = 7", async () => {
    for (const shards of [4, 7]) {
      const blob = bytes(500, shards)
      const e = await run(encoder.encode(shards, blob))
      Result.getOrThrow(Messages.verifyMetadata(e.blobId, response(e), shards))
      expect(await run(encoder.decode(shards, blob.length, e.primary))).toEqual(blob)
    }
  })
})

describe("typed errors", () => {
  const blob = bytes(2000, 9)
  const encodedP = run(encoder.encode(n, blob))

  test("decode with too few slivers", async () => {
    const e = await encodedP
    await encoderError(encoder.decode(n, blob.length, e.primary.slice(0, P - 1)), "decode")
    await encoderError(encoder.decode(n, blob.length, []), "decode")
  })

  test("decode with duplicate slivers", async () => {
    const e = await encodedP
    const dup = [e.primary[0]!, e.primary[1]!, e.primary[2]!, e.primary[2]!]
    await encoderError(encoder.decode(n, blob.length, dup), "decode")
  })

  test("decode with a malformed sliver", async () => {
    const e = await encodedP
    const slivers = [...e.primary.slice(0, P - 1), e.primary[P - 1]!.slice(0, 10)]
    await encoderError(encoder.decode(n, blob.length, slivers), "decode", /BCS/)
  })

  test("decode with a bad length", async () => {
    await encoderError(encoder.decode(n, -1, []), "decode", /invalid blob length/)
    await encoderError(encoder.decode(n, 1.5, []), "decode", /invalid blob length/)
    await encoderError(encoder.decode(n, Encoding.maxBlobSize(n) + 1, []), "decode", /exceeds/)
  })

  test("bad shard counts", async () => {
    for (const shards of [0, 1, 2, 3, -1, 4.5, 65_536]) {
      await encoderError(encoder.encode(shards, blob), "encode", /nShards/)
      await encoderError(encoder.blobId(shards, blob), "blobId", /nShards/)
    }
  })

  test("a blob over the maximum size", async () => {
    const tooLarge = new Uint8Array(Encoding.maxBlobSize(n) + 1)
    await encoderError(encoder.encode(n, tooLarge), "encode", /exceeds/)
    await encoderError(encoder.blobId(n, tooLarge), "blobId", /exceeds/)
  })

  test("errors are failures, not defects", async () => {
    const exit = await Effect.runPromiseExit(encoder.decode(n, 10, [new Uint8Array([1, 2, 3])]))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(exit.cause.reasons.every((r) => r._tag === "Fail")).toBe(true)
  })
})

describe("sliverRoots", () => {
  // symbol sizes 2 (one byte), 72, and the 100 kB blob's 3572
  for (const length of [1, 2000, 100_000]) {
    test(`equals the metadata hashes, and differs exactly for corrupted slivers (${length} bytes)`, async () => {
      const e = await run(encoder.encode(n, bytes(length, length)))
      const m = Result.getOrThrow(Messages.verifyMetadata(e.blobId, response(e), n))
      const { symbolSize } = Encoding.sliverBytes(length, n)
      const next = rng(length + 1)

      // primary: up to n - 2f at a time, systematic (< P) and repair pairs mixed
      for (const k of [1, 2, P]) {
        const pairs = pick(next, k, n)
        const roots = await run(encoder.sliverRoots(n, "primary", symbolSize, pairs.map((p) => e.primary[p]!)))
        expect(roots).toEqual(pairs.map((p) => m.hashes[p]!.primary))
      }
      const allPrimary = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
      for (let at = 0; at < n; at += P) {
        const pairs = allPrimary.slice(at, at + P)
        expect(await run(encoder.sliverRoots(n, "primary", symbolSize, pairs.map((p) => e.primary[p]!)))).toEqual(
          pairs.map((p) => m.hashes[p]!.primary)
        )
      }

      // secondary: up to n - f at a time
      for (const k of [1, 3, S]) {
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
      pPairs.forEach((p, i) => expect(Buffer.from(pRoots[i]!).equals(m.hashes[p]!.primary)).toBe(!pBad.has(p)))

      const sPairs = [0, 2, 3, 4, 6, 7, 9]
      const sBad = new Set([0, 6])
      const sRoots = await run(
        encoder.sliverRoots(n, "secondary", symbolSize, sPairs.map((p) => (sBad.has(p) ? corrupt(e.secondary[p]!, next(1 << 20)) : e.secondary[p]!)))
      )
      sPairs.forEach((p, i) => expect(Buffer.from(sRoots[i]!).equals(m.hashes[p]!.secondary)).toBe(!sBad.has(p)))
    })
  }

  test("argument checks", async () => {
    const e = await run(encoder.encode(n, bytes(2000, 1)))
    const { symbolSize } = Encoding.sliverBytes(2000, n)
    expect(await run(encoder.sliverRoots(n, "primary", symbolSize, []))).toEqual([])
    await encoderError(encoder.sliverRoots(n, "primary", symbolSize, e.primary.slice(0, P + 1)), "sliverRoots", /at most 4/)
    await encoderError(encoder.sliverRoots(n, "secondary", symbolSize, e.secondary.slice(0, S + 1)), "sliverRoots", /at most 7/)
    await encoderError(encoder.sliverRoots(n, "primary", symbolSize + 2, e.primary.slice(0, 1)), "sliverRoots", /symbol size/)
    await encoderError(encoder.sliverRoots(n, "primary", 3, e.primary.slice(0, 1)), "sliverRoots", /even/)
    await encoderError(encoder.sliverRoots(n, "primary", 0, e.primary.slice(0, 1)), "sliverRoots", /even/)
    // a secondary sliver on the primary axis has the wrong number of symbols
    await encoderError(encoder.sliverRoots(n, "primary", symbolSize, e.secondary.slice(0, 1)), "sliverRoots", /data bytes/)
    await encoderError(encoder.sliverRoots(n, "primary", symbolSize, [e.primary[0]!.slice(1)]), "sliverRoots", /sliver 0/)
    await encoderError(encoder.sliverRoots(0, "primary", symbolSize, []), "sliverRoots", /nShards/)
  })

  test("an allocation too large for the crafted blob is an EncoderError, not a defect", async () => {
    // n = 1000 and symbol size 20,000: the crafted blob would be 334 × 667 × 20,000 = 4.46 GB.
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
    await encoderError(encoder.sliverRoots(big, "primary", symbolSize, [sliver]), "sliverRoots", /./)
  })
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

  test("wasmUrl is accepted and ignored on Bun", async () => {
    const id = await Effect.runPromise(
      Effect.flatMap(Effect.service(Encoder.Encoder), (svc) => svc.blobId(4, bytes(10))).pipe(
        Effect.provide(Encoder.layer({ wasmUrl: "https://example.invalid/walrus_wasm_bg.wasm" }))
      )
    )
    expect(id.rootHash.length).toBe(32)
  })
})

describe("n = 1000 (slow)", () => {
  test("encode, sliverRoots on systematic, repair and corrupted slivers, decode from n - 2f", async () => {
    const big = 1000
    const blob = bytes(5000, 1000)
    const e = await run(encoder.encode(big, blob))
    const m = Result.getOrThrow(Messages.verifyMetadata(e.blobId, response(e), big))
    expect(e.metadata.length).toBe(66_044 - 32)
    const { symbolSize } = Encoding.sliverBytes(blob.length, big)
    const pairs = [0, 333, 334, 999]
    const slivers = pairs.map((p) => (p === 334 ? corrupt(e.primary[p]!, 3) : e.primary[p]!))
    const roots = await run(encoder.sliverRoots(big, "primary", symbolSize, slivers))
    pairs.forEach((p, i) => expect(Buffer.from(roots[i]!).equals(m.hashes[p]!.primary)).toBe(p !== 334))
    const { primary } = Encoding.sourceSymbols(big)
    expect(await run(encoder.decode(big, blob.length, e.primary.slice(big - primary)))).toEqual(blob)
  }, 60_000)
})
