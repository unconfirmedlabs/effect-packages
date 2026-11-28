// Types for both entry points: `index.js` (Bun, Node) and `web.js` (browsers).
export * from "./nodejs/walrus_wasm.js"

/** Where a build comes from: a URL to fetch, a `Response`, bytes, or a compiled module. */
export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module

export interface InitOptions {
  /** The SIMD build (`web/walrus_wasm_bg.wasm`). */
  readonly module_or_path?: InitInput | Promise<InitInput>
  /** The scalar build (`web/walrus_wasm_nosimd_bg.wasm`), used when the engine has no WebAssembly SIMD. */
  readonly fallback_module_or_path?: InitInput | Promise<InitInput>
}

/**
 * Browsers: fetch and instantiate the build this engine supports (once per
 * realm). Bun and Node: a no-op, the module is ready on import.
 */
export default function init(options?: InitOptions): void | Promise<unknown>

/** Whether the engine validates WebAssembly SIMD (`simd128`); always `true` on Bun and Node. */
export declare const simdSupported: () => boolean
