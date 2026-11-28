/**
 * End-to-end parity with `@mysten/seal` (§6.2, "End to end"): `SealClient`
 * (its `fetch` option routed into the fake `HttpClient`) and our `Seal.layer`
 * run against the same `fakeKeyServers` world and the same synthesized chain
 * objects (a first-version package and three V1 key servers). Each side
 * decrypts the other's objects; both load the same key servers.
 */
import { SealClient, SessionKey as MystenSessionKey } from "@mysten/seal"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as Ed25519 from "@unconfirmed/effect-sui/Ed25519"
import type * as Objects from "@unconfirmed/effect-sui/Objects"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Result from "effect/Result"
import * as Approval from "../src/Approval.ts"
import * as EncryptedObject from "../src/EncryptedObject.ts"
import * as KeyServer from "../src/KeyServer.ts"
import * as Seal from "../src/Seal.ts"
import { keyServerObjects, objectsLayer, packageObject } from "./fixtures.ts"
import { accountBased, approvalPtb, fakeKeyServers, hex, unhex, utf8 } from "./support.ts"

const PKG = Address.normalize("0x" + "b7".repeat(32))
const SECRET = unhex("33".repeat(32))
const keypair = Ed25519Keypair.fromSecretKey(SECRET)
const user = Effect.runSync(Ed25519.fromSecretKey(SECRET))
const ID = unhex(user.address.slice(2)) // account_based

const w = fakeKeyServers([{ policy: accountBased }, { policy: accountBased }, { policy: accountBased }])
const chainObjects: ReadonlyArray<Objects.SuiObject> = [...keyServerObjects(w.servers), packageObject(PKG)]
const byId = new Map(chainObjects.map((o) => [o.objectId as string, o]))
const objects = objectsLayer([], chainObjects)

// Ours: the real layer over the fake HTTP client and the synthesized objects.
const layer = Seal.layer({ servers: w.servers.map((s) => ({ objectId: s.objectId })) }).pipe(
  Layer.provideMerge(Layer.merge(objects.layer, w.layer))
)
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.provide(effect, layer))

// Theirs: a `suiClient` reading the same objects, and `fetch` through the same fake client.
const suiClient = {
  core: {
    getObject: async ({ objectId }: { objectId: string }) => {
      const o = byId.get(Address.normalize(objectId))
      if (!o) throw new Error(`object ${objectId} not found`)
      return { object: { objectId: o.objectId, version: String(o.version), content: o.contents } }
    },
    getDynamicField: async ({ parentId, name }: { parentId: string; name: { type: string; bcs: Uint8Array } }) => {
      const version = Number(new DataView(name.bcs.buffer, name.bcs.byteOffset).getBigUint64(0, true))
      const field = byId.get(KeyServer.fieldId(Address.normalize(parentId), version))
      if (!field) throw new Error(`no field ${version} under ${parentId}`)
      // `Field<u64, V>`: UID (32) and name (8), then the value.
      return { dynamicField: { value: { bcs: field.contents.slice(40) } } }
    }
  }
}

const fakeFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const headers = { ...(init.headers as Record<string, string>) }
  const base = init.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url)
  const request = typeof init.body === "string"
    ? HttpClientRequest.bodyText(HttpClientRequest.setHeaders(base, headers), init.body, headers["Content-Type"] ?? "application/json")
    : HttpClientRequest.setHeaders(base, headers)
  return Effect.runPromise(
    Effect.gen(function*() {
      const client = yield* Effect.service(HttpClient.HttpClient)
      const response = yield* client.execute(request)
      const text = yield* response.text
      return new Response(text, { status: response.status, headers: response.headers as Record<string, string> })
    }).pipe(Effect.provide(w.layer))
  )
}

const client = new SealClient({
  suiClient: suiClient as never,
  serverConfigs: w.servers.map((s) => ({ objectId: s.objectId, weight: 1 })),
  fetch: fakeFetch as never
})

const approval = Result.getOrThrow(Approval.fromBytes(approvalPtb({ packageId: PKG, ids: [ID] })))
const txBytes = new Uint8Array([0, ...approval.bytes]) // TransactionKind::ProgrammableTransaction

const theirSession = () =>
  MystenSessionKey.create({ address: keypair.toSuiAddress(), packageId: PKG, ttlMin: 10, signer: keypair, suiClient: suiClient as never })
const ourSession = () => Seal.session({ packageId: PKG, signer: user, clockSkew: 0 })

describe("end-to-end parity with @mysten/seal", () => {
  test("both sides load the same key servers from the same objects", async () => {
    const theirs = await client.getKeyServers()
    const ours = await run(Effect.forEach(w.servers, (s) => Effect.flatMap(Effect.service(KeyServer.KeyServers), (k) => k.get(s.objectId))))
    for (const s of ours) {
      const t = theirs.get(s.objectId)!
      expect([s.name, s.url, s.type, hex(s.publicKey)]).toEqual([t.name, t.url, t.serverType, hex(t.pk)])
    }
    expect(ours).toHaveLength(theirs.size)
  })

  for (const dem of ["AesGcm256", "Hmac256Ctr"] as const) {
    test(`${dem}: ours encrypts, SealClient decrypts; SealClient encrypts, ours decrypts`, async () => {
      const data = utf8(`parity ${dem}`)
      const aad = utf8("aad")
      const ours = await run(Seal.encrypt({ packageId: PKG, id: ID, data, threshold: 2, dem, aad }))
      const theirs = await client.encrypt({ demType: dem === "AesGcm256" ? 0 : 1, threshold: 2, packageId: PKG, id: hex(ID), data, aad })

      // Same layout either way: three services in configuration order, indices 1..3.
      const parsed = Result.getOrThrow(EncryptedObject.parse(theirs.encryptedObject))
      expect(parsed.services).toEqual(Result.getOrThrow(EncryptedObject.parse(ours.encryptedObject)).services)

      const session = await theirSession()
      expect(await client.decrypt({ data: ours.encryptedObject, sessionKey: session, txBytes })).toEqual(data)

      const before = w.requests.length
      const decrypted = await run(Effect.gen(function*() {
        const s = yield* ourSession()
        const plain = yield* Seal.decrypt({ data: theirs.encryptedObject, session: s, approval })
        const consistent = yield* Seal.decrypt({ data: theirs.encryptedObject, session: s, approval, checkShareConsistency: true })
        return { plain, consistent }
      }))
      expect(decrypted.plain).toEqual(data)
      expect(decrypted.consistent).toEqual(data)
      expect(w.requests.length - before).toBe(3) // one request per server, all at once; the second decrypt is served from the cache
    })
  }
})
