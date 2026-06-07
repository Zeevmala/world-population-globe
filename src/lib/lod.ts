import type { GlobeViewState, LodData, Manifest } from '../types'

/** Hard cap on rendered cells per frame for the dense tier (perf guard). */
const MAX_RENDERED_CELLS = 120_000

/**
 * Choose the active LOD name for the current zoom: the finest tier whose
 * `minZoom` is satisfied AND whose data is already loaded, else the coarsest.
 */
export function pickLod(
  zoom: number,
  manifest: Manifest | null,
  loaded: Record<string, LodData>,
): string | null {
  if (!manifest) return null
  let chosen: string | null = null
  for (const entry of manifest.lods) {
    if (zoom >= entry.minZoom && loaded[entry.lod]) chosen = entry.lod
  }
  return chosen ?? manifest.lods.find((l) => loaded[l.lod])?.lod ?? null
}

/** Smallest angular difference between two longitudes, handling the ±180 seam. */
function lngDelta(a: number, b: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, 360 - d)
}

export interface CullResult {
  /** Source indices to render, or `null` to render the whole tier. */
  indices: Uint32Array | null
  /** Memo key — recompute only when this changes. */
  key: string
}

/**
 * Cheap memo key for {@link cullForView}: stable while the active tier and the
 * coarsely-rounded camera are unchanged, so the heavy cull only re-runs when the
 * view has moved a meaningful amount (not on every drag tick).
 */
export function cullKeyFor(data: LodData | undefined, view: GlobeViewState): string {
  if (!data) return 'none'
  if (data.h3.length <= MAX_RENDERED_CELLS) return `${data.lod}:all`
  return `${data.lod}:${Math.round(view.longitude)}:${Math.round(view.latitude)}:${view.zoom.toFixed(1)}`
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

  const halfSpan = Math.min(60, 180 / Math.pow(2, view.zoom))
  const { lng, lat, population } = data
  const cLng = view.longitude
  const cLat = view.latitude

  const visible: number[] = []
  for (let i = 0; i < lng.length; i++) {
    if (Math.abs(lat[i] - cLat) <= halfSpan && lngDelta(lng[i], cLng) <= halfSpan) {
      visible.push(i)
    }
  }
  if (visible.length > MAX_RENDERED_CELLS) {
    visible.sort((a, b) => population[b] - population[a])
    visible.length = MAX_RENDERED_CELLS
  }

  const key = `${data.lod}:${Math.round(cLng)}:${Math.round(cLat)}:${view.zoom.toFixed(1)}`
  return { indices: Uint32Array.from(visible), key }
}
