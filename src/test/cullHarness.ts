import { expect } from 'vitest'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
import { cullForView, cullKeyFor } from '../lib/lod'
import { MAX_LATITUDE } from '../lib/footprint'
import type { Canvas } from '../lib/footprint'
import type { GlobeViewState, LodData } from '../types'
import { makeLod, rng } from './fixtures'

/**
 * The cull's test harness (`lod.test.ts`, `cullWindow.test.ts`): deck.gl's own projection
 * as the oracle, equal-area synthetic tiers sized around a view, and the views that share
 * its re-cull key. Test-only — nothing in the app imports it.
 */

/** The render cap (VISION: "any zoom renders ≤ 120 k culled cells/frame"). */
export const CAP = 120_000
export const DEG = Math.PI / 180

export const view = (longitude: number, latitude: number, zoom: number): GlobeViewState => ({
  longitude,
  latitude,
  zoom,
})

/** A tier one cell over the cap — culled, so it keys on the camera; for key probes. */
const PROBE = makeLod('mid', 6, CAP + 1, () => [0, 0, 1])

/**
 * deck.gl's own on-screen test, by brute force over a tier: each cell's world position
 * (`GlobeViewport.projectPosition`'s formula) through the viewport's `pixelProjectionMatrix`
 * — exactly what `project()` does — inside the canvas, and in front of the horizon as seen
 * from the viewport's `cameraPosition` (P·E ≥ R² on the 256-unit globe).
 */
export class RealProjection {
  readonly px: Float64Array
  readonly py: Float64Array
  readonly pz: Float64Array
  readonly count: number
  constructor(data: LodData, count: number) {
    this.count = count
    this.px = new Float64Array(count)
    this.py = new Float64Array(count)
    this.pz = new Float64Array(count)
    for (let i = 0; i < count; i++) {
      const p = data.lat[i] * DEG
      const l = data.lng[i] * DEG
      this.px[i] = 256 * Math.sin(l) * Math.cos(p)
      this.py[i] = -256 * Math.cos(l) * Math.cos(p)
      this.pz[i] = 256 * Math.sin(p)
    }
  }

  /**
   * Indices (< count) of the cells on screen for `v` on `canvas`, per deck.gl — or within
   * `pad` px of the canvas border when `pad` is given.
   */
  onScreen(v: GlobeViewState, canvas: Canvas, pad = 0): number[] {
    const vp = new GlobeViewport({ ...canvas, longitude: v.longitude, latitude: v.latitude, zoom: v.zoom })
    const M = vp.pixelProjectionMatrix
    const [ex, ey, ez] = vp.cameraPosition
    const out: number[] = []
    for (let i = 0; i < this.count; i++) {
      const x0 = this.px[i]
      const y0 = this.py[i]
      const z0 = this.pz[i]
      if (x0 * ex + y0 * ey + z0 * ez < 256 * 256) continue
      const w = M[3] * x0 + M[7] * y0 + M[11] * z0 + M[15]
      const sx = (M[0] * x0 + M[4] * y0 + M[8] * z0 + M[12]) / w
      if (sx < -pad || sx > canvas.width + pad) continue
      const sy = (M[1] * x0 + M[5] * y0 + M[9] * z0 + M[13]) / w
      if (sy < -pad || sy > canvas.height + pad) continue
      out.push(i)
    }
    return out
  }
}

/** Great-circle distance in degrees. */
export function angDist(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const p1 = lat1 * DEG
  const p2 = lat2 * DEG
  const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos((lng1 - lng2) * DEG)
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG
}

/**
 * How far deck.gl draws the globe from a view's center (degrees): the canvas corner the
 * viewport unprojects, when that pixel hits the globe (it re-projects onto itself), else
 * the horizon. Independent of `footprint.ts` — it sizes the test tiers below.
 */
export function deckReach(v: GlobeViewState, canvas: Canvas): number {
  const vp = new GlobeViewport({ ...canvas, longitude: v.longitude, latitude: v.latitude, zoom: v.zoom })
  const E = vp.cameraPosition
  const horizon = Math.acos(256 / Math.hypot(E[0], E[1], E[2])) / DEG
  let reach = 0
  for (const [sx, sy] of [[0, 0], [canvas.width, 0], [0, canvas.height], [canvas.width, canvas.height]]) {
    const ll = vp.unproject([sx, sy])
    const back = vp.project(ll)
    if (Math.hypot(back[0] - sx, back[1] - sy) > 0.5) return horizon // the corner is off the globe
    reach = Math.max(reach, angDist(vp.longitude, vp.latitude, ll[0], ll[1]))
  }
  return reach
}

/** Cells of the local equal-area patch in each test tier; the rest are filler. */
export const LOCAL = 25_000

/**
 * An equal-area synthetic tier for one view: {@link LOCAL} cells uniform on the sphere
 * inside `radius` degrees of (`lng`, `lat`) — uniform in azimuth and in cos of the distance,
 * so equal counts per unit area — then filler at the antipode to lift the tier past the
 * 120 k cap so it is culled at all. The filler is never on screen and never in a window.
 */
export function localTier(lng: number, lat: number, radius: number, seed: number): LodData {
  const rand = rng(seed)
  const c = [Math.cos(lat * DEG) * Math.cos(lng * DEG), Math.cos(lat * DEG) * Math.sin(lng * DEG), Math.sin(lat * DEG)]
  // East / north at the center (a pole center gets an arbitrary but orthonormal frame).
  const e = Math.abs(c[2]) > 0.999999 ? [1, 0, 0] : [-Math.sin(lng * DEG), Math.cos(lng * DEG), 0]
  const n = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]]
  const cosR = Math.cos(Math.min(180, radius) * DEG)
  const filler: [number, number, number] = [lng > 0 ? lng - 180 : lng + 180, -lat, 1]
  const tier = makeLod('mid', 6, CAP + 1_000, () => filler)
  for (let i = 0; i < LOCAL; i++) {
    const cosT = 1 - rand() * (1 - cosR)
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
    const az = rand() * 2 * Math.PI
    const ca = Math.cos(az)
    const sa = Math.sin(az)
    const ux = cosT * c[0] + sinT * (ca * e[0] + sa * n[0])
    const uy = cosT * c[1] + sinT * (ca * e[1] + sa * n[1])
    const uz = cosT * c[2] + sinT * (ca * e[2] + sa * n[2])
    tier.lng[i] = Math.atan2(uy, ux) / DEG
    tier.lat[i] = Math.asin(Math.max(-1, Math.min(1, uz))) / DEG
    tier.population[i] = 1 + Math.floor(rand() * 1000)
  }
  return tier
}

/**
 * Views sharing the key of `v`: the key's extent found from the key itself (bisection
 * along longitude, latitude and zoom — no trust in the bucket arithmetic), its corners —
 * where the worst drift lives — at both ends of its zoom range, and random interior views.
 */
export function sameKeyViews(v: GlobeViewState, canvas: Canvas, rand: () => number, interior = 8): GlobeViewState[] {
  const keyOf = (lng: number, lat: number, z: number) => cullKeyFor(PROBE, view(lng, lat, z), canvas)
  const reach = (at: (t: number) => string, max: number): number => {
    const k0 = at(0)
    if (at(max) === k0) return max
    let lo = 0
    let hi = max
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2
      if (at(mid) === k0) lo = mid
      else hi = mid
    }
    return lo
  }
  const { longitude: lng, latitude: lat, zoom: z } = v
  const latLo = lat - reach((t) => keyOf(lng, Math.max(-90, lat - t), z), 90)
  const latHi = lat + reach((t) => keyOf(lng, Math.min(90, lat + t), z), 90)
  const lngLo = lng - reach((t) => keyOf(lng - t, lat, z), 180)
  const lngHi = lng + reach((t) => keyOf(lng + t, lat, z), 180)
  const zLo = z - reach((t) => keyOf(lng, lat, z - t), 0.5)
  const zHi = z + reach((t) => keyOf(lng, lat, z + t), 0.5)
  const clampLat = (la: number) => Math.max(-90, Math.min(90, la))
  const pts: GlobeViewState[] = []
  for (const la of [latLo, latHi]) {
    for (const ln of [lngLo, lngHi]) for (const zz of [zLo, zHi]) pts.push(view(ln, clampLat(la), zz))
  }
  for (let t = 0; t < interior; t++) {
    const mix = (a: number, b: number) => a + (b - a) * rand()
    pts.push(view(mix(lngLo, lngHi), clampLat(mix(latLo, latHi)), mix(zLo, zHi)))
  }
  const key0 = keyOf(lng, lat, z)
  const same = pts.filter((p) => cullKeyFor(PROBE, p, canvas) === key0)
  expect(same.length).toBeGreaterThanOrEqual(8) // the corners themselves are on the key
  return same
}

/** Tightness bound (Accept b): the selection is at most this multiple of the on-screen count. */
export const TIGHT = 2.5

export interface Coverage {
  /** Views checked (trigger + same-key). */
  views: number
  /** Worst selection ÷ on-screen over every checked view. */
  worstRatio: number
  /** Least on-screen count over the checked views (so a ratio means something). */
  minOnScreen: number
}

/**
 * The cull's contract for one triggering view: the tier is sized around the key's whole
 * extent; the cull made at `v` keeps every cell deck.gl draws on screen for `v` and for
 * every sampled view sharing its key (whenever the selection is under the cap — asserted,
 * so a miss is geometry, never the top-k); and the selection stays within
 * {@link TIGHT}× each of those views' on-screen counts.
 */
export function checkCoverage(v: GlobeViewState, canvas: Canvas, seed: number, checkTight = true): Coverage {
  const rand = rng(seed)
  const views = [v, ...sameKeyViews(v, canvas, rand)]
  // Centered where the viewport renders: it clamps the camera to the Mercator limit.
  const lat0 = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, v.latitude))
  const at = (p: GlobeViewState) => Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, p.latitude))
  let radius = 0
  for (const p of views) {
    radius = Math.max(radius, angDist(v.longitude, lat0, p.longitude, at(p)) + deckReach(p, canvas))
  }
  const tier = localTier(v.longitude, lat0, Math.min(179, radius * 1.25 + 0.05), seed)
  const real = new RealProjection(tier, LOCAL)
  const { indices } = cullForView(tier, v, canvas)
  expect(indices!.length).toBeLessThan(CAP) // under the cap: nothing may be dropped
  const kept = new Set(indices!)
  for (const i of indices!) expect(i).toBeLessThan(LOCAL) // no filler, ever
  let worstRatio = 0
  let minOnScreen = Infinity
  for (const p of views) {
    const on = real.onScreen(p, canvas)
    const missing = on.filter((i) => !kept.has(i))
    if (missing.length) {
      throw new Error(`cull at ${JSON.stringify(v)} misses ${missing.length}/${on.length} on-screen cells of ${JSON.stringify(p)} on ${canvas.width}×${canvas.height}`)
    }
    minOnScreen = Math.min(minOnScreen, on.length)
    if (on.length > 0) worstRatio = Math.max(worstRatio, kept.size / on.length)
  }
  if (checkTight) expect(worstRatio).toBeLessThanOrEqual(TIGHT)
  // The window is a function of the key: a cull made at any other view on it is the same.
  const corner = views[views.length > 1 ? 1 : 0]
  expect(Array.from(cullForView(tier, corner, canvas).indices!)).toEqual(Array.from(indices!))
  return { views: views.length, worstRatio, minOnScreen }
}

