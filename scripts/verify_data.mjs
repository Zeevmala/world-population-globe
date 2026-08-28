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
 *   - overview + mid: rows == cellCount, Σpop == sumPopulation (and the hard
 *     8,031,924,025 / 8,031,924,024 constants), max == maxPopulation, bytes ==
 *     file size, finite non-negative populations, lng/lat in range, H3 resolution.
 *   - r8 pyramid: index.json == manifest, every listed tile exists, no orphan
 *     tiles on disk, Σ cellCount == 32,957,699, Σpop == 8,031,924,024, and every
 *     tile's cells really live under its declared H3 r3 parent.
 *   - every file under public/data/** < 100 MB (GitHub Pages hard limit).
 *
 * Usage: node scripts/verify_data.mjs [--sample[=N]] [--concurrency=N]
 *   default: FULL mode — reads all 12,761 r8 tiles (~1 min).
 *   --sample=N: read only N deterministically-strided tiles; the file-existence
 *   and Σ-cellCount checks still cover all 12,761. The mode is printed.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cellToParent, getResolution, isValidCell } from 'h3-js'
import { parquetMetadataAsync } from 'hyparquet'
import { parquetReadColumn } from 'hyparquet/src/read.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')
const DATA = path.join(PUBLIC, 'data')

/** Exact per-tier population totals baked by the pipeline (people). */
const EXPECTED_SUM = { overview: 8031924025, mid: 8031924024, r8: 8031924024 }
/** Σ of a FLOAT column is float32-rounded per value; allow drift, print the delta. */
const SUM_TOL = 512
/** Coarse "still ≈ 8.03 B" guard, same magnitude as verify_live.mjs. */
const WORLD_POP = 8.031924e9
const WORLD_TOL = 5e6
/** GitHub blob hard limit — a committed file at or above this cannot be pushed. */
const MAX_FILE_BYTES = 100 * 1024 * 1024
const EXPECTED_R8_CELLS = 32957699
const EXPECTED_R8_TILES = 12761
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
console.log(`MODE: ${SAMPLE_MODE ? `SAMPLE (${SAMPLE_N} tiles read whole)` : 'FULL (every r8 tile read whole)'}`)
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
check('manifest has overview/mid/r8', ['overview', 'mid', 'r8'].every((l) => byLod[l]), Object.keys(byLod).join(','))

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

for (const lod of ['overview', 'mid']) {
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

  summary.push({ tier: lod, cells: cols.population.length, sum: Math.round(st.sum), max: st.max, extra: `1 file · ${mb(size)}` })
}

// ------------------------------------------------------------- r8 pyramid

const r8 = byLod.r8
let idx = null
if (r8) {
  const idxPath = path.join(PUBLIC, r8.indexFile)
  try {
    idx = JSON.parse(await readFile(idxPath, 'utf8'))
    check('r8: index.json parses', true, r8.indexFile)
  } catch (err) {
    check('r8: index.json parses', false, err.message)
  }
}

if (idx) {
  const IDX_KEYS = ['parentRes', 'h3Res', 'approxKm', 'tileCount', 'cellCount', 'maxPopulation', 'sumPopulation', 'tiles']
  check('r8: TileIndex fields', IDX_KEYS.every((k) => idx[k] !== undefined), IDX_KEYS.filter((k) => idx[k] === undefined).join(',') || 'all present')
  check('r8: every TileRef has parent/file/cellCount', idx.tiles.every((t) => typeof t.parent === 'string' && typeof t.file === 'string' && Number.isInteger(t.cellCount)))
  check('r8: index tileCount == tiles.length', idx.tileCount === idx.tiles.length, `${n(idx.tileCount)} vs ${n(idx.tiles.length)}`)
  check(`r8: tileCount == ${n(EXPECTED_R8_TILES)}`, idx.tiles.length === EXPECTED_R8_TILES, n(idx.tiles.length))
  check('r8: index parentRes == manifest tileParentRes', idx.parentRes === r8.tileParentRes, `${idx.parentRes} vs ${r8.tileParentRes}`)
  check('r8: index h3Res == manifest h3Res', idx.h3Res === r8.h3Res, `${idx.h3Res} vs ${r8.h3Res}`)
  check('r8: index cellCount == manifest cellCount', idx.cellCount === r8.cellCount, `${n(idx.cellCount)} vs ${n(r8.cellCount)}`)
  check('r8: index sumPopulation == manifest sumPopulation', idx.sumPopulation === r8.sumPopulation, `${n(idx.sumPopulation)} vs ${n(r8.sumPopulation)}`)
  check('r8: unique parents', new Set(idx.tiles.map((t) => t.parent)).size === idx.tiles.length)
  check('r8: every parent is a valid r3 H3 cell', idx.tiles.every((t) => isValidCell(t.parent) && getResolution(t.parent) === idx.parentRes))

  const sumDeclared = idx.tiles.reduce((a, t) => a + t.cellCount, 0)
  check(`r8: Σ tile cellCount == ${n(EXPECTED_R8_CELLS)}`, sumDeclared === EXPECTED_R8_CELLS && sumDeclared === idx.cellCount, `Σ=${n(sumDeclared)} index=${n(idx.cellCount)}`)

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
  check('r8: every indexed tile file exists', missing === 0, `${n(idx.tiles.length - missing)}/${n(idx.tiles.length)} present, missing=${n(missing)}`)

  // -- no orphan tiles on disk (a partition the index forgot) ----------------
  const dirents = await readdir(path.join(DATA, 'tiles', 'r8'), { withFileTypes: true })
  const onDisk = new Set(dirents.filter((d) => !d.isFile() && d.name.startsWith('parent=')).map((d) => d.name.slice('parent='.length)))
  const indexed = new Set(idx.tiles.map((t) => t.parent))
  const orphans = [...onDisk].filter((p) => !indexed.has(p))
  check('r8: no orphan parent dirs on disk', orphans.length === 0, `dirs=${n(onDisk.size)} orphans=${n(orphans.length)}${orphans.length ? ' e.g. ' + orphans.slice(0, 3) : ''}`)

  // -- read tiles ------------------------------------------------------------
  const toRead = SAMPLE_MODE ? stride(idx.tiles, SAMPLE_N) : idx.tiles
  const deepSet = new Set(stride(toRead, Math.min(DEEP_PARENT_TILES, toRead.length)).map((t) => t.parent))

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
        if (typeof h3[i] !== 'string' || h3[i].length !== 15 || h3[i][1] !== '8') badRes++
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
    } catch (err) {
      readErr++
      if (errs.length < 3) errs.push(`${t.parent}: ${err.message}`)
    }
    if (++done % 2000 === 0 || done === toRead.length) {
      console.log(`      … ${n(done)}/${n(toRead.length)} tiles read (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    }
  })

  check('r8: every read tile parses', readErr === 0, `errors=${n(readErr)}${errs.length ? ' ' + errs.join(' | ') : ''}`)
  check('r8: per-tile rows == index cellCount', rowMismatch === 0, `mismatched tiles=${n(rowMismatch)} of ${n(toRead.length)}`)
  check('r8: no NaN/negative population', badPop === 0, `bad=${n(badPop)}`)
  check('r8: lng ∈ [-180,180]', badLng === 0, `out-of-range=${n(badLng)}`)
  check('r8: lat ∈ [-90,90]', badLat === 0, `out-of-range=${n(badLat)}`)
  check('r8: every H3 index is res 8', badRes === 0, `malformed=${n(badRes)} of ${n(rows)}`)
  check(
    `r8: cells roll up to declared r${idx.parentRes} parent`,
    parentMismatch === 0,
    `mismatches=${n(parentMismatch)}; deep=${n(deepCells)} cells in ${n(deepSet.size)} tiles + ${n(shallowCells)} spot cells`,
  )

  if (SAMPLE_MODE) {
    const declared = toRead.reduce((a, t) => a + t.cellCount, 0)
    check('r8 (SAMPLE): rows read == declared for sample', rows === declared, `rows=${n(rows)} declared=${n(declared)}`)
    console.log(`SKIP  r8: Σpop over all tiles — SAMPLE mode read ${n(toRead.length)}/${n(idx.tiles.length)} tiles (Σ of sample = ${n(Math.round(sum))})`)
  } else {
    check(`r8: rows read == ${n(EXPECTED_R8_CELLS)}`, rows === EXPECTED_R8_CELLS, `rows=${n(rows)}`)
    const dSum = sum - idx.sumPopulation
    check('r8: Σpop over ALL tiles == index sumPopulation', Math.abs(dSum) <= SUM_TOL, `Σ=${n(Math.round(sum))} index=${n(idx.sumPopulation)} Δ=${dSum.toFixed(3)}`)
    const dConst = sum - EXPECTED_SUM.r8
    check(`r8: Σpop over ALL tiles == ${n(EXPECTED_SUM.r8)}`, Math.abs(dConst) <= SUM_TOL, `Δ=${dConst.toFixed(3)}`)
    check('r8: Σpop ≈ 8.03 B', Math.abs(sum - WORLD_POP) < WORLD_TOL, `Σ=${n(Math.round(sum))}`)
    check('r8: max(population) == index maxPopulation', Math.abs(max - idx.maxPopulation) < 1e-3, `max=${n(max)} index=${n(idx.maxPopulation)}`)
  }

  const bytes = sizes.reduce((a, b) => a + b, 0)
  summary.push({
    tier: 'r8',
    cells: SAMPLE_MODE ? sumDeclared : rows,
    sum: SAMPLE_MODE ? idx.sumPopulation : Math.round(sum),
    max: SAMPLE_MODE ? idx.maxPopulation : max,
    extra: `${n(idx.tiles.length)} tiles · ${mb(bytes)} · biggest ${mb(Math.max(...sizes))}`,
  })
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
