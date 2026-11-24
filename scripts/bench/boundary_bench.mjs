#!/usr/bin/env node
/**
 * Node timing of the per-re-cull boundary work on the committed mid tier
 * (`public/data/mid.parquet`, 2,016,971 cells): deck.gl's stock `H3HexagonLayer` path
 * (BEFORE) vs the cached `getPolygon` of `src/lib/h3Boundary.ts` that
 * `src/layers/populationLayer.ts` renders with (AFTER).
 *
 * Headless Chromium here is SwiftShader, so its frame times don't transfer to a real GPU;
 * this work is pure main-thread JS (h3-js + array building + earcut), so a Node timing does.
 *
 * For each view it finds the NEXT re-cull window of an eastward pan (nudges the camera
 * until `cullKeyFor` changes), culls both, and reports:
 *   - overlap: how many of the second cull's cells the first cull already had;
 *   - BEFORE: deck.gl's own accessor `flattenPolygon(h3ToPolygon(id))`, called twice per
 *     cell as the polygon tesselator does (sizing pass + fill pass), plus the
 *     `_calculateH3DataProps` pass (`getResolution` + `isPentagon` per cell) that
 *     `highPrecision: 'auto'` re-runs on every `getHexagon` trigger change;
 *   - AFTER cold: the cache empty — still one `cellToBoundary` per cell, not two;
 *   - AFTER warm: the cache filled by the first cull — the repeat cull over an
 *     overlapping window, which is what a pan pays;
 *   - the full tesselation (deck.gl's real `PolygonTesselator` with a GlobeViewport
 *     `projectFlat` preprojection, earcut included) under both accessors, for scale.
 * Then a sustained pan (a full turn of the globe in re-cull steps) checks the cache's
 * hard cap and hit rate.
 *
 * BEFORE understates the old cost. On a geometry change `PolygonLayer._getPaths` calls
 * `getPolygon` once more per cell, before the tesselator's two passes, so the stock path
 * really paid `cellToBoundary` three times per cell per re-cull, not the two timed here.
 * The AFTER numbers cover only the same two passes, so the cache's real saving on a
 * warm re-cull is somewhat larger than the ratios printed (the third call is a hit too).
 * The measurement is kept as it was, so its numbers stay comparable with the ones
 * already recorded.
 *
 * Usage: node scripts/bench/boundary_bench.mjs [--repeats=N]
 * (Node ≥ 22.18 strips the TypeScript types of the imported `.ts` modules natively.)
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parquetMetadataAsync } from 'hyparquet'
import { parquetReadColumn } from 'hyparquet/src/read.js'
import { getResolution, isPentagon } from 'h3-js'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
// deck.gl's own accessor and tesselator, by path (neither is a package export).
import { flattenPolygon, h3ToPolygon } from '../../node_modules/@deck.gl/geo-layers/dist/h3-layers/h3-utils.js'
import PolygonTesselator from '../../node_modules/@deck.gl/layers/dist/solid-polygon-layer/polygon-tesselator.js'
import { cullForView, cullKeyFor } from '../../src/lib/lod.ts'
import { h3Column, packH3 } from '../../src/data/h3Column.ts'
import { BoundaryCache, BOUNDARY_CACHE_CAPACITY, HI_WORD, LO_WORD, h3Words } from '../../src/lib/h3Boundary.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const arg = process.argv.find((a) => a.startsWith('--repeats='))
const REPEATS = arg ? Math.max(1, Number(arg.split('=')[1]) | 0) : 7

// The cull keeps what a canvas shows; this bench's numbers were recorded at 1280×800.
const CANVAS = { width: 1280, height: 800 }
const VIEWS = [
  { name: 'India z2.5', longitude: 77, latitude: 20, zoom: 2.5 },
  { name: 'Tokyo z3.5', longitude: 139.7, latitude: 35.68, zoom: 3.5 },
]

const buf = await readFile(path.join(ROOT, 'public/data/mid.parquet'))
const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const file = { byteLength: bytes.byteLength, slice: (s, e) => bytes.slice(s, e) }
const metadata = await parquetMetadataAsync(file)
const col = (name) => parquetReadColumn({ file, metadata, columns: [name] })
const f32 = (c) => (c instanceof Float32Array ? c : Float32Array.from(c))
const [population, lng, lat] = [f32(await col('population')), f32(await col('lng')), f32(await col('lat'))]
const h3 = h3Column(packH3(await col('h3')))
const n = lng.length
const data = { lod: 'mid', h3Res: 6, approxKm: 3, h3, population, lng, lat, maxPopulation: 0 }
const words = h3Words(h3.packed)

/** The next re-cull window of an eastward pan: nudge east until the cull key changes. */
function nextWindow(v) {
  const k0 = cullKeyFor(data, v, CANVAS)
  let w = { ...v }
  while (cullKeyFor(data, w, CANVAS) === k0) w = { ...w, longitude: w.longitude + 0.05 }
  return w
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
function time(fn, setup) {
  const ts = []
  for (let r = 0; r < REPEATS + 1; r++) {
    const ctx = setup ? setup() : undefined
    const t0 = performance.now()
    fn(ctx)
    if (r > 0) ts.push(performance.now() - t0) // first run is warm-up
  }
  return median(ts)
}

// The accessors exactly as each path wires them (`info.index` → source index → cell).
const stockPolygon = (src) => flattenPolygon(h3ToPolygon(h3.at(src)))
const cachedPolygon = (cache, src) => cache.polygon(words[2 * src + LO_WORD], words[2 * src + HI_WORD])

/** What the tesselator does with getPolygon on a rebuild: two full passes. */
function boundaryPasses(idx, get) {
  let sink = 0
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < idx.length; i++) sink += get(idx[i]).length
  return sink
}
/** `H3HexagonLayer._calculateH3DataProps` with `highPrecision: 'auto'` (no early exit without a pentagon). */
function dataPropsPass(idx) {
  let res = -1
  for (let i = 0; i < idx.length; i++) {
    const id = h3.at(idx[i])
    const r = getResolution(id)
    if (res < 0) res = r
    else if (r !== res) break
    if (isPentagon(id)) break
  }
  return res
}

const fmt = (ms) => `${ms.toFixed(1).padStart(7)} ms`
console.log(`mid tier: ${n.toLocaleString('en-US')} cells · median of ${REPEATS} runs · cache cap ${BOUNDARY_CACHE_CAPACITY.toLocaleString('en-US')}`)

for (const v of VIEWS) {
  const w = nextWindow(v)
  const a = cullForView(data, v, CANVAS).indices
  const b = cullForView(data, w, CANVAS).indices
  const inA = new Set(a)
  let shared = 0
  for (const i of b) if (inA.has(i)) shared++
  // Materialize the strings the stock path needs up front, as the app has by then.
  for (const i of a) h3.at(i)
  for (const i of b) h3.at(i)

  const before = time(() => boundaryPasses(b, stockPolygon))
  const beforeProps = time(() => dataPropsPass(b))
  const cold = time((c) => boundaryPasses(b, (s) => cachedPolygon(c, s)), () => new BoundaryCache())
  const warmCache = () => {
    const c = new BoundaryCache()
    for (const i of a) cachedPolygon(c, i)
    return c
  }
  const warm = time((c) => boundaryPasses(b, (s) => cachedPolygon(c, s)), warmCache)

  const vp = new GlobeViewport({ width: 1280, height: 800, ...w })
  const tess = (get) => () =>
    new PolygonTesselator({
      data: { length: b.length },
      getGeometry: (_, info) => get(b[info.index]),
      normalize: false,
      positionFormat: 'XY',
      resolution: vp.resolution,
      preproject: vp.projectFlat.bind(vp),
      fp64: false,
      IndexType: Uint32Array,
    })
  const tessBefore = time(tess(stockPolygon))
  let warmed
  const tessAfter = time(
    () => tess((s) => cachedPolygon(warmed, s))(),
    () => (warmed = warmCache()),
  )

  console.log(
    `\n${v.name} → next re-cull at lng ${w.longitude.toFixed(2)} (key ${cullKeyFor(data, v, CANVAS)} → ${cullKeyFor(data, w, CANVAS)})`,
  )
  console.log(`  cells ${b.length.toLocaleString('en-US')} · shared with previous cull ${shared.toLocaleString('en-US')} (${((100 * shared) / b.length).toFixed(1)} %)`)
  console.log(`  boundary  BEFORE stock deck.gl ×2 passes ${fmt(before)}   + _calculateH3DataProps ${fmt(beforeProps)}`)
  console.log(`  boundary  AFTER  cache cold             ${fmt(cold)}   (${(before / cold).toFixed(1)}×)`)
  console.log(`  boundary  AFTER  cache warm (repeat)    ${fmt(warm)}   (${(before / warm).toFixed(1)}× vs BEFORE)`)
  console.log(`  whole tesselation (boundary + earcut)  BEFORE ${fmt(tessBefore)}  AFTER warm ${fmt(tessAfter)}`)
}

// Sustained pan: a full turn east at each view's latitude, one cull per re-cull step,
// both tesselator passes, through ONE cache. The cap must hold and evictions must happen.
for (const v of VIEWS) {
  const cache = new BoundaryCache()
  let view = { ...v }
  let steps = 0
  let maxSize = 0
  let cells = 0
  const t0 = performance.now()
  while (view.longitude < v.longitude + 360) {
    const idx = cullForView(data, view, CANVAS).indices
    boundaryPasses(idx, (s) => cachedPolygon(cache, s))
    cells += idx.length
    maxSize = Math.max(maxSize, cache.size)
    steps++
    view = nextWindow(view)
  }
  const ms = performance.now() - t0
  console.log(
    `\npan ${v.name} 360° east: ${steps} re-culls, ${cells.toLocaleString('en-US')} cells · max cache size ${maxSize.toLocaleString('en-US')} ≤ cap ${cache.capacity.toLocaleString('en-US')}: ${maxSize <= cache.capacity} · evictions ${cache.evictions.toLocaleString('en-US')} · hit rate ${((100 * cache.hits) / (cache.hits + cache.misses)).toFixed(1)} % · ${(ms / steps).toFixed(1)} ms/step (cull + 2 passes)`,
  )
}
