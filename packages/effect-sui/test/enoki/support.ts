/** A scripted `HttpClient` that records requests, and a fetch spy for `@mysten/enoki`. */
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"

export interface Recorded {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

export interface Reply {
  readonly status?: number
  readonly body: unknown
}

const bodyText = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body))

/** Answers each request with the next reply, or with `route(request)`. */
export const scripted = (route: (req: Recorded) => Reply | "network-error") => {
  const requests: Array<Recorded> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
      const recorded: Recorded = { method: request.method, url: url.toString(), headers: { ...request.headers }, body }
      requests.push(recorded)
      const reply = route(recorded)
      if (reply === "network-error") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "connection refused" })
          })
        )
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bodyText(reply.body), { status: reply.status ?? 200 }))
      )
    })
  )
  return { layer, requests, route }
}

/** Run `f` with `fetch` replaced; answer `reply` and capture the request `@mysten/enoki` made. */
export const captureFetch = async <A>(reply: Reply, f: () => Promise<A>) => {
  const original = globalThis.fetch
  let captured: Recorded | undefined
  globalThis.fetch = (async (input: string, init: RequestInit) => {
    captured = {
      method: init.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body as string | undefined
    }
    return new Response(bodyText(reply.body), { status: reply.status ?? 200 })
  }) as typeof fetch
  try {
    const result = await f().then((value) => ({ value }), (error) => ({ error }))
    return { ...result, request: captured! }
  } finally {
    globalThis.fetch = original
  }
}
