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
 * the zoom-1.3 hero (~800 km columns, the global look) and city zoom ≈5.5
 * (~13 km columns, readable towers over 400 m cells). The cap above takes over
 * below zoom ≈1.3, so zooming out can't grow columns past the hero proportions.
 */
const HEIGHT_AT_Z0_M = 2_900_000
const HEIGHT_ZOOM_DECAY = 1.425

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
  return Math.min(MAX_COLUMN_HEIGHT_M, HEIGHT_AT_Z0_M * Math.pow(2, -HEIGHT_ZOOM_DECAY * zoom))
}
