import type { LodData, LodEntry, Manifest } from '../types'
import { readColumns } from './parquet'

/** Vite base path ('/' in dev, '/world-population-globe/' in prod). */
export const BASE = import.meta.env.BASE_URL

function toF32(col: ArrayLike<unknown>): Float32Array {
  return col instanceof Float32Array ? col : Float32Array.from(col as ArrayLike<number>)
}

/** Fetch and parse the data manifest. */
export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${BASE}data/manifest.json`)
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`)
  return (await res.json()) as Manifest
}

/** Load one whole (non-tiled) LOD tier into columnar typed arrays. */
export async function loadLod(entry: LodEntry): Promise<LodData> {
  if (!entry.file) throw new Error(`LOD "${entry.lod}" has no file (tiled tiers must stream)`)
  const cols = await readColumns(`${BASE}${entry.file}`, ['h3', 'population', 'lng', 'lat'])
  return {
    lod: entry.lod,
    h3Res: entry.h3Res,
    approxKm: entry.approxKm,
    h3: Array.from(cols.h3 as ArrayLike<string>),
    population: toF32(cols.population),
    lng: toF32(cols.lng),
    lat: toF32(cols.lat),
    maxPopulation: entry.maxPopulation,
  }
}
