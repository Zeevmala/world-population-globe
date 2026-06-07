/** Maximum extruded column height in meters (tuned for globe legibility). */
export const ELEVATION_MAX_M = 700_000

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
