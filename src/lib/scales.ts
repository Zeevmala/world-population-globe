/** Mean Earth radius (meters) for the background sphere mesh. */
export const EARTH_RADIUS_M = 6_371_000

/**
 * Tallest column (meters) at the top of the density domain, capped for the hero view.
 * ~12.5% of Earth's radius — enough relief to read as 3D from orbit without turning
 * the planet into a sea urchin.
 */
const MAX_COLUMN_HEIGHT_M = 800_000

/**
 * Height profile constants: a full-domain column is `HEIGHT_AT_Z0_M · 2^(-DECAY·zoom)`
 * meters tall. Calibrated against the two views the project actually ships:
 * the zoom-1.3 hero (~800 km columns, the global look) and zoom ≈5.5
 * (~13 km columns — calibrated when that zoom drew 400 m cells; since the re-band it
 * draws 3 km r6 cells, and r8 starts near zoom 8). The cap above takes over
 * below zoom ≈1.3, so zooming out can't grow columns past the hero proportions.
 */
const HEIGHT_AT_Z0_M = 2_900_000
const HEIGHT_ZOOM_DECAY = 1.425

/**
 * Floor of the profile: a full-domain column is never shorter than 1 km. The decay
 * above shrinks a column's on-screen height by 2^-0.425 per zoom level, which is the
 * right look from orbit but makes the deep zooms flat: at zoom 10 it would leave a
 * 149 m column (≈ 2 px) over a 400 m cell that is ≈ 12 px wide. The decay reaches 1 km
 * at zoom ≈ 8.07 — just past where r8 switches on — and from there the height stays
 * put in metres, so zooming in magnifies a fixed scene: an r8 column keeps about the
 * aspect of its cell (1 km tall over a 0.92 km-wide hexagon) all the way to zoom 10.
 * `max` of two continuous functions is continuous, so no step is introduced.
 */
const MIN_COLUMN_HEIGHT_M = 1_000

/**
 * Height (meters) of a column at the top of the density domain, for this zoom.
 *
 * Height used to be a per-tier constant (`approxKm × 32,000`), which meant crossing a
 * LOD threshold collapsed every column ~7× in a single frame — the most visible seam
 * in the whole render. Making height a continuous function of *zoom* instead of a step
 * function of *tier* removes the seam entirely: both tiers agree on the height at the
 * crossing point, so the switch changes only the resolution of the mesh, never its
 * scale. Applied as deck.gl's `elevationScale` uniform (with `getElevation` returning
 * the normalized 0–1 density), so a zoom change costs one uniform write — no attribute
 * re-upload, no re-cull.
 */
export function maxColumnHeightM(zoom: number): number {
  const decayed = HEIGHT_AT_Z0_M * Math.pow(2, -HEIGHT_ZOOM_DECAY * zoom)
  return Math.min(MAX_COLUMN_HEIGHT_M, Math.max(MIN_COLUMN_HEIGHT_M, decayed))
}
