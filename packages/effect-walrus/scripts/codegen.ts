/**
 * Regenerate `src/generated` from the testnet Walrus package.
 *
 *   bun packages/walrus/scripts/codegen.ts
 */
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Generate from "@unconfirmed/sui-codegen/Generate"
import { dirname, join, relative } from "node:path"
import config from "../sui-codegen.config.ts"

const dir = join(dirname(new URL(import.meta.url).pathname), "..")
const written = await Effect.runPromise(Generate.run(config, dir).pipe(Effect.provide(FetchHttpClient.layer)))
for (const file of written) console.log(relative(process.cwd(), file))
