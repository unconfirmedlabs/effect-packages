/**
 * Provider conformance check for compressed Sui gRPC-web responses
 * (docs/design/grpc-compression.md §5), and a reference proxy that applies
 * layer 2 (§3) in front of any full node.
 *
 *   bun scripts/check-compression.ts <url> [--count N] [--mask paths]
 *       Checks the endpoint: SubscribeCheckpoints with `Accept-Encoding: zstd`
 *       (S2 headers, S3 one zstd stream, S4 flush per frame, S5 window, S6 no
 *       grpc-encoding, the ratio over the first N checkpoints, default 20), the
 *       same without zstd in `Accept-Encoding` (must come back uncompressed),
 *       and layer 1 (`grpc-encoding` zstd and gzip) on a unary GetCheckpoint.
 *       Exits 1 when a rule fails.
 *
 *   bun scripts/check-compression.ts --serve <upstream> [--port 8790]
 *       A gRPC-web proxy to <upstream> that compresses binary gRPC-web
 *       responses with one zstd stream per response (level 3, 8 MiB window),
 *       flushed after every gRPC-web frame, when the request's Accept-Encoding
 *       has zstd. Anything else passes through, layer 1 included.
 *
 * The checker makes its own requests with node:http(s), which never decodes
 * Content-Encoding, so it sees the compressed bytes as sent. Self-contained
 * (node:* only, protobuf by hand), so a provider can copy it. Runs under Bun or Node 24+.
 */
import * as http from "node:http"
import * as https from "node:https"
import * as zlib from "node:zlib"

const SUBSCRIBE = "sui.rpc.v2.SubscriptionService/SubscribeCheckpoints"
const GET_CHECKPOINT = "sui.rpc.v2.LedgerService/GetCheckpoint"
/** The mask of the design's measurements ("full mask"). */
const FULL_MASK = ["sequence_number", "digest", "summary", "signature", "contents", "transactions"]
const MAX_WINDOW = 8 << 20
/** A gap in arrival this long means the server has sent all it has; the decoded bytes must then end on a frame. */
const IDLE_MS = 50
/** A checkpoint may arrive this much later than on the uncompressed stream (p90). */
const MAX_DELAY_MS = 100

// -----------------------------------------------------------------------------
// Protobuf and gRPC-web, by hand
// -----------------------------------------------------------------------------

const varint = (n: number): Array<number> => {
  const out: Array<number> = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
const bytesField = (tag: number, b: Uint8Array) => Buffer.from([tag, ...varint(b.length), ...b])
/** `FieldMask { paths }`. */
const fieldMask = (paths: ReadonlyArray<string>) => Buffer.concat(paths.map((p) => bytesField(0x0a, Buffer.from(p))))
const grpcFrame = (msg: Uint8Array, flags = 0) => {
  const out = Buffer.alloc(5 + msg.length)
  out[0] = flags
  out.writeUInt32BE(msg.length, 1)
  out.set(msg, 5)
  return out
}
/** `cursor` (field 1, varint) of a `SubscribeCheckpointsResponse`. */
const cursorOf = (msg: Uint8Array): bigint | undefined => {
  if (msg[0] !== 0x08) return undefined
  let n = 0n
  for (let i = 1, shift = 0n; i < msg.length; i++, shift += 7n) {
    n |= BigInt(msg[i]! & 0x7f) << shift
    if ((msg[i]! & 0x80) === 0) return n
  }
  return undefined
}

interface GrpcFrame {
  readonly flags: number
  readonly payload: Buffer
}

/** Incremental gRPC-web frame splitter: `push` bytes, get the frames they complete. */
const frameSplitter = () => {
  let pending: Array<Buffer> = []
  let size = 0
  return {
    push(chunk: Buffer): Array<GrpcFrame> {
      pending.push(chunk)
      size += chunk.length
      const out: Array<GrpcFrame> = []
      while (size >= 5) {
        const head = pending[0]!.length >= 5 ? pending[0]! : Buffer.concat(pending)
        const length = head.readUInt32BE(1)
        if (size < 5 + length) break
        const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending)
        out.push({ flags: all[0]!, payload: all.subarray(5, 5 + length) })
        const rest = all.subarray(5 + length)
        pending = rest.length > 0 ? [rest] : []
        size = rest.length
      }
      return out
    },
    /** Whether the bytes so far end exactly on a frame boundary. */
    get atBoundary() {
      return size === 0
    }
  }
}

// -----------------------------------------------------------------------------
// Raw client
// -----------------------------------------------------------------------------

interface Chunk {
  readonly t: number
  readonly bytes: Buffer
}
interface Raw {
  readonly status: number
  readonly headers: http.IncomingHttpHeaders
  readonly chunks: Array<Chunk>
  readonly ended: Promise<void>
  /** Called with each chunk as it arrives. */
  onChunk: (c: Chunk) => void
  readonly close: () => void
}

const post = (base: string, path: string, body: Uint8Array, headers: Record<string, string>): Promise<Raw> =>
  new Promise((resolve, reject) => {
    const url = new URL(`${base.replace(/\/+$/, "")}/${path}`)
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST",
      headers: {
        "content-type": "application/grpc-web+proto",
        accept: "application/grpc-web+proto",
        "x-grpc-web": "1",
        "content-length": String(body.length),
        ...headers
      }
    }, (res) => {
      let end!: () => void
      const raw: Raw = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        chunks: [],
        ended: new Promise<void>((r) => (end = r)),
        onChunk: () => {},
        close: () => request.destroy()
      }
      res.on("data", (bytes: Buffer) => {
        const c = { t: performance.now(), bytes }
        raw.chunks.push(c)
        raw.onChunk(c)
      })
      res.on("end", () => end())
      res.on("close", () => end())
      res.on("error", () => end())
      resolve(raw)
    })
    request.on("error", reject)
    request.end(body)
  })

const header = (h: http.IncomingHttpHeaders, k: string) => {
  const v = h[k]
  return Array.isArray(v) ? v.join(", ") : v
}

// -----------------------------------------------------------------------------
// zstd frame structure (RFC 8878 §3.1.1)
// -----------------------------------------------------------------------------

interface ZstdLayout {
  /** Window size of the first frame, in bytes. */
  readonly window: number | undefined
  /** Frames seen (skippable frames included), and whether the bytes parse at all. */
  readonly frames: number
  readonly valid: boolean
}

/** Walk frame and block headers of a (possibly unfinished) zstd stream. */
const zstdLayout = (b: Buffer): ZstdLayout => {
  let at = 0
  let frames = 0
  let window: number | undefined
  while (at + 4 <= b.length) {
    const magic = b.readUInt32LE(at)
    frames++
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (at + 8 > b.length) break
      at += 8 + b.readUInt32LE(at + 4)
      continue
    }
    if (magic !== 0xfd2fb528 || at + 5 > b.length) return { window, frames, valid: magic === 0xfd2fb528 }
    const fhd = b[at + 4]!
    const singleSegment = (fhd & 0x20) !== 0
    const fcsFlag = fhd >> 6
    const didSize = [0, 1, 2, 4][fhd & 3]!
    const fcsSize = [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]!
    let p = at + 5
    let w: number | undefined
    if (!singleSegment) {
      const wd = b[p++]!
      const windowLog = 10 + (wd >> 3)
      const base = 2 ** windowLog
      w = base + (base / 8) * (wd & 7)
    }
    p += didSize
    if (singleSegment && p + fcsSize <= b.length) {
      let fcs = 0
      for (let i = fcsSize - 1; i >= 0; i--) fcs = fcs * 256 + b[p + i]!
      w = fcsSize === 2 ? fcs + 256 : fcs
    }
    p += fcsSize
    if (frames === 1) window = w
    for (;;) {
      if (p + 3 > b.length) return { window, frames, valid: true }
      const bh = b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16)
      const last = bh & 1
      const type = (bh >> 1) & 3
      if (type === 3) return { window, frames, valid: false }
      p += 3 + (type === 1 ? 1 : bh >>> 3)
      if (last) break
    }
    at = p + ((fhd & 4) !== 0 ? 4 : 0)
  }
  return { window, frames, valid: true }
}

// -----------------------------------------------------------------------------
// The check
// -----------------------------------------------------------------------------

interface Delivered {
  readonly cursor: bigint
  readonly t: number
}

/** Decode a layer-2 stream as it arrives: messages with the time they decoded, and idle points that fell mid-frame. */
const decodeLayer2 = (raw: Raw, count: number) => {
  const decoder = zlib.createZstdDecompress()
  const frames = frameSplitter()
  const delivered: Array<Delivered> = []
  let plainBytes = 0
  let receivedBytes = 0
  /** Plain and compressed bytes up to the end of checkpoint `count`. */
  let atCount: { plain: number; compressed: number } | undefined
  let compressedFlagSeen = false
  const boundaryAfter: Array<boolean> = [] // per chunk: decoded bytes end on a frame after it
  let queue = Promise.resolve()
  let done!: () => void
  const finished = new Promise<void>((r) => (done = r))
  decoder.on("data", (out: Buffer) => {
    plainBytes += out.length
    for (const f of frames.push(out)) {
      if ((f.flags & 0x80) !== 0) continue
      if ((f.flags & 1) !== 0) compressedFlagSeen = true
      const cursor = cursorOf(f.payload)
      if (cursor !== undefined) delivered.push({ cursor, t: performance.now() })
    }
  })
  decoder.on("error", () => done())
  const feed = (c: Chunk) => {
    queue = queue.then(() =>
      new Promise<void>((resolve) =>
        decoder.write(c.bytes, () => {
          receivedBytes += c.bytes.length
          boundaryAfter.push(frames.atBoundary)
          if (atCount === undefined && delivered.length >= count) {
            atCount = { plain: plainBytes, compressed: receivedBytes }
            done()
          }
          resolve()
        })
      )
    )
  }
  for (const c of raw.chunks) feed(c)
  raw.onChunk = feed
  void raw.ended.then(() => queue.then(() => done()))
  return {
    finished,
    get result() {
      const idle = raw.chunks.flatMap((c, i) => {
        const next = raw.chunks[i + 1]
        return next !== undefined && next.t - c.t >= IDLE_MS && i < boundaryAfter.length ? [boundaryAfter[i]!] : []
      })
      return {
        delivered: delivered.slice(0, count),
        plainBytes: atCount?.plain ?? plainBytes,
        compressedBytes: atCount?.compressed ?? receivedBytes,
        compressedFlagSeen,
        idlePoints: idle.length,
        midFrameAtIdle: idle.filter((b) => !b).length
      }
    }
  }
}

const decodePlain = (raw: Raw) => {
  const frames = frameSplitter()
  const delivered: Array<Delivered> = []
  let firstFlags: number | undefined
  const feed = (c: Chunk) => {
    for (const f of frames.push(c.bytes)) {
      firstFlags ??= f.flags
      const cursor = cursorOf(f.payload)
      if (cursor !== undefined) delivered.push({ cursor, t: c.t })
    }
  }
  for (const c of raw.chunks) feed(c)
  raw.onChunk = feed
  return {
    delivered,
    get firstFlags() {
      return firstFlags
    }
  }
}

const percentile = (xs: ReadonlyArray<number>, p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!
}

const results: Array<boolean> = []
const report = (ok: boolean | undefined, rule: string, detail: string) => {
  if (ok !== undefined) results.push(ok)
  console.log(`${ok === undefined ? "INFO" : ok ? "PASS" : "FAIL"}  ${rule.padEnd(30)} ${detail}`)
}

const check = async (url: string, count: number, mask: ReadonlyArray<string>) => {
  console.log(`${url}: SubscribeCheckpoints, first ${count} checkpoints, read mask ${mask.join(",")}\n`)
  const subscribe = grpcFrame(bytesField(0x0a, fieldMask(mask)))
  // What the SDK sends on Node 24, and what Node's fetch sends by default (the uncompressed baseline).
  const [z, plain] = await Promise.all([
    post(url, SUBSCRIBE, subscribe, { "accept-encoding": "zstd, gzip", "grpc-accept-encoding": "zstd,gzip" }),
    post(url, SUBSCRIBE, subscribe, { "accept-encoding": "gzip, deflate", "grpc-accept-encoding": "identity" })
  ])
  const p = decodePlain(plain)

  // S2, S6: headers.
  const ce = header(z.headers, "content-encoding")
  const vary = header(z.headers, "vary") ?? ""
  const cc = header(z.headers, "cache-control") ?? ""
  const length = header(z.headers, "content-length")
  const ge = header(z.headers, "grpc-encoding")
  report(
    z.status === 200 && ce === "zstd" && /\baccept-encoding\b/i.test(vary) && /\bno-transform\b/i.test(cc) && length === undefined,
    "S2 headers",
    `HTTP ${z.status}, content-encoding: ${ce ?? "-"}, vary: ${vary || "-"}, cache-control: ${cc || "-"}, content-length: ${length ?? "-"}`
  )
  if (ce !== "zstd") {
    z.close()
    for (let i = 0; i < 100 && p.delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 100))
    plain.close()
    report(undefined, "layer 2", "not applied: S3-S6 skipped")
  } else {
    const d = decodeLayer2(z, count)
    const deadline = setTimeout(() => z.close(), 30_000 + count * 2_000)
    await d.finished
    clearTimeout(deadline)
    // Let the plain stream catch up with the last compressed checkpoint, then stop both.
    const last = d.result.delivered.at(-1)?.cursor
    for (let i = 0; i < 40 && last !== undefined && !p.delivered.some((x) => x.cursor >= last); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    z.close()
    plain.close()
    const r = d.result
    const all = Buffer.concat(z.chunks.map((c) => c.bytes))
    const layout = zstdLayout(all)
    report(layout.valid && layout.frames === 1, "S3 one zstd stream", `${layout.frames} zstd frame(s)${layout.valid ? "" : ", unparseable"}`)
    const plainAt = new Map(p.delivered.map((x) => [x.cursor, x.t]))
    const delays = r.delivered.flatMap((x) => {
      const t = plainAt.get(x.cursor)
      return t === undefined ? [] : [x.t - t]
    })
    report(
      r.idlePoints > 0 && r.midFrameAtIdle === 0,
      "S4 flush at every frame",
      `${r.idlePoints} idle points (≥ ${IDLE_MS} ms without bytes), ${r.midFrameAtIdle} with a frame held back`
    )
    if (delays.length > 0) {
      const p50 = percentile(delays, 0.5)
      const p90 = percentile(delays, 0.9)
      report(
        p90 <= MAX_DELAY_MS,
        "S4 arrival vs uncompressed",
        `${delays.length} checkpoints: p50 ${p50.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms later than without compression`
      )
    } else {
      report(false, "S4 arrival vs uncompressed", "no checkpoint in common with the uncompressed stream")
    }
    report(
      layout.window !== undefined && layout.window <= MAX_WINDOW,
      "S5 window ≤ 8 MiB",
      layout.window === undefined ? "no window in the frame header" : `${(layout.window / (1 << 20)).toFixed(2)} MiB`
    )
    report(ge === undefined && !r.compressedFlagSeen, "S6 no grpc-encoding", `grpc-encoding: ${ge ?? "-"}, compressed frames: ${r.compressedFlagSeen ? "yes" : "none"}`)
    const seconds = r.delivered.length >= 2 ? (r.delivered.at(-1)!.t - r.delivered[0]!.t) / 1000 : 0
    report(
      r.delivered.length >= count ? undefined : false,
      "ratio",
      `${(r.plainBytes / Math.max(1, r.compressedBytes)).toFixed(2)}× over ${r.delivered.length} checkpoints ` +
        `(${r.plainBytes} bytes in ${r.compressedBytes})` +
        (seconds > 0 ? `; ${(r.compressedBytes / 1024 / seconds).toFixed(1)} KB/s instead of ${(r.plainBytes / 1024 / seconds).toFixed(1)}` : "")
    )
  }

  // S1: no zstd in Accept-Encoding, no stream compression.
  await plain.ended
  const pce = header(plain.headers, "content-encoding")
  report(
    plain.status === 200 && pce === undefined && p.firstFlags !== undefined && (p.firstFlags & 0x7e) === 0,
    "S1 plain without zstd",
    `Accept-Encoding: gzip, deflate -> content-encoding: ${pce ?? "-"}, ${p.delivered.length} checkpoints as plain gRPC-web`
  )

  // Layer 1 on a unary call, layer 2 not asked for.
  const getCheckpoint = grpcFrame(bytesField(0x1a, fieldMask(mask)))
  for (const offer of ["zstd,gzip", "gzip"]) {
    const raw = await post(url, GET_CHECKPOINT, getCheckpoint, { "accept-encoding": "identity", "grpc-accept-encoding": offer })
    await raw.ended
    const body = Buffer.concat(raw.chunks.map((c) => c.bytes))
    const f = frameSplitter().push(body)[0]
    const enc = header(raw.headers, "grpc-encoding")
    let detail = `grpc-accept-encoding: ${offer} -> grpc-encoding: ${enc ?? "-"}`
    let ok = false
    if (f !== undefined && (f.flags & 1) !== 0 && (enc === "zstd" || enc === "gzip") && offer.split(",").includes(enc)) {
      try {
        const msg = enc === "zstd" ? zlib.zstdDecompressSync(f.payload) : zlib.gunzipSync(f.payload)
        ok = true
        detail += `, ${msg.length} bytes in ${f.payload.length} (${(msg.length / f.payload.length).toFixed(2)}×)`
      } catch (e) {
        detail += `, does not decompress: ${String(e)}`
      }
    } else if (f !== undefined) {
      detail += `, frame flags 0x${f.flags.toString(16)}`
    }
    report(ok, `layer 1 unary (${offer.split(",")[0]})`, detail)
  }

  const failed = results.filter((x) => !x).length
  console.log(`\n${failed === 0 ? "conformant" : `${failed} rule(s) failed`}`)
  process.exitCode = failed === 0 ? 0 : 1
}

// -----------------------------------------------------------------------------
// Reference proxy (layer 2)
// -----------------------------------------------------------------------------

/** Whether an `Accept-Encoding` value accepts zstd (q > 0). */
const acceptsZstd = (value: string | undefined) =>
  (value ?? "").split(",").some((part) => {
    const [coding, ...params] = part.trim().split(";").map((s) => s.trim())
    const q = params.find((x) => x.startsWith("q="))
    return coding?.toLowerCase() === "zstd" && (q === undefined || Number(q.slice(2)) > 0)
  })

async function* read(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    yield value
  }
}

const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding", "upgrade", "te"])

const serve = (upstream: string, port: number) => {
  const base = upstream.replace(/\/+$/, "")
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const parts: Array<Buffer> = []
    for await (const c of req) parts.push(c as Buffer)
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim()
    // S1, and binary gRPC-web only.
    const layer2 = acceptsZstd(header(req.headers, "accept-encoding")) &&
      (contentType === "application/grpc-web" || contentType === "application/grpc-web+proto")
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !HOP.has(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
    }
    headers.set("accept-encoding", "identity")
    if (layer2) headers.set("grpc-accept-encoding", "identity") // S6: not combined with layer 1
    const abort = new AbortController()
    res.on("close", () => abort.abort())
    let up: Response
    try {
      up = await fetch(base + (req.url ?? "/"), {
        method: req.method ?? "GET",
        headers,
        ...(parts.length > 0 ? { body: Buffer.concat(parts) } : {}),
        signal: abort.signal
      })
    } catch (e) {
      res.writeHead(502).end(String(e))
      return
    }
    const out: Record<string, string> = {}
    up.headers.forEach((v, k) => {
      if (!HOP.has(k) && k !== "content-encoding") out[k] = v
    })
    // S9: trailers-only responses and HTTP errors pass through uncompressed.
    const compress = layer2 && up.status === 200 && !up.headers.has("grpc-status") && up.body !== null
    if (!compress) {
      res.writeHead(up.status, out)
      if (up.body !== null) for await (const c of read(up.body)) res.write(c)
      res.end()
      return
    }
    // S2.
    delete out["grpc-encoding"]
    out["content-encoding"] = "zstd"
    out["vary"] = out["vary"] ? `${out["vary"]}, Accept-Encoding` : "Accept-Encoding"
    out["cache-control"] = "no-transform"
    res.writeHead(200, out)
    // S3, S5, S7: one stream per response, level 3, 8 MiB window.
    const z = zlib.createZstdCompress({
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 3, [zlib.constants.ZSTD_c_windowLog]: 23 }
    })
    z.on("data", (c: Buffer) => res.write(c))
    z.on("end", () => res.end())
    res.on("close", () => z.destroy())
    const frames = frameSplitter()
    try {
      for await (const c of read(up.body!)) {
        for (const f of frames.push(Buffer.from(c))) {
          z.write(grpcFrame(f.payload, f.flags))
          // S4: flush after every frame, so no message waits for the next one.
          await new Promise<void>((r) => {
            z.once("close", r)
            z.flush(zlib.constants.ZSTD_e_flush, () => (z.off("close", r), r()))
          })
          if (z.destroyed) return
        }
      }
      z.end()
    } catch {
      z.destroy()
      res.destroy()
    }
  }
  const server = http.createServer((req, res) => {
    res.on("error", () => {})
    handle(req, res).catch(() => res.destroy())
  })
  server.listen(port, () => console.log(`layer-2 reference proxy: http://localhost:${port} -> ${base}`))
}

// -----------------------------------------------------------------------------

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const served = opt("--serve")
if (served !== undefined) {
  serve(served, Number(opt("--port") ?? 8790))
} else if (args[0] !== undefined && !args[0].startsWith("--")) {
  await check(args[0], Number(opt("--count") ?? 20), opt("--mask")?.split(",") ?? FULL_MASK)
} else {
  console.error("usage: check-compression.ts <url> [--count N] [--mask paths] | --serve <upstream> [--port P]")
  process.exitCode = 2
}
