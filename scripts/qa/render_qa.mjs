#!/usr/bin/env node
/**
 * render_qa — headless render/perf QA for the population globe.
 *
 * Why this exists: every sprint in PROJECT_STATE.md ends with the same caveat —
 * "preview_screenshot still hangs on the WebGL canvas, so all visual asserts went
 * through eval oracles, not pixels". Structural oracles cannot tell you that a
 * frame took two seconds, that a tier crossing froze the main thread, or that the
 * canvas came back blank. This harness measures those directly:
 *
 *   · a zoom sweep across all three LOD bands over dense and sparse regions
 *   · real rAF frame timing during scripted pans and zoom ramps
 *   · long-task / stall detection, with the 2.2 and 4.5 tier crossings instrumented
 *   · console + page errors, verbatim, failing the run
 *   · the 120k rendered-cells/frame invariant, read off the live deck.gl layer
 *   · a screenshot per sampled state, each decoded and scored so a blank one fails
 *
 * Usage:
 *   node scripts/qa/render_qa.mjs [options]
 *
 *   --url <baseUrl>       drive an already-running server or a deployed site
 *                         (a production build has no __globe/__deck, so the run
 *                         degrades to hash-driven navigation — see LIMITATIONS)
 *   --root <dir>          repo root to start the dev server from (default: this repo)
 *   --port <n>            dev-server port (default 5199)
 *   --json <path>         write the JSON report here (default scripts/qa/out/render-qa.json)
 *   --baseline <path>     compare against a previous report; regressions fail the run
 *   --quick               short plan (~1 min) for iterating
 *   --out <dir>           screenshot directory (default scripts/qa/out)
 *   --no-screenshots      skip PNG capture
 *   --max-stall-ms <n>    also fail if a steady-state frame exceeds this (default: off,
 *                         because absolute frame times under SwiftShader are not a
 *                         hardware-comparable number)
 *   --budget-ms <n>       stop sampling after this much wall clock (default 420000)
 *
 * Exit: 0 pass · 1 regression/defect · 2 harness error.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchBrowser, probeWebgl, GL_FLAGS } from './browser.mjs'
import { ensureDevServer } from './server.mjs'
import { scorePngFile } from './png.mjs'
import {
  PROBE_INIT,
  appReady,
  collectLongtasks,
  markPhase,
  quietFrames,
  readAppState,
  readGl,
  readbackCanvas,
  runAnimation,
  setCamera,
} from './page-probe.mjs'
import {
  MAX_RENDERED_CELLS,
  FREEZE_MS,
  compareToBaseline,
  frameStats,
  printSummary,
  worstStall,
} from './report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

/** Camera targets. Two dense metros (different tiles, different hemispheres) and
 *  one empty ocean cell, where the r8 pyramid has nothing to stream. */
const REGIONS = {
  tokyo: { label: 'Tokyo', longitude: 139.7, latitude: 35.68, density: 'dense' },
  cairo: { label: 'Cairo', longitude: 31.24, latitude: 30.04, density: 'dense' },
  ocean: { label: 'S-Pacific', longitude: -140, latitude: -30, density: 'sparse' },
}

/** Tier bands, from the manifest: overview < 2.2 ≤ mid < 4.5 ≤ r8. */
function expectedTier(zoom) {
  if (zoom < 2.2) return 'overview'
  if (zoom < 4.5) return 'mid'
  return 'r8'
}

/** Angular half-extent of the viewport, mirroring `lib/lod.ts` — used to size a
 *  pan step so every zoom level gets a comparable amount of camera motion. */
const halfSpanDeg = (zoom) => Math.min(60, 180 / Math.pow(2, zoom))

/**
 * The run plan, ordered so each tier crossing is measured COLD — before any
 * sample has warmed that tier's data. Crossing 2.2 pays the 31 MB mid parquet
 * parse; crossing 4.5 pays the first r8 tile burst. Sampling those zooms first
 * would hide exactly the stall we are hunting.
 */
function buildPlan(quick) {
  if (quick) {
    return [
      { type: 'sample', region: 'tokyo', zoom: 1.3 },
      { type: 'crossing', id: 'cross-2.2', region: 'tokyo', from: 2.0, to: 2.45, frames: 20 },
      { type: 'sample', region: 'tokyo', zoom: 2.3 },
      { type: 'crossing', id: 'cross-4.5', region: 'tokyo', from: 4.3, to: 4.7, frames: 20 },
      { type: 'sample', region: 'tokyo', zoom: 4.6 },
    ]
  }
  const steps = []
  for (const zoom of [0.5, 1.3, 2.0]) steps.push({ type: 'sample', region: 'tokyo', zoom })
  steps.push({ type: 'crossing', id: 'cross-2.2', region: 'tokyo', from: 2.0, to: 2.45, frames: 24 })
  for (const zoom of [2.3, 3.0, 4.0]) steps.push({ type: 'sample', region: 'tokyo', zoom })
  steps.push({ type: 'crossing', id: 'cross-4.5', region: 'tokyo', from: 4.3, to: 4.7, frames: 24 })
  for (const zoom of [4.6, 5.5, 6.5]) steps.push({ type: 'sample', region: 'tokyo', zoom })
  for (const zoom of [2.3, 4.6, 6.5]) steps.push({ type: 'sample', region: 'cairo', zoom })
  for (const zoom of [1.3, 2.3, 4.6]) steps.push({ type: 'sample', region: 'ocean', zoom })
  return steps
}

function parseArgs(argv) {
  const opts = {
    url: null,
    root: REPO_ROOT,
    port: 5199,
    json: null,
    baseline: null,
    quick: false,
    out: join(REPO_ROOT, 'scripts', 'qa', 'out'),
    screenshots: true,
    maxStallMs: 0,
    budgetMs: 420_000,
    width: 1024,
    height: 640,
    settleTimeoutMs: 45_000,
    animFrames: 40,
    animMaxMs: 3500,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--url': opts.url = next(); break
      case '--root': opts.root = resolve(next()); break
      case '--port': opts.port = Number(next()); break
      case '--json': opts.json = resolve(next()); break
      case '--baseline': opts.baseline = resolve(next()); break
      case '--out': opts.out = resolve(next()); break
      case '--quick': opts.quick = true; break
      case '--no-screenshots': opts.screenshots = false; break
      case '--max-stall-ms': opts.maxStallMs = Number(next()); break
      case '--budget-ms': opts.budgetMs = Number(next()); break
      case '--width': opts.width = Number(next()); break
      case '--height': opts.height = Number(next()); break
      case '--settle-timeout': opts.settleTimeoutMs = Number(next()); break
      case '--frames': opts.animFrames = Number(next()); break
      case '--anim-ms': opts.animMaxMs = Number(next()); break
      case '--help': case '-h': printHelp(); process.exit(0); break
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag ${a}`)
    }
  }
  if (!opts.json) opts.json = join(opts.out, 'render-qa.json')
  return opts
}

function printHelp() {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (msg) => console.log(msg)

function gitInfo(root) {
  const run = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  try {
    return { commit: run(['rev-parse', '--short', 'HEAD']), dirty: run(['status', '--porcelain']).length > 0 }
  } catch {
    return { commit: null, dirty: null }
  }
}

/** Has the tier we expect at this zoom actually got data behind it? */
function tierAvailable(state, tier) {
  if (!state || state.error) return false
  if (tier === 'r8') return state.r8Cells > 0
  return (state.loadedLods || []).includes(tier)
}

/**
 * Wait for the app to stop working: the expected tier's data arrives, or the
 * network and the frame loop both go quiet (the sparse-ocean case, where the r8
 * pyramid legitimately has no tiles to stream and the tier never arrives).
 */
async function settleAt(page, ctx, { tier, timeoutMs, quietMs = 2500 }) {
  const t0 = Date.now()
  let tierReached = false
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(readAppState)
    if (last.status === 'error') break
    if (tierAvailable(last, tier)) { tierReached = true; break }
    const idleFor = Date.now() - Math.max(ctx.lastNetworkAt, t0)
    if (ctx.inFlight === 0 && idleFor > quietMs) break
    await sleep(200)
  }
  const quiet = await page.evaluate(quietFrames, 4000)
  const longtasks = await page.evaluate(collectLongtasks)
  const state = await page.evaluate(readAppState)
  return {
    ms: Date.now() - t0,
    tierReached,
    quiet: quiet.quiet,
    worstStallMs: worstStall([quiet.worstFrameMs], longtasks.entries),
    longtasks: longtasks.entries,
    state: state.error ? last : state,
  }
}

/** Screenshot + decode + score. A PNG that scores blank is a failure, not a file. */
async function capture(page, opts, id, findings) {
  if (!opts.screenshots) return null
  const path = join(opts.out, `${id.replace(/[^a-z0-9._-]+/gi, '-')}.png`)
  await page.screenshot({ path })
  const score = await scorePngFile(path)
  if (!score.ok) {
    findings.failures.push(
      `screenshot ${id} is blank or undecodable (stdev=${score.stdev ?? '—'}, distinctColors=${score.distinctColors ?? '—'}${score.error ? `, ${score.error}` : ''})`,
    )
  }
  return { path: path.replace(`${REPO_ROOT}/`, ''), ...score }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  mkdirSync(opts.out, { recursive: true })
  mkdirSync(dirname(opts.json), { recursive: true })

  const startedAt = Date.now()
  const findings = { failures: [], warnings: [] }

  // ---- target -------------------------------------------------------------
  let server = { url: opts.url, started: false, stop: async () => {} }
  if (!opts.url) server = await ensureDevServer({ root: opts.root, port: opts.port, log })
  const baseUrl = server.url.replace(/\/+$/, '') + '/'
  const git = gitInfo(opts.url ? REPO_ROOT : opts.root)

  // ---- browser ------------------------------------------------------------
  const { browser, page, executablePath, version } = await launchBrowser({ width: opts.width, height: opts.height })
  const preflight = await probeWebgl(page)
  log(`chromium ${version} at ${executablePath}`)
  log(`WebGL2 preflight: ${preflight.ok ? 'OK' : 'FAILED'} — ${preflight.renderer}`)
  if (!preflight.ok) findings.failures.push(`headless WebGL2 preflight failed: ${preflight.reason || 'cleared pixel mismatch'}`)

  await page.addInitScript(PROBE_INIT)

  const ctx = { phase: 'boot', inFlight: 0, lastNetworkAt: Date.now() }
  const consoleErrors = []
  const consoleWarnings = []
  const pageErrors = []
  const requestLog = []

  page.on('console', (msg) => {
    const entry = { phase: ctx.phase, text: msg.text(), location: msg.location()?.url || null }
    if (msg.type() === 'error') consoleErrors.push(entry)
    else if (msg.type() === 'warning') consoleWarnings.push(entry)
  })
  page.on('pageerror', (err) => pageErrors.push({ phase: ctx.phase, text: err.message }))
  page.on('request', (req) => {
    if (/\.(parquet|json|geojson)(\?|$)/.test(req.url())) {
      ctx.inFlight += 1
      requestLog.push({ phase: ctx.phase, url: req.url().replace(baseUrl, ''), at: Date.now() - startedAt })
    }
  })
  const settleRequest = (req) => {
    if (/\.(parquet|json|geojson)(\?|$)/.test(req.url())) {
      ctx.inFlight = Math.max(0, ctx.inFlight - 1)
      ctx.lastNetworkAt = Date.now()
    }
  }
  page.on('requestfinished', settleRequest)
  page.on('requestfailed', (req) => {
    settleRequest(req)
    findings.warnings.push(`request failed (${ctx.phase}): ${req.url()} — ${req.failure()?.errorText}`)
  })

  // ---- boot ---------------------------------------------------------------
  ctx.phase = 'boot'
  const bootAt = Date.now()
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 120_000 })
  let driveable = true
  try {
    await page.waitForFunction(appReady, null, { timeout: 120_000, polling: 300 })
  } catch {
    driveable = false
  }
  const hasHandles = await page.evaluate(() => !!(window.__globe && window.__deck))
  if (!hasHandles) {
    driveable = false
    findings.warnings.push(
      'window.__globe / window.__deck are absent — this is a production build, so tier/cell oracles and camera driving are unavailable (see LIMITATIONS).',
    )
  }
  const bootMs = Date.now() - bootAt
  const bootLongtasks = await page.evaluate(collectLongtasks)
  log(`boot: ${bootMs} ms, handles=${hasHandles}, longtask support=${bootLongtasks.supported}`)

  // ---- WebGL, live in the app --------------------------------------------
  const inAppGl = hasHandles ? await page.evaluate(readGl) : { ok: false, reason: 'no __deck handle' }
  const readback = hasHandles ? await page.evaluate(readbackCanvas, 37) : { ok: false, reason: 'no __deck handle' }
  if (hasHandles && !inAppGl.ok) findings.failures.push(`deck.gl WebGL context is not live: ${inAppGl.reason || 'context lost'}`)
  if (hasHandles && !readback.ok) {
    findings.failures.push(
      `canvas readback is blank (stdev=${readback.stdev}, distinctColors=${readback.distinctColors}) — nothing is being rasterised`,
    )
  }

  // ---- run the plan -------------------------------------------------------
  const plan = buildPlan(opts.quick)
  const samples = []
  const crossings = []
  let truncated = null

  for (const step of plan) {
    if (Date.now() - startedAt > opts.budgetMs) {
      truncated = `wall-clock budget ${opts.budgetMs} ms exhausted; ${plan.length - samples.length - crossings.length} step(s) skipped`
      findings.warnings.push(truncated)
      break
    }
    const region = REGIONS[step.region]
    if (step.type === 'sample') {
      const id = `${step.region}@z${step.zoom.toFixed(2)}`
      ctx.phase = id
      log(`· ${id} (${region.label}, ${region.density}, expect ${expectedTier(step.zoom)})`)
      const errorsBefore = consoleErrors.length + pageErrors.length

      await page.evaluate(markPhase)
      if (driveable) {
        await page.evaluate(setCamera, { longitude: region.longitude, latitude: region.latitude, zoom: step.zoom })
      } else {
        await page.goto(`${baseUrl}#${region.longitude}/${region.latitude}/${step.zoom}`, { waitUntil: 'load', timeout: 120_000 })
        await page.waitForFunction(() => document.querySelector('canvas') !== null, null, { timeout: 60_000 }).catch(() => {})
      }

      const timeoutMs = region.density === 'sparse' ? Math.min(opts.settleTimeoutMs, 15_000) : opts.settleTimeoutMs
      const settle = driveable
        ? await settleAt(page, ctx, { tier: expectedTier(step.zoom), timeoutMs })
        : { ms: 0, tierReached: null, quiet: null, worstStallMs: 0, longtasks: [], state: {} }

      const state = driveable ? settle.state : await page.evaluate(readAppState).catch(() => ({}))
      const screenshot = await capture(page, opts, id, findings)

      await page.evaluate(markPhase)
      const anim = await page.evaluate(runAnimation, {
        mode: driveable ? 'pan' : 'passive',
        lngStep: halfSpanDeg(step.zoom) / 40,
        frames: opts.animFrames,
        maxMs: opts.animMaxMs,
      })
      const frame = frameStats(anim.deltas)
      const stall = worstStall(anim.deltas, anim.longtasks)

      const tier = state.tier ?? null
      const renderedCells = state.renderedCells ?? null
      const capExceeded = renderedCells != null && renderedCells > MAX_RENDERED_CELLS
      if (capExceeded) {
        findings.failures.push(
          `P0 invariant: ${id} rendered ${renderedCells} cells/frame, over the ${MAX_RENDERED_CELLS} cap (tier ${tier})`,
        )
      }
      if (driveable && tier !== expectedTier(step.zoom)) {
        const note = `${id}: active tier is "${tier}", expected "${expectedTier(step.zoom)}"${region.density === 'sparse' ? ' (sparse region — r8 pyramid has no tile here, so the fallback is correct)' : ''}`
        if (region.density === 'sparse') findings.warnings.push(note)
        else findings.failures.push(note)
      }
      if (opts.maxStallMs > 0 && stall > opts.maxStallMs) {
        findings.failures.push(`${id}: steady-state frame/stall of ${stall} ms exceeds --max-stall-ms ${opts.maxStallMs}`)
      }
      if (stall >= FREEZE_MS) {
        findings.warnings.push(`${id}: worst steady-state block ${stall} ms (>${FREEZE_MS} ms reads as a freeze)`)
      }

      samples.push({
        id,
        region: step.region,
        regionLabel: region.label,
        density: region.density,
        longitude: region.longitude,
        latitude: region.latitude,
        zoom: step.zoom,
        expectedTier: expectedTier(step.zoom),
        tier,
        tierCells: state.tierCells ?? null,
        renderedCells,
        capExceeded,
        loadedLods: state.loadedLods ?? null,
        settle: {
          ms: settle.ms,
          tierReached: settle.tierReached,
          quiet: settle.quiet,
          worstStallMs: settle.worstStallMs,
          longtasks: settle.longtasks,
        },
        frame,
        worstStallMs: stall,
        longtasks: anim.longtasks,
        animElapsedMs: Math.round(anim.elapsed),
        deckMetrics: state.metrics ?? null,
        screenshot,
        consoleErrors: consoleErrors.filter((e) => e.phase === id),
        pageErrors: pageErrors.filter((e) => e.phase === id),
        newErrors: consoleErrors.length + pageErrors.length - errorsBefore,
      })
      log(
        `    tier=${tier} cells=${renderedCells} settle=${settle.ms}ms(worst ${settle.worstStallMs}ms) frames=${frame.frames} p50=${frame.p50}ms p95=${frame.p95}ms max=${frame.max}ms png=${screenshot ? (screenshot.ok ? 'ok' : 'BLANK') : 'skipped'}`,
      )
    } else {
      if (!driveable) {
        findings.warnings.push(`${step.id}: skipped — tier crossings need the dev-build camera handle`)
        continue
      }
      ctx.phase = step.id
      log(`· ${step.id} (${region.label}: zoom ${step.from} → ${step.to}, cold)`)
      await page.evaluate(markPhase)
      await page.evaluate(setCamera, { longitude: region.longitude, latitude: region.latitude, zoom: step.from })
      const before = await settleAt(page, ctx, { tier: expectedTier(step.from), timeoutMs: opts.settleTimeoutMs })

      await page.evaluate(markPhase)
      const anim = await page.evaluate(runAnimation, {
        mode: 'zoom',
        zoomFrom: step.from,
        zoomTo: step.to,
        frames: step.frames,
        maxMs: 20_000,
      })
      const after = await settleAt(page, ctx, { tier: expectedTier(step.to), timeoutMs: opts.settleTimeoutMs })
      const frame = frameStats(anim.deltas)
      const stall = Math.max(worstStall(anim.deltas, anim.longtasks), after.worstStallMs)
      const shot = await capture(page, opts, step.id, findings)

      if (after.state.renderedCells != null && after.state.renderedCells > MAX_RENDERED_CELLS) {
        findings.failures.push(
          `P0 invariant: ${step.id} rendered ${after.state.renderedCells} cells/frame after the crossing, over the ${MAX_RENDERED_CELLS} cap`,
        )
      }
      if (stall >= FREEZE_MS) {
        findings.warnings.push(`${step.id}: crossing froze the main thread for ${stall} ms (>${FREEZE_MS} ms)`)
      }

      crossings.push({
        id: step.id,
        region: region.label,
        from: step.from,
        to: step.to,
        tierBefore: before.state.tier ?? null,
        tierAfter: after.state.tier ?? null,
        cellsBefore: before.state.renderedCells ?? null,
        cellsAfter: after.state.renderedCells ?? null,
        frame,
        elapsedMs: Math.round(anim.elapsed),
        worstStallMs: stall,
        longtasks: [...anim.longtasks, ...after.longtasks],
        settle: { ms: after.ms, worstStallMs: after.worstStallMs, tierReached: after.tierReached },
        screenshot: shot,
        consoleErrors: consoleErrors.filter((e) => e.phase === step.id),
      })
      log(
        `    ${before.state.tier} → ${after.state.tier}, frames=${frame.frames} max=${frame.max}ms worst stall=${stall}ms settle=${after.ms}ms`,
      )
    }
  }

  ctx.phase = 'teardown'
  const finalGl = hasHandles ? await page.evaluate(readGl) : inAppGl
  if (hasHandles && !finalGl.ok) findings.failures.push('deck.gl WebGL context was lost during the run')

  await browser.close()
  await server.stop()

  // ---- verdict ------------------------------------------------------------
  if (consoleErrors.length) {
    for (const e of consoleErrors) findings.failures.push(`console.error (${e.phase}): ${e.text}`)
  }
  for (const e of pageErrors) findings.failures.push(`uncaught page error (${e.phase}): ${e.text}`)

  const report = {
    schema: 'render-qa/1',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    target: {
      url: baseUrl,
      mode: opts.url ? 'external url' : `vite dev server (root ${opts.root})`,
      root: opts.url ? null : opts.root,
      commit: git.commit,
      dirty: git.dirty,
      driveable,
    },
    browser: { executable: executablePath, version, flags: GL_FLAGS },
    viewport: { width: opts.width, height: opts.height, deviceScaleFactor: 1 },
    config: {
      quick: opts.quick,
      animFrames: opts.animFrames,
      animMaxMs: opts.animMaxMs,
      settleTimeoutMs: opts.settleTimeoutMs,
      maxStallMs: opts.maxStallMs,
      maxRenderedCells: MAX_RENDERED_CELLS,
    },
    webgl: { preflight, inApp: inAppGl, readback, final: finalGl },
    boot: { ms: bootMs, longtaskSupported: bootLongtasks.supported, longtasks: bootLongtasks.entries },
    limitations: [
      `Rendering runs on SwiftShader (${inAppGl.renderer || preflight.renderer || 'software rasterizer'}), a CPU rasterizer — absolute FPS is NOT comparable to a real GPU. Use these numbers two ways only: relative (run vs baseline on the same machine) and stall detection (a ${FREEZE_MS} ms+ frame is a freeze on any hardware).`,
      'Frame deltas come from in-page requestAnimationFrame timestamps; the wall-clock cap on an animation can only be checked between frames, so a single multi-second frame overshoots it. `animElapsedMs` records the truth.',
      'p50/p95 with fewer than 10 frames are flagged `lowConfidence` — at deep zoom a single frame can exceed the whole animation budget, so there is little to take percentiles of.',
      'Long tasks come from PerformanceObserver `longtask`, which reports duration but attributes work only coarsely; a stall is located in time, not blamed on a specific call stack.',
      'The dev server is unminified and unbundled (Vite serves ES modules) and the data is uncompressed on localhost, so load-side timings are not the deployed experience — `npm run verify:live` covers the CDN path.',
      ...(driveable ? [] : ['No __globe/__deck handles on this target: tier, rendered-cell and camera-driven measurements are unavailable; frame timing is a passive sample of the app\'s own animation.']),
    ],
    samples,
    crossings,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    requests: requestLog,
    truncated,
    verdict: { pass: true, failures: findings.failures, warnings: findings.warnings },
  }

  if (opts.baseline) {
    try {
      const baseline = JSON.parse(readFileSync(opts.baseline, 'utf8'))
      const comparison = compareToBaseline(report, baseline, opts.baseline)
      report.comparison = comparison
      findings.failures.push(...comparison.failures)
      findings.warnings.push(...comparison.warnings)
    } catch (err) {
      findings.warnings.push(`baseline ${opts.baseline} could not be read: ${err.message}`)
    }
  }

  report.verdict = { pass: findings.failures.length === 0, failures: findings.failures, warnings: findings.warnings }
  writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`)

  printSummary(report)
  log(`report: ${opts.json}`)
  log(`screenshots: ${opts.out}`)
  log(`total: ${(report.durationMs / 1000).toFixed(1)} s`)
  process.exit(report.verdict.pass ? 0 : 1)
}

main().catch((err) => {
  console.error('\nrender_qa harness error:', err && err.stack ? err.stack : err)
  process.exit(2)
})
