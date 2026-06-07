#!/usr/bin/env node
/**
 * Post-deploy LIVE QA — the check that was missing.
 *
 * Fetches the *deployed* manifest, both whole tiers, and a sample r8 tile exactly
 * the way the browser does (full fetch + transparent gzip), then parses them with
 * hyparquet and asserts row counts + the 8.03 B population invariant. This catches
 * deploy-only failures that local dev and HEAD-only smoke tests miss — e.g. the
 * GitHub Pages gzip+range incompatibility that broke the in-browser parquet reader.
 *
 * Usage: node scripts/verify_live.mjs [baseUrl]
 *   default baseUrl = https://zeevmala.github.io/world-population-globe
 */
import { parquetMetadataAsync } from 'hyparquet'
import { parquetReadColumn } from 'hyparquet/src/read.js'

const base = (process.argv[2] || 'https://zeevmala.github.io/world-population-globe').replace(/\/+$/, '')
const WORLD_POP = 8.031e9

const memBuffer = (b) => ({ byteLength: b.byteLength, slice: (s, e) => b.slice(s, e) })

async function readCols(url, cols) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  const file = memBuffer(await res.arrayBuffer())
  const metadata = await parquetMetadataAsync(file)
  const out = {}
  for (const c of cols) out[c] = await parquetReadColumn({ file, metadata, columns: [c] })
  return out
}

const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}

console.log(`verify_live: ${base}`)

const manifest = await (await fetch(`${base}/data/manifest.json`)).json()
check('manifest has overview/mid/r8', ['overview', 'mid', 'r8'].every((l) => manifest.lods.some((e) => e.lod === l)))

for (const lod of ['overview', 'mid']) {
  const e = manifest.lods.find((x) => x.lod === lod)
  try {
    const { population } = await readCols(`${base}/${e.file}`, ['population'])
    check(`${lod} parses`, population.length === e.cellCount, `rows=${population.length} expected=${e.cellCount}`)
    check(`${lod} sum ~ 8.03B`, Math.abs(sum(population) - WORLD_POP) < 5e6, `sum=${Math.round(sum(population))}`)
  } catch (err) {
    check(`${lod} parses`, false, err.message)
  }
}

try {
  const idx = await (await fetch(`${base}/data/tiles/r8/index.json`)).json()
  const t = idx.tiles[Math.floor(idx.tiles.length / 2)]
  const { population } = await readCols(`${base}/${t.file}`, ['population'])
  check('r8 sample tile parses', population.length === t.cellCount, `${t.parent} rows=${population.length}`)
} catch (err) {
  check('r8 sample tile parses', false, err.message)
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
process.exit(failures ? 1 : 0)
