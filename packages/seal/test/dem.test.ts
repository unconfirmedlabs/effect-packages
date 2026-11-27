import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { Dem } from "../src/index.ts"
import { hex, seeded, unhex, utf8 } from "./support.ts"

const MSG = utf8("The difference between a Miracle and a Fact is exactly the difference between a mermaid and a seal.")
const AAD = utf8("Mark Twain")

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)
const failure = async <A, E>(e: Effect.Effect<A, E>): Promise<E> => {
  const exit = await Effect.runPromiseExit(e)
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  const err = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (err === undefined || err._tag !== "Fail") throw new Error(`expected a typed failure: ${String(exit.cause)}`)
  return err.error
}

const flip = (bytes: Uint8Array, i: number) => {
  const out = bytes.slice()
  out[i]! ^= 1
  return out
}

describe("Rust regression vectors (dem.rs)", () => {
  test("AES-256-GCM (regression_test_aes_gcm)", async () => {
    const key = unhex("43041389faab1f789fa56722b1def4c3ec6da22675e9bd8ad7329cd931bc840a")
    const blob = unhex(
      "a3a5c857ee27937f43ccfb42b41ca2155c9a4a77a8e54af35f78a78ff102206142d1be22dfc39a6374463255934ae640adceeffb17e56b9190d8c5f6456e9e7ff1c4eaa45114b640b407efd371f26b1f7d7e48bd86d742a01c0ad7dbe18b86df188e27cb029978b7fd243d9a63bdabd76aa478"
    )
    const ct = await run(Dem.encrypt({ _tag: "AesGcm256", data: MSG, aad: AAD }, key))
    expect(ct).toEqual({ _tag: "Aes256Gcm", blob, aad: Option.some(AAD) })
    expect(await run(Dem.decrypt(ct, key))).toEqual(MSG)
  })

  test("HMAC-SHA3-256 CTR (regression_test_hmac_ctr)", async () => {
    const key = unhex("5bfdfd7c814903f1311bebacfffa3c001cbeb1cbb3275baa9aafe21fadd9f396")
    const blob =
      "feadb8c8f781036f86b6a9f436cac6f9f68ba8fc8b8444f0331a5820f78580f32034f698f7ce15f25defae1749f0131c0a8b8c5e751b96aacf507d0dbd4d7790440d196a339fcb8498ca7dd236014e353729b7aa2cf524284a8d2305d2378494eadd6f"
    const mac = "85d498365972c3dc7a53f94232f9cb10dcc94eff064d6835d41d7a7536b47b51"
    const out = Dem.hmacCtr.encrypt(key, MSG, AAD)
    expect(hex(out.blob)).toBe(blob)
    expect(hex(out.mac)).toBe(mac)
    const ct = await run(Dem.encrypt({ _tag: "Hmac256Ctr", data: MSG, aad: AAD }, key))
    expect(ct).toEqual({ _tag: "Hmac256Ctr", blob: unhex(blob), aad: Option.some(AAD), mac: unhex(mac) })
    expect(await run(Dem.decrypt(ct, key))).toEqual(MSG)
  })
})

describe("DEM", () => {
  const next = seeded("dem")

  test("AES_IV (C12)", () => {
    expect(hex(Dem.AES_IV)).toBe("8a3799fdc62e79dba0805907d69c94dc")
  })

  test("empty and 1 MiB messages, both modes", async () => {
    for (const data of [new Uint8Array(0), next(1 << 20), next(33)]) {
      const key = next(32)
      for (const tag of ["AesGcm256", "Hmac256Ctr"] as const) {
        const ct = await run(Dem.encrypt({ _tag: tag, data }, key))
        if (ct._tag === "Plain") throw new Error("unexpected")
        expect(ct.blob.length).toBe(data.length + (tag === "AesGcm256" ? 16 : 0))
        expect(await run(Dem.decrypt(ct, key))).toEqual(data)
      }
    }
  })

  test("aad absent is written as Some(empty) and reads like empty; None reads too", async () => {
    const key = next(32)
    const data = next(50)
    for (const tag of ["AesGcm256", "Hmac256Ctr"] as const) {
      const absent = await run(Dem.encrypt({ _tag: tag, data }, key))
      const empty = await run(Dem.encrypt({ _tag: tag, data, aad: new Uint8Array(0) }, key))
      expect(absent).toEqual(empty)
      if (absent._tag === "Plain") throw new Error("unexpected")
      expect(absent.aad).toEqual(Option.some(new Uint8Array(0)))
      expect(await run(Dem.decrypt({ ...absent, aad: Option.none() }, key))).toEqual(data)
    }
  })

  test("a flipped byte in blob, tag, mac or aad, or the wrong key, is DecryptionFailed", async () => {
    const key = next(32)
    const data = next(40)
    const aad = next(5)
    const aes = await run(Dem.encrypt({ _tag: "AesGcm256", data, aad }, key))
    const hmac = await run(Dem.encrypt({ _tag: "Hmac256Ctr", data, aad }, key))
    if (aes._tag !== "Aes256Gcm" || hmac._tag !== "Hmac256Ctr") throw new Error("unexpected")
    const aesCases = [
      { ...aes, blob: flip(aes.blob, 0) },
      { ...aes, blob: flip(aes.blob, aes.blob.length - 1) }, // the tag
      { ...aes, aad: Option.some(flip(aad, 2)) }
    ]
    for (const ct of aesCases) expect(await failure(Dem.decrypt(ct, key))).toEqual(new Dem.DecryptionFailed({ reason: "tag" }))
    expect(await failure(Dem.decrypt(aes, next(32)))).toEqual(new Dem.DecryptionFailed({ reason: "tag" }))
    const hmacCases = [
      { ...hmac, blob: flip(hmac.blob, 0) },
      { ...hmac, mac: flip(hmac.mac, 31) },
      { ...hmac, aad: Option.some(flip(aad, 2)) },
      { ...hmac, mac: hmac.mac.subarray(1) }
    ]
    for (const ct of hmacCases) expect(await failure(Dem.decrypt(ct, key))).toEqual(new Dem.DecryptionFailed({ reason: "mac" }))
    expect(await failure(Dem.decrypt(hmac, next(32)))).toEqual(new Dem.DecryptionFailed({ reason: "mac" }))
    const r = Dem.hmacCtr.decrypt(key, hmac.blob, flip(hmac.mac, 0), aad)
    expect(Result.isFailure(r)).toBe(true)
  })

  test("Plain: no data, decrypting returns the key (C14)", async () => {
    const key = next(32)
    const ct = await run(Dem.encrypt({ _tag: "Plain" }, key))
    expect(ct).toEqual({ _tag: "Plain" })
    expect(await run(Dem.decrypt(ct, key))).toEqual(key)
  })

  test("a key that is not 32 bytes is a defect", async () => {
    const exit = await Effect.runPromiseExit(Dem.encrypt({ _tag: "Hmac256Ctr", data: next(3) }, next(16)))
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((r) => r._tag === "Die")).toBe(true)
  })

  test("without crypto.subtle: CryptoUnavailable for AES only", async () => {
    const key = next(32)
    const data = next(20)
    const aes = await run(Dem.encrypt({ _tag: "AesGcm256", data }, key))
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")!
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: crypto.getRandomValues.bind(crypto) },
      configurable: true,
      writable: true
    })
    try {
      expect(globalThis.crypto.subtle).toBeUndefined()
      expect((await failure(Dem.encrypt({ _tag: "AesGcm256", data }, key)))._tag).toBe("CryptoUnavailable")
      expect((await failure(Dem.decrypt(aes, key)))._tag).toBe("CryptoUnavailable")
      const hmac = await run(Dem.encrypt({ _tag: "Hmac256Ctr", data }, key))
      expect(await run(Dem.decrypt(hmac, key))).toEqual(data)
    } finally {
      Object.defineProperty(globalThis, "crypto", original)
    }
    expect(globalThis.crypto.subtle).toBeDefined()
  })
})
