// `.ts` extensions: `scripts/` import this module under Node's native type stripping.
import { ZOOM_STEP, cullWindow, keyCanvas } from './footprint.ts'
import type { Canvas, CullWindow } from './footprint.ts'

/**
 * When does a tier's cull window fit the 120 k cap — by construction, from the GROUND the
 * window covers, not from a flat `W·H ÷ cell px²` estimate (`tierBands.ts` uses this as one
 * of the two parts of a threshold; the other is the 3-px rule).
 *
 * A window (`footprint.ts` `cullWindow`: the canvas rectangle grown by the re-cull drift
 * margin, cut at the horizon) can hold at most its ground area × the number of cells per
 * mean-cell area there, populated or not. Where the limb is far out of view the area is about
 * the canvas's px area over px/km² times the margin's ~1.6×; where the limb is near (r5's
 * threshold on a desktop canvas) foreshortening puts far more ground in the window and the
 * bound delays the tier by exactly what the geometry requires. The cells per area are not a
 * flat worst case: H3's hexagons are 0.605 × the mean next to the icosahedron's vertices and
 * 1.21 × at its face centres ({@link H3_AREA_SCALE}), and a window is weighed by where it can
 * actually sit ({@link windowWeight}) — at its worst longitude, so the result still depends
 * on the latitude band and canvas alone.
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
 * The smallest H3 hexagon's area over the resolution's mean, anywhere: 0.606 at r5–r8, next
 * to the 12 icosahedron vertices (the pentagons, 0.505, are single cells). The bound below no
 * longer uses it flat — it knows where the small cells are ({@link cellAreaFloor}) — but it
 * is still the floor that bound can never go under (`tierFit.test.ts`).
 */
export const CELL_AREA_FLOOR = 0.6

/**
 * Slack on the measured cell count: the area grid's sampling error (< 0.5 %), the weight
 * grid's (< 0.5 %), plus the cells whose centre is inside a window whose boundary cuts them
 * — a band one cell wide around a window ~200 cells across (a window at a binding threshold
 * holds ~120 k cells) is ~2 % of its area.
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
const latOfMercY = (y: number) => Math.atan(Math.sinh(y)) / DEG
const MAX_LATITUDE = 85.051129
const MERC_Y_MAX = mercY(MAX_LATITUDE)

/** The widest window a view can be served at zoom `z` on `canvas` (see {@link worstWindowAreaKm2}), and its Mercator step. */
function worstWindow(z: number, latitude: number, canvas: Canvas): { w: CullWindow; q: number } {
  const { width, height } = keyCanvas(canvas)
  const zq = z - ZOOM_STEP / 2
  const q = (Math.min(width, height) * (1 / 6) * 2 * Math.PI) / (512 * Math.pow(2, zq))
  const iy = mercY(Math.abs(latitude)) / q - 0.5
  return { w: cullWindow({ zq, ix: 0, iy, q, width, height }), q }
}

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
  return windowAreaKm2(worstWindow(z, latitude, canvas).w)
}

// ---------------------------------------------------------------------------------------
// Where the small cells are: H3's area distortion.

/**
 * The 20 icosahedron face centres H3 projects each face from (lat, lng degrees): the
 * normalized sums of each face's three vertices, the res-0 pentagon centres
 * (`tierFit.test.ts` derives them with h3-js). Inlined like `density.ts`'s mean areas, so
 * the entry chunk stays free of h3-js.
 */
const FACE_CENTERS_DEG = [
  [74.928434389174, 145.35624192278], [60.432795263056, -77.207057485608],
  [46.041894318838, 71.527903299099], [34.388445323561, -25.817702244712],
  [28.173218757258, 23.032227440866], [34.717192809264, 169.247339803482],
  [24.486526988569, -108.224634301977], [13.233127456695, -150.979940503857],
  [9.897578191521, 96.150733929594], [4.530154895351, 137.977584312943],
  [-4.530154895351, -42.022415687057], [-9.89757819152, -83.849266070406],
  [-13.233127456695, 29.020059496143], [-24.486526988569, 71.775365698023],
  [-34.717192809264, -10.752660196518], [-28.173218757258, -156.967772559134],
  [-34.388445323561, 154.182297755288], [-46.041894318838, -108.472096700901],
  [-60.432795263056, 102.792942514392], [-74.928434389174, -34.64375807722],
] as const
const FACES = new Float64Array(60)
FACE_CENTERS_DEG.forEach(([lat, lng], f) => {
  FACES[3 * f] = Math.cos(lat * DEG) * Math.cos(lng * DEG)
  FACES[3 * f + 1] = Math.cos(lat * DEG) * Math.sin(lng * DEG)
  FACES[3 * f + 2] = Math.sin(lat * DEG)
})

/** Angle (rad) from a face centre to its three vertices — the farthest any point is from its nearest face centre. */
export const VERTEX_ANGLE = 37.37736814064969 * DEG

/**
 * H3 lays one uniform hexagon grid on each face's gnomonic plane, and a gnomonic projection
 * maps area on the plane to cos³θ times as much on the sphere at angle θ from the face
 * centre. So every hexagon's area is this × cos³θ × the resolution's mean, θ the angle from
 * its centre to the nearest face centre: 1.2066 measured with h3-js on 850 k hexagons at
 * r5–r8 over the whole sphere and around every pentagon, the smallest ratio 1.20656
 * (`tierFit.test.ts`). At a vertex that is 1.206 · cos³ 37.38° = 0.605 — the old uniform floor.
 */
export const H3_AREA_SCALE = 1.206

/** Angle (rad) from unit vector (x, y, z) to the nearest H3 face centre. */
export function faceAngle(x: number, y: number, z: number): number {
  let best = -1
  for (let f = 0; f < 60; f += 3) {
    const d = x * FACES[f] + y * FACES[f + 1] + z * FACES[f + 2]
    if (d > best) best = d
  }
  return Math.acos(Math.min(1, best))
}

/** Smallest H3 hexagon area at a point, over the resolution's mean (any resolution): see {@link H3_AREA_SCALE}. */
export function cellAreaFloor(lat: number, lng: number): number {
  const c = Math.cos(lat * DEG)
  const t = Math.min(VERTEX_ANGLE, faceAngle(c * Math.cos(lng * DEG), c * Math.sin(lng * DEG), Math.sin(lat * DEG)))
  return H3_AREA_SCALE * Math.cos(t) ** 3
}

/**
 * The weight raster: cells per mean-cell area (1 / {@link cellAreaFloor}) on a grid of
 * {@link RASTER}° rows of latitude × columns of longitude, each the MOST over its cell
 * widened by half a column east and west (so a window turned by any longitude is within half
 * a column of a whole-column turn) and by {@link PLACEMENT_RADIUS} (the window's own
 * placement error, below): θ at the cell centre + 0.25° + 0.5° + PLACEMENT_RADIUS bounds θ
 * over all of it (a meridian step, then a parallel step of at most 0.5° · cos φ). Kept as
 * running sums along each row (doubled, so a turn never wraps), filled the first time a
 * window touches the row (≤ 360 rows × 11.5 kB, ~0.1 ms each).
 */
const RASTER = 0.5
const ROWS = 180 / RASTER
const COLS = 360 / RASTER
/**
 * How far (°) a window may sit from the place its weights are taken at: the windows of one
 * latitude band lie along a meridian arc ({@link maxWindowCells}), cut into pieces this far
 * either side of their middles.
 */
const PLACEMENT_RADIUS = 0.5
const RASTER_SLACK = (RASTER / 2 + RASTER + PLACEMENT_RADIUS) * DEG
const prefixRows: (Float64Array | undefined)[] = []

/** Running sums of row `r` of the weight raster over two turns: P[c] = Σ weights of columns < c. */
function prefixRow(r: number): Float64Array {
  let row = prefixRows[r]
  if (row) return row
  row = new Float64Array(2 * COLS + 1)
  const lat = (-90 + (r + 0.5) * RASTER) * DEG
  const cl = Math.cos(lat)
  const z = Math.sin(lat)
  for (let c = 0; c < COLS; c++) {
    const lng = (-180 + (c + 0.5) * RASTER) * DEG
    const t = Math.min(VERTEX_ANGLE, faceAngle(cl * Math.cos(lng), cl * Math.sin(lng), z) + RASTER_SLACK)
    row[c + 1] = 1 / (H3_AREA_SCALE * Math.cos(t) ** 3)
  }
  for (let c = 0; c < COLS; c++) row[COLS + c + 1] = row[c + 1]
  for (let c = 1; c <= 2 * COLS; c++) row[c] += row[c - 1]
  return (prefixRows[r] = row)
}

/** Arcs of longitude (rad, within [−π, π]) as [from, to] pairs. */
type Arcs = number[]

/** `arcs` ∩ {λ : α·sin λ + β·cos λ ≥ γ} (`atLeast`) or ≤ γ: the set is one arc of the circle (or all, or none). */
function cutArcs(arcs: Arcs, alpha: number, beta: number, gamma: number, atLeast: boolean): Arcs {
  // α sin λ + β cos λ = ρ cos(λ − ψ).
  const rho = Math.hypot(alpha, beta)
  const g = atLeast ? gamma : -gamma
  const sgn = atLeast ? 1 : -1 // ρ' cos(λ − ψ') ≥ g with ψ' = ψ (≥) or ψ + π (≤)
  if (g <= -rho) return arcs
  if (g > rho) return []
  const psi = Math.atan2(sgn * alpha, sgn * beta)
  const half = Math.acos(g / rho)
  // The allowed arc [ψ − half, ψ + half], as pieces within [−π, π].
  let lo = psi - half
  let hi = psi + half
  const pieces: number[] = []
  if (hi - lo >= 2 * Math.PI) return arcs
  while (lo < -Math.PI) {
    lo += 2 * Math.PI
    hi += 2 * Math.PI
  }
  while (lo >= Math.PI) {
    lo -= 2 * Math.PI
    hi -= 2 * Math.PI
  }
  if (hi <= Math.PI) pieces.push(lo, hi)
  else pieces.push(lo, Math.PI, -Math.PI, hi - 2 * Math.PI)
  const out: Arcs = []
  for (let i = 0; i < arcs.length; i += 2) {
    for (let j = 0; j < pieces.length; j += 2) {
      const a = Math.max(arcs[i], pieces[j])
      const b = Math.min(arcs[i + 1], pieces[j + 1])
      if (b > a) out.push(a, b)
    }
  }
  return out
}

/**
 * The largest mean of the weight raster over a window, over every longitude it can be turned
 * to and every placement `deltas` (rad, along its centre's meridian, + toward the pole): the
 * most cells per mean-cell area such a window can hold wherever it is. No sampling: on each
 * raster row's middle parallel the window is an intersection of five arcs of longitude (its
 * cap, and the four sides of its chart rectangle — each a linear condition on cos λ and
 * sin λ), so one or two arcs; a turn by k columns then costs one difference of running sums
 * per arc, and all 720 turns are summed. The window's own longitude does not matter.
 */
export function windowWeight(w: CullWindow, deltas: readonly number[] = [0]): number {
  const lat0 = Math.asin(Math.max(-1, Math.min(1, w.c0[2])))
  const sums = new Float64Array(COLS)
  let worst = 0
  for (const delta of deltas) {
    const p0 = lat0 + delta
    const s0 = Math.sin(p0)
    const k0 = Math.cos(p0)
    const capRad = Math.acos(Math.max(-1, Math.min(1, w.cosCap)))
    // Strips of latitude, each within one raster row (a row cut into `sub` strips so a small
    // window still spans 16 or more), each weighed at its middle parallel: the midpoint rule
    // along the meridian.
    const sub = Math.max(1, Math.ceil((16 * RASTER * DEG) / (2 * capRad)))
    const h = (RASTER * DEG) / sub
    const sLo = Math.max(0, Math.floor((p0 - capRad + Math.PI / 2) / h))
    const sHi = Math.min(ROWS * sub - 1, Math.floor((p0 + capRad + Math.PI / 2) / h))
    sums.fill(0)
    let total = 0
    for (let st = sLo; st <= sHi; st++) {
      const south = -Math.PI / 2 + st * h
      const north = south + h
      const phi = (south + north) / 2
      const r = Math.floor(st / sub)
      const sp = Math.sin(phi)
      const cp = Math.cos(phi)
      // u = (cos φ cos λ, cos φ sin λ, sin φ) against the frame at (φ0, 0):
      // u·c0 = cp·k0·cos λ + sp·s0, u·e0 = cp·sin λ, u·n0 = k0·sp − s0·cp·cos λ.
      let arcs: Arcs = [-Math.PI, Math.PI]
      arcs = cutArcs(arcs, 0, cp * k0, w.cosCap - sp * s0, true)
      if (w.rect && arcs.length) {
        const depth = w.kc - sp * s0 // kc − u·c0 = depth − cp·k0·cos λ
        arcs = cutArcs(arcs, cp, w.xMax * cp * k0, w.xMax * depth, false)
        arcs = cutArcs(arcs, cp, w.xMin * cp * k0, w.xMin * depth, true)
        arcs = cutArcs(arcs, 0, cp * (w.yMax * k0 - s0), w.yMax * depth - k0 * sp, false)
        arcs = cutArcs(arcs, 0, cp * (w.yMin * k0 - s0), w.yMin * depth - k0 * sp, true)
      }
      if (!arcs.length) continue
      const P = prefixRow(r)
      const area = Math.sin(north) - Math.sin(south) // a column's area in the strip, up to a constant
      for (let i = 0; i < arcs.length; i += 2) {
        const west = (arcs[i] / DEG + 180) / RASTER
        const east = (arcs[i + 1] / DEG + 180) / RASTER
        total += area * (east - west)
        // P at fractional columns x + k, linear within a column.
        const wi = Math.min(COLS - 1, Math.floor(west))
        const ei = Math.min(COLS - 1, Math.floor(east))
        const wf = area * (west - wi)
        const ef = area * (east - ei)
        for (let k = 0; k < COLS; k++) {
          const a = wi + k
          const b = ei + k
          sums[k] += area * (P[b] - P[a]) + ef * (P[b + 1] - P[b]) - wf * (P[a + 1] - P[a])
        }
      }
    }
    if (total <= 0) continue
    let best = 0
    for (let k = 0; k < COLS; k++) if (sums[k] > best) best = sums[k]
    worst = Math.max(worst, best / total)
  }
  return worst
}

/**
 * The most cells (any population) a window can hold for a view at zoom `z` whose latitude is
 * in [`latitude` − `band`, `latitude`] (≥ 0; the hemispheres mirror, and H3's grid is
 * centrally symmetric, so a window and its mirror image turned by 180° hold the same), cells
 * of mean area `cellKm2`: the widest window such a view can be served
 * ({@link worstWindowAreaKm2}) × the most cells per mean-cell area it can meet
 * ({@link windowWeight}) — at every longitude, and at every place along the meridian its
 * centre can take: a re-cull row's centre is within half a step q of its views, so the
 * windows of the band's views are centred anywhere from q/2 equatorward of its low edge to
 * q/2 poleward of its high edge. That arc is cut into pieces at most 2 ×
 * {@link PLACEMENT_RADIUS} long, each weighed at its middle with the raster widened by the
 * radius (a turn along the meridian moves no point farther than the turn).
 */
export function maxWindowCells(z: number, latitude: number, canvas: Canvas, cellKm2: number, band = 0): number {
  const { areaKm2, weight } = windowBound(z, latitude, canvas, band)
  return (areaKm2 * weight() * AREA_SLACK) / cellKm2
}

/** {@link maxWindowCells} in two parts: the window's area now, its weight (the costly part) on demand. */
function windowBound(z: number, latitude: number, canvas: Canvas, band: number): { areaKm2: number; weight: () => number } {
  const lat = Math.abs(latitude)
  const { w, q } = worstWindow(z, lat, canvas)
  const ref = Math.asin(w.c0[2]) / DEG
  const lo = latOfMercY(Math.max(-MERC_Y_MAX, mercY(lat - band) - q / 2)) - ref
  const yHi = mercY(lat)
  const hi = latOfMercY(yHi + q / 2) - ref
  const pieces = Math.max(1, Math.ceil((hi - lo) / (2 * PLACEMENT_RADIUS) - 1e-9))
  const deltas: number[] = []
  for (let k = 0; k < pieces; k++) deltas.push((lo + ((k + 0.5) * (hi - lo)) / pieces) * DEG)
  return { areaKm2: windowAreaKm2(w), weight: () => windowWeight(w, deltas) }
}

/** Width of the final bracket (zoom levels); the result is always on the fitting side. */
const TOLERANCE = 1 / 128

/**
 * The earliest zoom ≥ `from` at latitude `latitude` at which a tier of mean cell area
 * `cellKm2` fits `cap` while HELD `hysteresis` below it: the most cells a window at
 * zoom − hysteresis can hold, for any view of the latitude band [latitude − band, latitude],
 * is no more than `cap`. `from` itself when that already fits. The window only shrinks as the
 * zoom rises, so the test is monotone, and log(cells) falls almost linearly with the zoom
 * (a flat window's area goes as 4^−Δz): the search steps up by log4(cells ÷ cap) until it
 * fits, then probes {@link TOLERANCE}/2 either side of the root interpolated in log(cells)
 * — usually closing the bracket there; else it narrows the bracket and interpolates again.
 * ~4–5 evaluations of {@link maxWindowCells} per tier.
 */
export function fitThreshold(
  from: number,
  latitude: number,
  cellKm2: number,
  cap: number,
  hysteresis: number,
  canvas: Canvas,
  band = 0,
): number {
  /**
   * log(cells ÷ cap): ≤ 0 fits. Where even the largest cells (weight 1 / H3_AREA_SCALE) would
   * overfill the cap, that lower bound is returned without weighing the window: the answer
   * (does not fit) is the same, and the step it gives is only shorter.
   */
  const excess = (t: number) => {
    const { areaKm2, weight } = windowBound(t - hysteresis, latitude, canvas, band)
    const least = (areaKm2 * AREA_SLACK) / (cellKm2 * H3_AREA_SCALE)
    return Math.log((least > cap ? least : least * H3_AREA_SCALE * weight()) / cap)
  }
  let lo = from
  let gLo = excess(from)
  if (gLo <= 0) return from
  let hi = from
  let gHi = gLo
  for (let i = 0; i < 64; i++) {
    hi = lo + Math.max(TOLERANCE, gLo / Math.log(4))
    gHi = excess(hi)
    if (gHi <= 0) break
    lo = hi
    gLo = gHi
  }
  // [lo, hi]: lo overfills, hi fits.
  for (let i = 0; i < 64 && hi - lo > TOLERANCE; i++) {
    const root = lo + ((hi - lo) * gLo) / (gLo - gHi)
    const up = Math.min(hi - TOLERANCE / 4, Math.max(lo + TOLERANCE / 4, root + TOLERANCE / 2))
    const g = excess(up)
    if (g > 0) {
      lo = up
      gLo = g
      continue
    }
    hi = up
    gHi = g
    if (hi - lo <= TOLERANCE) break
    const down = hi - TOLERANCE
    const g2 = excess(down)
    if (g2 > 0) {
      lo = down
      gLo = g2
    } else {
      hi = down
      gHi = g2
    }
  }
  return hi
}
