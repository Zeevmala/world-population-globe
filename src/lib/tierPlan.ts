import type { GlobeViewState, LodEntry, Manifest } from '../types'
import { MAX_ZOOM } from './camera'
import type { Canvas } from './footprint'
import { floorEntry, tierEntry, wantedIndex } from './tierBands'

/**
 * Which whole tiers to fetch and where to fly — the band decisions the eager UI shell
 * makes (`useGlobeData`, `DataStatus`, the store's `flyTo`), on the same per-view
 * thresholds as selection (`tierBands.ts`). Kept apart from `lod.ts` so the entry chunk
 * does not pull in the render path's cull code with them.
 */

/**
 * How far below a whole tier's threshold (zoom levels) its file is requested, so a zoom-in
 * by wheel or pinch has a head start on the download — the camera's destination is not
 * known there. Half a zoom level is one or two wheel notches; the 6 MB r5 usually lands in
 * that time, the 31 MB r6 does not (it takes seconds to fetch and decode), and the tier
 * below keeps drawing until it does. A longer lead would fetch the 31 MB file for views
 * that stop short of its band (a deep link to 4.5 on a small canvas); zoom buttons, keys
 * and searches know where the camera is going and request at the start of the tween.
 */
export const PREFETCH_LEAD = 0.5

/** Destination of a camera flight in progress (the store's `flyTarget`, cleared on landing). */
export type Flight = Pick<GlobeViewState, 'longitude' | 'latitude' | 'zoom'>

/**
 * The view the loader plans for: where a flight in progress will END, else the camera. A
 * flight from the hero to a city tweens through every band in ~1.6 s; planning for the
 * frames it passes through would fetch r5 and the 31 MB r6 to show each for a few frames.
 */
export function planView(view: GlobeViewState, flight: Flight | null | undefined): GlobeViewState {
  return flight ? { longitude: flight.longitude, latitude: flight.latitude, zoom: flight.zoom } : view
}

/**
 * The whole-file tiers the loader should have requested for this view (`planView`),
 * coarsest first — the order to request them in:
 *  - the coarsest tier (the overview), always: it is the floor every fallback ends on;
 *  - every whole tier whose band (for this latitude and canvas) holds the zoom, or starts
 *    within {@link PREFETCH_LEAD} above it;
 *  - when the view wants a whole tier that has not loaded (a cold deep link into r6's
 *    band), the whole tier just below it as an interim: the 6 MB r5 arrives long before
 *    the 31 MB r6 and draws 9 km cells instead of the overview's 22 km meanwhile. It is
 *    requested at the same time, not after — a failed interim must not hold the tier back.
 * Nothing is fetched as a fallback under a tiled tier: its tiles are small and come
 * first, and the overview is under them. So a cold deep link to zoom 9 fetches the
 * overview and tiles only, and a flight to a city fetches what the city needs.
 */
export function wholeTiersFor(
  view: GlobeViewState,
  canvas: Canvas,
  manifest: Manifest | null,
  loaded: Readonly<Record<string, unknown>>,
): LodEntry[] {
  if (!manifest?.lods.length) return []
  const { lods } = manifest
  const want = new Set<number>([0])
  for (let i = 1; i < lods.length; i++) {
    // Thresholds only rise from the 3-px floor: far below it, nothing to measure or fetch.
    if (view.zoom < floorEntry(lods, i, view.latitude) - PREFETCH_LEAD) break
    if (lods[i].tiled) continue
    const to = i + 1 < lods.length ? tierEntry(lods, i + 1, view.latitude, canvas) : Infinity
    if (view.zoom >= tierEntry(lods, i, view.latitude, canvas) - PREFETCH_LEAD && view.zoom < to) want.add(i)
  }
  const w = wantedIndex(view, canvas, lods)
  if (!lods[w].tiled && !loaded[lods[w].lod]) {
    for (let i = w - 1; i > 0; i--) {
      if (!lods[i].tiled) {
        want.add(i)
        break
      }
    }
  }
  return [...want].sort((a, b) => a - b).map((i) => lods[i])
}

/**
 * The whole tier the view (`planView`) wants and does not have yet — what `DataStatus`
 * reports as loading. Always one `wholeTiersFor` requests, so the status never names a tier
 * the loader skipped. Null when the wanted tier is loaded or tiled.
 */
export function pendingWholeTier(
  view: GlobeViewState,
  canvas: Canvas,
  manifest: Manifest | null,
  loaded: Readonly<Record<string, unknown>>,
): LodEntry | null {
  if (!manifest?.lods.length) return null
  const entry = manifest.lods[wantedIndex(view, canvas, manifest.lods)]
  return entry.tiled || loaded[entry.lod] ? null : entry
}

/** The tier a flight's destination wants (`lod.ts` `streamWanted`), or null when nothing is flying. */
export function flightTier(flight: Flight | null | undefined, canvas: Canvas, manifest: Manifest | null): string | null {
  if (!flight || !manifest?.lods.length) return null
  return manifest.lods[wantedIndex(flight, canvas, manifest.lods)].lod
}

/** How far past the finest tier's threshold a place search lands. */
const ARRIVAL_MARGIN = 0.5

/**
 * Default zoom for a fly-to (place search): half a zoom level past the finest tier's
 * threshold for the destination's latitude and this canvas, so the flight ends on 400 m
 * cells rather than on the threshold or its hysteresis band — and on a large canvas, where
 * the threshold is later, still on them. Capped at the deepest zoom (a 3840×2160 canvas at
 * the equator cannot reach r8's threshold and lands on r7 at zoom 10). Before the manifest
 * arrives, the deepest zoom.
 */
export function arrivalZoom(manifest: Manifest | null, latitude = 0, canvas: Canvas = { width: 0, height: 0 }): number {
  if (!manifest?.lods.length) return MAX_ZOOM
  const { lods } = manifest
  const finest = tierEntry(lods, lods.length - 1, latitude, canvas)
  return Math.min(MAX_ZOOM, finest + ARRIVAL_MARGIN)
}
