#!/usr/bin/env node
/**
 * Local DATA-integrity gate — the offline twin of `verify_live.mjs`.
 *
 * `verify_live.mjs` proves the *deployed* files parse over HTTP; this proves the
 * *committed* `public/data/**` is internally consistent before it is ever pushed.
 * It reads the Parquet exactly the way the browser does (whole file -> hyparquet,
 * never range reads) but from disk, so it needs no network and no pipeline re-run.
 *
 * Asserts:
 *   - manifest.json shape == `src/types.ts` `Manifest` / `LodEntry`.
 *   - overview + r5 + mid: rows == cellCount, Σpop == sumPopulation (and the hard
 *     8,031,924,025 / 8,031,924,024 constants), max == maxPopulation, bytes ==
 *     file size, finite non-negative populations, lng/lat in range, H3 resolution.
 *   - r5 (the parent roll-up of mid, `pipeline/build_parents.py`): 393,791 cells; every
 *     r5 cell is the H3 parent of at least one mid cell, every mid cell's parent is in
 *     r5, each r5 population == the exact sum of its mid children, and each r5 lng/lat
 *     is its H3 cell center (h3-js — independent of the pipeline's bit arithmetic).
 *   - every tiled pyramid (r7 by r2 parent, r8 by r3 parent — whatever the manifest lists
 *     with `tiled: true`): index.json == manifest, every listed tile exists under
 *     `parent=<its parent>/`, no orphan tiles on disk, Σ cellCount == 9,012,014 /
 *     32,957,699, Σpop == 8,031,924,024, and every tile's cells really live under its
 *     declared H3 parent.
 *   - r7 (the parent roll-up of r8, `pipeline/build_parents.py`), checked tile group by
 *     tile group during the r8 pass: every r8 cell's r7 parent (h3-js) is a row of the r7
 *     tile of its r2 ancestor, every r7 cell has ≥ 1 r8 child, each r7 population ==
 *     the exact Σ of its r8 children, each r7 cell sits in the tile of its r2 parent,
 *     each r7 lng/lat is its H3 cell center — and, as a by-product, every r8 cell lies
 *     under its tile's r3 parent (not just the sampled ones).
 *   - every file under public/data/** < 100 MB (GitHub Pages hard limit).
 *
 * Usage: node scripts/verify_data.mjs [--sample[=N]] [--concurrency=N] [--public=DIR]
 *   default: FULL mode — reads all 12,761 r8 tiles (~1 min).
 *   --sample=N: read only N deterministically-strided tiles; the file-existence
 *   and Σ-cellCount checks still cover all 12,761. The mode is printed.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cellToLatLng, cellToParent, getResolution, isValidCell } from 'h3-js'
import { parquetMetadataAsync } from 'hyparquet'
import { parquetReadColumn } from 'hyparquet/src/read.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicArg = process.argv.slice(2).find((a) => a.startsWith('--public='))
const PUBLIC = publicArg ? path.resolve(publicArg.slice('--public='.length)) : path.join(ROOT, 'public')
const DATA = path.join(PUBLIC, 'data')

/** Exact per-tier population totals baked by the pipeline (people). */
const EXPECTED_SUM = { overview: 8031924025, r5: 8031924024, mid: 8031924024, r7: 8031924024, r8: 8031924024 }
/** Whole-file tiers, coarse → fine. */
const WHOLE_TIERS = ['overview', 'r5', 'mid']
const EXPECTED_R5_CELLS = 393791
/** Σ of a FLOAT column is float32-rounded per value; allow drift, print the delta. */
const SUM_TOL = 512
/** Coarse "still ≈ 8.03 B" guard, same magnitude as verify_live.mjs. */
const WORLD_POP = 8.031924e9
const WORLD_TOL = 5e6
/** GitHub blob hard limit — a committed file at or above this cannot be pushed. */
const MAX_FILE_BYTES = 100 * 1024 * 1024
/** Tiled tiers: exact cell and tile counts, and the H3 resolution of the tile parents. */
const EXPECTED_TILED = {
  r7: { cells: 9012014, tiles: 2409, parentRes: 2 },
  r8: { cells: 32957699, tiles: 12761, parentRes: 3 },
}
/**
 * Tiled tiers that are the H3-parent roll-up of a finer tiled tier (parent → child),
 * as `pipeline/build_parents.py` derives them. The whole-file r5 ↔ mid roll-up is
 * checked separately below.
 */
const TILED_ROLLUPS = { r7: 'r8' }
/** Minimum tiles read whole in --sample mode (the brief's floor). */
const MIN_SAMPLE_TILES = 500
/** Tiles whose every cell gets an H3-parent check (the mis-partition detector). */
const DEEP_PARENT_TILES = 600

const args = process.argv.slice(2)
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
const flagNum = (name, dflt) => {
  const a = flag(name)
  if (!a) return dflt
  const v = Number(a.split('=')[1])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt
}
const SAMPLE_MODE = Boolean(flag('sample'))
const SAMPLE_N = Math.max(MIN_SAMPLE_TILES, flagNum('sample', MIN_SAMPLE_TILES))
const CONCURRENCY = flagNum('concurrency', 8)

// ---------------------------------------------------------------- reporting

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
  return ok
}
const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v))
const mb = (b) => `${(b / 1e6).toFixed(2)} MB`

// ---------------------------------------------------------------- parquet io

/** Minimal AsyncBuffer over a file already read into memory (mirrors src/data/parquet.ts). */
const memBuffer = (b) => ({ byteLength: b.byteLength, slice: (s, e) => b.slice(s, e) })

async function fileBuffer(abs) {
  const buf = await readFile(abs)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/** Read named columns of a local Parquet file; also returns the schema leaf names. */
async function readCols(abs, columns) {
  const file = memBuffer(await fileBuffer(abs))
  const metadata = await parquetMetadataAsync(file)
  const out = {
    schema: metadata.schema.slice(1).map((s) => s.name),
    rowCount: Number(metadata.num_rows),
  }
  for (const c of columns) out[c] = await parquetReadColumn({ file, metadata, columns: [c] })
  return out
}

/** Run `fn` over `items` with a bounded worker pool (keeps memory flat over 12 k files). */
async function pool(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

/** Deterministic evenly-strided subset — same sample on every run and machine. */
function stride(items, count) {
  if (count >= items.length) return items.slice()
  const step = items.length / count
  const out = []
  for (let i = 0; i < count; i++) out.push(items[Math.floor(i * step)])
  return out
}

// ------------------------------------------------------------ column asserts

/** Column-wise sanity: finite, non-negative pop, lng/lat in range. Returns stats. */
function scanColumns({ population, lng, lat }) {
  let sum = 0
  let max = -Infinity
  let badPop = 0
  let badLng = 0
  let badLat = 0
  for (let i = 0; i < population.length; i++) {
    const p = population[i]
    if (!Number.isFinite(p) || p < 0) badPop++
    else {
      sum += p
      if (p > max) max = p
    }
    const x = lng[i]
    const y = lat[i]
    if (!Number.isFinite(x) || x < -180 || x > 180) badLng++
    if (!Number.isFinite(y) || y < -90 || y > 90) badLat++
  }
  return { sum, max: max === -Infinity ? 0 : max, badPop, badLng, badLat }
}

/**
 * All-cells, allocation-free H3 shape check. In the 15-hex-char form the nibble at
 * index 1 is the index's resolution field (bits 52-55), so a mis-tiered file is
 * caught without 2 M h3-js round-trips; a strided sample is cross-checked with
 * h3-js `isValidCell` / `getResolution` to prove the shortcut.
 */
function scanH3(h3, res) {
  const nib = res.toString(16)
  let bad = 0
  for (let i = 0; i < h3.length; i++) {
    const s = h3[i]
    if (typeof s !== 'string' || s.length !== 15 || s[1] !== nib || !/^[0-9a-f]{15}$/.test(s)) bad++
  }
  let badLib = 0
  const sample = stride(Array.from({ length: h3.length }, (_, i) => i), Math.min(5000, h3.length))
  for (const i of sample) {
    if (!isValidCell(h3[i]) || getResolution(h3[i]) !== res) badLib++
  }
  return { bad, badLib, sampled: sample.length }
}

// ------------------------------------------------------------------ manifest

console.log(`verify_data: ${DATA}`)
console.log(`MODE: ${SAMPLE_MODE ? `SAMPLE (${SAMPLE_N} tiles read whole)` : 'FULL (every tile of every tiled tier read whole)'}`)
console.log('')

let manifest
try {
  manifest = JSON.parse(await readFile(path.join(DATA, 'manifest.json'), 'utf8'))
  check('manifest.json parses', true)
} catch (err) {
  check('manifest.json parses', false, err.message)
  console.log('\n1 FAILURE(S) — cannot continue without a manifest')
  process.exit(1)
}

const MANIFEST_KEYS = ['source', 'dataDate', 'license', 'attribution', 'crs', 'generatedAt', 'lods']
check(
  'manifest top-level fields',
  MANIFEST_KEYS.every((k) => manifest[k] !== undefined) && Array.isArray(manifest.lods),
  MANIFEST_KEYS.filter((k) => manifest[k] === undefined).join(',') || `${MANIFEST_KEYS.length} fields present`,
)
check('manifest license is CC-BY 4.0', manifest.license === 'CC-BY 4.0', `license="${manifest.license}"`)
check('manifest crs is EPSG:4326 (client centroids)', manifest.crs === 'EPSG:4326', `crs="${manifest.crs}"`)

const byLod = Object.fromEntries(manifest.lods.map((e) => [e.lod, e]))
check('manifest has overview/r5/mid/r7/r8', [...WHOLE_TIERS, ...Object.keys(EXPECTED_TILED)].every((l) => byLod[l]), Object.keys(byLod).join(','))
check(
  'manifest tiers ordered coarse → fine with contiguous bands',
  manifest.lods.every((e, i, a) => i === 0 || (e.h3Res > a[i - 1].h3Res && e.minZoom === a[i - 1].maxZoom)),
  manifest.lods.map((e) => `${e.lod}[r${e.h3Res}] ${e.minZoom}–${e.maxZoom}`).join(', '),
)

// `LodEntry` (src/types.ts): required numerics + the file/tiled discriminator.
const LOD_REQUIRED = ['lod', 'h3Res', 'approxKm', 'minZoom', 'maxZoom', 'cellCount', 'maxPopulation', 'sumPopulation']
for (const e of manifest.lods) {
  const missing = LOD_REQUIRED.filter((k) => e[k] === undefined)
  const typed = LOD_REQUIRED.slice(1).every((k) => typeof e[k] === 'number' && Number.isFinite(e[k]))
  check(`manifest[${e.lod}] LodEntry fields`, missing.length === 0 && typed, missing.length ? `missing ${missing}` : 'all present + numeric')
  const shape = e.tiled
    ? typeof e.indexFile === 'string' && typeof e.tileParentRes === 'number'
    : typeof e.file === 'string'
  check(`manifest[${e.lod}] file/tiled discriminator`, shape, e.tiled ? `tiled indexFile=${e.indexFile}` : `file=${e.file}`)
  check(`manifest[${e.lod}] zoom band ordered`, e.minZoom < e.maxZoom, `${e.minZoom} .. ${e.maxZoom}`)
}

// --------------------------------------------------------- whole tiers

const summary = []
/** Decoded whole tiers, kept for the r5 ↔ mid roll-up below. */
const tierCols = {}

for (const lod of WHOLE_TIERS) {
  const e = byLod[lod]
  if (!e) continue
  const abs = path.join(PUBLIC, e.file)
  let size = 0
  try {
    size = (await stat(abs)).size
  } catch {
    check(`${lod}: file exists`, false, abs)
    continue
  }
  check(`${lod}: file exists`, true, `${e.file} (${n(size)} B)`)
  check(`${lod}: manifest bytes == file size`, e.bytes === size, `manifest=${n(e.bytes)} actual=${n(size)}`)

  let cols
  try {
    cols = await readCols(abs, ['h3', 'population', 'lng', 'lat'])
  } catch (err) {
    check(`${lod}: parquet parses`, false, err.message)
    continue
  }
  check(`${lod}: parquet schema`, ['h3', 'population', 'lng', 'lat'].every((c) => cols.schema.includes(c)), cols.schema.join(','))
  check(`${lod}: rows == cellCount`, cols.population.length === e.cellCount, `rows=${n(cols.population.length)} manifest=${n(e.cellCount)}`)
  check(`${lod}: footer num_rows == decoded rows`, cols.rowCount === cols.population.length, `footer=${n(cols.rowCount)} decoded=${n(cols.population.length)}`)

  const st = scanColumns(cols)
  const dSum = st.sum - e.sumPopulation
  check(`${lod}: Σpop == manifest sumPopulation`, Math.abs(dSum) <= SUM_TOL, `Σ=${n(Math.round(st.sum))} manifest=${n(e.sumPopulation)} Δ=${dSum.toFixed(3)}`)
  const dConst = st.sum - EXPECTED_SUM[lod]
  check(`${lod}: Σpop == ${n(EXPECTED_SUM[lod])}`, Math.abs(dConst) <= SUM_TOL, `Δ=${dConst.toFixed(3)}`)
  check(`${lod}: Σpop ≈ 8.03 B`, Math.abs(st.sum - WORLD_POP) < WORLD_TOL, `Σ=${n(Math.round(st.sum))}`)
  check(`${lod}: max(population) == maxPopulation`, Math.abs(st.max - e.maxPopulation) < 1e-3, `max=${n(st.max)} manifest=${n(e.maxPopulation)}`)
  check(`${lod}: no NaN/negative population`, st.badPop === 0, `bad=${n(st.badPop)}`)
  check(`${lod}: lng ∈ [-180,180]`, st.badLng === 0, `out-of-range=${n(st.badLng)}`)
  check(`${lod}: lat ∈ [-90,90]`, st.badLat === 0, `out-of-range=${n(st.badLat)}`)

  const h3st = scanH3(cols.h3, e.h3Res)
  check(`${lod}: every H3 index is res ${e.h3Res}`, h3st.bad === 0, `malformed=${n(h3st.bad)} of ${n(cols.h3.length)}`)
  check(`${lod}: h3-js validates sample`, h3st.badLib === 0, `invalid=${h3st.badLib} of ${n(h3st.sampled)} sampled`)

  tierCols[lod] = cols
  summary.push({ tier: lod, cells: cols.population.length, sum: Math.round(st.sum), max: st.max, extra: `1 file · ${mb(size)}` })
}

// ------------------------------------------------- r5 = parent roll-up of mid

{
  const r5 = tierCols.r5
  const mid = tierCols.mid
  if (r5) {
    check(`r5: rows == ${n(EXPECTED_R5_CELLS)}`, r5.population.length === EXPECTED_R5_CELLS, `rows=${n(r5.population.length)}`)
  }
  if (r5 && mid) {
    const t0 = Date.now()
    const res = byLod.r5.h3Res
    /** r5 index → row. A duplicate row would hide a child sum, so count those too. */
    const row = new Map()
    let dupes = 0
    for (let i = 0; i < r5.h3.length; i++) {
      if (row.has(r5.h3[i])) dupes++
      else row.set(r5.h3[i], i)
    }
    const childSum = new Float64Array(r5.h3.length)
    const childCount = new Uint32Array(r5.h3.length)
    let orphans = 0
    const orphanEg = []
    for (let i = 0; i < mid.h3.length; i++) {
      const parent = cellToParent(mid.h3[i], res)
      const j = row.get(parent)
      if (j === undefined) {
        orphans++
        if (orphanEg.length < 3) orphanEg.push(`${mid.h3[i]}→${parent}`)
        continue
      }
      childSum[j] += mid.population[i]
      childCount[j]++
    }
    let childless = 0
    let sumMismatch = 0
    let nonInteger = 0
    let worst = { d: 0, h3: '' }
    let centerOff = 0
    let maxOff = 0
    for (let j = 0; j < r5.h3.length; j++) {
      if (childCount[j] === 0) childless++
      const p = r5.population[j]
      if (!Number.isInteger(p)) nonInteger++
      // Every mid population is an integer and every r5 sum is < 2^24, so the FLOAT
      // column holds the sum exactly: compare with no tolerance.
      if (p !== childSum[j]) {
        sumMismatch++
        if (Math.abs(p - childSum[j]) > worst.d) worst = { d: Math.abs(p - childSum[j]), h3: r5.h3[j] }
      }
      const [la, ln] = cellToLatLng(r5.h3[j])
      let dLng = Math.abs(ln - r5.lng[j])
      if (dLng > 180) dLng = 360 - dLng
      const off = Math.max(Math.abs(la - r5.lat[j]), dLng)
      if (off > maxOff) maxOff = off
      if (off > 1e-4) centerOff++
    }
    check('r5: no duplicate cells', dupes === 0, `duplicates=${n(dupes)}`)
    check(`r5: every mid cell's r${res} parent is an r5 cell`, orphans === 0, `missing parents=${n(orphans)} of ${n(mid.h3.length)} mid cells${orphanEg.length ? ' e.g. ' + orphanEg.join(', ') : ''}`)
    check('r5: every r5 cell is the parent of ≥ 1 mid cell', childless === 0, `childless=${n(childless)} of ${n(r5.h3.length)}`)
    check(
      'r5: population == exact Σ of its mid children',
      sumMismatch === 0,
      `mismatched=${n(sumMismatch)}${sumMismatch ? `, worst Δ=${n(worst.d)} at ${worst.h3}` : ''}`,
    )
    check('r5: every population is a whole number (float32-exact)', nonInteger === 0, `non-integer=${n(nonInteger)}`)
    check('r5: lng/lat == H3 cell center (EPSG:4326, lng first)', centerOff === 0, `off by > 1e-4°: ${n(centerOff)}, max off ${maxOff.toExponential(2)}°`)
    console.log(`      … r5 ↔ mid roll-up over ${n(mid.h3.length)} cells in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }
}

// ------------------------------------------------------------ tiled pyramids

/** Per-tile shape of a tiled tier's index.json (`TileIndex` in src/types.ts). */
const IDX_KEYS = ['parentRes', 'h3Res', 'approxKm', 'tileCount', 'cellCount', 'maxPopulation', 'sumPopulation', 'tiles']

async function readIndex(e) {
  try {
    const idx = JSON.parse(await readFile(path.join(PUBLIC, e.indexFile), 'utf8'))
    check(`${e.lod}: index.json parses`, true, e.indexFile)
    return idx
  } catch (err) {
    check(`${e.lod}: index.json parses`, false, err.message)
    return null
  }
}

/**
 * The children check of a tiled roll-up (r7 = Σ of r8 children, `build_parents.py`),
 * run inside the CHILD tier's tile pass. The H3 hierarchy nests: every child tile (an r3
 * cell) lies inside exactly one parent-tier tile (its r2 ancestor), so child tiles are
 * summed into their parent tile's group and a group is compared — and dropped — as soon
 * as its last child tile is in. Only the groups in flight are ever held (the index is
 * sorted, so a group's tiles are adjacent), never 33 M strings or one giant Map.
 *
 * Per cell it uses h3-js `cellToParent` — independent of the pipeline's bit arithmetic.
 */
function tiledRollup(parent, parentIdx, child, childIdx) {
  const pres = parentIdx.parentRes
  const res = parent.h3Res
  const parentTiles = new Map(parentIdx.tiles.map((t) => [t.parent, t]))
  /** group (parent-tier tile) → child tiles not yet summed. */
  const pending = new Map()
  for (const t of childIdx.tiles) {
    let g
    try {
      g = cellToParent(t.parent, pres)
    } catch {
      continue // not an H3 cell: the child tier's own index checks already fail it
    }
    pending.set(g, (pending.get(g) ?? 0) + 1)
  }
  /** group → (parent cell → Σ children so far). */
  const groups = new Map()
  const visited = new Set()
  const s = {
    childCells: 0,
    misfiled: 0,
    orphans: 0,
    orphanEg: [],
    missingTile: 0,
    childless: 0,
    mismatch: 0,
    worst: { d: 0, h3: '' },
    nonInteger: 0,
    dupes: 0,
    misplaced: 0,
    centerOff: 0,
    maxOff: 0,
    rows: 0,
    readErr: 0,
    errs: [],
  }

  async function finalize(g, sums) {
    visited.add(g)
    const t = parentTiles.get(g)
    if (!t) {
      s.missingTile++
      s.orphans += sums.size
      if (s.orphanEg.length < 3) s.orphanEg.push(`no ${parent.lod} tile ${g}`)
      return
    }
    let cols
    try {
      cols = await readCols(path.join(PUBLIC, t.file), ['h3', 'population', 'lng', 'lat'])
    } catch (err) {
      s.readErr++
      if (s.errs.length < 3) s.errs.push(`${g}: ${err.message}`)
      return
    }
    const seen = new Set()
    for (let j = 0; j < cols.h3.length; j++) {
      const h = cols.h3[j]
      s.rows++
      if (seen.has(h)) s.dupes++
      seen.add(h)
      if (cellToParent(h, pres) !== g) s.misplaced++
      const p = cols.population[j]
      if (!Number.isInteger(p)) s.nonInteger++
      const sum = sums.get(h)
      if (sum === undefined) {
        s.childless++
        continue
      }
      sums.delete(h)
      // Every child population is a whole number and every parent sum is < 2^24, so the
      // FLOAT column holds the sum exactly: compare with no tolerance.
      if (p !== sum) {
        s.mismatch++
        if (Math.abs(p - sum) > s.worst.d) s.worst = { d: Math.abs(p - sum), h3: h }
      }
      const [la, ln] = cellToLatLng(h)
      let dLng = Math.abs(ln - cols.lng[j])
      if (dLng > 180) dLng = 360 - dLng
      const off = Math.max(Math.abs(la - cols.lat[j]), dLng)
      if (off > s.maxOff) s.maxOff = off
      if (off > 1e-4) s.centerOff++
    }
    // Whatever is left has children but no row in the tile the hierarchy puts it in.
    s.orphans += sums.size
    for (const k of sums.keys()) {
      if (s.orphanEg.length >= 3) break
      s.orphanEg.push(`${k} (not in ${g})`)
    }
  }

  return {
    /** Called once per child tile read (FULL mode only — a group needs all its tiles). */
    async onTile(t, cols) {
      const g = cellToParent(t.parent, pres)
      let sums = groups.get(g)
      if (!sums) groups.set(g, (sums = new Map()))
      const local = new Map()
      for (let i = 0; i < cols.h3.length; i++) {
        const p = cellToParent(cols.h3[i], res)
        local.set(p, (local.get(p) ?? 0) + cols.population[i])
      }
      s.childCells += cols.h3.length
      for (const [p, v] of local) {
        // The child tier's partition, for every cell: its parent (and so the cell) lies
        // under the tile's declared parent. One h3-js call per parent cell, not per child.
        if (cellToParent(p, childIdx.parentRes) !== t.parent) s.misfiled++
        sums.set(p, (sums.get(p) ?? 0) + v)
      }
      const left = pending.get(g) - 1
      pending.set(g, left)
      if (left === 0) {
        groups.delete(g)
        await finalize(g, sums)
      }
    },
    finish(t0) {
      const unread = [...pending.values()].filter((v) => v > 0).length
      let childlessTiles = 0
      for (const t of parentIdx.tiles) {
        if (!visited.has(t.parent)) {
          childlessTiles++
          s.childless += t.cellCount
        }
      }
      const P = parent.lod
      const C = child.lod
      check(`${P} ↔ ${C}: every ${C} tile group read`, unread === 0 && s.readErr === 0, `incomplete groups=${n(unread)}, ${P} read errors=${n(s.readErr)}${s.errs.length ? ' ' + s.errs.join(' | ') : ''}`)
      check(`${P} ↔ ${C}: every ${C} cell lies under its tile's r${childIdx.parentRes} parent`, s.misfiled === 0, `misfiled ${P} parents=${n(s.misfiled)} over ${n(s.childCells)} ${C} cells`)
      check(`${P} ↔ ${C}: every ${C} cell's r${res} parent is in the ${P} tile of its r${pres} ancestor`, s.orphans === 0 && s.missingTile === 0, `missing parents=${n(s.orphans)}, groups with no ${P} tile=${n(s.missingTile)}${s.orphanEg.length ? ' e.g. ' + s.orphanEg.join(', ') : ''}`)
      check(`${P} ↔ ${C}: every ${P} cell is the parent of ≥ 1 ${C} cell`, s.childless === 0, `childless=${n(s.childless)} (${n(childlessTiles)} ${P} tiles with no ${C} tiles)`)
      check(`${P} ↔ ${C}: every ${P} cell sits in the tile of its r${pres} parent`, s.misplaced === 0, `misplaced=${n(s.misplaced)} of ${n(s.rows)}`)
      check(`${P}: no duplicate cells`, s.dupes === 0, `duplicates=${n(s.dupes)}`)
      check(
        `${P} ↔ ${C}: population == exact Σ of its ${C} children`,
        s.mismatch === 0,
        `mismatched=${n(s.mismatch)}${s.mismatch ? `, worst Δ=${n(s.worst.d)} at ${s.worst.h3}` : ''}`,
      )
      check(`${P}: every population is a whole number (float32-exact)`, s.nonInteger === 0, `non-integer=${n(s.nonInteger)}`)
      check(`${P}: lng/lat == H3 cell center (EPSG:4326, lng first)`, s.centerOff === 0, `off by > 1e-4°: ${n(s.centerOff)}, max off ${s.maxOff.toExponential(2)}°`)
      console.log(`      … ${P} ↔ ${C} roll-up over ${n(s.childCells)} cells, tile group by tile group, in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    },
  }
}

/** Index ↔ manifest, files on disk, and every (or a sample of) tile read whole. */
async function verifyTiled(e, idx, rollup) {
  const L = e.lod
  const expected = EXPECTED_TILED[L]
  check(`${L}: TileIndex fields`, IDX_KEYS.every((k) => idx[k] !== undefined), IDX_KEYS.filter((k) => idx[k] === undefined).join(',') || 'all present')
  check(`${L}: every TileRef has parent/file/cellCount`, idx.tiles.every((t) => typeof t.parent === 'string' && typeof t.file === 'string' && Number.isInteger(t.cellCount)))
  check(`${L}: index tileCount == tiles.length`, idx.tileCount === idx.tiles.length, `${n(idx.tileCount)} vs ${n(idx.tiles.length)}`)
  if (expected) {
    check(`${L}: tileCount == ${n(expected.tiles)}`, idx.tiles.length === expected.tiles, n(idx.tiles.length))
    check(`${L}: tiles are r${expected.parentRes} parents`, idx.parentRes === expected.parentRes, `parentRes=${idx.parentRes}`)
  } else check(`${L}: a tiled tier this gate knows`, false, `add ${L} to EXPECTED_TILED`)
  check(`${L}: index parentRes == manifest tileParentRes`, idx.parentRes === e.tileParentRes, `${idx.parentRes} vs ${e.tileParentRes}`)
  check(`${L}: index h3Res == manifest h3Res`, idx.h3Res === e.h3Res, `${idx.h3Res} vs ${e.h3Res}`)
  check(`${L}: index cellCount == manifest cellCount`, idx.cellCount === e.cellCount, `${n(idx.cellCount)} vs ${n(e.cellCount)}`)
  check(`${L}: index sumPopulation == manifest sumPopulation`, idx.sumPopulation === e.sumPopulation, `${n(idx.sumPopulation)} vs ${n(e.sumPopulation)}`)
  check(`${L}: index maxPopulation == manifest maxPopulation`, idx.maxPopulation === e.maxPopulation, `${n(idx.maxPopulation)} vs ${n(e.maxPopulation)}`)
  check(`${L}: unique parents`, new Set(idx.tiles.map((t) => t.parent)).size === idx.tiles.length)
  check(`${L}: every parent is a valid r${idx.parentRes} H3 cell`, idx.tiles.every((t) => isValidCell(t.parent) && getResolution(t.parent) === idx.parentRes))
  check(
    `${L}: every tile file is parent=<its parent>/`,
    idx.tiles.every((t) => t.file.startsWith(`${path.posix.dirname(e.indexFile)}/parent=${t.parent}/`)),
    `under ${path.posix.dirname(e.indexFile)}/`,
  )

  const sumDeclared = idx.tiles.reduce((a, t) => a + t.cellCount, 0)
  check(
    `${L}: Σ tile cellCount == ${expected ? n(expected.cells) : 'index cellCount'}`,
    sumDeclared === idx.cellCount && (!expected || sumDeclared === expected.cells),
    `Σ=${n(sumDeclared)} index=${n(idx.cellCount)}`,
  )

  // -- existence over ALL tiles (both modes) ---------------------------------
  const sizes = new Array(idx.tiles.length).fill(0)
  let missing = 0
  await pool(idx.tiles, 32, async (t, i) => {
    try {
      sizes[i] = (await stat(path.join(PUBLIC, t.file))).size
    } catch {
      missing++
    }
  })
  check(`${L}: every indexed tile file exists`, missing === 0, `${n(idx.tiles.length - missing)}/${n(idx.tiles.length)} present, missing=${n(missing)}`)

  // -- no orphan tiles on disk (a partition the index forgot) ----------------
  const tileDir = path.join(PUBLIC, path.dirname(e.indexFile))
  const dirents = await readdir(tileDir, { withFileTypes: true })
  const onDisk = new Set(dirents.filter((d) => !d.isFile() && d.name.startsWith('parent=')).map((d) => d.name.slice('parent='.length)))
  const indexed = new Set(idx.tiles.map((t) => t.parent))
  const orphans = [...onDisk].filter((p) => !indexed.has(p))
  check(`${L}: no orphan parent dirs on disk`, orphans.length === 0, `dirs=${n(onDisk.size)} orphans=${n(orphans.length)}${orphans.length ? ' e.g. ' + orphans.slice(0, 3) : ''}`)

  // -- read tiles ------------------------------------------------------------
  const toRead = SAMPLE_MODE ? stride(idx.tiles, SAMPLE_N) : idx.tiles
  const deepSet = new Set(stride(toRead, Math.min(DEEP_PARENT_TILES, toRead.length)).map((t) => t.parent))
  const nib = e.h3Res.toString(16)

  let sum = 0
  let max = -Infinity
  let rows = 0
  let rowMismatch = 0
  let badPop = 0
  let badLng = 0
  let badLat = 0
  let badRes = 0
  let parentMismatch = 0
  let deepCells = 0
  let shallowCells = 0
  let readErr = 0
  const errs = []
  let done = 0
  const t0 = Date.now()
  const progressEvery = Math.max(500, Math.ceil(toRead.length / 6 / 500) * 500)

  await pool(toRead, CONCURRENCY, async (t) => {
    try {
      const cols = await readCols(path.join(PUBLIC, t.file), ['h3', 'population', 'lng', 'lat'])
      if (cols.population.length !== t.cellCount) rowMismatch++
      rows += cols.population.length
      const st = scanColumns(cols)
      sum += st.sum
      if (st.max > max) max = st.max
      badPop += st.badPop
      badLng += st.badLng
      badLat += st.badLat

      const h3 = cols.h3
      for (let i = 0; i < h3.length; i++) {
        if (typeof h3[i] !== 'string' || h3[i].length !== 15 || h3[i][1] !== nib) badRes++
      }
      // Partition proof: every cell must roll up to the parent named by the path.
      if (deepSet.has(t.parent)) {
        for (let i = 0; i < h3.length; i++) {
          if (cellToParent(h3[i], idx.parentRes) !== t.parent) parentMismatch++
        }
        deepCells += h3.length
      } else if (h3.length) {
        for (const i of [0, h3.length >> 1, h3.length - 1]) {
          if (cellToParent(h3[i], idx.parentRes) !== t.parent) parentMismatch++
          shallowCells++
        }
      }
      if (rollup) await rollup.onTile(t, cols)
    } catch (err) {
      readErr++
      if (errs.length < 3) errs.push(`${t.parent}: ${err.message}`)
    }
    if (++done % progressEvery === 0 || done === toRead.length) {
      console.log(`      … ${L}: ${n(done)}/${n(toRead.length)} tiles read (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    }
  })

  check(`${L}: every read tile parses`, readErr === 0, `errors=${n(readErr)}${errs.length ? ' ' + errs.join(' | ') : ''}`)
  check(`${L}: per-tile rows == index cellCount`, rowMismatch === 0, `mismatched tiles=${n(rowMismatch)} of ${n(toRead.length)}`)
  check(`${L}: no NaN/negative population`, badPop === 0, `bad=${n(badPop)}`)
  check(`${L}: lng ∈ [-180,180]`, badLng === 0, `out-of-range=${n(badLng)}`)
  check(`${L}: lat ∈ [-90,90]`, badLat === 0, `out-of-range=${n(badLat)}`)
  check(`${L}: every H3 index is res ${e.h3Res}`, badRes === 0, `malformed=${n(badRes)} of ${n(rows)}`)
  check(
    `${L}: cells roll up to declared r${idx.parentRes} parent`,
    parentMismatch === 0,
    `mismatches=${n(parentMismatch)}; deep=${n(deepCells)} cells in ${n(deepSet.size)} tiles + ${n(shallowCells)} spot cells`,
  )

  if (SAMPLE_MODE) {
    const declared = toRead.reduce((a, t) => a + t.cellCount, 0)
    check(`${L} (SAMPLE): rows read == declared for sample`, rows === declared, `rows=${n(rows)} declared=${n(declared)}`)
    console.log(`SKIP  ${L}: Σpop over all tiles — SAMPLE mode read ${n(toRead.length)}/${n(idx.tiles.length)} tiles (Σ of sample = ${n(Math.round(sum))})`)
  } else {
    check(`${L}: rows read == ${n(expected?.cells ?? idx.cellCount)}`, rows === (expected?.cells ?? idx.cellCount), `rows=${n(rows)}`)
    const dSum = sum - idx.sumPopulation
    check(`${L}: Σpop over ALL tiles == index sumPopulation`, Math.abs(dSum) <= SUM_TOL, `Σ=${n(Math.round(sum))} index=${n(idx.sumPopulation)} Δ=${dSum.toFixed(3)}`)
    const dConst = sum - EXPECTED_SUM[L]
    check(`${L}: Σpop over ALL tiles == ${n(EXPECTED_SUM[L])}`, Math.abs(dConst) <= SUM_TOL, `Δ=${dConst.toFixed(3)}`)
    check(`${L}: Σpop ≈ 8.03 B`, Math.abs(sum - WORLD_POP) < WORLD_TOL, `Σ=${n(Math.round(sum))}`)
    check(`${L}: max(population) == index maxPopulation`, Math.abs(max - idx.maxPopulation) < 1e-3, `max=${n(max)} index=${n(idx.maxPopulation)}`)
  }
  console.log(`      … ${L}: ${n(toRead.length)} tiles in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const bytes = sizes.reduce((a, b) => a + b, 0)
  summary.push({
    tier: L,
    cells: SAMPLE_MODE ? sumDeclared : rows,
    sum: SAMPLE_MODE ? idx.sumPopulation : Math.round(sum),
    max: SAMPLE_MODE ? idx.maxPopulation : max,
    extra: `${n(idx.tiles.length)} tiles · ${mb(bytes)} · biggest ${mb(Math.max(...sizes))}`,
  })
}

{
  const tiled = manifest.lods.filter((e) => e.tiled)
  const indexes = {}
  for (const e of tiled) indexes[e.lod] = await readIndex(e)
  for (const e of tiled) {
    const idx = indexes[e.lod]
    if (!idx) continue
    // Is this tier the CHILD of a tiled roll-up? Then sum it into its parent as it is read.
    const parentLod = Object.keys(TILED_ROLLUPS).find((p) => TILED_ROLLUPS[p] === e.lod)
    const parent = parentLod && byLod[parentLod]
    let rollup = null
    if (parent && indexes[parentLod]) {
      if (SAMPLE_MODE) {
        console.log(`SKIP  ${parentLod} ↔ ${e.lod}: children roll-up — SAMPLE mode does not read every ${e.lod} tile`)
      } else if (e.tileParentRes < parent.tileParentRes) {
        check(`${parentLod} ↔ ${e.lod}: ${e.lod} tiles nest in ${parentLod} tiles`, false, `r${e.tileParentRes} < r${parent.tileParentRes}`)
      } else {
        rollup = tiledRollup(parent, indexes[parentLod], e, idx)
      }
    } else if (parent) {
      check(`${parentLod} ↔ ${e.lod}: both indexes present`, false)
    }
    const t0 = Date.now()
    await verifyTiled(e, idx, rollup)
    rollup?.finish(t0)
  }
  for (const [p, c] of Object.entries(TILED_ROLLUPS)) {
    if (!byLod[p] || !byLod[c]) check(`${p} ↔ ${c}: both tiers in the manifest`, false, Object.keys(byLod).join(','))
  }
}

// ------------------------------------------------- 100 MB Pages file limit

const entries = await readdir(DATA, { withFileTypes: true, recursive: true })
let fileCount = 0
let totalBytes = 0
let biggest = { name: '', size: 0 }
const over = []
for (const d of entries) {
  if (!d.isFile()) continue
  const abs = path.join(d.parentPath ?? d.path, d.name)
  const size = (await stat(abs)).size
  fileCount++
  totalBytes += size
  if (size > biggest.size) biggest = { name: path.relative(ROOT, abs), size }
  if (size >= MAX_FILE_BYTES) over.push(path.relative(ROOT, abs))
}
check(
  'public/data/**: every file < 100 MB',
  over.length === 0,
  `${n(fileCount)} files, ${mb(totalBytes)} total, biggest ${biggest.name} (${mb(biggest.size)})${over.length ? ' OVER: ' + over.join(',') : ''}`,
)

// ------------------------------------------------------------------ summary

console.log('')
console.log('tier      h3  cells         Σ population    max pop      storage')
console.log('--------  --  ------------  --------------  -----------  ----------------------------------')
for (const s of summary) {
  const e = byLod[s.tier]
  console.log(
    `${s.tier.padEnd(8)}  r${String(e.h3Res).padEnd(1)}  ${n(s.cells).padStart(12)}  ${n(s.sum).padStart(14)}  ${n(s.max).padStart(11)}  ${s.extra}`,
  )
}
console.log('')
console.log(`source=${manifest.source}  dataDate=${manifest.dataDate}  license=${manifest.license}  generatedAt=${manifest.generatedAt}`)
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
process.exit(failures ? 1 : 0)
