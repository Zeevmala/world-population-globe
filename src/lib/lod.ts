import type { GlobeViewState, LodData, LodEntry, Manifest, TileSet } from '../types'
// `.ts` extension: `scripts/bench/*.mjs` import this module under Node's native type stripping.
import { bucketKey, bucketView, cameraFor, cullBucket, cullWindow } from './footprint.ts'
import type { Canvas, CullBucket } from './footprint.ts'
import { TIER_HYSTERESIS, bandThresholds, latitudeShift } from './tierBands.ts'

/** Hard cap on rendered cells per frame for the dense tier (perf guard). */
const MAX_RENDERED_CELLS = 120_000

/**
 * A tier's threshold for this view, lowered by the hysteresis band while it is the tier on
 * screen (`tierBands.ts`: the nominal band moved by the view's latitude and canvas).
 */
function entryAt(t: readonly number[], lods: readonly LodEntry[], i: number, lat: number, activeLod?: string | null): number {
  return t[i] + lat - (lods[i].lod === activeLod ? TIER_HYSTERESIS : 0)
}

/**
 * Choose the active LOD name for a view among the whole (loaded) tiers: the finest tier
 * whose threshold (`tierBands.ts`, for this latitude and canvas) is reached AND whose data
 * is already loaded, else the coarsest loaded. Tiled tiers are never in `loaded`;
 * {@link selectActive} handles them.
 */
export function pickLod(
  view: GlobeViewState,
  canvas: Canvas,
  manifest: Manifest | null,
  loaded: Record<string, LodData>,
  activeLod?: string | null,
): string | null {
  if (!manifest) return null
  const { lods } = manifest
  const t = bandThresholds(lods, canvas, view.latitude)
  const lat = latitudeShift(view.latitude)
  let chosen: string | null = null
  for (let i = 0; i < lods.length; i++) {
    if (view.zoom >= entryAt(t, lods, i, lat, activeLod) && loaded[lods[i].lod]) chosen = lods[i].lod
  }
  return chosen ?? lods.find((l) => loaded[l.lod])?.lod ?? null
}

/**
 * Whether tiled tier `lods[i]`'s stream should be following the camera: while the view is
 * in the tier's band for its latitude and canvas (no early entry — the same rule as
 * selection), and while the tier is the one on screen, as long as selection could still
 * keep it — inside its hysteresis on the way out, or past its band while a finer tier's
 * tiles load — so the tier being drawn keeps its tiles current under a pan. Never below
 * its threshold − TIER_HYSTERESIS, where selection cannot pick the tier: after a jump out
 * (a ladder click from 9 to 3) the hook can still see the old `activeLod` for one render,
 * and at zoom 3 the footprint holds ~2,000 r3 parents. Two adjacent tiled tiers are never
 * both streaming, except while the coarser is on screen and the finer is loading, or the
 * finer is held inside its hysteresis.
 *
 * `flight`: while a fly-to is under way, the tier its destination wants (`tierPlan.ts`
 * `flightTier`). A tier the camera merely passes through on the way — neither on screen
 * nor where the flight ends — does not stream: its tiles would be for views shown for a
 * frame or two, and they compete with the destination's.
 */
export function streamWanted(
  lods: readonly LodEntry[],
  i: number,
  view: GlobeViewState,
  canvas: Canvas,
  activeLod?: string | null,
  flight?: string | null,
): boolean {
  const t = bandThresholds(lods, canvas, view.latitude)
  const lat = latitudeShift(view.latitude)
  const entry = lods[i]
  if (view.zoom < entryAt(t, lods, i, lat, activeLod)) return false
  if (entry.lod === activeLod) return true
  if (i + 1 < lods.length && view.zoom >= t[i + 1] + lat) return false
  return flight == null || flight === entry.lod
}

/** Does a tiled tier's published set draw the whole screen of this view? (`lib/tiles.ts` `tileSetCovers`) */
export type TileCoverage = (set: TileSet, view: GlobeViewState, canvas: Canvas) => boolean

/**
 * Resolve the active tier + its data for the current view: walk from the finest tier whose
 * threshold the view has reached (`tierBands.ts`: zoom against the nominal band moved by the
 * view's latitude and canvas, with TIER_HYSTERESIS for the tier now on screen,
 * `activeLod`) down to the first tier that has data for this view — a whole tier once it
 * is loaded, a tiled tier once its published tiles cover the screen (`covers`). So the
 * tier already on screen keeps drawing while the next one's tiles load, a pan into tiles
 * not loaded yet falls back to the tier below instead of drawing a previous view's
 * tiles over a screen they do not cover, and a cold deep link draws the finest tier that
 * is loaded. If nothing at or below the wanted tier has data, the coarsest loaded tier.
 */
export function selectActive(
  view: GlobeViewState,
  canvas: Canvas,
  manifest: Manifest | null,
  loaded: Record<string, LodData>,
  tiles: Record<string, TileSet>,
  activeLod: string | null | undefined,
  covers: TileCoverage,
): { entry?: LodEntry; data?: LodData } {
  if (!manifest) return {}
  const { lods } = manifest
  const t = bandThresholds(lods, canvas, view.latitude)
  const lat = latitudeShift(view.latitude)
  for (let i = lods.length - 1; i >= 0; i--) {
    const entry = lods[i]
    if (view.zoom < entryAt(t, lods, i, lat, activeLod)) continue
    if (entry.tiled) {
      const set = tiles[entry.lod]
      if (set?.data && set.data.h3.length > 0 && covers(set, view, canvas)) return { entry, data: set.data }
    } else if (loaded[entry.lod]) {
      return { entry, data: loaded[entry.lod] }
    }
  }
  const entry = lods.find((l) => !l.tiled && loaded[l.lod])
  return entry ? { entry, data: loaded[entry.lod] } : {}
}

/**
 * In-place iterative quickselect: rearrange `idx` so its first `k` entries are the
 * `k` highest-population cells (unordered within the k). O(n) average vs the
 * O(n log n) full sort it replaces — render order is irrelevant, only the set.
 */
function topKByPopulation(idx: number[], population: ArrayLike<number>, k: number): Uint32Array {
  if (k <= 0) return new Uint32Array(0)
  let lo = 0
  let hi = idx.length - 1
  while (lo < hi) {
    const pivot = population[idx[(lo + hi) >> 1]]
    let i = lo
    let j = hi
    while (i <= j) {
      while (population[idx[i]] > pivot) i++ // larger pops belong on the left
      while (population[idx[j]] < pivot) j-- // smaller pops belong on the right
      if (i <= j) {
        const t = idx[i]
        idx[i] = idx[j]
        idx[j] = t
        i++
        j--
      }
    }
    // Narrow to the partition holding the k-largest boundary; stop once it splits there.
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else break
  }
  return Uint32Array.from(idx.slice(0, k))
}

export interface CullResult {
  /** Source indices to render, or `null` to render the whole tier. */
  indices: Uint32Array | null
  /** Memo key — recompute only when this changes. */
  key: string
}

/**
 * Memo key for {@link cullForView}: the tier, the canvas size rounded up to 16 px and the
 * camera's re-cull bucket ({@link cullBucket} — zoom in steps of 1/8, the view center in Web
 * Mercator steps of a sixth of the canvas's shorter side). Stable while the camera drifts
 * inside one bucket, so the cull re-runs only when the view has moved a real share of the
 * screen — not on every drag tick — and when a resize crosses a 16 px step, not on every
 * resize frame. The window is a function of this key
 * alone ({@link cullWindow}) and covers the footprint of every view that maps to it, so
 * cells never pop at the screen edges between re-culls, whatever the drift in position,
 * zoom or both — while the window holds no more than the cap (past it, see
 * {@link keepPastCap}).
 */
export function cullKeyFor(data: LodData | undefined, view: GlobeViewState, canvas: Canvas): string {
  if (!data) return 'none'
  if (data.h3.length <= MAX_RENDERED_CELLS) return `${data.lod}:all`
  return `${data.lod}:${bucketKey(cullBucket(view, canvas))}`
}

/**
 * Per-tier unit vectors (three float32 columns) — what the cull tests instead of paying
 * four trig calls per cell on every re-cull. Built once per tier object on its first cull
 * and dropped with it (weak key). 12 B per cell: 4.7 MB for r5 (393,791 cells), 24.2 MB
 * for mid (2,016,971 cells), 12 B × the merged cell count of each published tile set; no other
 * tier is culled (the overview renders whole). Float32 places a cell within ~1 m.
 */
interface UnitColumns {
  x: Float32Array
  y: Float32Array
  z: Float32Array
}
/** Bound on the rounding of a float32 unit vector's dot product with a float64 one (> 3 × 2⁻²⁴). */
const F32_SLACK = 4e-7

const unitColumns = new WeakMap<LodData, UnitColumns>()

function unitVectors(data: LodData): UnitColumns {
  let u = unitColumns.get(data)
  if (u) return u
  const { lng, lat } = data
  const n = lng.length
  u = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) }
  const DEG = Math.PI / 180
  for (let i = 0; i < n; i++) {
    const p = lat[i] * DEG
    const l = lng[i] * DEG
    const cp = Math.cos(p)
    u.x[i] = cp * Math.cos(l)
    u.y[i] = cp * Math.sin(l)
    u.z[i] = Math.sin(p)
  }
  unitColumns.set(data, u)
  return u
}

/**
 * Every cell of `data` inside the {@link cullWindow} of the view's key, before the cap —
 * the window's own count, which `scripts/bench/cull_coverage.mjs` reports beside the
 * capped selection.
 *
 * Cost (main thread, every re-cull, all cells of the tier): no per-cell trig — the test
 * is three dot products against the tier's cached unit vectors ({@link unitVectors}):
 * the cap's latitude band first (one float read rejects most of the globe), the cap, then
 * the chart rectangle, compared without a division. Exact at the poles and across the
 * antimeridian: nothing here is in longitude/latitude.
 */
export function cullWindowCells(data: LodData, view: GlobeViewState, canvas: Canvas): number[] {
  const w = cullWindow(cullBucket(view, canvas))
  const { x: ux, y: uy, z: uz } = unitVectors(data)
  const n = ux.length
  const [cx, cy, cz] = w.c0
  const [ex, ey, ez] = w.e0
  const [nx, ny, nz] = w.n0
  const { kc, xMin, xMax, yMin, yMax } = w
  // Both cap tests compare a cosine or a sine near ±1 — flat there, so the float32 unit
  // vectors' rounding (≤ 3 × 2⁻²⁴ on a dot product) would be a visible share of a cap a
  // fraction of a degree wide (zoom 10). They are widened by F32_SLACK; the rectangle,
  // which is well conditioned, does the exact work.
  const cosCap = w.cosCap - F32_SLACK
  const lat0 = Math.asin(Math.max(-1, Math.min(1, cz)))
  const cap = w.capDeg * (Math.PI / 180)
  const zLo = lat0 - cap <= -Math.PI / 2 ? -2 : Math.sin(lat0 - cap) - F32_SLACK
  const zHi = lat0 + cap >= Math.PI / 2 ? 2 : Math.sin(lat0 + cap) + F32_SLACK

  const inside: number[] = []
  for (let i = 0; i < n; i++) {
    const z0 = uz[i]
    if (z0 < zLo || z0 > zHi) continue
    const x0 = ux[i]
    const y0 = uy[i]
    const d = x0 * cx + y0 * cy + z0 * cz
    if (d < cosCap) continue
    const depth = kc - d // > 0: kc > 1 ≥ d (a cap-only window has infinite bounds)
    const x = x0 * ex + y0 * ey + z0 * ez
    if (x < xMin * depth || x > xMax * depth) continue
    const y = x0 * nx + y0 * ny + z0 * nz
    if (y < yMin * depth || y > yMax * depth) continue
    inside.push(i)
  }
  return inside
}

/**
 * When the window holds more than the cap — a function of the KEY alone, so every view
 * that shares the key draws the same cells whichever of them triggered the cull. Ranked
 * against the key's reference view ({@link bucketView}: the bucket's center at its zoom,
 * on the key's canvas): its on-screen cells first, by population if even they exceed the
 * cap; what is left of the cap goes to the drift margin nearest that screen first (the
 * larger of the normalized |x|, |y| — concentric rectangles), cells behind its horizon
 * last. A view drifted inside the key then loses only the outermost margin, on its
 * leading edge, and only as far as the cap falls short of the window. The tier-selection
 * rule (`tierBands.ts`, `tierFit.ts`) starts every tier where its window cannot hold more
 * than the cap, so this is a safety net that the committed data never reaches.
 *
 * "On screen" is the footprint model's (`footprint.ts`, held to GlobeViewport), on the
 * same float32 unit vectors, widened by half a pixel and {@link F32_SLACK} at the
 * horizon so rounding can only promote a cell on the edge, never demote one.
 */
function keepPastCap(inside: number[], u: UnitColumns, population: Float32Array, bucket: CullBucket): Uint32Array {
  const cam = cameraFor(bucketView(bucket), { width: bucket.width, height: bucket.height })
  const [cx, cy, cz] = cam.c
  const [ex, ey, ez] = cam.e
  const [nx, ny, nz] = cam.n
  const minDot = 1 / cam.k - F32_SLACK
  const halfW = (cam.width / 2 + 0.5) / cam.f
  const halfH = (cam.height / 2 + 0.5) / cam.f
  const shown: number[] = []
  const marginCells: number[] = []
  const nearness: number[] = []
  for (const i of inside) {
    const x0 = u.x[i]
    const y0 = u.y[i]
    const z0 = u.z[i]
    const d = x0 * cx + y0 * cy + z0 * cz
    const depth = cam.k - d
    const r = Math.max(Math.abs(x0 * ex + y0 * ey + z0 * ez) / (halfW * depth), Math.abs(x0 * nx + y0 * ny + z0 * nz) / (halfH * depth))
    if (d >= minDot && r <= 1) {
      shown.push(i)
    } else {
      // Larger is kept first: nearer the reference screen, and in front of its horizon.
      nearness.push(d >= minDot ? -r : -r - 1e6)
      marginCells.push(i)
    }
  }
  if (shown.length >= MAX_RENDERED_CELLS) return topKByPopulation(shown, population, MAX_RENDERED_CELLS)
  // Ranked by position in the margin list (`nearness` is indexed by it), then mapped back.
  const positions = Array.from(marginCells.keys())
  const kept = topKByPopulation(positions, nearness, MAX_RENDERED_CELLS - shown.length)
  const out = new Uint32Array(MAX_RENDERED_CELLS)
  out.set(shown)
  let o = shown.length
  for (const m of kept) out[o++] = marginCells[m]
  return out
}

/**
 * Viewport cull for dense tiers. The coarse overview tier (71k cells) renders whole;
 * finer tiers keep the cells inside the key's {@link cullWindow} — the canvas rectangle,
 * as GlobeView projects it, grown by the margin the camera may drift before the next
 * re-cull, and cut at the horizon ({@link cullWindowCells}). The rectangle, not a circle
 * around it: a cap around a 16:10 canvas is ~3× its area and would spend the 120 k cap
 * off screen. Past the cap, what is kept is a function of the key alone: the key's
 * reference view's on-screen cells, then the margin nearest them ({@link keepPastCap}).
 */
export function cullForView(
  data: LodData | undefined,
  view: GlobeViewState,
  canvas: Canvas,
): CullResult {
  if (!data) return { indices: null, key: 'none' }
  if (data.h3.length <= MAX_RENDERED_CELLS) {
    return { indices: null, key: `${data.lod}:all` }
  }
  const inside = cullWindowCells(data, view, canvas)
  const indices =
    inside.length > MAX_RENDERED_CELLS
      ? keepPastCap(inside, unitVectors(data), data.population, cullBucket(view, canvas))
      : Uint32Array.from(inside)
  return { indices, key: cullKeyFor(data, view, canvas) }
}
