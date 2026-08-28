import type { LodData, LodEntry, Manifest } from '../types'
import { decodeTable } from './decodeClient'

/** Vite base path ('/' in dev, '/world-population-globe/' in prod). */
export const BASE = import.meta.env.BASE_URL

/** Fetch and parse the data manifest. */
export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${BASE}data/manifest.json`)
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`)
  return (await res.json()) as Manifest
}

/**
 * Load one whole (non-tiled) LOD tier into columnar typed arrays. The fetch and the
 * decode both run in a worker (see `decodeClient`), so entering the `mid` band no
 * longer freezes the camera for the duration of a 2 M-row parse.
 */
export async function loadLod(entry: LodEntry): Promise<LodData> {
  if (!entry.file) throw new Error(`LOD "${entry.lod}" has no file (tiled tiers must stream)`)
  const cols = await decodeTable(`${BASE}${entry.file}`)
  return {
    lod: entry.lod,
    h3Res: entry.h3Res,
    approxKm: entry.approxKm,
    ...cols,
    maxPopulation: entry.maxPopulation,
  }
}
