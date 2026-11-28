/**
 * Both shapes work: `import * as Quorum from "@unconfirmed/quorum"` (flat, like
 * the other single-module packages) and `import { Quorum } from "@unconfirmed/quorum"`.
 */
export * from "./Quorum.ts"
export * as Quorum from "./Quorum.ts"
