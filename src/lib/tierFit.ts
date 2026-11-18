// `.ts` extensions: `scripts/` import this module under Node's native type stripping.
import { ZOOM_STEP, cullWindow, keyCanvas } from './footprint.ts'
import type { Canvas, CullWindow } from './footprint.ts'

/**
 * When does a tier's cull window fit the 120 k cap — by construction, from the GROUND the
 * window covers, not from a flat `W·H ÷ cell px²` estimate (`tierBands.ts` uses this as one
 * of the two parts of a threshold; the other is the 3-px rule).
 *
 * A window (`footprint.ts` `cullWindow`: the canvas rectangle grown by the re-cull drift
 * margin, cut at the horizon) can hold at most (its ground area) ÷ (the smallest cell area
 * there) cells, populated or not. Where the limb is far out of view the area is about the
 * canvas's px area over px/km² times the margin's ~1.6×, so this is a flat budget; where
 * the limb is near (r5's threshold on a desktop canvas) foreshortening puts far more ground
 * in the window and the bound delays the tier by exactly what the geometry requires.
 *
 * The bound is evaluated at the view's latitude, for the widest window a view there can be
 * served ({@link worstWindowAreaKm2}). Not at the equator moved by log2(cos φ): GlobeView's
 * camera at φ is the equator's at zoom z − log2(cos φ), but a re-cull bucket spans a
 * Mercator row whose members each zoom by their OWN 1 / cos — so off the equator the window
 * holds 5 % (35° N) to 35 % (60° N) and up to 2.7× (85° N) more ground than the congruent
 * equator window. `tierBands.ts` caches one search per canvas key and 1° latitude band.
 */

/** Earth radius of the sphere GlobeView projects onto (km). */
const R_KM = 6371

/**
 * Rings (equal-area in cos θ) × azimuths of the fixed grid {@link windowAreaKm2} samples:
 * 32,768 point tests, ~0.2 ms. Its error against a 16× finer grid is under 0.5 % on every
 * window the tests sweep (`tierFit.test.ts`); {@link AREA_SLACK} covers it.
 */
const RINGS = 128
const AZIMUTHS = 256

/**
 * The smallest H3 hexagon's area over the resolution's mean: 0.606 at r5–r8 (measured with
 * h3-js over every hexagon within 40 rings of a pentagon, where the icosahedron's vertices
 * squeeze cells; one such vertex sits on populated land at Dalian). A window anywhere can
 * hold at most area ÷ (0.6 × mean) cells. The 12 pentagons (0.505) are single cells.
 */
export const CELL_AREA_FLOOR = 0.6

/**
 * Slack on the measured area: the sampling error (< 0.5 %) plus the cells whose centre is
 * inside a window whose boundary cuts them — a band one cell wide around a window ~200
 * cells across (a window at a binding threshold holds ~120 k cells) is ~2 % of its area.
 */
export const AREA_SLACK = 1.03

/**
 * Ground area (km²) inside a cull window: the share of its cap that passes the chart
 * rectangle, on a fixed equal-area grid over the cap (rings uniform in cos θ, so every
 * sample stands for the same area). For u = d·c0 + s·(cos a·e0 + sin a·n0), the chart
 * coordinates are (s·cos a, s·sin a) / (kc − d), so the loop has no trig.
 */
export function windowAreaKm2(w: CullWindow, rings = RINGS, azimuths = AZIMUTHS): number {
  const capArea = 2 * Math.PI * R_KM * R_KM * (1 - w.cosCap)
  if (!w.rect) return capArea
  const cosA = new Float64Array(azimuths)
  const sinA = new Float64Array(azimuths)
  for (let j = 0; j < azimuths; j++) {
    cosA[j] = Math.cos(((j + 0.5) * 2 * Math.PI) / azimuths)
    sinA[j] = Math.sin(((j + 0.5) * 2 * Math.PI) / azimuths)
  }
  let inside = 0
  for (let i = 0; i < rings; i++) {
    const d = 1 - ((i + 0.5) / rings) * (1 - w.cosCap)
    const s = Math.sqrt(Math.max(0, 1 - d * d))
    const depth = w.kc - d
    const xLo = w.xMin * depth
    const xHi = w.xMax * depth
    const yLo = w.yMin * depth
    const yHi = w.yMax * depth
    for (let j = 0; j < azimuths; j++) {
      const x = s * cosA[j]
      const y = s * sinA[j]
      if (x >= xLo && x <= xHi && y >= yLo && y <= yHi) inside++
    }
  }
  return (capArea * inside) / (rings * azimuths)
}

const DEG = Math.PI / 180
/** Web Mercator y of a latitude (clamped like the camera), as the re-cull key buckets it (`footprint.ts`). */
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * DEG) / 2))
const MAX_LATITUDE = 85.051129

/**
 * The widest cull window a view at zoom `z` and latitude `latitude` (≥ 0; the hemispheres are
 * mirror images) can be served on `canvas`, in ground km²:
 *  - its zoom bucket starts a whole ZOOM_STEP below `z` (a view's bucket starts at most that
 *    far below it, and a lower start only widens the window);
 *  - its Mercator row lies wholly equatorward of the view (the view on the row's poleward
 *    edge): GlobeView zooms each view in by 1 / cos(its own latitude), so the row's
 *    equatorward members are the most zoomed-out and their footprints the widest — at 60° N
 *    and zoom ~4 this is 20–35 % more ground than the equator's window at the same scale.
 */
export function worstWindowAreaKm2(z: number, latitude: number, canvas: Canvas): number {
  const { width, height } = keyCanvas(canvas)
  const zq = z - ZOOM_STEP / 2
  const q = (Math.min(width, height) * (1 / 6) * 2 * Math.PI) / (512 * Math.pow(2, zq))
  const iy = mercY(Math.abs(latitude)) / q - 0.5
  return windowAreaKm2(cullWindow({ zq, ix: 0, iy, q, width, height }))
}

/** The most cells (any population) such a window can hold, for cells of mean area `cellKm2`. */
export function maxWindowCells(z: number, latitude: number, canvas: Canvas, cellKm2: number): number {
  return (worstWindowAreaKm2(z, latitude, canvas) * AREA_SLACK) / (cellKm2 * CELL_AREA_FLOOR)
}

/** Width of the final bracket (zoom levels); the result is always on the fitting side. */
const TOLERANCE = 1 / 128

/**
 * The earliest zoom ≥ `from` at latitude `latitude` at which a tier of mean cell area
 * `cellKm2` fits `cap` while HELD `hysteresis` below it: the widest window at
 * zoom − hysteresis can hold no more than `cap` cells. `from` itself when that already fits.
 * The window only shrinks as the zoom rises, so the test is monotone: the search steps up by
 * log4(cells ÷ cap) — what a flat window's 4^−Δz area law needs, so one or two steps reach
 * the fitting side — then bisects the last step to {@link TOLERANCE}. ~6–9 window
 * evaluations (~0.3 ms each) per tier.
 */
export function fitThreshold(from: number, latitude: number, cellKm2: number, cap: number, hysteresis: number, canvas: Canvas): number {
  const fits = (t: number) => maxWindowCells(t - hysteresis, latitude, canvas, cellKm2) <= cap
  let lo = from
  let cells = maxWindowCells(from - hysteresis, latitude, canvas, cellKm2)
  if (cells <= cap) return from
  let hi = from
  for (let i = 0; i < 64; i++) {
    hi = lo + Math.max(TOLERANCE, Math.log(cells / cap) / Math.log(4))
    cells = maxWindowCells(hi - hysteresis, latitude, canvas, cellKm2)
    if (cells <= cap) break
    lo = hi
  }
  while (hi - lo > TOLERANCE) {
    const mid = (lo + hi) / 2
    if (fits(mid)) hi = mid
    else lo = mid
  }
  return hi
}
