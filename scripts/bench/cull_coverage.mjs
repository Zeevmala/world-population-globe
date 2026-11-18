#!/usr/bin/env node
/**
 * Cull coverage on the committed culled tiers, at the zooms the APP selects them — r5
 * (`public/data/r5.parquet`), mid/r6 (`public/data/mid.parquet`), and the merged tiles of
 * r7 and r8 (`public/data/tiles/`).
 *
 * Default: over India, Tokyo, Lagos, São Paulo, Delhi and Moscow on 900×560 (the render
 * harness), 1280×800 and 1920×1080, the full table below. `--scan`: the review's scan — every
 * populated 2.5° land cell from 60° S to 70° N plus the 150 most populous r4 cells, on five
 * canvases (adds 375×812 and 2560×1080) — summarized, with the ten largest windows.
 *
 * Each view sits at the tier's threshold FOR THAT VIEW — the app's own selection
 * (`src/lib/tierBands.ts`: the later of the 3-px rule and the zoom from which the tier's cull
 * window cannot overfill the cap, both moved by latitude) — and, with `--hysteresis` (always
 * in `--scan`), 0.15 below it with the tier on screen (the widest view a tier is ever drawn
 * at). The selected-tier column is the app's `wantedIndex` for that view, so a row only
 * counts if the app would draw that tier there. A tiled tier's data is what the app merges
 * for the view: the tiles of the parents `selectParents` lists as visible (`src/lib/tiles.ts`).
 *
 * Per view it reports:
 *   on-screen — cells deck.gl draws inside the canvas: each cell's world position through
 *               the real `GlobeViewport`'s pixel projection matrix, inside the canvas, and
 *               in front of the horizon as seen from the viewport's camera position (the
 *               oracle, independent of `src/lib/footprint.ts`);
 *   window    — cells in the cull window before the cap (`cullWindowCells`; a merged tile set
 *               at or under the cap is drawn whole, but its window is still what is counted);
 *   selected  — cells `cullForView` hands to the layer (the window, capped);
 *   cap       — 120,000;
 *   coverage  — share of the on-screen cells that are selected;
 *   window÷on — the window's tightness;
 *   key views — views sharing the trigger's re-cull key (the key's corners at both ends of
 *               its zoom range, found by bisection on the key itself, plus random interior
 *               views) THAT STILL SELECT THE TIER (held), each checked against the
 *               trigger's selection with the same oracle;
 *   key cover — the worst coverage over those views.
 *
 * Usage: node scripts/bench/cull_coverage.mjs [--hysteresis] [--scan]
 * Exit: 0 only when no window exceeds the cap, no checked view (trigger or same-key) misses
 * an on-screen cell, no view needs more tiles than the cache holds, and every row's tier is
 * the one the app selects there; else 1, listing every offender.
 * (Node ≥ 22.18 strips the TypeScript types of the imported `src/lib/*.ts` natively.)
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
import { parquetMetadataAsync } from 'hyparquet'
import { parquetReadColumn } from 'hyparquet/src/read.js'
import { loadTier } from './cull_bench.mjs'
import { cullForView, cullKeyFor, cullWindowCells } from '../../src/lib/lod.ts'
import { TIER_HYSTERESIS, tierEntry, wantedIndex } from '../../src/lib/tierBands.ts'
import { selectParents } from '../../src/lib/tiles.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CAP = 120_000
const TILE_CACHE_MAX = 64 // src/data/tileStream.ts
const DEG = Math.PI / 180
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public/data/manifest.json'), 'utf8'))
const { lods } = manifest

const PLACES = [
  ['India', 77, 20],
  ['Tokyo', 139.7, 35.68],
  ['Lagos', 3.4, 6.5],
  ['São Paulo', -46.6, -23.5],
  ['Delhi', 77.2, 28.6],
  ['Moscow', 37.6, 55.75],
]
const CANVASES = [
  { width: 900, height: 560 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]
const TIERS = lods.map((l, i) => ({ ...l, i })).filter((l) => l.tiled || l.cellCount > CAP) // r5, mid, r7, r8
const withHysteresis = process.argv.includes('--hysteresis')

/** Deterministic PRNG for the interior same-key views. */
function rng(seed) {
  let s = seed >>> 0
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}

/** A tile file decoded like `decode.worker.ts` (lng / lat / population as Float32Array). */
async function loadColumns(file) {
  const buf = await readFile(path.join(ROOT, 'public', file))
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const pf = { byteLength: bytes.byteLength, slice: (s, e) => bytes.slice(s, e) }
  const metadata = await parquetMetadataAsync(pf)
  const f32 = (c) => (c instanceof Float32Array ? c : Float32Array.from(c))
  const read = async (name) => f32(await parquetReadColumn({ file: pf, metadata, columns: [name] }))
  return { population: await read('population'), lng: await read('lng'), lat: await read('lat') }
}

const tileIndex = new Map()
const tileCache = new Map()
/** What the app draws for a tiled tier at a view: the merge of the visible parents' tiles. */
async function tiledData(t, view, canvas) {
  if (!tileIndex.has(t.lod)) {
    const idx = JSON.parse(readFileSync(path.join(ROOT, 'public', t.indexFile), 'utf8'))
    tileIndex.set(t.lod, new Map(idx.tiles.map((x) => [x.parent, x.file])))
  }
  const files = tileIndex.get(t.lod)
  const sel = selectParents(view, canvas, t.tileParentRes, TILE_CACHE_MAX)
  const parts = []
  for (const p of sel.visible) {
    const file = files.get(p)
    if (!file) continue
    if (!tileCache.has(file)) tileCache.set(file, await loadColumns(file))
    parts.push(tileCache.get(file))
  }
  const n = parts.reduce((a, p) => a + p.lng.length, 0)
  const out = { lod: t.lod, h3Res: t.h3Res, approxKm: 0, h3: { length: n }, population: new Float32Array(n), lng: new Float32Array(n), lat: new Float32Array(n), maxPopulation: 0 }
  let o = 0
  for (const p of parts) {
    out.population.set(p.population, o)
    out.lng.set(p.lng, o)
    out.lat.set(p.lat, o)
    o += p.lng.length
  }
  return { data: out, tiles: sel.visible.length }
}

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

/** Views sharing `v`'s key: its extent by bisection on the key, corners at both zoom ends, interior samples. */
function sameKeyViews(data, v, canvas, rand, interior = 4) {
  const keyOf = (lng, lat, z) => cullKeyFor(data, { longitude: lng, latitude: lat, zoom: z }, canvas)
  const k0 = keyOf(v.longitude, v.latitude, v.zoom)
  const reach = (at, max) => {
    if (at(max) === k0) return max
    let lo = 0
    let hi = max
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (at(mid) === k0) lo = mid
      else hi = mid
    }
    return lo
  }
  const { longitude: lng, latitude: lat, zoom: z } = v
  const latLo = lat - reach((t) => keyOf(lng, lat - t, z), 30)
  const latHi = lat + reach((t) => keyOf(lng, lat + t, z), 30)
  const lngLo = lng - reach((t) => keyOf(lng - t, lat, z), 30)
  const lngHi = lng + reach((t) => keyOf(lng + t, lat, z), 30)
  const zLo = z - reach((t) => keyOf(lng, lat, z - t), 0.5)
  const zHi = z + reach((t) => keyOf(lng, lat, z + t), 0.5)
  const pts = []
  for (const la of [latLo, latHi]) for (const ln of [lngLo, lngHi]) for (const zz of [zLo, zHi]) pts.push({ longitude: ln, latitude: la, zoom: zz })
  const mix = (a, b) => a + (b - a) * rand()
  for (let t = 0; t < interior; t++) pts.push({ longitude: mix(lngLo, lngHi), latitude: mix(latLo, latHi), zoom: mix(zLo, zHi) })
  return pts.filter((p) => keyOf(p.longitude, p.latitude, p.zoom) === k0)
}

const fmt = (n) => n.toLocaleString('en-US')
const wholeData = new Map()
/** What the app culls for tier `t` at a view: the whole tier, or the merge of its visible tiles. */
async function dataFor(t, view, canvas) {
  if (t.tiled) return tiledData(t, view, canvas)
  if (!wholeData.has(t.lod)) wholeData.set(t.lod, await loadTier(t.lod, t.h3Res, path.basename(t.file)))
  return { data: wholeData.get(t.lod), tiles: null }
}
const positions = new WeakMap()
const worldOf = (data) => {
  if (!positions.has(data)) positions.set(data, worldPositions(data))
  return positions.get(data)
}

/**
 * The oracle check of one view: deck.gl's on-screen cells for the triggering view, and for
 * the views sharing its re-cull key THAT STILL SELECT THE TIER (with it on screen, so held
 * by the hysteresis) — a corner of the key that would draw another tier is not this tier's
 * concern — against what `cullForView` keeps.
 */
function check(t, data, view, canvas, seed) {
  const P = worldOf(data)
  const { indices } = cullForView(data, view, canvas)
  const kept = indices ? new Set(indices) : null
  const has = (i) => !kept || kept.has(i)
  const on = onScreen(P, view, canvas)
  let covered = 0
  for (const i of on) if (has(i)) covered++
  let keyViews = 0
  let keyWorst = 1
  let keyMissing = 0
  for (const p of sameKeyViews(data, view, canvas, rng(seed))) {
    if (wantedIndex(p, canvas, lods, t.lod) !== t.i) continue
    const onP = onScreen(P, p, canvas)
    let c = 0
    for (const i of onP) if (has(i)) c++
    keyViews++
    keyMissing += onP.length - c
    if (onP.length) keyWorst = Math.min(keyWorst, c / onP.length)
  }
  return { onScreen: on.length, selected: indices ? indices.length : data.h3.length, coverage: on.length ? covered / on.length : 1, missing: on.length - covered, keyViews, keyWorst, keyMissing }
}

if (process.argv.includes('--scan')) await scan()
else await places()

async function places() {
  const rows = []
  for (const t of TIERS) {
    for (const canvas of CANVASES) {
      for (const [place, longitude, latitude] of PLACES) {
        const entry = tierEntry(lods, t.i, latitude, canvas)
        const zooms = withHysteresis ? [[entry, null], [entry - TIER_HYSTERESIS, t.lod]] : [[entry, null]]
        for (const [zoom, active] of zooms) {
          if (zoom > 10) continue // past MAX_ZOOM: the tier is never drawn on this canvas here
          const view = { longitude, latitude, zoom }
          const sel = lods[wantedIndex(view, canvas, lods, active)].lod
          const { data, tiles } = await dataFor(t, view, canvas)
          const windowCount = cullWindowCells(data, view, canvas).length
          rows.push({
            tier: `${t.lod} (r${t.h3Res})`,
            zoom,
            canvas: `${canvas.width}×${canvas.height}`,
            place,
            sel: active ? `${sel} (held)` : sel,
            selOk: sel === t.lod,
            tiles,
            window: windowCount,
            ...check(t, data, view, canvas, rows.length + 1),
          })
        }
      }
    }
  }

  const head = ['tier', 'zoom', 'canvas', 'place', 'selected tier', 'tiles', 'on-screen', 'window', 'selected', 'cap', 'coverage', 'window÷on', 'key views', 'key cover']
  const NUM = 5
  const body = rows.map((r) => [
    r.tier,
    r.zoom.toFixed(2),
    r.canvas,
    r.place,
    r.sel,
    r.tiles === null ? '—' : String(r.tiles),
    fmt(r.onScreen),
    fmt(r.window),
    fmt(r.selected),
    fmt(CAP),
    `${(100 * r.coverage).toFixed(1)} %`,
    r.onScreen ? (r.window / r.onScreen).toFixed(2) : '—',
    String(r.keyViews),
    `${(100 * r.keyWorst).toFixed(1)} %`,
  ])
  const widths = head.map((h, k) => Math.max(h.length, ...body.map((b) => b[k].length)))
  const line = (cells) => `| ${cells.map((c, k) => (k >= NUM ? c.padStart(widths[k]) : c.padEnd(widths[k]))).join(' | ')} |`
  console.log(`tier thresholds per tierBands.ts; ${withHysteresis ? 'thresholds and thresholds − 0.15 (held)' : 'thresholds'} per view; key views = same-key views that still select the tier`)
  console.log(line(head))
  console.log(`|${widths.map((w, k) => (k >= NUM ? `${'-'.repeat(w + 1)}:` : '-'.repeat(w + 2))).join('|')}|`)
  for (const b of body) console.log(line(b))
  report(rows, rows.length)
}

/**
 * `--scan`: the review's scan — every populated 2.5° land cell from 60° S to 70° N plus the
 * 150 most populous r4 cells, on 900×560, 1280×800, 1920×1080, 375×812 and 2560×1080, each
 * culled tier at its threshold for the view and held 0.15 below it. Every view's window is
 * counted; the deck.gl oracle (trigger + same-key views still selecting the tier) runs on
 * every view whose window exceeds 90 % of the cap, the three largest windows per tier and
 * canvas, and every 40th view — the window fitting the cap is what keeps the rest whole
 * (`cullForView` keeps the whole window then; `lod.test.ts` / `cullWindow.test.ts` hold the
 * window to deck.gl's footprint). ~5 min.
 */
async function scan() {
  // (A full run is ~8 min: every view's window on the 2 M-cell r6 tier dominates.)
  const STEP = 2.5
  const ov = await loadTier('overview', 4, 'overview.parquet')
  const order = Array.from(ov.population.keys()).sort((a, b) => ov.population[b] - ov.population[a])
  const views = order.slice(0, 150).map((i, k) => ({ name: `top${k}`, lng: ov.lng[i], lat: ov.lat[i] }))
  const land = new Set()
  for (let i = 0; i < ov.lng.length; i++) land.add(`${Math.floor(ov.lat[i] / STEP)}:${Math.floor(ov.lng[i] / STEP)}`)
  for (let la = -60; la <= 70; la += STEP) {
    for (let ln = -180; ln < 180; ln += STEP) {
      if (land.has(`${Math.floor(la / STEP)}:${Math.floor(ln / STEP)}`)) views.push({ name: 'grid', lng: ln + STEP / 2, lat: la + STEP / 2 })
    }
  }
  const SCAN_CANVASES = [...CANVASES, { width: 375, height: 812 }, { width: 2560, height: 1080 }]
  console.log(`scan: ${views.length} view centres (150 top r4 + populated ${STEP}° land cells) × ${SCAN_CANVASES.length} canvases × ${TIERS.length} tiers × (threshold, held)`)
  const rows = []
  const t0 = Date.now()
  for (const t of TIERS) {
    const tierRows = []
    for (const canvas of SCAN_CANVASES) {
      for (const v of views) {
        const entry = tierEntry(lods, t.i, v.lat, canvas)
        for (const [zoom, active] of [[entry, null], [entry - TIER_HYSTERESIS, t.lod]]) {
          if (zoom > 10) continue
          const view = { longitude: v.lng, latitude: v.lat, zoom }
          const selOk = wantedIndex(view, canvas, lods, active) === t.i
          const { data, tiles } = await dataFor(t, view, canvas)
          const win = cullWindowCells(data, view, canvas).length
          tierRows.push({ t, tier: t.lod, canvas, cs: `${canvas.width}×${canvas.height}`, name: v.name, lng: v.lng, lat: v.lat, zoom, held: !!active, selOk, tiles, window: win })
        }
      }
    }
    // Which rows get the oracle.
    const pick = new Set(tierRows.filter((r, k) => r.window > 0.9 * CAP || k % 40 === 0))
    for (const cs of new Set(tierRows.map((r) => r.cs))) {
      for (const r of tierRows.filter((x) => x.cs === cs).sort((a, b) => b.window - a.window).slice(0, 3)) pick.add(r)
    }
    for (const r of pick) {
      const view = { longitude: r.lng, latitude: r.lat, zoom: r.zoom }
      const { data } = await dataFor(t, view, r.canvas)
      Object.assign(r, check(t, data, view, r.canvas, rows.length + tierRows.indexOf(r)), { checked: true })
    }
    rows.push(...tierRows)
    console.log(`  ${t.lod}: ${tierRows.length} views, ${pick.size} oracle-checked, largest window ${fmt(tierRows.reduce((a, r) => Math.max(a, r.window), 0))} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  }
  const f = (r) =>
    `${r.tier} ${r.cs} ${r.name} (${r.lat.toFixed(2)}, ${r.lng.toFixed(2)}) z${r.zoom.toFixed(2)} ${r.held ? 'held' : 'threshold'}: window ${fmt(r.window)}` +
    (r.checked ? `, on screen ${fmt(r.onScreen)}, missing ${r.missing}, key views ${r.keyViews} (missing ${r.keyMissing})` : '') +
    (r.tiles !== null ? `, ${r.tiles} tiles` : '')
  console.log('\nworst ten windows:')
  for (const r of [...rows].sort((a, b) => b.window - a.window).slice(0, 10)) console.log(`  ${f(r)}`)
  report(rows, rows.filter((r) => r.checked).length)
}

function report(rows, checkedCount) {
  const checked = rows.filter((r) => r.checked !== false && r.onScreen !== undefined)
  const wrongTier = rows.filter((r) => !r.selOk)
  const overCap = rows.filter((r) => r.window > CAP)
  const overTiles = rows.filter((r) => r.tiles !== null && r.tiles > TILE_CACHE_MAX)
  const missing = checked.filter((r) => r.missing > 0 || r.keyMissing > 0)
  console.log(
    `\nSUMMARY: ${rows.length} views · windows over the ${fmt(CAP)} cap: ${overCap.length} (largest ${fmt(rows.reduce((a, r) => Math.max(a, r.window), 0))}) · ` +
      `oracle-checked ${checkedCount} views + ${checked.reduce((a, r) => a + r.keyViews, 0)} same-key views still selecting the tier: ` +
      `${missing.length} with on-screen cells missing · more visible tiles than the ${TILE_CACHE_MAX}-tile cache: ${overTiles.length} · ` +
      `rows where the app does not select the row's tier: ${wrongTier.length}`,
  )
  const bad = [...overCap, ...missing, ...overTiles, ...wrongTier]
  if (bad.length) {
    console.log('\nFAIL:')
    for (const r of new Set(bad)) console.log(`  ${r.tier} z${r.zoom.toFixed(2)} ${r.cs ?? r.canvas} ${r.place ?? r.name}: window ${fmt(r.window)}, missing ${r.missing ?? '—'} / key ${r.keyMissing ?? '—'}${r.selOk ? '' : ', tier not selected'}`)
    process.exit(1)
  }
  console.log('\nPASS: every window fits the cap; 0 on-screen cells missing (trigger and same-key views still selecting the tier)')
}
