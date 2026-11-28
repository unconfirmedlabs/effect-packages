// Browsers: fetch and instantiate one of two builds, the SIMD one when the
// engine validates a SIMD instruction, else the scalar one (same exports).
import initGlue from "./web/walrus_wasm.js"

export * from "./web/walrus_wasm.js"

// (module (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt))
const SIMD_PROBE = /* @__PURE__ */ new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
])

/** Whether this engine has WebAssembly SIMD (`simd128`). */
export const simdSupported = () => WebAssembly.validate(SIMD_PROBE)

/**
 * Fetch and instantiate the module (once per realm). Without arguments the
 * builds next to this file are used (`new URL(…, import.meta.url)`, which Vite
 * and webpack 5 emit as assets); `module_or_path` / `fallback_module_or_path`
 * override where the SIMD and the scalar build come from.
 */
export default function init(options) {
  const simd = simdSupported()
  const source = simd
    ? (options?.module_or_path ?? new URL("./web/walrus_wasm_bg.wasm", import.meta.url))
    : (options?.fallback_module_or_path ?? new URL("./web/walrus_wasm_nosimd_bg.wasm", import.meta.url))
  return initGlue({ module_or_path: source })
}
