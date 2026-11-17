#!/usr/bin/env node
/**
 * tile_fail — headless confirmation that ONE failed r8 tile does not blank the r8 tier.
 *
 * Opens the dev server deep-linked to Tokyo at z5.5 (`#139.7/35.68/5.5`, an r8 view),
 * aborts every request for the r3 tile under the camera (Playwright `route.abort`,
 * on the browser context so the decode worker's fetches are intercepted too), and
 * waits for the app to publish r8 anyway. PASS = `activeLod === 'r8'` with r8 cells
 * > 0, the aborted tile really was requested, and no unhandled promise rejection.
 *
 * Before the fix, the visible tiles were awaited with `Promise.all`: the one abort
 * rejected the lot, nothing was merged, and the rejection went unhandled.
 *
 * With `--fail-times N` only the first N requests for that tile are aborted, so the
 * bounded retry can be seen recovering it (the tile's cells then join the r8 tier).
 *
 * Usage: node scripts/qa/tile_fail.mjs [--port 5199] [--timeout-ms 300000] [--parent <h3>] [--fail-times N]
 * Exit: 0 pass · 1 fail / inconclusive
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { latLngToCell } from 'h3-js'
import { launchBrowser } from './browser.mjs'
import { ensureDevServer } from './server.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const PORT = Number(opt('port', '5199'))
const TIMEOUT_MS = Number(opt('timeout-ms', '300000'))
// After the abort has been seen, give up once no tile has been requested for this long.
const QUIET_MS = 45_000
const VIEW = { lng: 139.7, lat: 35.68, zoom: 5.5 }
const PARENT = opt('parent', latLngToCell(VIEW.lat, VIEW.lng, 3))
const FAIL_TIMES = Number(opt('fail-times', 'Infinity'))

const t0 = Date.now()
const log = (m) => console.log(`[tile_fail +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)

const INIT = `
  window.__qaRejections = []
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    window.__qaRejections.push(String(r && r.message ? r.message : r))
  })
`

async function main() {
  const server = await ensureDevServer({ root: ROOT, port: PORT, log })
  const { browser, context, page } = await launchBrowser({ width: 1280, height: 800 })
  const pageErrors = []
  const tileWarnings = []
  const aborts = []
  let lastTileActivity = Date.now()
  let result
  try {
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'warning' && /tile/i.test(msg.text())) tileWarnings.push(msg.text())
    })
    // One route for every r8 tile request, so tile activity is tracked even though the
    // fetches come from the decode worker (whose requests never reach `page.on`).
    await context.route('**/data/tiles/r8/parent=*/**', (route) => {
      lastTileActivity = Date.now()
      if (!route.request().url().includes(`parent=${PARENT}/`)) return route.continue()
      if (aborts.length >= FAIL_TIMES) {
        log(`let through: ${route.request().url().replace(server.url, '')}`)
        return route.continue()
      }
      aborts.push(Date.now() - t0)
      log(`abort #${aborts.length}: ${route.request().url().replace(server.url, '')}`)
      return route.abort('failed')
    })
    await page.addInitScript(INIT)

    const url = `${server.url}#${VIEW.lng}/${VIEW.lat}/${VIEW.zoom}`
    log(`open ${url} — aborting ${Number.isFinite(FAIL_TIMES) ? `the first ${FAIL_TIMES}` : "every"} request(s) for tile ${PARENT}`)
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 })

    const read = () =>
      page.evaluate(() => {
        const s = window.__globe?.getState()
        return {
          activeLod: s?.activeLod ?? null,
          r8Cells: s?.r8Data ? s.r8Data.h3.length : 0,
          r8Aligned: s?.r8Data
            ? [s.r8Data.population.length, s.r8Data.lng.length, s.r8Data.lat.length].every(
                (n) => n === s.r8Data.h3.length,
              )
            : null,
          zoom: s?.viewState.zoom ?? null,
          rejections: window.__qaRejections ?? [],
        }
      })

    const deadline = t0 + TIMEOUT_MS
    let state = await read()
    let lastLog = 0
    for (;;) {
      state = await read().catch(() => state)
      if (state.activeLod === 'r8' && state.r8Cells > 0 && aborts.length > 0) break
      const now = Date.now()
      if (now > deadline) break
      if (aborts.length > 0 && now - lastTileActivity > QUIET_MS) break
      if (now - lastLog > 10_000) {
        lastLog = now
        log(`waiting: activeLod=${state.activeLod} r8Cells=${state.r8Cells} aborts=${aborts.length}`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    // Let the trailing retries land (2 s + 4 s backoff, queued behind the idle prefetch
    // in the decode workers) so the abort count — which shows whether the retry is
    // bounded — and the warnings are complete: wait for tile traffic to go quiet. Each
    // step round-trips through the page, because an r8 frame can block its main thread
    // for tens of seconds on SwiftShader, holding the retry timers back; a Node-side
    // clock alone would call that "quiet".
    const tailEnd = Math.min(deadline, Date.now() + 180_000)
    let quietSince = Date.now()
    while (Date.now() < tailEnd) {
      await new Promise((r) => setTimeout(r, 1000))
      const before = aborts.length
      await page.evaluate(() => new Promise((r) => setTimeout(r, 50))).catch(() => {})
      if (aborts.length !== before || Date.now() - lastTileActivity < 1500) quietSince = Date.now()
      if (Date.now() - quietSince > 15_000) break
    }
    state = await read().catch(() => state)

    const unhandled = [
      ...state.rejections,
      ...pageErrors.filter((m) => !state.rejections.includes(m)),
    ]
    const checks = {
      abortedTileRequested: aborts.length > 0,
      activeLodIsR8: state.activeLod === 'r8',
      r8CellsPositive: state.r8Cells > 0,
      columnsAligned: state.r8Aligned === true,
      noUnhandledRejection: unhandled.length === 0,
    }
    result = { pass: Object.values(checks).every(Boolean), checks, state, aborts, unhandled, tileWarnings }
  } finally {
    await browser.close().catch(() => {})
    await server.stop()
  }

  log(`activeLod=${result.state.activeLod} r8Cells=${result.state.r8Cells} aligned=${result.state.r8Aligned}`)
  log(`aborted requests for ${PARENT}: ${result.aborts.length} (at ms ${result.aborts.join(', ')})`)
  log(`unhandled rejections / page errors: ${result.unhandled.length}${result.unhandled.length ? ' — ' + result.unhandled.join(' | ') : ''}`)
  log(`tile console.warn lines: ${result.tileWarnings.length}${result.tileWarnings.length ? ' — ' + result.tileWarnings.join(' | ') : ''}`)
  for (const [k, v] of Object.entries(result.checks)) log(`  ${v ? 'ok  ' : 'FAIL'} ${k}`)
  log(result.pass ? 'PASS' : 'FAIL')
  process.exit(result.pass ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
