/**
 * Optional real-browser smoke test: bundles browser-smoke.entry.ts, serves it
 * on localhost (a secure context, so Web Locks and OPFS exist) and runs it in
 * headless Chromium through `playwright-core`. Off unless `SUI_BROWSER=1`;
 * `SUI_BROWSER_ENGINE=firefox|webkit` picks another engine. It needs that
 * Playwright browser already installed (`~/.cache/ms-playwright`, or
 * `SUI_BROWSER_EXECUTABLE`) and never downloads one.
 */
import { expect, test } from "bun:test"

const enabled = process.env.SUI_BROWSER === "1"

test.skipIf(!enabled)(`IndexedDB, OPFS and Web Locks in headless ${process.env.SUI_BROWSER_ENGINE ?? "chromium"}`, async () => {
  const engines = await import("playwright-core")
  const engine = (process.env.SUI_BROWSER_ENGINE ?? "chromium") as "chromium" | "firefox" | "webkit"
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/browser-smoke.entry.ts`], target: "browser", minify: false })
  if (!built.success) throw new AggregateError(built.logs, "bundling the smoke entry failed")
  const js = await built.outputs[0]!.text()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/smoke.js"
        ? new Response(js, { headers: { "content-type": "text/javascript" } })
        : new Response("<!doctype html><script type=module src=/smoke.js></script>", { headers: { "content-type": "text/html" } })
  })
  const executable = process.env.SUI_BROWSER_EXECUTABLE
  const browser = await engines[engine].launch(executable === undefined ? {} : { executablePath: executable })
  try {
    const page = await browser.newPage()
    const errors: Array<string> = []
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`http://localhost:${server.port}/`)
    await page.waitForFunction(() => (globalThis as { __smoke?: unknown }).__smoke !== undefined, undefined, { timeout: 20_000 })
    const result = await page.evaluate(() => (globalThis as { __smoke?: unknown }).__smoke)
    expect(errors).toEqual([])
    const store = { ok: { tag: "Executed", keys: ["bin", "entry:D1", "settled:D1"], bin: [0, 1, 255] } }
    const r = result as { opfs: object }
    expect(result).toEqual({ indexedDb: store, opfs: r.opfs, locks: { ok: { max: 1, after: "released" } } })
    // Playwright's WebKit on Linux refuses getDirectory (UnknownError): that must surface typed, not as a defect.
    if (engine === "webkit") expect<Array<object>>([store, { error: expect.stringMatching(/^KeyValueStoreError: OPFS open failed/) }]).toContainEqual(r.opfs)
    else expect(r.opfs).toEqual(store)
  } finally {
    await browser.close()
    server.stop(true)
  }
}, 60_000)
