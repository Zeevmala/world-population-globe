/**
 * Column height scales with the tier's cell footprint (km) so towers stay
 * visually proportionate across zoom levels rather than fixed in absolute meters:
 * r4 (22 km) → ~700 km max columns (the global hero look), r6 (3 km) → ~96 km,
 * r8 (400 m) → ~13 km — readable city towers at deep zoom instead of huge spikes.
 */
export const ELEVATION_PER_KM_M = 32_000

/** Mean Earth radius (meters) for the background sphere mesh. */
export const EARTH_RADIUS_M = 6_371_000

/**
 * Population density is heavily right-skewed (a handful of megacity cells dwarf
 * the rest). A linear ramp would collapse all but the extremes into one bucket,
 * so both color and elevation use a log1p normalization to [0,1].
 */
export function makeLogNorm(maxValue: number): (v: number) => number {
  const denom = Math.log1p(Math.max(0, maxValue))
  if (denom <= 0) return () => 0
  return (v: number) => Math.log1p(Math.max(0, v)) / denom
}
