import type { Manifest } from '../types'

/**
 * Average area (km²) of an H3 *hexagon* at each resolution — a fixed property of
 * the H3 grid, not of our data. Generated from `h3-js` `getHexagonAreaAvg(r, 'km2')`
 * and inlined so the eager UI shell (Legend) can reason about density without
 * pulling h3-js into the entry chunk; h3-js stays in the lazy globe chunk.
 */
const HEX_AREA_KM2 = [
  4357449.416078383, // r0
  609788.4417941332, // r1
  86801.7803989972, // r2
  12393.43465508816, // r3
  1770.347654491307, // r4
  252.9038581819449, // r5
  36.12906216441245, // r6
  5.161293359717191, // r7
  0.7373275975944177, // r8
  0.1053325134272067, // r9
  0.01504750190766435, // r10
  0.002149643129451879, // r11
  0.000307091875631606, // r12
  0.00004387026794728296, // r13
  0.000006267181135324313, // r14
  8.95311590760579e-7, // r15
] as const

/**
 * Nominal cell area (km²) for an H3 resolution.
 *
 * Real cells vary around this average (roughly ±25% with latitude and position in
 * the icosahedron face), so this is an approximation — but a *uniform* one within a
 * tier. On the log ramp a 25% area error moves a cell under 1% of the ramp's length,
 * while an exact per-cell `cellArea()` costs ~3.6 µs/cell (≈7 s for the 2 M-cell mid
 * tier), which no frame or worker budget can absorb. Nominal area it is, and the UI
 * says "≈" wherever it surfaces a number derived from it.
 */
export function cellAreaKm2(h3Res: number): number {
  return HEX_AREA_KM2[Math.max(0, Math.min(15, Math.round(h3Res)))]
}

/** People per km² for a cell holding `population` at resolution `h3Res`. */
export function densityOf(population: number, h3Res: number): number {
  return population / cellAreaKm2(h3Res)
}

/**
 * Top of the shared color/height domain, in people/km².
 *
 * This is the crux of cross-tier continuity. Each tier's cells hold wildly different
 * populations *because they cover different areas* (an r4 cell is 2,400× an r8 cell),
 * so normalizing population against a per-tier maximum made the same place render a
 * different color and a 7× different height on either side of a zoom threshold, and
 * made the legend's "density" claim untrue. Density is the quantity that is actually
 * comparable across resolutions, so every tier is normalized against one domain: the
 * densest cell published by any tier (the r8 max — the finest tier resolves the
 * sharpest peaks). Derived from the manifest, so a pipeline re-run updates it.
 */
export function densityDomainMax(manifest: Manifest | null): number {
  if (!manifest) return 0
  let max = 0
  for (const lod of manifest.lods) {
    const d = densityOf(lod.maxPopulation, lod.h3Res)
    if (d > max) max = d
  }
  return max
}

/**
 * Map density → [0,1] for both color and column height.
 *
 * Population density is heavily right-skewed — a handful of megacity cells dwarf
 * everything else — so a linear ramp would collapse all but the extremes into one
 * bucket. `log1p` keeps the rural-to-urban range legible. (Project invariant: log1p
 * → Inferno for both height and color.)
 */
export function makeDensityNorm(domainMax: number): (density: number) => number {
  const denom = Math.log1p(Math.max(0, domainMax))
  if (denom <= 0) return () => 0
  return (d: number) => Math.min(1, Math.log1p(Math.max(0, d)) / denom)
}

/** Inverse of {@link makeDensityNorm} — the density a ramp position stands for. */
export function densityAt(norm: number, domainMax: number): number {
  return Math.expm1(norm * Math.log1p(Math.max(0, domainMax)))
}

/** Compact people/km² label for legend ticks and readouts (250, 1.2k, 55k). */
export function formatDensity(d: number): string {
  if (!isFinite(d) || d <= 0) return '0'
  if (d >= 1000) {
    const k = d / 1000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
  }
  if (d >= 10) return String(Math.round(d))
  if (d >= 1) return d.toFixed(1)
  return d.toFixed(2)
}
