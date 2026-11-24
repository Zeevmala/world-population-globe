/** Shareable camera state encoded in the URL hash as `#lng/lat/zoom`. */

import { clampZoom, wrapLng } from './camera'

export interface UrlView {
  longitude: number
  latitude: number
  zoom: number
}

/**
 * A plain decimal: optional sign, digits with an optional fraction (or a bare fraction).
 * Stricter than `Number()`, which turns `''` and `' '` into 0 and also accepts `0x10`,
 * `1e3` and `Infinity`. `formatHash` only ever writes `toFixed` output, which always
 * matches. Percent-encoded input (`%20`, `%2D`) is not decoded and so is rejected:
 * a hash we wrote never contains an escape, and a hand-mangled one is not worth guessing at.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

/**
 * Parse `#lng/lat/zoom` from the URL hash; null if absent or malformed.
 *
 * Out-of-range values are handled per field, by whether there is one obvious meaning:
 * - longitude wraps into [−180, 180): 540 and 180 name the same meridian as −180.
 * - zoom clamps to the camera's [MIN_ZOOM, MAX_ZOOM]: `#…/999` plainly means "as close
 *   as you go", and an unclamped seed would render a blank screen.
 * - latitude is rejected: 91° is not a point on the sphere, and neither clamping to the
 *   pole nor reflecting over it is what the sender meant.
 */
export function parseHash(hash: string = location.hash): UrlView | null {
  const parts = hash.replace(/^#/, '').split('/')
  if (parts.length !== 3 || !parts.every((p) => DECIMAL.test(p))) return null
  const [longitude, latitude, zoom] = parts.map(Number)
  // A 309+-digit literal still overflows to Infinity, which would wrap to NaN.
  if (![longitude, latitude, zoom].every(Number.isFinite)) return null
  if (latitude < -90 || latitude > 90) return null
  // `+ 0` folds a written `-0` / `-0.0000` into 0.
  return { longitude: wrapLng(longitude), latitude: latitude + 0, zoom: clampZoom(zoom) + 0 }
}

/** Encode a view as a compact `#lng/lat/zoom` hash (lng/lat 4 dp, zoom 2 dp). */
export function formatHash(v: UrlView): string {
  return `#${v.longitude.toFixed(4)}/${v.latitude.toFixed(4)}/${v.zoom.toFixed(2)}`
}

/** Full shareable URL (origin + path + hash) for a view. */
export function viewUrl(v: UrlView): string {
  return `${location.origin}${location.pathname}${formatHash(v)}`
}
