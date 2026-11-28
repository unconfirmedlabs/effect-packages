# Compressed gRPC streams — design

Status: design, 2026-11-28. SDK side not yet implemented.

How an RPC provider compresses Sui gRPC-web responses, and above all `SubscriptionService/SubscribeCheckpoints`, so that clients built on `@unconfirmed/sui` decompress them without code of their own. It has two layers, and both are existing standards:

1. **Per-message gRPC compression** (`grpc-encoding`): standard gRPC. Sui full nodes already apply it to every service except subscriptions. It gives about 4.6×.
2. **Stream compression** (`Content-Encoding: zstd` on a gRPC-web response, flushed after every frame): standard HTTP. One zstd context covers the whole response, so later checkpoints compress against earlier ones. It gives about 8–10× on checkpoint streams.

The SDK negotiates both and decodes whichever one the server picks. A provider can turn either layer on or off per endpoint, or per request under load, and clients keep working. If Mysten later compresses subscriptions upstream, layer 1 needs no change on our side, and a provider can drop layer 2 by no longer sending `Content-Encoding`.

## 1. Measurements

Workload: 200 consecutive mainnet checkpoints (from 349 964 851 on, at 4.15 checkpoints/s), read with `GetCheckpoint` under two read masks:

- **SDK mask:** `CHECKPOINT_PATHS` in `packages/sui/src/grpc/convert.ts` (summary fields, transaction digests, effects, events). Averages 116.7 KB/message, 536 KB/s.
- **Full mask:** `sequence_number, digest, summary, signature, contents, transactions`. Averages 327.7 KB/message, 1.51 MB/s.

Dictionaries were trained on the 200 checkpoints before the test range. Compression uses Node 24 `node:zlib` (libzstd), one core; "stream" means one context with `ZSTD_e_flush` after each message.

| Method | Ratio, SDK mask | Ratio, full mask | Compress throughput |
|---|---|---|---|
| gzip-6 per message | 4.35× | 3.67× | ~95 MB/s |
| zstd-1 per message | 4.71× | 4.37× | ~560 MB/s |
| zstd-3 per message | 4.78× | 4.59× | ~380 MB/s |
| zstd-3 + 110 KB dictionary per message | 6.32× | 5.66× | ~180–270 MB/s |
| zstd-1 stream (any window) | 6.56× | 4.99× | ~170–240 MB/s |
| zstd-3 stream, 1 MiB window | 7.95× | 6.45× | ~95 MB/s |
| zstd-3 stream, 4 MiB window | 9.57× | 7.71× | ~120 MB/s |
| **zstd-3 stream, 8 MiB window** | **9.81×** | **7.97×** | **~120 MB/s** |
| zstd-9 stream, 8 MiB window | 10.99× | 9.61× | ~50–60 MB/s |

Native zstd decompression in Node runs at about 1.0–1.2 GB/s, so client decode cost is negligible.

Findings:

- **Checkpoints repeat each other.** The same packages, type strings, addresses and shared objects recur, so a context that remembers earlier checkpoints roughly doubles what per-message compression achieves. On the full mask, 8 MiB stream mode sends about 190 KB/s instead of 1.51 MB/s.
- **Dictionaries are not worth it.** They recover only part of the gain and need versioning and distribution.
- **Window size matters at level 3,** up to 8 MiB.

Upstream behaviour, checked 2026-11-28 against `fullnode.mainnet.sui.io` and `MystenLabs/sui` main:

- With `grpc-accept-encoding: zstd` (or `gzip`), unary calls come back compressed per message. A full-transactions `GetCheckpoint` went from 252 928 to 67 838 bytes. Every v2 service is built with `.send_compressed(CompressionEncoding::Zstd)` (`crates/sui-rpc-api/src/lib.rs`), **except `SubscriptionService`**, which streams uncompressed whatever the client asks. No issue or PR proposes changing that.
- No full node sends `Content-Encoding` on gRPC-web.

Client runtimes, checked 2026-11-28:

| Runtime | `fetch` decodes a flushed `Content-Encoding: zstd` stream as it arrives | Sends `Accept-Encoding: zstd` by default | `DecompressionStream("zstd")` |
|---|---|---|---|
| Bun 1.4 | yes (each flushed chunk on time, tested) | yes (`gzip, deflate, br, zstd`) | yes |
| Node 24 | yes (tested) | **no** (`gzip, deflate`) | no |
| Chrome 123+, Firefox 126+ | yes (zstd content coding) | yes (over HTTPS; set by the browser, not by page code) | no (Firefox only behind a pref) |
| Safari | unclear | unclear | no |

## 2. Layer 1: per-message compression (`grpc-encoding`)

This layer is standard gRPC over HTTP/2 and gRPC-web, with nothing added:

- **The client** sends `grpc-accept-encoding: <list>`.
- **The server** may compress any message with one encoding from that list. It names the encoding in the `grpc-encoding` response header and sets bit 0 of that frame's flag byte. Each compressed message must be decodable on its own.
- **Trailer frames** (flag bit 7) are never compressed.

Providers:

- **What to enable:** `zstd`, plus `gzip` for clients without a zstd decoder.
- **Sharing work:** a provider that fans one upstream subscription out to many clients can compress each checkpoint once per (read mask, encoding) and send the same bytes to all of them. This is the cheap layer.
- **Native gRPC clients** (tonic, grpc-go, grpc-java) use only this layer; HTTP/2 gRPC has no use for `Content-Encoding`.

## 3. Layer 2: stream compression (`Content-Encoding: zstd`)

This layer applies to binary gRPC-web responses only (`application/grpc-web`, `application/grpc-web+proto`; not `-text`). The rules:

- **S1. Negotiation.** The server may apply it when the request's `Accept-Encoding` includes `zstd` with a non-zero q-value. Otherwise it must not.
- **S2. Headers.** The response carries `Content-Encoding: zstd`, `Vary: Accept-Encoding` and `Cache-Control: no-transform`. It carries no `Content-Length`.
- **S3. One stream per response.** The whole gRPC-web body (every frame, headers and payloads, data and trailers) is one zstd stream, as RFC 8878 §3 defines the `zstd` content coding.
- **S4. Flush at every frame boundary.** After writing each complete gRPC-web frame, the server calls `ZSTD_e_flush`, or the library's equivalent: Node `zstd.flush(ZSTD_e_flush)`, Rust `zstd::stream::Encoder::flush`. The bytes received so far then decode to whole frames, and no message waits for the next one. The server ends the stream (`ZSTD_e_end`) after the trailers frame.
- **S5. Window at most 8 MiB** (`windowLog ≤ 23`). This is the window decoders of the zstd content coding must support (RFC 8878 §3). A larger window can be refused by browsers.
- **S6. Not combined with layer 1.** A response with `Content-Encoding: zstd` must not also set `grpc-encoding` or compress individual messages, since compressing twice wastes CPU for no gain.
- **S7. Recommended level: 3.** Level 1 is acceptable under load; it gives 6.6×/5.0× stream ratios here. Levels above 3 cost more CPU than they save for live streams.
- **S8. Unary responses may use it too,** with the same rules. For one message the gain over layer 1 is small, so layer 1 is usually enough there.
- **S9. Errors.** A gRPC error during the stream arrives in the trailers frame, compressed like everything else. A trailers-only error response (`grpc-status` in the HTTP headers, empty body) is sent without `Content-Encoding`. The HTTP status stays `200` for gRPC-level errors.

Proxies and CDNs in the path must pass the stream through without buffering or re-encoding, which is what `no-transform` asks for. If a proxy strips the encoding, the client gets plain gRPC-web and still works.

### Server cost

Layer 2 needs one compression context per connection, so its output can't be shared between subscribers:

- **CPU.** At level 3 with an 8 MiB window, one core compresses about 120 MB/s. That is roughly 220 subscribers on the SDK mask or 80 on the full mask, at mainnet's current rate.
- **Memory.** Each context holds the 8 MiB window plus zstd's level-3 tables, on the order of 10 MiB; measure on the target build.
- **Under load,** a provider may cap concurrent layer-2 streams and serve the rest with layer 1 (S1 says "may"). Clients can't tell the difference.

### Why not a custom `grpc-encoding` with a shared context

A `grpc-encoding: zstd-stream` that kept one context across messages would compress the same as layer 2. It was rejected for now:

- gRPC requires every compressed message to be decodable on its own, so gRPC-aware proxies that inspect messages would break.
- Every client would need custom codec code.
- Browsers would need a WASM or JS zstd decoder, because `DecompressionStream("zstd")` isn't available.

Layer 2 gets native decoding in browsers, Bun and Node for free. If native gRPC clients ever need the stream ratio, `zstd-stream` can be specified later with S3–S5 carried over (a context per RPC, a flush per message, the window cap).

## 4. SDK behaviour (`GrpcWeb`)

New option, following the README conventions:

```ts
GrpcWeb.layer({ url, compression?: boolean }) // default true
```

With `compression` on:

- **Layer 1.**
  - Send `grpc-accept-encoding`, listing only encodings this runtime can decode: `zstd` when `new DecompressionStream("zstd")` constructs (Bun today; browsers as they ship it), and always `gzip`.
  - Decode any data frame with flag bit 0 set, according to the response's `grpc-encoding`.
  - A compressed frame without `grpc-encoding`, or with an encoding we didn't offer, fails with `RpcError` `INTERNAL`, as gRPC specifies. Today's code ignores the flag and would misread such a frame.
- **Layer 2.**
  - Outside browsers, send `Accept-Encoding: zstd, gzip` explicitly, because Node's `fetch` leaves `zstd` out. In browsers the header is forbidden and the browser sets it itself; setting it there is a no-op.
  - `fetch` decodes the response; `GrpcWeb` sees plain frames.
- **Off (`compression: false`).** Send `grpc-accept-encoding: identity` and leave `Accept-Encoding` alone. This is for debugging or for measuring the uncompressed size.

Decompression of layer-1 messages is async (`DecompressionStream`), which fits the existing `Stream`-based frame pipeline. Programs that never receive a compressed frame should pay almost nothing in bundle size: the decoder is the platform's, not ours.

## 5. Conformance check for providers

The script `scripts/check-compression.ts <url>` runs against a provider endpoint and reports pass or fail for each rule:

- `SubscribeCheckpoints` with `Accept-Encoding: zstd`:
  - S2 headers;
  - S3 one stream;
  - S4: each checkpoint arrives without waiting for the next, measured as time from the zstd flush boundary to frame decode while the stream is live;
  - S5 window size, read from the zstd frame header;
  - S6 no `grpc-encoding`;
  - the ratio achieved on the first N checkpoints;
- that the response is uncompressed when `Accept-Encoding` omits zstd;
- layer 1 on a unary call.

The SDK's own tests run against a local Bun server that implements S1–S9, so they need neither a network nor a provider.
