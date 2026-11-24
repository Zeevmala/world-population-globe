import { cellAreaKm2 } from './density.ts'

/**
 * How big things are on screen on deck.gl's `_GlobeView` — the model the LOD bands are
 * cut from (`pipeline/tiers.py`, which writes them into the manifest) and the yardstick
 * the column-height profile is reported against.
 *
 * GlobeView draws `TILE_SIZE · 2^zoom` px around the equator and, like Web Mercator,
 * scales the view center by 1 / cos(lat), so at the center of the view
 *
 *     px/km = 512 · 2^zoom / (2π · 6371 · cos lat)
 *
 * `bands.test.ts` holds this to `GlobeViewport` within 1 % from zoom 2 to 10.
 * Pure arithmetic over the inlined H3 areas — no h3-js, no deck.gl.
 */

/** deck.gl world size at zoom 0, px around the equator. */
const TILE_SIZE = 512
/** The sphere GlobeView projects onto (km). */
const EARTH_RADIUS_KM = 6371
const DEG = Math.PI / 180

/** CSS px per km at the view center for a camera at `zoom` over latitude `latDeg`. */
export function pxPerKm(zoom: number, latDeg = 0): number {
  return (TILE_SIZE * Math.pow(2, zoom)) / (2 * Math.PI * EARTH_RADIUS_KM * Math.cos(latDeg * DEG))
}

/** Mean width across flats (km) of an H3 hexagon at `h3Res`: √(2A/√3) for mean area A. */
export function hexWidthKm(h3Res: number): number {
  return Math.sqrt((2 * cellAreaKm2(h3Res)) / Math.sqrt(3))
}

/** The zoom at which an `h3Res` hexagon is `px` CSS px across at latitude `latDeg`. */
export function zoomForHexPx(h3Res: number, px: number, latDeg = 0): number {
  return Math.log2(px / (hexWidthKm(h3Res) * pxPerKm(0, latDeg)))
}
