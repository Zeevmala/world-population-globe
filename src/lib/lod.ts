import type { GlobeViewState, LodData, LodEntry, Manifest } from '../types'

/** Hard cap on rendered cells per frame for the dense tier (perf guard). */
const MAX_RENDERED_CELLS = 120_000

/**
 * Zoom slack a tier keeps once it is on screen. Without it, a camera resting on a
 * threshold (2.2 or 4.5) flips tiers on every sub-pixel zoom jitter, and each flip
 * rebuilds and re-uploads the whole layer. A tier now has to be left by this much
 * before it yields, so the boundary is crossed once, deliberately.
 */
const TIER_HYSTERESIS = 0.15

/**
 * Choose the active LOD name for the current zoom: the finest tier whose
 * `minZoom` is satisfied AND whose data is already loaded, else the coarsest.
 */
export function pickLod(
  zoom: number,
  manifest: Manifest | null,
  loaded: Record<string, LodData>,
  activeLod?: string | null,
): string | null {
  if (!manifest) return null
  let chosen: string | null = null
  for (const entry of manifest.lods) {
    if (zoom >= entryZoom(entry, activeLod) && loaded[entry.lod]) chosen = entry.lod
  }
  return chosen ?? manifest.lods.find((l) => loaded[l.lod])?.lod ?? null
}

/** A tier's effective entry zoom — lowered by the hysteresis band while it is active. */
function entryZoom(entry: LodEntry, activeLod?: string | null): number {
  return entry.lod === activeLod ? entry.minZoom - TIER_HYSTERESIS : entry.minZoom
}

/**
 * Resolve the active tier + its data for the current view. The tiled r8 tier
 * wins when its zoom band is reached and viewport tiles are merged & ready;
 * otherwise fall back to the finest loaded whole tier ({@link pickLod}).
 * Pass the currently-rendered tier as `activeLod` to apply {@link TIER_HYSTERESIS}
 * so a camera parked on a threshold doesn't oscillate between tiers.
 */
export function selectActive(
  view: GlobeViewState,
  manifest: Manifest | null,
  loaded: Record<string, LodData>,
  r8Data: LodData | null,
  activeLod?: string | null,
): { entry?: LodEntry; data?: LodData } {
  if (!manifest) return {}
  const r8 = manifest.lods.find((l) => l.lod === 'r8')
  if (r8 && view.zoom >= entryZoom(r8, activeLod) && r8Data && r8Data.h3.length > 0) {
    return { entry: r8, data: r8Data }
  }
  const lod = pickLod(view.zoom, manifest, loaded, activeLod)
  return { entry: manifest.lods.find((l) => l.lod === lod), data: lod ? loaded[lod] : undefined }
}

const DEG = Math.PI / 180

/** Approximate angular half-extent (degrees) of the viewport at a globe zoom. */
function halfSpanDeg(zoom: number): number {
  return Math.min(60, 180 / Math.pow(2, zoom))
}

/** Zoom step of the re-cull key: a cull is reused for any zoom within ±0.125 of its bucket. */
const ZOOM_STEP = 0.25

/** The key's zoom bucket (center) for a camera zoom. */
const quantizeZoom = (zoom: number) => Math.round(zoom / ZOOM_STEP) * ZOOM_STEP

/** Re-cull position quantum (degrees of ground) for a zoom bucket ≈ halfSpan/4. */
const positionQuantum = (zq: number) => Math.max(0.25, halfSpanDeg(zq) / 4)

/**
 * Angular radius (degrees, great-circle) of the spherical cap {@link cullForView} keeps.
 * It is a function of the *key's* zoom bucket, not of the zoom of whichever view happened
 * to trigger the cull, because the cull is then reused for every view sharing that key
 * ({@link cullKeyFor}) — and all of their viewports must lie inside it.
 *
 * The bound: two views on one key have zooms in [zq − 0.125, zq + 0.125), so the widest
 * viewport is halfSpan(zq − 0.125); and their centers are at most D apart, where
 * D = 2·asin(√2·sin(q/2)) ≈ √2·q. (Same lat band: Δφ ≤ q; same lng bucket: Δλ·cos φ ≤ q at
 * the band's equatorward edge, where cos φ is largest. Haversine: hav d = hav Δφ +
 * cosφ₁cosφ₂·hav Δλ ≤ hav q + hav q, using c²·sin²(x/2) ≤ sin²(cx/2) for c ≤ 1. The polar
 * bucket is < q across.) A cap of radius halfSpan(zq − 0.125) + D around any of them
 * therefore covers the viewport of every other. That sum is ≈ 1.44·halfSpan(zq) while the
 * quantum is halfSpan/4, so the established 1.5·halfSpan(zq) margin is kept as the floor;
 * the sum only wins where the 0.25° quantum floor bites (zoom ≳ 9.5).
 *
 * Clamped to 90°: past a hemisphere is the far side of the globe, never on screen. (It
 * only binds at zoom ≲ 1.6, where the half-span is capped at 60°; the mid tier starts at
 * 2.05, where the radius is ≈ 67.5°.)
 */
export function cullRadiusDeg(zoom: number): number {
  const zq = quantizeZoom(zoom)
  const q = positionQuantum(zq)
  const drift = (2 * Math.asin(Math.min(1, Math.SQRT2 * Math.sin((q / 2) * DEG)))) / DEG
  const covering = halfSpanDeg(zq - ZOOM_STEP / 2) + drift
  return Math.min(90, Math.max(1.5 * halfSpanDeg(zq), covering))
}

/** Latitude bins of the per-cull longitude half-width table (see {@link cullForView}). */
const CAP_BINS = 2048

/**
 * In-place iterative quickselect: rearrange `idx` so its first `k` entries are the
 * `k` highest-population cells (unordered within the k). O(n) average vs the
 * O(n log n) full sort it replaces — render order is irrelevant, only the set.
 */
function topKByPopulation(idx: number[], population: ArrayLike<number>, k: number): Uint32Array {
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
 * Cheap memo key for {@link cullForView}: stable while the active tier and the
 * coarsely-quantized camera are unchanged, so the heavy cull only re-runs when the
 * view has moved a meaningful fraction of the viewport — not on every drag tick.
 * The quantum scales with zoom (≈ halfSpan/4): zoomed out, a 1° nudge is nothing
 * and shouldn't re-cull; zoomed in, the same nudge is a big move and should. The
 * cull window ({@link cullRadiusDeg}) is sized from this key's buckets, so it covers
 * the viewport of every view that maps to the key — cells never pop at the edges in the
 * gap between re-culls, whether the camera drifted in position, zoom, or both.
 *
 * The quantum is a *ground* distance: latitude steps by `q` degrees, and longitude by
 * `q / cos(φ)` where φ is the bucket's most equatorward latitude — so a bucket is never
 * wider than `q` on the ground, and the re-cull cadence doesn't thrash as the camera
 * nears a pole. Within `q/2` of a pole the longitude is meaningless and dropped from
 * the key (one polar bucket, ≤ `q` across). The key holds bucket indices, and `q` is
 * derived from the *quantized* zoom, so one key is always one region of the globe.
 */
export function cullKeyFor(data: LodData | undefined, view: GlobeViewState): string {
  if (!data) return 'none'
  if (data.h3.length <= MAX_RENDERED_CELLS) return `${data.lod}:all`
  const zq = quantizeZoom(view.zoom)
  const z = zq.toFixed(2)
  const q = positionQuantum(zq)
  const lat = Math.max(-90, Math.min(90, view.latitude))
  if (90 - Math.abs(lat) < q / 2) return `${data.lod}:pole${lat > 0 ? 'N' : 'S'}:${z}`
  const latIdx = Math.round(lat / q)
  // Most equatorward latitude of this band (≤ 90 − q/2, so its cosine is ≥ sin(q/2) > 0).
  const edge = Math.max(0, Math.abs(latIdx * q) - q / 2)
  const qLng = q / Math.cos(edge * DEG)
  const lng = ((((view.longitude + 180) % 360) + 360) % 360) - 180 // [-180, 180)
  const lngIdx = Math.round(lng / qLng)
  return `${data.lod}:${latIdx}:${lngIdx}:${z}`
}

/**
 * Viewport cull for dense tiers. The coarse overview tier (71k cells) renders whole;
 * finer tiers keep the cells inside a spherical cap — great-circle distance from the view
 * center ≤ {@link cullRadiusDeg} — capped to the highest-population cells. A cap, not a
 * lng/lat degree box: a degree of longitude shrinks by cos(lat), so a box is too narrow on
 * the ground at high latitude and misses the far side of a pole. The cap is exact at the
 * poles and across the antimeridian by construction.
 *
 * Cost (main thread, every re-cull, all 2 M mid cells): no per-cell trig on the hot path.
 * A cell is in the cap iff `cosΔλ·cosφc·cosφ ≥ cos r − sinφc·sinφ`, i.e. iff its longitude
 * offset Δλ ≤ Λ(φ), the cap's half-width at the cell's latitude. The latitude band
 * `|φ − φc| ≤ r` is the first prefilter and Δλ ≤ max Λ (the cap's bounding box) the
 * second; past both, a {@link CAP_BINS}-bin table holds, per latitude bin, a lower and an
 * upper bound of Λ over the bin. Δλ ≤ lower → in, Δλ > upper → out, and only the thin
 * sliver between (cells right at the cap's rim) pays the exact trig test. The table is
 * 2 × 2048 float64 (32 KB) per re-cull; no per-cell columns are added.
 */
export function cullForView(data: LodData | undefined, view: GlobeViewState): CullResult {
  if (!data) return { indices: null, key: 'none' }
  if (data.h3.length <= MAX_RENDERED_CELLS) {
    return { indices: null, key: `${data.lod}:all` }
  }

  const rDeg = cullRadiusDeg(view.zoom)
  const { lng, lat, population } = data
  const cLat = Math.max(-90, Math.min(90, view.latitude))
  const cLng = ((((view.longitude + 180) % 360) + 360) % 360) - 180 // [-180, 180): |Δ| ≤ 360
  const cosR = Math.cos(rDeg * DEG)
  const sinC = Math.sin(cLat * DEG)
  const cosC = Math.cos(cLat * DEG)

  // Cap half-width in longitude (degrees) at latitude φ: 180 when the whole parallel is
  // inside (a pole in the cap), −1 when none of it is. Both cases are decided before the
  // division, so a center on a pole (cosC ≈ 0) or a parallel at a pole (cosφ ≈ 0) can't
  // divide by ~0, and acos only ever sees an argument inside [−1, 1] — no NaN.
  const halfWidth = (phiDeg: number): number => {
    const num = cosR - sinC * Math.sin(phiDeg * DEG)
    const den = cosC * Math.cos(phiDeg * DEG)
    if (num <= -den) return 180
    if (num > den) return -1
    return Math.acos(num / den) / DEG
  }

  const bandLo = Math.max(-90, cLat - rDeg)
  const bandHi = Math.min(90, cLat + rDeg)
  const binW = (bandHi - bandLo) / CAP_BINS
  const invBinW = binW > 0 ? 1 / binW : 0
  // Λ is unimodal in φ (0 at the band edges, peak where the cap's rim runs along a
  // meridian, sinφ* = sinφc / cos r — or monotone up to 180 when the cap holds a pole),
  // so its minimum over a bin is at an endpoint and its maximum at an endpoint or φ*.
  const sPeak = sinC / cosR
  const phiPeak = Math.abs(sPeak) < 1 ? Math.asin(sPeak) / DEG : NaN
  const lower = new Float64Array(CAP_BINS)
  const upper = new Float64Array(CAP_BINS)
  let prev = halfWidth(bandLo)
  let widest = -1 // max Λ over the band: the cap's lng/lat bounding box, a second cheap reject
  for (let k = 0; k < CAP_BINS; k++) {
    const a = bandLo + k * binW
    const b = k === CAP_BINS - 1 ? bandHi : a + binW
    const next = halfWidth(b)
    lower[k] = Math.min(prev, next)
    const hi = Math.max(prev, next)
    upper[k] = phiPeak >= a && phiPeak <= b ? Math.max(hi, halfWidth(phiPeak)) : hi
    if (upper[k] > widest) widest = upper[k]
    prev = next
  }

  const visible: number[] = []
  for (let i = 0; i < lat.length; i++) {
    const phi = lat[i]
    if (phi < bandLo || phi > bandHi) continue
    let d = Math.abs(lng[i] - cLng)
    if (d > 180) d = 360 - d
    if (d > widest) continue
    let k = ((phi - bandLo) * invBinW) | 0
    if (k >= CAP_BINS) k = CAP_BINS - 1
    if (d <= lower[k]) visible.push(i)
    else if (d <= upper[k]) {
      // Exact test for the rim sliver: cosΔλ·cosφc·cosφ ≥ cos r − sinφc·sinφ.
      const p = phi * DEG
      if (Math.cos(d * DEG) * cosC * Math.cos(p) >= cosR - sinC * Math.sin(p)) visible.push(i)
    }
  }

  const indices =
    visible.length > MAX_RENDERED_CELLS
      ? topKByPopulation(visible, population, MAX_RENDERED_CELLS)
      : Uint32Array.from(visible)

  return { indices, key: cullKeyFor(data, view) }
}
