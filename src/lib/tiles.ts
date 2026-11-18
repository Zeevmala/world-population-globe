import { cellToBoundary, cellToLatLng, gridDisk, latLngToCell } from 'h3-js'
import type { GlobeViewState, TileSet } from '../types'
// `.ts` extension: `scripts/bench/cull_coverage.mjs` imports this module under Node's native type stripping.
import { bucketKey, cameraFor, cullBucket, cullWindow, lngLatToUnit, unprojectPixel } from './footprint.ts'
import type { Canvas, CullWindow } from './footprint.ts'

/**
 * Which parent tiles a tiled tier needs for a view — chosen from the same footprint
 * model and the same re-selection key as the viewport cull (`footprint.ts`), so "what
 * is on screen" means one thing in the whole render path.
 *
 * The key is the cull's bucket ({@link tileKey}): canvas W×H, zoom in steps of 1/8, the
 * view center in Web Mercator steps of a sixth of the canvas's shorter side. The visible
 * tiles are the parents whose cells overlap the bucket's {@link cullWindow} — the union of
 * the footprints of every view sharing the key — so no view on a key can show a parent
 * the selection left out, and the selection re-runs only when the cull would.
 *
 * Why not h3-js `polygonToCellsExperimental(…, containmentOverlapping)`: it reads polygon
 * edges as straight lines in lng/lat and takes any polygon spanning more than 180° of
 * longitude as one that crosses the antimeridian (measured on h3-js 4.4: a box from
 * −170° to 170° at ±80° came back as the 20° strip across ±180°, 2,567 r3 cells), so the
 * window would have to be re-expressed as a densified lng/lat polygon and trusted near
 * the poles. A flood fill over `gridDisk` neighbours, with each cell's edges (great-circle
 * arcs) tested exactly against the window's planes ({@link cellOverlapsWindow}), has no
 * lng/lat seam anywhere: it uses unit vectors, like the cull.
 */

/** The tile re-selection key — the cull's bucket key (without the tier name). */
export const tileKey = (view: GlobeViewState, canvas: Canvas): string => bucketKey(cullBucket(view, canvas))

/**
 * Hard stop on the flood fill (cells tested). Tiled tiers run where a few dozen parents
 * cover the screen; this only bounds a camera far outside every tiled band.
 */
const MAX_VISIT = 2048

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Lng/lat (degrees) of a unit vector. */
function unitToLngLat(u: readonly number[]): [number, number] {
  return [Math.atan2(u[1], u[0]) * (180 / Math.PI), Math.asin(Math.max(-1, Math.min(1, u[2]))) * (180 / Math.PI)]
}

/**
 * The window as half-spaces: a unit vector `u` is inside iff `u·n ≥ k` for every `[n, k]`.
 * The cap is `u·c0 ≥ cosCap`; each side of the chart rectangle, `xMin ≤ u·e0 / (kc − u·c0)`
 * and so on, is linear in `u` once multiplied by the depth `kc − u·c0`, which is positive
 * on the whole sphere (kc > 1) — so every side is a plane, and on the sphere a circle.
 * These are exactly the inequalities the cull tests per cell (`lod.ts` `cullWindowCells`).
 */
export function windowPlanes(w: CullWindow): [number[], number][] {
  const { c0, e0, n0, kc } = w
  const lin = (a: readonly number[], s: number, b: number): number[] => [a[0] * s + c0[0] * b, a[1] * s + c0[1] * b, a[2] * s + c0[2] * b]
  const planes: [number[], number][] = [[[...c0], w.cosCap]]
  if (Number.isFinite(w.xMin)) planes.push([lin(e0, 1, w.xMin), w.xMin * kc]) // u·e0 + xMin·u·c0 ≥ xMin·kc
  if (Number.isFinite(w.xMax)) planes.push([lin(e0, -1, -w.xMax), -w.xMax * kc]) // −u·e0 − xMax·u·c0 ≥ −xMax·kc
  if (Number.isFinite(w.yMin)) planes.push([lin(n0, 1, w.yMin), w.yMin * kc])
  if (Number.isFinite(w.yMax)) planes.push([lin(n0, -1, -w.yMax), -w.yMax * kc])
  return planes
}

/** Inclusive slack on the arc test (radians / dot products): far below a metre on the globe. */
const ARC_EPS = 1e-12

/**
 * Whether the great-circle arc from unit vector `a` to `b` (shorter way) has a point inside
 * every half-space of `planes`. Exact: on the arc `u(θ) = a·cosθ + t·sinθ`, θ ∈ [0, Θ], a
 * constraint `u·n ≥ k` reads `R·cos(θ − φ) ≥ k` — one interval of θ around φ — so the arc
 * meets the window iff the intervals of all constraints, clipped to [0, Θ], share a point.
 */
export function arcMeetsPlanes(a: readonly number[], b: readonly number[], planes: readonly [number[], number][]): boolean {
  const ab = dot(a, b)
  const tx = b[0] - ab * a[0]
  const ty = b[1] - ab * a[1]
  const tz = b[2] - ab * a[2]
  const tl = Math.hypot(tx, ty, tz)
  const theta = Math.atan2(tl, ab)
  const t = tl > 0 ? [tx / tl, ty / tl, tz / tl] : [0, 0, 0]
  // The feasible part of [0, Θ], as a list of disjoint intervals.
  let feasible: [number, number][] = [[0, theta]]
  for (const [n, k] of planes) {
    const al = dot(a, n)
    const be = dot(t, n)
    const r = Math.hypot(al, be)
    if (k <= -r + ARC_EPS) continue // holds on the whole circle
    if (k > r + ARC_EPS) return false // holds nowhere on it
    const phi = Math.atan2(be, al)
    const h = Math.acos(Math.max(-1, Math.min(1, k / r))) + ARC_EPS
    const next: [number, number][] = []
    for (const shift of [-2 * Math.PI, 0, 2 * Math.PI]) {
      const lo = phi - h + shift
      const hi = phi + h + shift
      for (const [f0, f1] of feasible) {
        const x0 = Math.max(lo, f0)
        const x1 = Math.min(hi, f1)
        if (x0 <= x1) next.push([x0, x1])
      }
    }
    if (next.length === 0) return false
    feasible = next
  }
  return true
}

/**
 * Whether H3 cell `cell` shares any point with window `w` — exactly, not by sampling. A
 * closed cell and the window (a convex region containing its center `c0`) meet iff
 *  - an edge of the cell meets the window ({@link arcMeetsPlanes}; H3 edges, distortion
 *    vertices included, are great-circle arcs): this covers a cell partly inside, a cell
 *    wholly inside (all its edges are), and a corner of the window poking into a cell; or
 *  - no edge does, and the window lies wholly inside the cell — then the cell holds `c0`:
 *    it is the cell under the window's center (`isCenter`).
 */
export function cellOverlapsWindow(cell: string, w: CullWindow, isCenter = false): boolean {
  if (isCenter) return true
  const planes = windowPlanes(w)
  const ring = cellToBoundary(cell).map(([lat, lng]) => lngLatToUnit(lng, lat))
  for (let i = 0; i < ring.length; i++) {
    if (arcMeetsPlanes(ring[i], ring[(i + 1) % ring.length], planes)) return true
  }
  return false
}

/** The parents a tiled tier wants for one re-selection key. */
export interface ParentSelection {
  /** {@link tileKey} of the view the selection was made for. */
  key: string
  /** Every parent whose cell overlaps the key's window — what is merged and drawn. */
  visible: string[]
  /**
   * The ring just outside `visible` (neighbours of a visible parent that are not
   * visible), nearest the window's center first, cut so `visible` + `prefetch` fits
   * `budget`. Warmed into the cache on idle, never merged.
   */
  prefetch: string[]
  /** The ring's length before the budget cut. */
  ringSize: number
}

/**
 * Select the parent tiles (H3 resolution `parentRes`) for a view on a canvas: a flood fill
 * from the parent under the window's center through `gridDisk` neighbours, keeping every
 * cell that overlaps the window ({@link cellOverlapsWindow}). The window and its cells are
 * connected, so the fill finds them all; the cells it tested and rejected are exactly the
 * ring around them — the prefetch candidates.
 */
export function selectParents(
  view: GlobeViewState,
  canvas: Canvas,
  parentRes: number,
  budget: number,
): ParentSelection {
  const bucket = cullBucket(view, canvas)
  const w = cullWindow(bucket)
  const [lng0, lat0] = unitToLngLat(w.c0)
  const start = latLngToCell(lat0, lng0, parentRes)
  const seen = new Set<string>([start])
  const queue = [start]
  const visible: string[] = []
  const ring: string[] = []
  for (let q = 0; q < queue.length && q < MAX_VISIT; q++) {
    const cell = queue[q]
    if (!cellOverlapsWindow(cell, w, cell === start)) {
      ring.push(cell)
      continue
    }
    visible.push(cell)
    for (const nb of gridDisk(cell, 1)) {
      if (!seen.has(nb)) {
        seen.add(nb)
        queue.push(nb)
      }
    }
  }
  const dist = new Map<string, number>()
  for (const p of ring) {
    const [lat, lng] = cellToLatLng(p)
    dist.set(p, -dot(lngLatToUnit(lng, lat), w.c0))
  }
  ring.sort((a, b) => dist.get(a)! - dist.get(b)!)
  return {
    key: bucketKey(bucket),
    visible,
    prefetch: ring.slice(0, Math.max(0, budget - visible.length)),
    ringSize: ring.length,
  }
}

/** Canvas border sample spacing (CSS px) for {@link tileSetCovers}. */
const COVER_STEP_PX = 16

/**
 * Whether a tiled tier's published set draws the whole screen of `view`: its merged data
 * is non-empty and every parent under the screen is settled — loaded, absent from the
 * index (ocean) or failed and being retried — for the key it was selected for.
 *
 * Exact when the view is on that key (the key's window holds every view's footprint).
 * Otherwise — the camera has moved on and the stream is still loading the new key — the
 * canvas border is walked every {@link COVER_STEP_PX} px (and the center tested): the
 * settled parents are a hole-free patch, so a border inside it means a screen inside it.
 * That keeps the tier drawing through a pan that stays over tiles it already has, and
 * gives way to the tier below as soon as the screen reaches a parent it does not — rather
 * than draw a previous view's tiles over a screen they do not cover. Between border
 * samples a cell can poke in by at most ~0.3 × the spacing (5 px), for the frames until
 * the new key's tiles merge.
 */
export function tileSetCovers(set: TileSet, view: GlobeViewState, canvas: Canvas): boolean {
  if (!set.data || set.data.h3.length === 0) return false
  if (set.key === tileKey(view, canvas)) return true
  const cam = cameraFor(view, canvas)
  const { width: W, height: H } = cam
  const nx = Math.max(1, Math.ceil(W / COVER_STEP_PX))
  const ny = Math.max(1, Math.ceil(H / COVER_STEP_PX))
  const at = (sx: number, sy: number): boolean => {
    const [lng, lat] = unitToLngLat(unprojectPixel(cam, sx, sy).u)
    return set.settled.has(latLngToCell(lat, lng, set.parentRes))
  }
  if (!at(W / 2, H / 2)) return false
  for (let i = 0; i < nx; i++) {
    const x = (i / nx) * W
    if (!at(x, 0) || !at(W - x, H)) return false
  }
  for (let j = 0; j < ny; j++) {
    const y = (j / ny) * H
    if (!at(W, y) || !at(0, H - y)) return false
  }
  return true
}
