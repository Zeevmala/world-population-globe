#!/usr/bin/env node
/**
 * tile_fail — headless confirmation that ONE failed tile does not blank a tiled tier.
 *
 * Takes the finest tiled tier in the manifest (r8 today) and opens the dev server
 * deep-linked to Tokyo one zoom level inside its band (`#139.7/35.68/8.99` with r8 from
 * 7.99), aborts every request for the parent tile under the camera (Playwright `route.abort`,
 * on the browser context so the decode worker's fetches are intercepted too), and
 * waits for the app to publish the tier anyway. PASS = `activeLod` is the tier, with its
 * merged cells (`tiles[tier].data`) > 0 and aligned, the aborted tile really was
 * requested, and no unhandled promise rejection.
 *
 * Before the fix, the visible tiles were awaited with `Promise.all`: the one abort
 * rejected the lot, nothing was merged, and the rejection went unhandled.
 *
 * With `--fail-times N` only the first N requests for that tile are aborted, so the
 * bounded retry can be seen recovering it (the tile's cells then join the tier).
 *
 * With `--fail-worker` it checks the decode-worker fallback instead: every request for
 * the decode worker's module script is aborted, so each pool worker fails to load and
 * reports it asynchronously through `error`. The overview is opened (no deep link) and
 * PASS = `status === 'ready'`, the population layer has cells, the worker script really
 * was requested, each dead worker logged its `decode worker failed` console.error (the
 * failure is surfaced, not swallowed — that line is what turns qa:render red if a
 * worker dies in a normal run), and no unhandled rejection / page error. Before the
 * fix the requests posted to the dead workers were never settled and the app sat on
 * the loader forever.
 *
 * Usage: node scripts/qa/tile_fail.mjs [--port 5199] [--timeout-ms 300000] [--parent <h3>] [--fail-times N]
 *        node scripts/qa/tile_fail.mjs --fail-worker [--port 5199] [--timeout-ms 180000]
 * Exit: 0 pass · 1 fail / inconclusive
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { latLngToCell } from 'h3-js'
import { launchBrowser } from './browser.mjs'
import { readAppState } from './page-probe.mjs'
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
// The finest tiled tier in the committed manifest (r8 today), viewed one zoom level past
// the start of its band; the tile aborted is its parent (at the tier's tileParentRes)
// under the camera.
const TIER = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'manifest.json'), 'utf8'))
  .lods.filter((l) => l.tiled)
  .at(-1)
const VIEW = { lng: 139.7, lat: 35.68, zoom: Math.round((TIER.minZoom + 1) * 100) / 100 }
const PARENT = opt('parent', latLngToCell(VIEW.lat, VIEW.lng, TIER.tileParentRes))
// Tile URLs live beside the tier's index: `data/tiles/<tier>/parent=<h3>/…`.
const TILE_DIR = TIER.indexFile.slice(0, TIER.indexFile.lastIndexOf('/'))
const FAIL_TIMES = Number(opt('fail-times', 'Infinity'))
const FAIL_WORKER = args.includes('--fail-worker')

const t0 = Date.now()
const log = (m) => console.log(`[tile_fail +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)

const INIT = `
  window.__qaRejections = []
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    window.__qaRejections.push(String(r && r.message ? r.message : r))
  })
`

/**
 * `--fail-worker`: abort the decode worker's script and wait for the overview anyway.
 * The worker never loads, so `loadLod()` can only settle through the inline fallback.
 */
async function workerFail(server, context, page, pageErrors) {
  const workerAborts = []
  const deathErrors = []
  const otherErrors = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    if (/decode worker failed/.test(msg.text())) deathErrors.push(msg.text())
    else otherErrors.push(msg.text())
  })
  // A predicate, not a glob: the dev-server worker URL carries a query string
  // (`decode.worker.ts?worker_file&type=module`).
  await context.route(
    (u) => u.pathname.includes('decode.worker'),
    (route) => {
      workerAborts.push(Date.now() - t0)
      log(`abort worker script #${workerAborts.length}: ${route.request().url().replace(server.url, '')}`)
      return route.abort('failed')
    },
  )
  await page.addInitScript(INIT)
  log(`open ${server.url} — aborting every request for the decode worker script`)
  await page.goto(server.url, { waitUntil: 'load', timeout: 120_000 })

  const read = async () => ({
    ...(await page.evaluate(readAppState)),
    rejections: await page.evaluate(() => window.__qaRejections ?? []),
  })
  const deadline = t0 + TIMEOUT_MS
  let state = {}
  let lastLog = 0
  for (;;) {
    state = await read().catch(() => state)
    if (state.status === 'ready' && state.renderedCells > 0 && deathErrors.length >= workerAborts.length) break
    if (state.status === 'error') break
    if (Date.now() > deadline) break
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now()
      log(`waiting: status=${state.status} loaded=${JSON.stringify(state.loadedLods)} renderedCells=${state.renderedCells} workerAborts=${workerAborts.length}`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  const unhandled = [
    ...(state.rejections ?? []),
    ...pageErrors.filter((m) => !(state.rejections ?? []).includes(m)),
  ]
  const checks = {
    workerScriptRequested: workerAborts.length > 0,
    // One error line per dead worker: every aborted worker script is one death.
    workerDeathLogged: deathErrors.length > 0 && deathErrors.length === workerAborts.length,
    statusReady: state.status === 'ready',
    cellsOnScreen: (state.renderedCells ?? 0) > 0,
    noUnhandledRejection: unhandled.length === 0,
  }
  log(`status=${state.status} error=${state.storeError} loaded=${JSON.stringify(state.loadedLods)} tier=${state.tier} renderedCells=${state.renderedCells}`)
  log(`worker script requests aborted: ${workerAborts.length}`)
  log(`worker-death console.error lines: ${deathErrors.length}${deathErrors.length ? ' — ' + deathErrors.join(' | ') : ''}`)
  log(`other console.error lines (not asserted): ${otherErrors.length}${otherErrors.length ? ' — ' + otherErrors.join(' | ') : ''}`)
  log(`unhandled rejections / page errors: ${unhandled.length}${unhandled.length ? ' — ' + unhandled.join(' | ') : ''}`)
  for (const [k, v] of Object.entries(checks)) log(`  ${v ? 'ok  ' : 'FAIL'} ${k}`)
  return Object.values(checks).every(Boolean)
}

async function main() {
  const server = await ensureDevServer({ root: ROOT, port: PORT, log })
  const { browser, context, page } = await launchBrowser({ width: 1280, height: 800 })
  const pageErrors = []
  const tileWarnings = []
  const aborts = []
  let lastTileActivity = Date.now()
  let result
  if (FAIL_WORKER) {
    let pass = false
    try {
      page.on('pageerror', (err) => pageErrors.push(err.message))
      pass = await workerFail(server, context, page, pageErrors)
    } finally {
      await browser.close().catch(() => {})
      await server.stop()
    }
    log(pass ? 'PASS' : 'FAIL')
    process.exit(pass ? 0 : 1)
  }
  try {
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'warning' && /tile/i.test(msg.text())) tileWarnings.push(msg.text())
    })
    // One route for every r8 tile request, so tile activity is tracked even though the
    // fetches come from the decode worker (whose requests never reach `page.on`).
    await context.route(`**/${TILE_DIR}/parent=*/**`, (route) => {
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
      page.evaluate((lod) => {
        const s = window.__globe?.getState()
        const d = s?.tiles?.[lod]?.data ?? null
        return {
          activeLod: s?.activeLod ?? null,
          tierCells: d ? d.h3.length : 0,
          aligned: d ? [d.population.length, d.lng.length, d.lat.length].every((n) => n === d.h3.length) : null,
          zoom: s?.viewState.zoom ?? null,
          rejections: window.__qaRejections ?? [],
        }
      }, TIER.lod)

    const deadline = t0 + TIMEOUT_MS
    let state = await read()
    let lastLog = 0
    for (;;) {
      state = await read().catch(() => state)
      if (state.activeLod === TIER.lod && state.tierCells > 0 && aborts.length > 0) break
      const now = Date.now()
      if (now > deadline) break
      if (aborts.length > 0 && now - lastTileActivity > QUIET_MS) break
      if (now - lastLog > 10_000) {
        lastLog = now
        log(`waiting: activeLod=${state.activeLod} ${TIER.lod}Cells=${state.tierCells} aborts=${aborts.length}`)
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
      [`activeLodIs_${TIER.lod}`]: state.activeLod === TIER.lod,
      tierCellsPositive: state.tierCells > 0,
      columnsAligned: state.aligned === true,
      noUnhandledRejection: unhandled.length === 0,
    }
    result = { pass: Object.values(checks).every(Boolean), checks, state, aborts, unhandled, tileWarnings }
  } finally {
    await browser.close().catch(() => {})
    await server.stop()
  }

  log(`activeLod=${result.state.activeLod} ${TIER.lod}Cells=${result.state.tierCells} aligned=${result.state.aligned}`)
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
