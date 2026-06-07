import { gridDisk, latLngToCell } from 'h3-js'
import type { GlobeViewState } from '../types'

/** Approximate angular half-extent (degrees) of the viewport at a globe zoom. */
export function halfSpanDeg(zoom: number): number {
  return Math.min(80, 180 / Math.pow(2, zoom))
}

/** Coarse, stable view signature — recompute streaming only when this changes. */
export function viewKey(view: GlobeViewState): string {
  return `${Math.round(view.longitude)}:${Math.round(view.latitude)}:${view.zoom.toFixed(1)}`
}

/** Nominal H3 cell edge length in degrees latitude, by resolution (rough). */
function parentEdgeDeg(res: number): number {
  const byRes: Record<number, number> = { 0: 60, 1: 23, 2: 9, 3: 3.4, 4: 1.3, 5: 0.5 }
  return byRes[res] ?? 9
}

/**
 * Which parent tiles intersect the current view: the parent cell under the
 * camera center plus a `gridDisk` ring sized so the disk covers the viewport.
 * Kept small (k ≤ 6) — r8 only activates at city zoom, where few parents are visible.
 */
export function visibleParents(view: GlobeViewState, parentRes: number): string[] {
  const center = latLngToCell(view.latitude, view.longitude, parentRes)
  const k = Math.min(6, Math.max(1, Math.ceil(halfSpanDeg(view.zoom) / parentEdgeDeg(parentRes))))
  return gridDisk(center, k)
}
