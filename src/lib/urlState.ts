/** Shareable camera state encoded in the URL hash as `#lng/lat/zoom`. */

export interface UrlView {
  longitude: number
  latitude: number
  zoom: number
}

/** Parse `#lng/lat/zoom` from the URL hash; null if absent or malformed. */
export function parseHash(hash: string = location.hash): UrlView | null {
  const parts = hash.replace(/^#/, '').split('/')
  if (parts.length !== 3) return null
  const [longitude, latitude, zoom] = parts.map(Number)
  if (![longitude, latitude, zoom].every(Number.isFinite)) return null
  if (latitude < -90 || latitude > 90) return null
  return { longitude, latitude, zoom }
}

/** Encode a view as a compact `#lng/lat/zoom` hash (lng/lat 4 dp, zoom 2 dp). */
export function formatHash(v: UrlView): string {
  return `#${v.longitude.toFixed(4)}/${v.latitude.toFixed(4)}/${v.zoom.toFixed(2)}`
}

/** Full shareable URL (origin + path + hash) for a view. */
export function viewUrl(v: UrlView): string {
  return `${location.origin}${location.pathname}${formatHash(v)}`
}
