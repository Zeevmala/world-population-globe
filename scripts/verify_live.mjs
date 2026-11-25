#!/usr/bin/env node
/**
 * Post-deploy LIVE QA — the check that was missing.
 *
 * Fetches the *deployed* manifest and then EVERY tier it lists — each whole tier in full,
 * and for each tiled tier its index plus a sample tile — exactly the way the browser does
 * (full fetch + transparent gzip), then parses them with hyparquet and asserts row counts
 * + the 8.03 B population invariant. This catches deploy-only failures that local dev and
 * HEAD-only smoke tests miss — e.g. the GitHub Pages gzip+range incompatibility that broke
 * the in-browser parquet reader.
 *
 * Walking the deployed list alone would pass a manifest that lost a tier altogether, so
 * the deployed tier set is first asserted against the committed manifest
 * (`public/data/manifest.json` in this checkout — the pipeline's output, whose tier set
 * `verify:data` asserts in the same workflow before anything is published). The
 * expectation is never typed here, so a tier the pipeline adds is expected the day it
 * ships, and a deployment that lost one cannot pass.
 *
 * Usage: node scripts/verify_live.mjs [baseUrl] [--expect <manifest.json>]
 *   default baseUrl = https://zeevmala.github.io/world-population-globe
 *   default --expect = public/data/manifest.json of this checkout
 *
 * Exit: 0 all pass · 1 a check failed · 2 usage error
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parquetMetadataAsync } from 'hyparquet'
import { parquetReadColumn } from 'hyparquet/src/read.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BASE = 'https://zeevmala.github.io/world-population-globe'
const WORLD_POP = 8.031e9

/** What identifies a tier: a deployed entry must match the committed one on each of these. */
const TIER_KEYS = ['h3Res', 'tiled', 'cellCount']

/**
 * Everything wrong with the deployed tier list, compared with the expected (committed)
 * one: a missing, extra or duplicated tier, the right tiers in the wrong order, or a tier
 * whose resolution, tiling or cell count differs. Empty when they agree.
 * @param {unknown} deployed `manifest.lods` as served
 * @param {unknown} expected `manifest.lods` as committed
 * @returns {string[]}
 */
export function tierSetProblems(deployed, expected) {
  if (!Array.isArray(expected) || expected.length === 0) {
    return ['the expected tier set is empty — nothing to check the deployment against']
  }
  if (!Array.isArray(deployed)) return ['the deployed manifest has no lods array']
  const value = (e, k) => (k === 'tiled' ? !!e[k] : e[k])
  const problems = []
  const want = expected.map((e) => e.lod)
  const got = deployed.map((e) => e?.lod)
  for (const lod of want) if (!got.includes(lod)) problems.push(`missing tier "${lod}"`)
  for (const lod of new Set(got)) {
    if (!want.includes(lod)) problems.push(`unexpected tier "${lod}"`)
    const n = got.filter((l) => l === lod).length
    if (n > 1) problems.push(`tier "${lod}" listed ${n}×`)
  }
  if (!problems.length && got.join() !== want.join()) {
    problems.push(`tiers out of order: got ${got.join(', ')}, expected ${want.join(', ')}`)
  }
  for (const e of expected) {
    const d = deployed.find((x) => x?.lod === e.lod)
    if (!d) continue
    for (const k of TIER_KEYS) {
      if (value(d, k) !== value(e, k)) problems.push(`${e.lod}: ${k} is ${value(d, k)}, expected ${value(e, k)}`)
    }
  }
  return problems
}

/** `[baseUrl] [--expect <manifest.json>]`; throws a usage error on a flag it does not know or one missing its value. */
export function parseArgs(argv) {
  const opts = { base: DEFAULT_BASE, expect: join(ROOT, 'public', 'data', 'manifest.json') }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expect') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error('--expect needs a path to a manifest.json')
      opts.expect = resolve(value)
    } else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`)
    else opts.base = argv[i]
  }
  opts.base = opts.base.replace(/\/+$/, '')
  return opts
}

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

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`verify_live: ${err.message}\nUsage: node scripts/verify_live.mjs [baseUrl] [--expect <manifest.json>]`)
    process.exit(2)
  }
  const { base, expect } = opts
  let failures = 0
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
    if (!ok) failures++
  }
  const bail = () => {
    console.log(`\n${failures} FAILURE(S)`)
    process.exit(1)
  }

  console.log(`verify_live: ${base}`)

  let expected
  try {
    expected = JSON.parse(readFileSync(expect, 'utf8')).lods
    check('expected tier set read', Array.isArray(expected) && expected.length > 0, `${expect.replace(`${ROOT}/`, '')}: ${expected?.map((e) => e.lod).join(', ')}`)
  } catch (err) {
    check('expected tier set read', false, `${expect}: ${err.message}`)
    bail()
  }

  let manifest
  try {
    manifest = await (await fetch(`${base}/data/manifest.json`)).json()
    check('manifest parses', Array.isArray(manifest.lods) && manifest.lods.length > 0, `${manifest.lods?.length} tiers`)
  } catch (err) {
    check('manifest parses', false, err.message)
    bail()
  }
  const problems = tierSetProblems(manifest.lods, expected)
  check(
    `deployed tier set == committed (${expected.length} tiers)`,
    problems.length === 0,
    problems.length ? problems.join('; ') : manifest.lods.map((e) => e.lod).join(', '),
  )
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
