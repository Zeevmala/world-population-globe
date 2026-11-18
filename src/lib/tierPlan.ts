import type { LodEntry, Manifest } from '../types'
import { MAX_ZOOM } from './camera'

/**
 * Which tier to fetch and where to fly — the two band decisions the eager UI shell
 * makes (`useGlobeData`, `DataStatus`, the store's `flyTo`). Kept apart from `lod.ts`
 * so the entry chunk does not pull in the render path's cull code with them.
 */

/**
 * The whole-file tier the loader should have in memory at this zoom: the finest
 * non-tiled tier whose band is reached (the coarsest tier below every band). Only that
 * one is fetched — not every whole tier whose `minZoom` lies below the camera — so a
 * cold deep link to street zoom pulls the overview (always loaded first) plus the
 * finest whole tier as the fallback under the streamed r8 tiles, and skips the tiers
 * in between. Zooming through a band still loads its tier on the way, as before.
 */
export function wholeTierFor(zoom: number, manifest: Manifest | null): LodEntry | null {
  if (!manifest) return null
  let chosen: LodEntry | null = null
  for (const entry of manifest.lods) {
    if (entry.tiled) continue
    if (!chosen || zoom >= entry.minZoom) chosen = entry
  }
  return chosen
}

/** How far past the finest tier's entry zoom a place search lands. */
const ARRIVAL_MARGIN = 0.5

/**
 * Default zoom for a fly-to (place search): half a zoom level inside the finest tier's
 * band, so the flight ends on 400 m cells rather than on the threshold or its
 * hysteresis band. Read from the manifest — the bands live in the pipeline's tier
 * table, not here. Before the manifest arrives, the deepest zoom.
 */
export function arrivalZoom(manifest: Manifest | null): number {
  const finest = manifest?.lods[manifest.lods.length - 1]
  return finest ? Math.min(MAX_ZOOM, finest.minZoom + ARRIVAL_MARGIN) : MAX_ZOOM
}

