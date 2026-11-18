#!/usr/bin/env node
/**
 * Node timing of `cullForView` (src/lib/lod.ts) on the committed culled tiers — r5
 * (`public/data/r5.parquet`, 393,791 cells) and mid (`public/data/mid.parquet`, 2,016,971
 * cells): the main-thread cost of one re-cull.
 *
 * Headless Chromium here is SwiftShader, so its frame times don't transfer to a real
 * GPU; the cull is pure JS over typed arrays, so a Node timing does.
 *
 * Reads each file whole (never range reads, same as the browser), decodes lng/lat/population
 * as Float32Array exactly like `decode.worker.ts`, then times each view REPEATS times after a
 * warm-up and prints the median (and min) per view. The views sit where each tier is
 * actually on screen since the re-band: r5 from 3.63 (its 3.78 entry less the hysteresis)
 * to 5.18, mid from 5.03 to 7.99 — the entry zooms are where a cull window is widest and
 * the cull most expensive. Canvas 1280×800.
 *
 * Usage: node scripts/bench/cull_bench.mjs [--repeats=N]
 * (Node ≥ 22.18 strips the TypeScript types of the imported `lod.ts` natively.)
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parquetMetadataAsync } from 'hyparquet'
import { parquetReadColumn } from 'hyparquet/src/read.js'
import { cullForView } from '../../src/lib/lod.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const arg = process.argv.find((a) => a.startsWith('--repeats='))
const REPEATS = arg ? Math.max(1, Number(arg.split('=')[1]) | 0) : 25
const WARMUP = 5
const CANVAS = { width: 1280, height: 800 }

const PLACES = [
  ['India', 77, 20],
  ['Tokyo', 139.7, 35.68],
  ['Lapland', 25, 68],
]
const TIERS = [
  { lod: 'r5', h3Res: 5, file: 'r5.parquet', zooms: [3.63, 3.78, 4.0, 4.5] },
  { lod: 'mid', h3Res: 6, file: 'mid.parquet', zooms: [5.03, 5.18, 5.5, 6.0, 6.5] },
]

/** Load a committed tier the way `decode.worker.ts` does (no h3 strings: the cull reads only `h3.length`). */
export async function loadTier(lod, h3Res, file) {
  const buf = await readFile(path.join(ROOT, 'public/data', file))
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const pf = { byteLength: bytes.byteLength, slice: (s, e) => bytes.slice(s, e) }
  const metadata = await parquetMetadataAsync(pf)
  const f32 = (c) => (c instanceof Float32Array ? c : Float32Array.from(c))
  const read = async (name) => f32(await parquetReadColumn({ file: pf, metadata, columns: [name] }))
  const [population, lng, lat] = [await read('population'), await read('lng'), await read('lat')]
  const n = lng.length
  return { lod, h3Res, approxKm: 0, h3: { length: n }, population, lng, lat, maxPopulation: 0 }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  console.log(`canvas ${CANVAS.width}×${CANVAS.height} · ${REPEATS} repeats/view (median, min)`)
  for (const t of TIERS) {
    const data = await loadTier(t.lod, t.h3Res, t.file)
    const n = data.lng.length
    console.log(`\n${t.lod} tier: ${n.toLocaleString('en-US')} cells`)
    // The first cull of a tier object also builds its cached unit-vector columns (once per tier).
    const first = { longitude: PLACES[0][1], latitude: PLACES[0][2], zoom: t.zooms[0] }
    const c0 = performance.now()
    cullForView(data, first, CANVAS)
    console.log(`first cull of the tier (cold, incl. one-time per-tier setup) ${(performance.now() - c0).toFixed(2)} ms`)
    const medians = []
    for (const [name, longitude, latitude] of PLACES) {
      for (const zoom of t.zooms) {
        const v = { longitude, latitude, zoom }
        for (let i = 0; i < WARMUP; i++) cullForView(data, v, CANVAS)
        const times = []
        let selected = 0
        for (let i = 0; i < REPEATS; i++) {
          const t0 = performance.now()
          const r = cullForView(data, v, CANVAS)
          times.push(performance.now() - t0)
          selected = r.indices ? r.indices.length : n
        }
        times.sort((a, b) => a - b)
        const med = times[times.length >> 1]
        medians.push(med)
        const label = `${name} z${zoom.toFixed(2)}`
        console.log(
          `${label.padEnd(15)} median ${med.toFixed(2).padStart(7)} ms  min ${times[0].toFixed(2).padStart(7)} ms  selected ${selected.toLocaleString('en-US')}`,
        )
      }
    }
    const mean = medians.reduce((a, b) => a + b, 0) / medians.length
    const worst = Math.max(...medians)
    console.log(`${t.lod}: mean of medians ${mean.toFixed(2)} ms · worst median ${worst.toFixed(2)} ms`)
  }
}
