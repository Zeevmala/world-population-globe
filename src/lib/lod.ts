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

/** Smallest angular difference between two longitudes, handling the ±180 seam. */
function lngDelta(a: number, b: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, 360 - d)
}

/** Approximate angular half-extent (degrees) of the viewport at a globe zoom. */
function halfSpanDeg(zoom: number): number {
  return Math.min(60, 180 / Math.pow(2, zoom))
}

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
 * cull window ({@link cullForView}) carries a wider margin than this quantum, so
 * cells never pop at the edges in the gap between re-culls.
 */
export function cullKeyFor(data: LodData | undefined, view: GlobeViewState): string {
  if (!data) return 'none'
  if (data.h3.length <= MAX_RENDERED_CELLS) return `${data.lod}:all`
  const q = Math.max(0.25, halfSpanDeg(view.zoom) / 4)
  const lng = Math.round(view.longitude / q) * q
  const lat = Math.round(view.latitude / q) * q
  const z = Math.round(view.zoom / 0.25) * 0.25
  return `${data.lod}:${lng.toFixed(2)}:${lat.toFixed(2)}:${z.toFixed(2)}`
}

/**
 * Frustum-approximate viewport cull for dense tiers. The coarse overview tier
 * (71k cells) renders whole; finer tiers are clipped to a zoom-scaled lng/lat
 * window and capped to the highest-population cells. (Proper H3 tiling is the
 * Sprint 2 replacement for this approximation.)
 */
export function cullForView(data: LodData | undefined, view: GlobeViewState): CullResult {
  if (!data) return { indices: null, key: 'none' }
  if (data.h3.length <= MAX_RENDERED_CELLS) {
    return { indices: null, key: `${data.lod}:all` }
  }

  // Scan a window 1.5× the visible half-span: wider than the re-cull quantum
  // (halfSpan/4), so the rendered set still covers the viewport after the camera
  // drifts up to one quantum between re-culls — no empty edges mid-drag.
  const win = Math.min(90, 1.5 * halfSpanDeg(view.zoom))
  const { lng, lat, population } = data
  const cLng = view.longitude
  const cLat = view.latitude

  const visible: number[] = []
  for (let i = 0; i < lng.length; i++) {
    if (Math.abs(lat[i] - cLat) <= win && lngDelta(lng[i], cLng) <= win) {
      visible.push(i)
    }
  }

  const indices =
    visible.length > MAX_RENDERED_CELLS
      ? topKByPopulation(visible, population, MAX_RENDERED_CELLS)
      : Uint32Array.from(visible)

  return { indices, key: cullKeyFor(data, view) }
}
