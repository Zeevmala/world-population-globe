#!/usr/bin/env node
/**
 * Node timing of `cullForView` (src/lib/lod.ts) on the committed mid tier
 * (`public/data/mid.parquet`, 2,016,971 cells) — the main-thread cost of one re-cull.
 *
 * Headless Chromium here is SwiftShader, so its frame times don't transfer to a real
 * GPU; the cull is pure JS over typed arrays, so a Node timing does.
 *
 * Reads the file whole (never range reads, same as the browser), decodes lng/lat/population
 * as Float32Array exactly like `decode.worker.ts`, then times each view REPEATS times after a
 * warm-up and prints the median (and min) per view.
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

const VIEWS = [
  { name: 'India z2.5', longitude: 77, latitude: 20, zoom: 2.5 },
  { name: 'India z3.5', longitude: 77, latitude: 20, zoom: 3.5 },
  { name: 'Tokyo z3.0', longitude: 139.7, latitude: 35.68, zoom: 3 },
  { name: 'Tokyo z4.0', longitude: 139.7, latitude: 35.68, zoom: 4 },
  { name: 'Lapland z3.0', longitude: 25, latitude: 68, zoom: 3 },
  { name: 'Lapland z4.0', longitude: 25, latitude: 68, zoom: 4 },
  // Top of a 0.25 zoom bucket: the cull radius is sized for the bucket's most zoomed-out
  // view, so these are the views where it exceeds 1.5 × the view's own half-span most.
  { name: 'India z2.62', longitude: 77, latitude: 20, zoom: 2.6249 },
  { name: 'Tokyo z4.12', longitude: 139.7, latitude: 35.68, zoom: 4.1249 },
]

const buf = await readFile(path.join(ROOT, 'public/data/mid.parquet'))
const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const file = { byteLength: bytes.byteLength, slice: (s, e) => bytes.slice(s, e) }
const metadata = await parquetMetadataAsync(file)
const f32 = (c) => (c instanceof Float32Array ? c : Float32Array.from(c))
const read = async (name) => f32(await parquetReadColumn({ file, metadata, columns: [name] }))
const [population, lng, lat] = [await read('population'), await read('lng'), await read('lat')]
const n = lng.length
// The cull reads only `h3.length`; skip decoding the 2 M index strings.
const data = { lod: 'mid', h3Res: 6, approxKm: 3, h3: { length: n }, population, lng, lat, maxPopulation: 0 }

console.log(`mid tier: ${n.toLocaleString('en-US')} cells · ${REPEATS} repeats/view (median, min)`)
const medians = []
for (const v of VIEWS) {
  for (let i = 0; i < WARMUP; i++) cullForView(data, v)
  const times = []
  let selected = 0
  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now()
    const r = cullForView(data, v)
    times.push(performance.now() - t0)
    selected = r.indices ? r.indices.length : n
  }
  times.sort((a, b) => a - b)
  const med = times[times.length >> 1]
  medians.push(med)
  console.log(
    `${v.name.padEnd(14)} median ${med.toFixed(2).padStart(7)} ms  min ${times[0].toFixed(2).padStart(7)} ms  selected ${selected.toLocaleString('en-US')}`,
  )
}
const mean = medians.reduce((a, b) => a + b, 0) / medians.length
console.log(`mean of medians ${mean.toFixed(2)} ms`)
