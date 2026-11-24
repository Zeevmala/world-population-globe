#!/usr/bin/env node
/**
 * zoom_rebuild — does a zoom inside one cull key re-tessellate the column layer?
 *
 * The unit tests prove it through deck.gl's prop diff in Node; this checks the same thing
 * in the real page, where the LayerManager and the attribute manager are live. It wraps
 * the fill sublayer's PolygonTesselator.updateGeometry on the dev server and counts calls:
 * ten zoom-only frames inside one cull key must cost 0 (and keep the same data object
 * while elevationScale moves), and a pan to a new cull key must cost at least 1 — the
 * control that shows the counter is wired to something.
 *
 * Usage: node scripts/qa/zoom_rebuild.mjs      (≈ 6 min on the software rasterizer)
 * Exit: 0 pass · 1 fail
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBrowser } from './browser.mjs'
import { ensureDevServer } from './server.mjs'
import { readAppState, setCamera } from './page-probe.mjs'
import { ZOOM_STEP } from '../../src/lib/footprint.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// A culled tier (more cells than the 120 k cap, so `cullForView` keys on the camera):
// the coarsest such tier in the manifest — r5 since the re-band — at the cull-key zoom
// bucket (`ZOOM_STEP` wide, from `src/lib/footprint.ts`) nearest the middle of its band.
const CAP = 120_000
const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'manifest.json'), 'utf8'))
const TIER = manifest.lods.find((l) => !l.tiled && l.cellCount > CAP)
const Z0 = Math.round((TIER.minZoom + TIER.maxZoom) / 2 / ZOOM_STEP) * ZOOM_STEP
const t0 = Date.now()
const log = (m) => console.log(`[zoom_rebuild +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const server = await ensureDevServer({ root: ROOT, port: 5199, log })
const { browser, page } = await launchBrowser({ width: 900, height: 560 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
try {
  log(`culled tier: ${TIER.lod} (${TIER.cellCount} cells, band ${TIER.minZoom}–${TIER.maxZoom}) at zoom ${Z0}`)
  await page.goto(`${server.url}#77.0000/20.0000/${Z0.toFixed(2)}`, { waitUntil: 'load', timeout: 120_000 })
  let st
  for (let i = 0; i < 120; i++) {
    st = await page.evaluate(readAppState)
    if (st.tier === TIER.lod && st.renderedCells > 0) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  log(`tier=${st.tier} renderedCells=${st.renderedCells}`)
  if (st.tier !== TIER.lod) throw new Error(`expected the culled "${TIER.lod}" tier on screen, got "${st.tier}"`)
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))
  await frame(); await frame()

  const install = await page.evaluate(() => {
    const layers = window.__deck.layerManager.getLayers()
    const top = layers.find((l) => l.id === 'population')
    const fill = layers.find((l) => l.id.startsWith('population') && l.id.endsWith('fill'))
    const t = fill?.state?.polygonTesselator
    if (!top || !fill || !t) return { ok: false, ids: layers.map((l) => l.id) }
    window.__d0 = top.props.data
    window.__tess = 0
    const orig = t.updateGeometry.bind(t)
    t.updateGeometry = (...a) => { window.__tess++; return orig(...a) }
    return { ok: true, fillId: fill.id, cells: top.props.data.length, elevationScale: top.props.elevationScale }
  })
  log(`installed counter: ${JSON.stringify(install)}`)
  if (!install.ok) throw new Error('population layers not found')

  const read = () => page.evaluate(() => {
    const top = window.__deck.layerManager.getLayers().find((l) => l.id === 'population')
    return { tess: window.__tess, sameData: top.props.data === window.__d0, elevationScale: Math.round(top.props.elevationScale), cells: top.props.data.length }
  })

  // 1) zoom-only frames inside one cull key (zoom bucket Z0 ± ZOOM_STEP/2, position unchanged):
  //    offsets up to 0.44 of a step either way.
  const zooms = [-0.32, -0.2, -0.08, 0.08, 0.2, 0.32, 0.44, 0.28, 0, -0.24].map((d) => Z0 + d * ZOOM_STEP)
  for (const z of zooms) {
    await page.evaluate(setCamera, { longitude: 77, latitude: 20, zoom: z })
    await frame(); await frame()
  }
  const afterZoom = await read()
  log(`after ${zooms.length} zoom-only frames: ${JSON.stringify(afterZoom)}`)

  // 2) control: a pan across a cull key must re-tessellate
  await page.evaluate(setCamera, { longitude: 95, latitude: 20, zoom: Z0 })
  await frame(); await frame(); await frame()
  const afterPan = await read()
  log(`after an 18° pan (new cull key):   ${JSON.stringify(afterPan)}`)

  const pass = afterZoom.tess === 0 && afterZoom.sameData && afterZoom.elevationScale !== Math.round(install.elevationScale) && afterPan.tess >= 1 && !afterPan.sameData && errors.length === 0
  log(`console/page errors: ${errors.length}${errors.length ? ' — ' + errors.slice(0, 3).join(' | ') : ''}`)
  log(pass ? 'PASS — zoom frames re-tessellate nothing; a re-cull still does' : 'FAIL')
  process.exitCode = pass ? 0 : 1
} finally {
  await browser.close()
  await server.stop()
}
