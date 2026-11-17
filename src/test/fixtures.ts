import { h3Column } from '../data/h3Column'
import type { LodData, Manifest } from '../types'

/**
 * The shipped manifest's tier table (`public/data/manifest.json`), inlined so the unit
 * tests need neither a DOM nor `fs`. If the pipeline is re-run and these numbers move,
 * update them here — `npm run verify:data` is the gate on the real files, these tests
 * are the gate on the math applied to them.
 */
export const MANIFEST: Manifest = {
  source: 'Kontur Population',
  dataDate: '2023-11-01',
  license: 'CC-BY 4.0',
  attribution: '© Kontur (kontur.io), CC-BY 4.0',
  crs: 'EPSG:4326',
  generatedAt: '2026-06-07T17:38:35Z',
  lods: [
    {
      lod: 'overview',
      file: 'data/overview.parquet',
      h3Res: 4,
      approxKm: 22,
      minZoom: -2,
      maxZoom: 2.2,
      cellCount: 71283,
      maxPopulation: 22732636,
      sumPopulation: 8031924025,
    },
    {
      lod: 'mid',
      file: 'data/mid.parquet',
      h3Res: 6,
      approxKm: 3,
      minZoom: 2.2,
      maxZoom: 4.5,
      cellCount: 2016971,
      maxPopulation: 1949226,
      sumPopulation: 8031924024,
    },
    {
      lod: 'r8',
      tiled: true,
      tileParentRes: 3,
      indexFile: 'data/tiles/r8/index.json',
      h3Res: 8,
      approxKm: 0.4,
      minZoom: 4.5,
      maxZoom: 24,
      cellCount: 32957699,
      maxPopulation: 40673,
      sumPopulation: 8031924024,
    },
  ],
}

/**
 * Build a synthetic columnar tier of `n` cells. `fill(i)` returns `[lng, lat, population]`.
 * The H3 column is a zeroed placeholder: LOD selection and the cull read only
 * lng/lat/population, so tests that exercise them never need real indices.
 */
export function makeLod(
  lod: string,
  h3Res: number,
  n: number,
  fill: (i: number) => [number, number, number],
): LodData {
  const lng = new Float32Array(n)
  const lat = new Float32Array(n)
  const population = new Float32Array(n)
  let maxPopulation = 0
  for (let i = 0; i < n; i++) {
    const [x, y, p] = fill(i)
    lng[i] = x
    lat[i] = y
    population[i] = p
    if (p > maxPopulation) maxPopulation = p
  }
  return {
    lod,
    h3Res,
    approxKm: 0,
    h3: h3Column(new BigUint64Array(n)),
    population,
    lng,
    lat,
    maxPopulation,
  }
}

/** Deterministic PRNG (mulberry32) — tests must not depend on `Math.random`. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
