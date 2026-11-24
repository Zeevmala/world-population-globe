#!/usr/bin/env node
/**
 * Real H3 cells in the app's worst cull windows — the check the tier thresholds' guarantee
 * answers to (`src/lib/tierFit.ts`: a tier starts where its cull window, held 0.15 below the
 * threshold, cannot hold more than the 120 k cap, whatever the data).
 *
 * The thresholds are a model — the window's ground area × the most cells per area H3 packs
 * anywhere along that latitude — so this script asks h3-js instead: for every culled tier
 * (r5, mid/r6, r7, r8) on five canvases, it builds the re-cull windows the app would use where
 * H3's cells are smallest, at the 12 icosahedron vertices (the pentagons, where hexagons are
 * 0.605 × the mean), and where they are largest, at the 20 face centres, plus a lat/lng grid
 * over the whole globe; and it COUNTS the H3 cells whose centre is inside each window (flood
 * fill over grid neighbours from the window's centre cell, the window test of `lod.ts`
 * `cullWindowCells` with its float32 slack). No data: every cell counts, populated or not.
 *
 * Each window is the WORST one a view there can be served: the view sits on its Mercator
 * row's poleward edge (where the row's threshold is lowest) at the tier's threshold for that
 * view − 0.15 (held, the most zoomed-out zoom the tier is drawn at), so its zoom bucket is the
 * lowest that tier ever uses on that row; around each vertex the view is also moved by ± a
 * third of the window in latitude and longitude, so the vertex sits in different parts of it.
 *
 * Usage: node scripts/bench/h3_window_count.mjs [--quick]   (--quick: vertices only, centred)
 * Exit: 0 when no window holds more than 120,000 H3 cells; else 1, listing the offenders.
 * Runs on all cores (worker threads); ~3–6 min on 4 cores, --quick ~1 min.
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cullBucket, cullWindow, lngLatToUnit } from '../../src/lib/footprint.ts'
import { TIER_HYSTERESIS, tierEntry } from '../../src/lib/tierBands.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const h3 = createRequire(import.meta.url)('h3-js')
const CAP = 120_000
const F32_SLACK = 4e-7 // lod.ts: the cull widens its cap test by this
const DEG = Math.PI / 180
const MAX_ZOOM = 10 // camera.ts
const lods = JSON.parse(readFileSync(path.join(ROOT, 'public/data/manifest.json'), 'utf8')).lods
const TIERS = lods.map((l, i) => ({ ...l, i })).filter((l) => l.tiled || l.cellCount > CAP) // r5, mid, r7, r8
const CANVASES = [
  [900, 560],
  [1280, 800],
  [1920, 1080],
  [375, 812],
  [2560, 1080],
]

/** Window test of `lod.ts` cullWindowCells (cap widened by its float32 slack). */
function inside(w, lat, lng) {
  const u = lngLatToUnit(lng, lat)
  const d = u[0] * w.c0[0] + u[1] * w.c0[1] + u[2] * w.c0[2]
  if (d < w.cosCap - F32_SLACK) return false
  if (!w.rect) return true
  const depth = w.kc - d
  const x = u[0] * w.e0[0] + u[1] * w.e0[1] + u[2] * w.e0[2]
  if (x < w.xMin * depth || x > w.xMax * depth) return false
  const y = u[0] * w.n0[0] + u[1] * w.n0[1] + u[2] * w.n0[2]
  return y >= w.yMin * depth && y <= w.yMax * depth
}

/** H3 cells at `res` whose centre is inside `w`: flood fill from the cell under its centre. */
function count(w, res) {
  const lat0 = Math.asin(w.c0[2]) / DEG
  const lng0 = Math.atan2(w.c0[1], w.c0[0]) / DEG
  const start = h3.latLngToCell(lat0, lng0, res)
  const [la, ln] = h3.cellToLatLng(start)
  if (!inside(w, la, ln)) throw new Error(`window centre cell outside its window at ${lat0}, ${lng0}`)
  const seen = new Set([start])
  const stack = [start]
  let n = 0
  while (stack.length) {
    const c = stack.pop()
    n++
    for (const nb of h3.gridDisk(c, 1)) {
      if (seen.has(nb)) continue
      seen.add(nb)
      const [a, b] = h3.cellToLatLng(nb)
      if (inside(w, a, b)) stack.push(nb)
    }
  }
  return n
}

/**
 * The widest window a view near (lat, lng) can be served while tier `i` is on screen: the
 * view moved to its Mercator row's poleward edge, at that view's threshold − 0.15.
 */
function worstCase(i, lat, lng, canvas) {
  let v = { longitude: lng, latitude: lat, zoom: tierEntry(lods, i, lat, canvas) - TIER_HYSTERESIS }
  for (let k = 0; k < 3; k++) {
    const b = cullBucket(v, canvas)
    const north = lat >= 0
    const y = (north ? b.iy + 0.5 : b.iy - 0.5) * b.q
    const edge = Math.atan(Math.sinh(y)) / DEG + (north ? -1e-9 : 1e-9)
    const zoom = tierEntry(lods, i, edge, canvas) - TIER_HYSTERESIS + 1e-9
    v = { longitude: lng, latitude: edge, zoom }
  }
  return v
}

function cases(quick) {
  const out = []
  const vertices = h3.getPentagons(0).map((c) => h3.cellToLatLng(c))
  for (const [cw, ch] of CANVASES) {
    const canvas = { width: cw, height: ch }
    for (const t of TIERS) {
      const add = (kind, lat, lng) => {
        const v = worstCase(t.i, lat, lng, canvas)
        if (v.zoom > MAX_ZOOM) return
        out.push({ canvas: `${cw}x${ch}`, tier: t.lod, res: t.h3Res, kind, view: v, cw, ch })
      }
      for (const [lat, lng] of vertices) {
        // A third of the window's half-height ≈ the screen's: (canvas px / 3) at the view's scale.
        const z = tierEntry(lods, t.i, lat, canvas)
        const degPerPx = 360 / (512 * 2 ** z) // at the equator; × cos lat in latitude
        const dy = (ch / 3) * degPerPx * Math.cos(lat * DEG)
        const dx = (cw / 3) * degPerPx
        const offsets = quick ? [[0, 0]] : [[0, 0], [dy, 0], [-dy, 0], [0, dx], [0, -dx], [dy, dx], [-dy, -dx]]
        for (const [a, b] of offsets) add('vertex', lat + a, lng + b)
      }
      if (quick) continue
      const faces = [] // face centres: normalized sums of three mutually adjacent vertices
      const V = vertices.map(([la, ln]) => lngLatToUnit(ln, la))
      const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
      for (let a = 0; a < 12; a++)
        for (let b = a + 1; b < 12; b++)
          for (let c = b + 1; c < 12; c++)
            if (dot(V[a], V[b]) > 0.4 && dot(V[b], V[c]) > 0.4 && dot(V[a], V[c]) > 0.4) {
              const s = [0, 1, 2].map((k) => V[a][k] + V[b][k] + V[c][k])
              const n = Math.hypot(...s)
              faces.push([Math.asin(s[2] / n) / DEG, Math.atan2(s[1], s[0]) / DEG])
            }
      for (const [lat, lng] of faces) add('face', lat, lng)
      for (let lat = -80; lat <= 80; lat += 10) for (let lng = -180; lng < 180; lng += 45) add('grid', lat + 0.37, lng + 7.3)
    }
  }
  return out
}

if (isMainThread) {
  const quick = process.argv.includes('--quick')
  const all = cases(quick)
  const threads = Math.max(1, Math.min(os.cpus().length, 8))
  const t0 = Date.now()
  console.log(`h3_window_count: ${all.length} worst-case windows (${quick ? 'vertices' : 'vertices ± offsets, face centres, 10° grid'}) × real H3 cells, ${threads} threads`)
  const results = (
    await Promise.all(
      Array.from({ length: threads }, (_, k) => {
        const mine = all.filter((_, j) => j % threads === k)
        return new Promise((resolve, reject) => {
          const w = new Worker(fileURLToPath(import.meta.url), { workerData: mine })
          w.on('message', resolve)
          w.on('error', reject)
        })
      }),
    )
  ).flat()
  const fmt = (n) => n.toLocaleString('en-US')
  let worstAll = null
  const offenders = results.filter((r) => r.n > CAP)
  for (const [cw, ch] of CANVASES) {
    const row = []
    for (const t of TIERS) {
      const rs = results.filter((r) => r.canvas === `${cw}x${ch}` && r.tier === t.lod)
      const worst = rs.reduce((a, r) => (r.n > a.n ? r : a), { n: 0 })
      if (!worstAll || worst.n > worstAll.n) worstAll = worst
      row.push(`${t.lod} ${fmt(worst.n)} (${((100 * worst.n) / CAP).toFixed(1)} %, ${worst.kind})`)
    }
    console.log(`  ${`${cw}×${ch}`.padEnd(10)} ${row.join('  ')}`)
  }
  for (const t of TIERS) {
    const rs = results.filter((r) => r.tier === t.lod)
    const worst = rs.reduce((a, r) => (r.n > a.n ? r : a), { n: 0 })
    const v = worst.view
    console.log(`  worst ${t.lod}: ${fmt(worst.n)} cells (${((100 * worst.n) / CAP).toFixed(1)} % of the cap) — ${worst.canvas} ${worst.kind} at ${v.latitude.toFixed(3)}, ${v.longitude.toFixed(3)} z ${v.zoom.toFixed(3)}`)
  }
  for (const o of offenders) console.log(`  OVER THE CAP: ${o.canvas} ${o.tier} ${o.kind} at ${o.view.latitude}, ${o.view.longitude} z ${o.view.zoom}: ${fmt(o.n)}`)
  console.log(
    `h3_window_count: ${results.length} windows, largest ${fmt(worstAll.n)} real H3 cells (${((100 * worstAll.n) / CAP).toFixed(1)} % of the cap), ${offenders.length} over the cap — ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  )
  process.exit(offenders.length ? 1 : 0)
} else {
  const out = workerData.map((c) => {
    const w = cullWindow(cullBucket(c.view, { width: c.cw, height: c.ch }))
    return { ...c, n: count(w, c.res) }
  })
  parentPort.postMessage(out)
}
