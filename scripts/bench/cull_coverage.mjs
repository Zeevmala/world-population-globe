#!/usr/bin/env node
/**
 * Cull coverage on the committed culled tiers — r5 (`public/data/r5.parquet`) and mid/r6
 * (`public/data/mid.parquet`) — at each tier's entry zoom (from `public/data/manifest.json`)
 * over India, Tokyo, Lagos and São Paulo, on 1280×800 and 1920×1080 canvases.
 *
 * Per view it reports:
 *   on-screen — cells deck.gl draws inside the canvas: each cell's world position through
 *               the real `GlobeViewport`'s pixel projection matrix, inside the canvas, and
 *               in front of the horizon as seen from the viewport's camera position (the
 *               oracle, independent of `src/lib/footprint.ts`);
 *   window    — cells in the cull window before the cap (`cullWindowCells`);
 *   selected  — cells `cullForView` hands to the layer (the window, top-k capped);
 *   cap       — 120,000;
 *   coverage  — share of the on-screen cells that are selected. 100 % wherever the
 *               on-screen count fits under the cap; below it, the cap is binding;
 *   window ÷ on-screen — the window's tightness.
 * Then it lists every view whose on-screen count exceeds the cap — the input to the
 * latitude/canvas-aware tier selection item.
 *
 * Also prints the same table at entry − 0.15 (the hysteresis band: the widest view each
 * tier is ever drawn at) with `--hysteresis`.
 *
 * Usage: node scripts/bench/cull_coverage.mjs [--hysteresis]
 * Exit: 0 when coverage is 100 % at every view with on-screen ≤ cap, else 1.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
import { loadTier } from './cull_bench.mjs'
import { cullForView, cullWindowCells } from '../../src/lib/lod.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CAP = 120_000
const HYSTERESIS = 0.15
const DEG = Math.PI / 180
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public/data/manifest.json'), 'utf8'))

const PLACES = [
  ['India', 77, 20],
  ['Tokyo', 139.7, 35.68],
  ['Lagos', 3.4, 6.5],
  ['São Paulo', -46.6, -23.5],
]
const CANVASES = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]
const TIERS = manifest.lods.filter((l) => !l.tiled && l.cellCount > CAP) // r5, mid
const withHysteresis = process.argv.includes('--hysteresis')

/** World positions as `GlobeViewport.projectPosition` computes them (256-unit globe). */
function worldPositions(data) {
  const n = data.lng.length
  const P = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const p = data.lat[i] * DEG
    const l = data.lng[i] * DEG
    P[3 * i] = 256 * Math.sin(l) * Math.cos(p)
    P[3 * i + 1] = -256 * Math.cos(l) * Math.cos(p)
    P[3 * i + 2] = 256 * Math.sin(p)
  }
  return P
}

/** deck.gl's own on-screen set for a view (see the header). */
function onScreen(P, view, canvas) {
  const vp = new GlobeViewport({ ...canvas, ...view })
  const M = vp.pixelProjectionMatrix
  const [ex, ey, ez] = vp.cameraPosition
  const out = []
  for (let i = 0, j = 0; j < P.length; i++, j += 3) {
    const x0 = P[j]
    const y0 = P[j + 1]
    const z0 = P[j + 2]
    if (x0 * ex + y0 * ey + z0 * ez < 256 * 256) continue
    const w = M[3] * x0 + M[7] * y0 + M[11] * z0 + M[15]
    const sx = (M[0] * x0 + M[4] * y0 + M[8] * z0 + M[12]) / w
    if (sx < 0 || sx > canvas.width) continue
    const sy = (M[1] * x0 + M[5] * y0 + M[9] * z0 + M[13]) / w
    if (sy < 0 || sy > canvas.height) continue
    out.push(i)
  }
  return out
}

const fmt = (n) => n.toLocaleString('en-US')
const rows = []
for (const t of TIERS) {
  const data = await loadTier(t.lod, t.h3Res, path.basename(t.file))
  const P = worldPositions(data)
  const zooms = withHysteresis ? [t.minZoom, t.minZoom - HYSTERESIS] : [t.minZoom]
  for (const zoom of zooms) {
    for (const canvas of CANVASES) {
      for (const [place, longitude, latitude] of PLACES) {
        const view = { longitude, latitude, zoom }
        const on = onScreen(P, view, canvas)
        const windowCount = cullWindowCells(data, view, canvas).length
        const sel = new Set(cullForView(data, view, canvas).indices)
        let covered = 0
        for (const i of on) if (sel.has(i)) covered++
        rows.push({
          tier: `${t.lod} (r${t.h3Res})`,
          zoom,
          canvas: `${canvas.width}×${canvas.height}`,
          place,
          onScreen: on.length,
          window: windowCount,
          selected: sel.size,
          coverage: on.length ? covered / on.length : 1,
        })
      }
    }
  }
}

const head = ['tier', 'zoom', 'canvas', 'place', 'on-screen', 'window', 'selected', 'cap', 'coverage', 'window÷on-screen']
const body = rows.map((r) => [
  r.tier,
  r.zoom.toFixed(2),
  r.canvas,
  r.place,
  fmt(r.onScreen),
  fmt(r.window),
  fmt(r.selected),
  fmt(CAP),
  `${(100 * r.coverage).toFixed(1)} %`,
  r.onScreen ? (r.window / r.onScreen).toFixed(2) : '—',
])
const widths = head.map((h, k) => Math.max(h.length, ...body.map((b) => b[k].length)))
const line = (cells) => `| ${cells.map((c, k) => (k >= 4 ? c.padStart(widths[k]) : c.padEnd(widths[k]))).join(' | ')} |`
console.log(line(head))
console.log(`|${widths.map((w, k) => (k >= 4 ? `${'-'.repeat(w + 1)}:` : '-'.repeat(w + 2))).join('|')}|`)
for (const b of body) console.log(line(b))

const over = rows.filter((r) => r.onScreen > CAP)
console.log(`\nViews with more than ${fmt(CAP)} cells on screen (the cap binds; coverage < 100 % by design):`)
if (!over.length) console.log('  none')
for (const r of over) {
  console.log(`  ${r.tier} z${r.zoom.toFixed(2)} ${r.canvas} ${r.place}: ${fmt(r.onScreen)} on screen → ${fmt(r.selected)} drawn (${(100 * r.coverage).toFixed(1)} %)`)
}
const bad = rows.filter((r) => r.onScreen <= CAP && r.coverage < 1)
if (bad.length) {
  console.log(`\nFAIL: ${bad.length} view(s) under the cap with on-screen cells missing`)
  process.exit(1)
}
console.log('\nPASS: 100 % coverage wherever on-screen ≤ cap')
