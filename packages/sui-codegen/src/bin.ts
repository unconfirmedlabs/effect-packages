#!/usr/bin/env bun
/**
 * sui-codegen generate [--config sui-codegen.config.ts]
 */
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { relative } from "node:path"
import * as Config from "./Config.ts"
import * as Generate from "./Generate.ts"

const usage = "usage: sui-codegen generate [--config <file>]"

const main = (argv: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const [command, ...rest] = argv
    if (command !== "generate") {
      console.error(usage)
      return 1
    }
    const at = rest.indexOf("--config")
    const path = at >= 0 ? rest[at + 1] : undefined
    const { config, dir } = yield* Config.load(path)
    const written = yield* Generate.run(config, dir)
    for (const file of written) console.log(relative(process.cwd(), file))
    return 0
  }).pipe(
    Effect.catch((e) => Effect.sync(() => {
      console.error(`${e._tag}: ${e.message}`)
      return 1
    })),
    Effect.provide(FetchHttpClient.layer)
  )

process.exitCode = await Effect.runPromise(main(process.argv.slice(2)))
