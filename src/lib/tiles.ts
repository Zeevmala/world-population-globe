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

/** `gridDisk` radius (rings) needed to cover the viewport, clamped to [1, 6]. */
function diskRadius(view: GlobeViewState, parentRes: number): number {
  return Math.min(6, Math.max(1, Math.ceil(halfSpanDeg(view.zoom) / parentEdgeDeg(parentRes))))
}

/**
 * Which parent tiles intersect the current view: the parent cell under the
 * camera center plus a `gridDisk` ring sized so the disk covers the viewport.
 * Kept small (k ≤ 6) — r8 only activates at city zoom, where few parents are visible.
 */
export function visibleParents(view: GlobeViewState, parentRes: number): string[] {
  const center = latLngToCell(view.latitude, view.longitude, parentRes)
  return gridDisk(center, diskRadius(view, parentRes))
}

/**
 * The next ring out from {@link visibleParents} (the gridDisk k+1 shell, minus the
 * visible k-disk). Warmed on idle so a pan reveals already-cached tiles instead of
 * flashing empty — these are exactly the parents about to scroll into view.
 */
export function prefetchParents(view: GlobeViewState, parentRes: number): string[] {
  const center = latLngToCell(view.latitude, view.longitude, parentRes)
  const k = diskRadius(view, parentRes)
  const inner = new Set(gridDisk(center, k))
  return gridDisk(center, k + 1).filter((p) => !inner.has(p))
}
