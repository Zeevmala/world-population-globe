import type { GlobeViewState, LodEntry, Manifest } from '../types'
// `.ts` extensions: `scripts/` import this module under Node's native type stripping.
import { cellAreaKm2 } from './density.ts'
import { keyCanvas } from './footprint.ts'
import type { Canvas } from './footprint.ts'
import { fitThreshold } from './tierFit.ts'

/**
 * Which tier a view wants. The one rule every band consumer reads: selection (`lod.ts`),
 * the whole-tier loader and the search's arrival zoom (`tierPlan.ts`), the tile streams,
 * the zoom ladder, `DataStatus`, the render harness and the cull bench.
 *
 * The manifest's bands are the NOMINAL thresholds: a tier starts where its hexagon is
 * {@link BAND_PX} CSS px across flats at the equator (`pipeline/tiers.py`). For a view, a
 * tier starts at the LATER of
 *  1. its nominal threshold moved by log2(cos φ) — GlobeView zooms the whole globe in by
 *     1 / cos(latitude of the view center), so the 3-px rule stays the floor of every
 *     threshold at every latitude; and
 *  2. the zoom from which its cull window cannot hold more than {@link CAP} cells, even held
 *     {@link TIER_HYSTERESIS} below the threshold with the worst zoom-bucket and Mercator-row
 *     alignment — judged from the ground the window covers ÷ the smallest H3 cell area
 *     (`tierFit.ts`). This replaces a calibrated on-screen budget: the window fits the cap
 *     by construction, whatever the data and wherever the view.
 * The latitude φ is the camera's, clamped at 85.05° like GlobeViewport's. The coarsest tier
 * (r4) has no threshold: it is the floor. Both parts rise with the resolution, so the
 * thresholds keep their order on any canvas at any latitude (`tierBands.test.ts`).
 */

/** What selection reads of a view: the zoom, and the latitude its scale depends on. */
export type ViewAt = Pick<GlobeViewState, 'latitude' | 'zoom'>

/** The nominal band rule's cell width, CSS px across flats (`pipeline/tiers.py` `BAND_PX`). */
export const BAND_PX = 3

/** Cells a culled tier may draw per frame (`lod.ts` MAX_RENDERED_CELLS): what a window must fit. */
export const CAP = 120_000

/** GlobeViewport's camera latitude clamp (`footprint.ts` `MAX_LATITUDE`; `tierBands.test.ts` pins it). */
const MAX_LATITUDE = 85.051129

/**
 * Zoom slack a tier keeps once it is on screen. Without it, a camera resting on a
 * threshold flips tiers on every sub-pixel jitter, and each flip rebuilds and re-uploads
 * the whole layer. A tier now has to be left by this much before it yields — in zoom, or
 * the equivalent change of latitude or canvas size: the threshold moves continuously with
 * latitude and by < 0.03 zoom per 16 px canvas step, so a view parked on it moves the
 * quantity `zoom − threshold` by its jitter and never by 0.15. The window rule (2. above)
 * is evaluated at the bottom of this band, so a held tier fits the cap too.
 */
export const TIER_HYSTERESIS = 0.15

/** How far latitude moves every threshold (zoom levels): log2(cos φ), φ clamped like the camera. */
export function latitudeShift(latitude: number): number {
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, Number.isFinite(latitude) ? latitude : 0))
  return Math.log2(Math.cos((lat * Math.PI) / 180))
}

const cache = new WeakMap<readonly LodEntry[], Map<string, number[]>>()

/** Latitude bands the window rule is cached per: 1° of |latitude| (the hemispheres mirror). */
const bandOf = (latitude: number) => Math.min(85, Math.floor(Math.abs(Number.isFinite(latitude) ? latitude : 0)))

/**
 * Every tier's threshold for this canvas and latitude band, less the band's latitude shift
 * (index 0, the floor, is −∞), so a view at latitude ψ in the band starts tier i at
 * `t[i] + latitudeShift(ψ)`. Each is the later of the nominal band and the window fit
 * (`tierFit.ts`), the fit taken at the band's POLEWARD edge — the window at a given
 * effective scale only grows toward the pole, so every latitude in the band fits too
 * (`tierFit.test.ts` sweeps it). Cached per tier table, key canvas (16 px) and 1° band:
 * ~12 ms the first time a band is seen on a canvas (measured in Node), a map lookup after.
 */
export function bandThresholds(lods: readonly LodEntry[], canvas: Canvas, latitude: number): number[] {
  const k = keyCanvas(canvas)
  const band = bandOf(latitude)
  const key = `${k.width}x${k.height}:${band}`
  let byKey = cache.get(lods)
  if (!byKey) cache.set(lods, (byKey = new Map()))
  let t = byKey.get(key)
  if (!t) {
    const edge = Math.min(band + 1, MAX_LATITUDE)
    const s = latitudeShift(edge)
    t = lods.map((l, i) =>
      i === 0 ? -Infinity : fitThreshold(l.minZoom + s, edge, cellAreaKm2(l.h3Res), CAP, TIER_HYSTERESIS, k) - s,
    )
    byKey.set(key, t)
  }
  return t
}

/**
 * The earliest tier `i` can start at this latitude on any canvas: its nominal band moved by
 * latitude (the 3-px floor of {@link tierEntry}). Below it no window needs measuring — the
 * cheap test that keeps a pan at the hero zoom from filling the cache.
 */
export function floorEntry(lods: readonly LodEntry[], i: number, latitude: number): number {
  return i === 0 ? -Infinity : lods[i].minZoom + latitudeShift(latitude)
}

/**
 * Fill one missing 1° band of this canvas's threshold cache, nearest `latitude` first; false
 * once all 86 are there. Called from idle time (`useGlobeData`), so panning across latitudes
 * rarely meets an empty band (~12 ms each to fill on the spot).
 */
export function warmOneBand(lods: readonly LodEntry[], canvas: Canvas, latitude: number): boolean {
  const k = keyCanvas(canvas)
  const byKey = cache.get(lods)
  const b0 = bandOf(latitude)
  for (let d = 0; d <= 85; d++) {
    for (const b of d === 0 ? [b0] : [b0 - d, b0 + d]) {
      if (b < 0 || b > 85 || byKey?.has(`${k.width}x${k.height}:${b}`)) continue
      bandThresholds(lods, canvas, b + 0.5)
      return true
    }
  }
  return false
}

/** The zoom at which tier `i` starts for this latitude and canvas (−∞ for the floor). */
export function tierEntry(lods: readonly LodEntry[], i: number, latitude: number, canvas: Canvas): number {
  return bandThresholds(lods, canvas, latitude)[i] + latitudeShift(latitude)
}

/**
 * Index of the tier this view wants: the finest whose threshold the zoom has reached —
 * lowered by {@link TIER_HYSTERESIS} for the tier on screen (`activeLod`).
 */
export function wantedIndex(view: ViewAt, canvas: Canvas, lods: readonly LodEntry[], activeLod?: string | null): number {
  // Below the first tier's 3-px floor (less any hysteresis) nothing finer can be wanted.
  if (lods.length < 2 || view.zoom < floorEntry(lods, 1, view.latitude) - TIER_HYSTERESIS) return 0
  const t = bandThresholds(lods, canvas, view.latitude)
  const lat = latitudeShift(view.latitude)
  let chosen = 0
  for (let i = 1; i < lods.length; i++) {
    const slack = lods[i].lod === activeLod ? TIER_HYSTERESIS : 0
    if (view.zoom >= t[i] + lat - slack) chosen = i
  }
  return chosen
}

/** The tier this view wants (no hysteresis): see {@link wantedIndex}. */
export function wantedTier(view: ViewAt, canvas: Canvas, manifest: Manifest | null): LodEntry | null {
  if (!manifest?.lods.length) return null
  return manifest.lods[wantedIndex(view, canvas, manifest.lods)]
}

/** A tier's band for this latitude and canvas: [from, to) in zoom (−∞ / +∞ at the ends). */
export interface EffectiveBand {
  lod: string
  approxKm: number
  from: number
  to: number
}

/** Every tier's band for this latitude and canvas — what the zoom ladder draws. */
export function effectiveBands(lods: readonly LodEntry[], latitude: number, canvas: Canvas): EffectiveBand[] {
  const t = bandThresholds(lods, canvas, latitude)
  const lat = latitudeShift(latitude)
  return lods.map((l, i) => ({
    lod: l.lod,
    approxKm: l.approxKm,
    from: t[i] + lat,
    to: i + 1 < lods.length ? t[i + 1] + lat : Infinity,
  }))
}
