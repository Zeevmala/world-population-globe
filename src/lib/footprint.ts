import type { GlobeViewState } from '../types'

/**
 * What deck.gl's `_GlobeView` shows for a camera and a canvas — the footprint model the
 * viewport cull (`lod.ts`) is cut from, written so tile selection and tier selection can
 * use it too. Pure arithmetic: no deck.gl, no h3-js, no DOM. `footprint.test.ts` holds
 * it to `GlobeViewport`'s own projection and unprojection.
 *
 * The camera, read off `GlobeViewport` (deck.gl 9, `viewports/globe-viewport.js`):
 *  - the view latitude is clamped to the Web Mercator limit (±85.0511°), like the viewport;
 *  - the eye sits on the globe's radius through the view center, looking at the center,
 *    `altitude · H / scale` world units above the surface, where `altitude = 1.5`,
 *    `H` = canvas height (CSS px), `scale = 2^zoom / (π cos lat)` and the globe radius is
 *    256 world units — so, in globe radii, the eye is at distance
 *        k = 1 + 1.5 · π · H · cos(lat) / (256 · 2^zoom)
 *    from the globe's center;
 *  - the vertical field of view is `2·atan(1 / (2·altitude))`, i.e. the focal length is
 *    `f = 1.5 · H` px, and pixels are square;
 *  - screen up is north (GlobeView has no bearing or pitch).
 * A point `u` on the unit sphere is drawn at `(u·e, u·n) · f / (k − u·c)` px from the
 * canvas center (`c` the view center, `e`/`n` east/north there), and is in front of the
 * horizon — not hidden by the globe — iff `u·c ≥ 1/k`. "On screen" is both: front-facing
 * and projected inside the canvas. The limb is the circle `u·c = 1/k`; at low zoom it
 * lies inside the canvas, and nothing past it is on screen.
 *
 * Unit vectors use x = cosφ·cosλ, y = cosφ·sinλ, z = sinφ — CRS-free, so poles and the
 * antimeridian are not special cases anywhere below.
 */

export interface Canvas {
  /** CSS px. */
  width: number
  /** CSS px. */
  height: number
}

/** math.gl's `MAX_LATITUDE` (rounded as it is there): GlobeViewport clamps the camera latitude to it. */
export const MAX_LATITUDE = 85.051129
/** deck.gl GlobeViewport default `altitude` (camera height in canvas heights). */
const ALTITUDE = 1.5
/** deck.gl `GLOBE_RADIUS` (world units). */
const GLOBE_UNITS = 256
const DEG = Math.PI / 180

/** A canvas of 0 px (mid-layout) is treated as 1 px: a degenerate but finite camera. */
const px = (v: number) => (Number.isFinite(v) && v >= 1 ? v : 1)

/** The camera latitude GlobeViewport actually renders for `lat` (degrees). */
export const clampLat = (lat: number): number => Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat))

/** Unit vector of a lng/lat (degrees). */
export function lngLatToUnit(lng: number, lat: number): [number, number, number] {
  const p = lat * DEG
  const l = lng * DEG
  const cp = Math.cos(p)
  return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)]
}

/** A view's camera in the frame of its center (all lengths in globe radii). */
export interface Camera {
  /** View center (unit). */
  c: [number, number, number]
  /** East at the center (unit). */
  e: [number, number, number]
  /** North at the center (unit). */
  n: [number, number, number]
  /** Eye distance from the globe's center, in globe radii (> 1). */
  k: number
  /** Focal length, CSS px. */
  f: number
  width: number
  height: number
}

/** The frame (center, east, north) at a lng/lat in degrees. */
function frameAt(lng: number, lat: number): Pick<Camera, 'c' | 'e' | 'n'> {
  const p = lat * DEG
  const l = lng * DEG
  const sp = Math.sin(p)
  const cp = Math.cos(p)
  const sl = Math.sin(l)
  const cl = Math.cos(l)
  return { c: [cp * cl, cp * sl, sp], e: [-sl, cl, 0], n: [-sp * cl, -sp * sl, cp] }
}

/** Eye distance from the globe's center (globe radii) for a zoom, clamped latitude and canvas height. */
export function eyeDistance(zoom: number, lat: number, height: number): number {
  return 1 + (ALTITUDE * Math.PI * px(height) * Math.cos(clampLat(lat) * DEG)) / (GLOBE_UNITS * Math.pow(2, zoom))
}

/** The camera GlobeViewport builds for `view` on `canvas`. */
export function cameraFor(view: GlobeViewState, canvas: Canvas): Camera {
  const lat = clampLat(view.latitude)
  const height = px(canvas.height)
  return {
    ...frameAt(view.longitude, lat),
    k: eyeDistance(view.zoom, lat, height),
    f: ALTITUDE * height,
    width: px(canvas.width),
    height,
  }
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * Screen position (CSS px, top-left origin, y down — `GlobeViewport.project`'s
 * convention) of unit vector `u`, or `null` when it is behind the horizon.
 */
export function projectUnit(cam: Camera, u: readonly number[]): [number, number] | null {
  const dc = dot(u, cam.c)
  if (dc < 1 / cam.k) return null
  const z = cam.k - dc
  return [cam.width / 2 + (cam.f * dot(u, cam.e)) / z, cam.height / 2 - (cam.f * dot(u, cam.n)) / z]
}

/** True iff `u` is front-facing and projects inside the canvas (edges inclusive). */
export function isOnScreen(cam: Camera, u: readonly number[]): boolean {
  const p = projectUnit(cam, u)
  return p !== null && p[0] >= 0 && p[0] <= cam.width && p[1] >= 0 && p[1] <= cam.height
}

/**
 * The point of the globe under canvas pixel (`sx`, `sy`), or — when that pixel's ray
 * misses the globe — the limb point in the same direction from the canvas center.
 * `hit` tells which. The footprint is star-shaped from the center, so walking the canvas
 * border through this map traces the footprint's boundary: canvas edges where the globe
 * fills them, the limb where it doesn't.
 */
export function unprojectPixel(
  cam: Camera,
  sx: number,
  sy: number,
): { u: [number, number, number]; hit: boolean } {
  let a = (sx - cam.width / 2) / cam.f
  let b = (cam.height / 2 - sy) / cam.f
  const s2 = a * a + b * b
  const limb2 = 1 / (cam.k * cam.k - 1) // tan² of the limb's angle off the view axis
  const hit = s2 <= limb2
  if (!hit) {
    const r = Math.sqrt(limb2 / s2)
    a *= r
    b *= r
  }
  const t2 = a * a + b * b
  // Ray P(t) = k·c + t·(a·e + b·n − c); |P| = 1 → (1+s²)t² − 2kt + k² − 1 = 0, near root.
  const disc = Math.max(0, 1 - t2 * (cam.k * cam.k - 1))
  const t = (cam.k - Math.sqrt(disc)) / (1 + t2)
  const w = cam.k - t
  const { c, e, n } = cam
  const u: [number, number, number] = [
    w * c[0] + t * (a * e[0] + b * n[0]),
    w * c[1] + t * (a * e[1] + b * n[1]),
    w * c[2] + t * (a * e[2] + b * n[2]),
  ]
  const len = Math.hypot(u[0], u[1], u[2])
  return { u: [u[0] / len, u[1] / len, u[2] / len], hit }
}

/** Angular radius (degrees) of the horizon around the view center: acos(1/k). */
export const horizonDeg = (cam: Camera): number => Math.acos(1 / cam.k) / DEG

/**
 * The footprint's angular reach (degrees): the great-circle distance from the view center
 * to the farthest on-screen point — a canvas corner, or the horizon when the limb is in
 * view. The angle grows with distance from the canvas center, so the corner is the max.
 */
export function reachDeg(cam: Camera): number {
  const { u } = unprojectPixel(cam, 0, 0)
  return Math.acos(Math.max(-1, Math.min(1, dot(u, cam.c)))) / DEG
}

/**
 * Points along the footprint's boundary (unit vectors), `perSide` per canvas edge,
 * corners included: the canvas border unprojected, limb where the globe doesn't reach.
 */
export function footprintBoundary(cam: Camera, perSide: number): [number, number, number][] {
  const out: [number, number, number][] = []
  const { width: W, height: H } = cam
  for (let i = 0; i < perSide; i++) {
    const t = i / perSide
    out.push(unprojectPixel(cam, t * W, 0).u)
    out.push(unprojectPixel(cam, W, t * H).u)
    out.push(unprojectPixel(cam, W - t * W, H).u)
    out.push(unprojectPixel(cam, 0, H - t * H).u)
  }
  return out
}

// ---------------------------------------------------------------------------------------
// The re-cull key and the cull window.

/**
 * Zoom step of the re-cull key: a cull is reused for any zoom within ±1/16 of its bucket.
 * 1/8, not 1/4: the window must hold the bucket's most zoomed-out footprint, and at the r5
 * entry over mid-latitudes (screen corners near the limb) the footprint's area grows 1.8×
 * across a quarter zoom — too much to stay within 2.5× of the on-screen count.
 */
export const ZOOM_STEP = 0.125

/**
 * Position step of the re-cull key, as a share of the canvas's shorter side: the camera
 * may pan about a sixth of the screen's shorter side before the cull re-runs (133 px on a
 * 1280×800 canvas). Smaller re-culls more often; larger widens the drift margin and loosens
 * the window past 2.5× the on-screen count.
 */
const QUANTUM_SHARE = 1 / 6

/**
 * The key's position buckets live in Web Mercator (x = λ, y = ln tan(π/4 + φ/2), radians),
 * because GlobeView scales its view center exactly like Web Mercator: at any latitude a
 * zoom shows the same span of Mercator units, so one step in Mercator is the same share
 * of the screen everywhere — near the equator and near the 85.05° limit alike — without
 * a latitude-dependent quantum. A step of `qPx` CSS px is `qPx · 2π / (512 · 2^zoom)`
 * Mercator radians.
 */
const mercY = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (clampLat(latDeg) * DEG) / 2))
const latOfMercY = (y: number) => Math.atan(Math.sinh(y)) / DEG
const MERC_Y_MAX = mercY(MAX_LATITUDE) // ≈ π

/** One re-cull bucket: the region of view space (center, zoom) that shares a key. */
export interface CullBucket {
  /** Bucket zoom (center of its ±ZOOM_STEP/2 range). */
  zq: number
  /** Mercator x index (longitude). */
  ix: number
  /** Mercator y index (latitude). */
  iy: number
  /** Mercator step, radians. */
  q: number
  width: number
  height: number
}

/** The key's buckets for a view on a canvas — `cullKeyFor` prints these. */
export function cullBucket(view: GlobeViewState, canvas: Canvas): CullBucket {
  const width = px(canvas.width)
  const height = px(canvas.height)
  const zq = Math.round(view.zoom / ZOOM_STEP) * ZOOM_STEP
  const q = (Math.min(width, height) * QUANTUM_SHARE * 2 * Math.PI) / (512 * Math.pow(2, zq))
  const lng = ((((view.longitude + 180) % 360) + 360) % 360) - 180 // [-180, 180)
  return {
    zq,
    ix: Math.round((lng * DEG) / q),
    iy: Math.round(mercY(view.latitude) / q),
    q,
    width,
    height,
  }
}

/** The bucket's key string (without the tier name). */
export const bucketKey = (b: CullBucket): string =>
  `${b.width}x${b.height}:${b.iy}:${b.ix}:${b.zq.toFixed(2)}`

/**
 * The cull window of one bucket: a cap around the reference center `c0` and a rectangle
 * in the chart of a perspective camera at `c0` (distance `kc` globe radii). A unit vector
 * `u` is inside iff
 *     u·c0 ≥ cosCap  and  xMin ≤ u·e0 / (kc − u·c0) ≤ xMax  and  yMin ≤ u·n0 / (kc − u·c0) ≤ yMax.
 * `rect: false` means the cap alone, with infinite bounds (only when the cap reaches past a
 * hemisphere, at zooms no culled tier runs).
 */
export interface CullWindow {
  c0: [number, number, number]
  e0: [number, number, number]
  n0: [number, number, number]
  kc: number
  cosCap: number
  capDeg: number
  rect: boolean
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/** Bucket views sampled per axis (corners and edges included) when bounding the window. */
const GRID = 5
/** Footprint boundary samples per canvas edge. */
const PER_SIDE = 24
/**
 * Slack on the sampled bounds: the chart rectangle grows by this share of its own size on
 * each side, and the cap by this share of its radius. The bounds are maxima over sampled
 * views and boundary points of smooth functions, so the true maxima exceed them only by a
 * second-order sliver; `lod.test.ts` and `cullWindow.test.ts` sweep views sharing a key
 * against deck.gl's own projection and find none missed.
 */
const SLACK = 0.01

/**
 * The window a cull keeps for a bucket: the union of the footprints of every view that
 * shares the bucket's key — every center in its Mercator cell, every zoom in its
 * ±ZOOM_STEP/2 range, on its canvas — so a cull made at any one of them covers all the others.
 *
 * A footprint only shrinks as the zoom rises (the eye moves in: every point projects
 * farther out and the horizon closes in), so the bucket's lowest zoom bounds them all.
 * Over the bucket's centers (a {@link GRID}² grid, corners included), the footprint
 * boundaries ({@link footprintBoundary}) are mapped into one chart — a perspective
 * camera at the bucket's center — and bounded by a rectangle there: the canvas rectangle
 * grown by the drift margin, measured rather than assumed, so the frame's rotation near
 * the Mercator limit and the globe's curvature are in it. The chart is injective on the
 * window's cap (its eye is pushed back if needed so the cap is in front of its horizon),
 * so bounding a footprint's boundary bounds the footprint.
 *
 * The cap: every on-screen point of a view is within its {@link reachDeg} of its center,
 * so within (distance between centers + reach) of the bucket's center — exactly what
 * keeps cells behind every view's horizon out, and the chart unambiguous.
 */
export function cullWindow(b: CullBucket): CullWindow {
  const canvas = { width: b.width, height: b.height }
  const zLo = b.zq - ZOOM_STEP / 2
  const x0 = b.ix * b.q
  const yLo = Math.max(-MERC_Y_MAX, (b.iy - 0.5) * b.q)
  const yHi = Math.min(MERC_Y_MAX, (b.iy + 0.5) * b.q)
  const lng0 = x0 / DEG
  const lat0 = latOfMercY((yLo + yHi) / 2)
  const { c: c0, e: e0, n: n0 } = frameAt(lng0, lat0)

  let capDeg = 0
  const boundary: [number, number, number][] = []
  for (let gi = 0; gi < GRID; gi++) {
    const lng = (x0 + (gi / (GRID - 1) - 0.5) * b.q) / DEG
    for (let gj = 0; gj < GRID; gj++) {
      const lat = latOfMercY(yLo + (gj / (GRID - 1)) * (yHi - yLo))
      const cam = cameraFor({ longitude: lng, latitude: lat, zoom: zLo }, canvas)
      const apart = Math.acos(Math.max(-1, Math.min(1, dot(cam.c, c0)))) / DEG
      capDeg = Math.max(capDeg, apart + reachDeg(cam))
      for (const u of footprintBoundary(cam, PER_SIDE)) boundary.push(u)
    }
  }
  capDeg = Math.min(180, capDeg * (1 + SLACK))
  const cosCap = Math.cos(capDeg * DEG)
  const win: CullWindow = {
    c0,
    e0,
    n0,
    kc: 2, // any eye outside the globe: the bounds below are infinite
    cosCap,
    capDeg,
    rect: false,
    xMin: -Infinity,
    xMax: Infinity,
    yMin: -Infinity,
    yMax: Infinity,
  }
  // The chart needs the whole cap in front of its horizon: 1/kc < cosCap.
  if (cosCap <= 0.02) return win
  const kRef = eyeDistance(zLo, lat0, b.height)
  const kc = Math.max(kRef, 1.0001 / cosCap)
  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (const u of boundary) {
    const z = kc - dot(u, c0)
    const x = dot(u, e0) / z
    const y = dot(u, n0) / z
    if (x < xMin) xMin = x
    if (x > xMax) xMax = x
    if (y < yMin) yMin = y
    if (y > yMax) yMax = y
  }
  const gx = (xMax - xMin) * SLACK
  const gy = (yMax - yMin) * SLACK
  return { ...win, kc, rect: true, xMin: xMin - gx, xMax: xMax + gx, yMin: yMin - gy, yMax: yMax + gy }
}
