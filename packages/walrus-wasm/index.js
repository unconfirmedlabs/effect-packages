// Bun and Node: the CommonJS glue reads `nodejs/walrus_wasm_bg.wasm` with `fs`
// and instantiates it synchronously on import. Every supported Node and Bun
// has WebAssembly SIMD, so there is no scalar fallback here.
export * from "./nodejs/walrus_wasm.js"

/** A no-op: the module is ready once imported. */
export default function init() {}

/** Always `true` on Bun and Node. */
export const simdSupported = () => true
