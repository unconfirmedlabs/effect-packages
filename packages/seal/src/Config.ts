/**
 * Which key servers this client may ask, and what each counts for (§4.3).
 *
 * A server is named by its object id alone (K4: the object's type does not
 * identify a key server). The URL of an independent server is read from
 * chain (`KeyServer.ts`); a committee server's aggregator URL is not on chain
 * (K5) and must be configured here. Nothing in this module does I/O.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import type { Address } from "@unconfirmed/sui/Address"
import { InvalidConfig } from "./Errors.ts"

export { InvalidConfig }

export interface ServerConfig {
  readonly objectId: Address
  /** A positive integer: shares given to this server when encrypting, and its weight toward a threshold when no object says otherwise. */
  readonly weight: number
  readonly apiKey?: { readonly name: string; readonly value: Redacted.Redacted<string> }
  /** Required for a committee server, refused for an independent one (K5). Checked when the server is loaded. */
  readonly aggregatorUrl?: string
}

export interface SealConfigService {
  readonly servers: ReadonlyArray<ServerConfig>
}

export class SealConfig extends /* @__PURE__ */ Context.Service<SealConfig, SealConfigService>()(
  "@unconfirmed/seal/SealConfig"
) {}

/** What a caller writes. */
export interface ServerInput {
  /** Exactly 64 hex digits, `0x` optional, any case. */
  readonly objectId: string
  /** Default 1. */
  readonly weight?: number
  /** The HTTP header that carries the API key; give both or neither. */
  readonly apiKeyName?: string
  readonly apiKey?: string | Redacted.Redacted<string>
  readonly aggregatorUrl?: string
}

/** The largest total weight: share indices are `u8`, `1..=n` (I5). */
export const MAX_TOTAL_WEIGHT = 255

const OBJECT_ID = /^(0x)?[0-9a-fA-F]{64}$/
/** An RFC 9110 field name (`token`). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Strict object id normalisation: exactly 64 hex digits, `0x` optional, any
 * case; returns `0x` + 64 lower-case digits. A truncated paste (`0x2`) is
 * refused rather than padded.
 */
export const normalizeObjectId = (s: string): Address | undefined =>
  OBJECT_ID.test(s) ? (("0x" + s.replace(/^0x/, "").toLowerCase()) as Address) : undefined

/** An absolute `http:` or `https:` URL with a host, no credentials. */
export const isHttpUrl = (s: string): boolean => {
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return false
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "" && url.username === "" &&
    url.password === ""
}

const fail = (reason: string) => Result.fail(new InvalidConfig({ reason }))

/**
 * Validate and normalise a server list. Refuses: an empty list, an object id
 * that is not 64 hex digits, a duplicate (after normalisation), a weight that
 * is not a positive integer, a total weight above 255, half an API key (or an
 * empty value, or a name that is not an HTTP header name), and an aggregator
 * URL that is not http(s). Messages name the server by position, never the
 * API key.
 */
export const make = (servers: ReadonlyArray<ServerInput>): Result.Result<SealConfigService, InvalidConfig> => {
  if (servers.length === 0) return fail("no key servers configured")
  const seen = new Set<string>()
  const out: Array<ServerConfig> = []
  let total = 0
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i]!
    const at = `server ${i}`
    const objectId = normalizeObjectId(s.objectId)
    if (objectId === undefined) return fail(`${at}: object id ${JSON.stringify(s.objectId)} is not 64 hex digits`)
    if (seen.has(objectId)) return fail(`${at}: duplicate object id ${objectId}`)
    seen.add(objectId)
    const weight = s.weight ?? 1
    if (!Number.isSafeInteger(weight) || weight < 1) return fail(`${at}: weight ${weight} is not a positive integer`)
    total += weight
    if (total > MAX_TOTAL_WEIGHT) return fail(`total weight exceeds ${MAX_TOTAL_WEIGHT}`)
    if ((s.apiKeyName === undefined) !== (s.apiKey === undefined)) {
      return fail(`${at}: apiKeyName and apiKey must be given together`)
    }
    let apiKey: ServerConfig["apiKey"]
    if (s.apiKeyName !== undefined && s.apiKey !== undefined) {
      if (!HEADER_NAME.test(s.apiKeyName)) return fail(`${at}: apiKeyName is not an HTTP header name`)
      const value = Redacted.isRedacted(s.apiKey) ? s.apiKey : Redacted.make(s.apiKey)
      if (Redacted.value(value) === "") return fail(`${at}: apiKey is empty`)
      apiKey = { name: s.apiKeyName, value }
    }
    if (s.aggregatorUrl !== undefined && !isHttpUrl(s.aggregatorUrl)) {
      return fail(`${at}: aggregatorUrl is not an http(s) URL`)
    }
    out.push({
      objectId,
      weight,
      ...(apiKey !== undefined && { apiKey }),
      ...(s.aggregatorUrl !== undefined && { aggregatorUrl: s.aggregatorUrl })
    })
  }
  return Result.succeed({ servers: out })
}

export const layer = (servers: ReadonlyArray<ServerInput>): Layer.Layer<SealConfig, InvalidConfig> =>
  Layer.effect(SealConfig, Effect.suspend(() => Effect.fromResult(make(servers))))

/** The configuration of a validated `SealConfigService`, as a layer. */
export const layerFrom = (config: SealConfigService): Layer.Layer<SealConfig> => Layer.succeed(SealConfig, config)

/** Look a server up by (normalised) object id. */
export const find = (config: SealConfigService, objectId: Address): ServerConfig | undefined =>
  config.servers.find((s) => s.objectId === objectId)

/** Testnet servers that are free and open (§0.1). */
export const testnet: {
  readonly mysten1: ServerInput
  readonly mysten2: ServerInput
  readonly committee: ServerInput
} = {
  mysten1: { objectId: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75" },
  mysten2: { objectId: "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8" },
  /** 3-of-5 MPC committee behind Mysten's aggregator (no API key needed on testnet). */
  committee: {
    objectId: "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
    aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com"
  }
}

/** Mainnet: the 5-of-8 committee. Its aggregator needs an API key: spread this and add `apiKeyName` / `apiKey`. */
export const mainnet: { readonly committee: ServerInput } = {
  committee: {
    objectId: "0x686098f1439237fff9f36b99c7329683c22979d2005c2465cb891acb012a7595",
    aggregatorUrl: "https://seal-aggregator-mainnet.mystenlabs.com"
  }
}
