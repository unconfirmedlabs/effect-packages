/**
 * Parity with `@mysten/seal` 2.0.1 sessions (§6.2 "Session"): personal
 * message bytes, export / import in both directions, certificate and request
 * signature. Real clock: `@mysten/seal` uses `Date.now()`; our sessions use
 * `clockSkew: 0` so both sides agree on the creation time.
 */
import { SessionKey as MystenSessionKey } from "@mysten/seal"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import * as Ed25519 from "@unconfirmed/sui/Ed25519"
import * as Signer from "@unconfirmed/sui/Signer"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Approval, SessionKey } from "../src/index.ts"
import { b64, toB64 } from "./support.ts"

const SEED = new Uint8Array(32).fill(5)
const keypair = Ed25519Keypair.fromSecretKey(SEED)
const signer = Effect.runSync(Ed25519.fromSecretKey(SEED))
const PKG = "0x" + "4f".repeat(32)
/** `@mysten/seal` never calls the client in the paths used here. */
const suiClient = {} as never
/** The constructor is private in the typings; `create` would read the chain. */
const Fresh = MystenSessionKey as unknown as new(o: object) => MystenSessionKey

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff)

describe("session parity with @mysten/seal", () => {
  for (const mvrName of [undefined, "@my/package"]) {
    test(`ours → theirs: personal message, certificate, export${mvrName ? " (MVR name)" : ""}`, async () => {
      const r = await run(Effect.gen(function*() {
        const s = yield* SessionKey.make({ packageId: PKG, signer, ttl: "7 minutes", clockSkew: 0, ...(mvrName && { mvrName }) })
        const cert = yield* s.certificate
        const exported = Schema.encodeSync(SessionKey.Exported)(yield* SessionKey.toExported(s))
        return { s, cert, exported }
      }))
      const theirs = MystenSessionKey.import(r.exported as never, suiClient)
      expect(theirs.getPersonalMessage()).toEqual(r.s.personalMessage)
      expect(await theirs.getCertificate()).toEqual({
        user: r.s.address,
        session_vk: toB64(r.s.publicKey),
        creation_time: r.s.createdAt,
        ttl_min: 7,
        signature: toB64(r.cert.signature),
        mvr_name: mvrName
      } as never)
      expect(theirs.export()).toEqual({ ...r.exported, mvrName } as never)
    })

    test(`theirs → ours: import, personal message, certificate${mvrName ? " (MVR name)" : ""}`, async () => {
      const fresh = new Fresh({ address: keypair.toSuiAddress(), packageId: PKG, ttlMin: 12, suiClient, ...(mvrName && { mvrName }) })
      const { signature } = await keypair.signPersonalMessage(fresh.getPersonalMessage())
      const theirs = MystenSessionKey.import({ ...fresh.export(), personalMessageSignature: signature }, suiClient)
      const exported = theirs.export()
      const ours = await run(SessionKey.fromExported(exported))
      expect(ours.personalMessage).toEqual(theirs.getPersonalMessage())
      expect(ours.address).toBe(keypair.toSuiAddress() as never)
      expect(ours.mvrName).toBe(mvrName)
      const cert = await run(ours.certificate)
      const theirCert = await theirs.getCertificate()
      expect(toB64(cert.signature)).toBe(theirCert.signature)
      expect(toB64(cert.sessionVk)).toBe(theirCert.session_vk)
      expect(cert.creationTime).toBe(theirCert.creation_time)
      // and back again, unchanged
      const back = Schema.encodeSync(SessionKey.Exported)(await run(SessionKey.toExported(ours)))
      expect({ ...back, mvrName }).toEqual({ ...exported } as never)
    })
  }

  test("request signature: the same bytes for the same transaction and ElGamal keys", async () => {
    const fresh = new Fresh({ address: keypair.toSuiAddress(), packageId: PKG, ttlMin: 10, suiClient })
    const ours = await run(SessionKey.fromExported(fresh.export()))
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::account_based::seal_approve`, arguments: [tx.pure.vector("u8", [9, 9])] })
    const kind = await tx.build({ onlyTransactionKind: true })
    const params = await fresh.createRequestParams(kind)
    const approval = Result.getOrThrow(Approval.fromTransactionKindBytes(kind))
    const sig = await run(SessionKey.signRequest(ours, approval.bytes, params.encKeyPk, params.encVerificationKey))
    expect(toB64(sig)).toBe(params.requestSignature)
  })

  test("a wallet-style signature from @mysten/sui verifies through SessionKey.withSignature + verify", async () => {
    const s = await run(SessionKey.make({ packageId: PKG, address: keypair.toSuiAddress() }))
    const { signature } = await keypair.signPersonalMessage(s.personalMessage)
    const signed = await run(SessionKey.withSignature(s, b64(signature)))
    const ours = await run(Signer.signPersonalMessage(signer, s.personalMessage))
    expect(toB64(ours.signature)).toBe(signature)
    expect((await run(signed.certificate)).signature).toEqual(b64(signature))
  })
})
