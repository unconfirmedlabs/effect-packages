/**
 * README examples (Importing), compiled by `bun run typecheck`. Each
 * `// #region readme` is a README block verbatim; `readme.test.ts` in
 * packages/test-support checks that they stay identical. Not meant to run.
 */
import * as Effect from "effect/Effect"
import * as Address from "@unconfirmed/effect-sui/Address"
import * as ObjectsGrpc from "@unconfirmed/effect-sui/grpc/ObjectsGrpc"

export const used = [Effect.void, Address.normalize, ObjectsGrpc.layer]
