/** Compact human-readable population count (e.g. 1.2M, 340K, 8.0B). */
export function formatPop(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return `${Math.round(n)}`
}

/** Signed degrees with a compass suffix, e.g. "30.14° N". */
export function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`
}

export function formatLng(lng: number): string {
  return `${Math.abs(lng).toFixed(2)}° ${lng >= 0 ? 'E' : 'W'}`
}
