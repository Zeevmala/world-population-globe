#!/usr/bin/env node
/**
 * Post-deploy LIVE QA — the check that was missing.
 *
 * Fetches the *deployed* manifest and then EVERY tier it lists — each whole tier in full,
 * and for each tiled tier its index plus a sample tile — exactly the way the browser does
 * (full fetch + transparent gzip), then parses them with hyparquet and asserts row counts
 * + the 8.03 B population invariant. The tiers come from the manifest, never a fixed
 * list, so a tier added by the pipeline (r5, r7) is checked the day it ships. This catches
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

let manifest
try {
  manifest = await (await fetch(`${base}/data/manifest.json`)).json()
  check('manifest parses', Array.isArray(manifest.lods) && manifest.lods.length > 0, `${manifest.lods?.length} tiers`)
} catch (err) {
  check('manifest parses', false, err.message)
  console.log(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
check(
  'manifest tiers ordered coarse → fine with contiguous bands',
  manifest.lods.every((e, i, a) => i === 0 || (e.h3Res > a[i - 1].h3Res && e.minZoom === a[i - 1].maxZoom)),
  manifest.lods.map((e) => `${e.lod}[r${e.h3Res}${e.tiled ? ' tiled' : ''}] ${e.minZoom}–${e.maxZoom}`).join(', '),
)

for (const e of manifest.lods) {
  check(`${e.lod}: manifest Σ ~ 8.03B`, Math.abs(e.sumPopulation - WORLD_POP) < 5e6, `sumPopulation=${e.sumPopulation}`)
  if (!e.tiled) {
    try {
      const { population } = await readCols(`${base}/${e.file}`, ['population'])
      check(`${e.lod}: parses`, population.length === e.cellCount, `rows=${population.length} expected=${e.cellCount}`)
      check(`${e.lod}: sum ~ 8.03B`, Math.abs(sum(population) - WORLD_POP) < 5e6, `sum=${Math.round(sum(population))}`)
    } catch (err) {
      check(`${e.lod}: parses`, false, err.message)
    }
    continue
  }
  try {
    const res = await fetch(`${base}/${e.indexFile}`)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${e.indexFile}`)
    const idx = await res.json()
    const declared = idx.tiles.reduce((a, t) => a + t.cellCount, 0)
    check(
      `${e.lod}: index matches manifest`,
      idx.cellCount === e.cellCount && idx.sumPopulation === e.sumPopulation && idx.parentRes === e.tileParentRes && declared === idx.cellCount,
      `${idx.tiles.length} tiles (r${idx.parentRes} parents), Σ tile cellCount=${declared} index=${idx.cellCount} manifest=${e.cellCount}`,
    )
    // The middle tile and the most populous one (the heaviest the client fetches).
    const busiest = idx.tiles.reduce((a, t) => (t.cellCount > a.cellCount ? t : a))
    for (const t of new Set([idx.tiles[Math.floor(idx.tiles.length / 2)], busiest])) {
      const { population } = await readCols(`${base}/${t.file}`, ['population'])
      check(`${e.lod}: sample tile parses`, population.length === t.cellCount, `${t.parent} rows=${population.length} expected=${t.cellCount}`)
    }
  } catch (err) {
    check(`${e.lod}: index + sample tile`, false, err.message)
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
process.exit(failures ? 1 : 0)
