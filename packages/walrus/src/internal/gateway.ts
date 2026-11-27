/**
 * The request helper shared by `Aggregator` and `Publisher`: one request to
 * a Walrus HTTP daemon, a 2xx body as bytes, everything else a typed
 * `GatewayError` (timeouts and anything an `HttpClient` implementation throws
 * included). Not part of the public API.
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { GatewayError } from "../Errors.ts"

export interface GatewayOptions {
  /** The daemon's base URL, e.g. `https://aggregator.walrus-testnet.walrus.space`. */
  readonly url: string
  /** Per request, body included. */
  readonly requestTimeout?: Duration.Input
  /** Sent with every request, e.g. `{ authorization: "Bearer …" }` for a publisher behind JWT auth. */
  readonly headers?: Readonly<Record<string, string>>
  /** Default `false`: public daemons do not list trace headers for CORS, so browsers would preflight. */
  readonly tracerPropagation?: boolean
}

/**
 * The daemons answer errors with the storage nodes' envelope (N7):
 * `{ "error": { "code", "status", "message", "details": [{ "reason" }] } }`.
 * Use its message and reason when present, else the body text.
 */
export const errorMessage = (status: number, text: string): string => {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; details?: ReadonlyArray<{ reason?: unknown }> } }
    const message = parsed?.error?.message
    if (typeof message === "string") {
      const reason = parsed.error?.details?.find((d) => typeof d?.reason === "string")?.reason
      return typeof reason === "string" ? `${message} (${reason})` : message
    }
  } catch {
    // not JSON: fall through
  }
  return text.trim().slice(0, 500) || `HTTP ${status}`
}

export type Call = (
  operation: string,
  request: HttpClientRequest.HttpClientRequest
) => Effect.Effect<{ readonly status: number; readonly body: Uint8Array }, GatewayError>

export const makeCall = (
  http: HttpClient.HttpClient,
  options: GatewayOptions,
  defaultTimeout: Duration.Input,
  span: string
): Call => {
  const base = options.url.replace(/\/+$/, "")
  const timeout = Duration.fromInputUnsafe(options.requestTimeout ?? defaultTimeout)
  const tracerPropagation = options.tracerPropagation ?? false
  const headers = options.headers ?? {}
  return (operation, request) => {
    const fail = (message: string, status?: number) =>
      new GatewayError({ ...(status !== undefined && { status }), message: `${operation}: ${message}` })
    return http.execute(HttpClientRequest.setHeaders(HttpClientRequest.prependUrl(request, base), headers)).pipe(
      Effect.mapError((e) => fail(e.message)),
      Effect.flatMap((res) =>
        Effect.flatMap(
          Effect.mapError(res.arrayBuffer, (e) => fail(e.message, res.status)),
          (buf) =>
            res.status >= 200 && res.status < 300
              ? Effect.succeed({ status: res.status, body: new Uint8Array(buf) })
              : Effect.fail(fail(errorMessage(res.status, new TextDecoder().decode(buf)), res.status))
        )
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(fail(`no answer within ${Duration.format(timeout)}`))
      }),
      Effect.catchDefect((defect) => Effect.fail(fail(`transport defect: ${String(defect)}`))),
      Effect.provideService(HttpClient.TracerPropagationEnabled, tracerPropagation),
      Effect.withSpan(`${span}.${operation}`, { attributes: { "walrus.gateway": base, "http.request.method": request.method } })
    )
  }
}
