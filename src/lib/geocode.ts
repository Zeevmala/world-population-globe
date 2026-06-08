/**
 * Minimal forward-geocoder over OSM Nominatim — no API key (matches the app's
 * "no secrets" constraint). The browser sends a `Referer`, which satisfies
 * Nominatim's usage policy for client apps; callers must debounce (≤ 1 req/s).
 */
export interface GeoResult {
  /** Full display name from Nominatim (e.g. "Cairo, Cairo Governorate, Egypt"). */
  name: string
  lat: number
  lng: number
}

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'

interface NominatimRow {
  display_name: string
  lat: string
  lon: string
}

/** Geocode a free-text query to up to 5 places. Returns [] for trivial input. */
export async function geocode(query: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&format=json&addressdetails=0&limit=5&accept-language=en`
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`geocode failed: HTTP ${res.status}`)
  const rows = (await res.json()) as NominatimRow[]
  return rows.map((r) => ({ name: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }))
}
