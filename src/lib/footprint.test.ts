import { describe, expect, it } from 'vitest'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
import { rng } from '../test/fixtures'
import {
  MAX_LATITUDE,
  bucketKey,
  cameraFor,
  cullBucket,
  cullWindow,
  footprintBoundary,
  horizonDeg,
  isOnScreen,
  lngLatToUnit,
  projectUnit,
  reachDeg,
  unprojectPixel,
} from './footprint'

const DEG = Math.PI / 180
const CANVASES = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  { width: 375, height: 812 },
]
const LATS = [0, 45, 70, 85]
const ZOOMS = [3, 3.8, 4.5, 5.2, 6, 7, 8, 9, 10]

const unitToLngLat = (u: readonly number[]): [number, number] => [
  Math.atan2(u[1], u[0]) / DEG,
  Math.asin(Math.max(-1, Math.min(1, u[2]))) / DEG,
]
const angleDeg = (a: readonly number[], b: readonly number[]) =>
  Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / DEG

/**
 * deck.gl's own visibility of a lng/lat on a GlobeViewport: projected inside the canvas by
 * the viewport, and in front of the horizon as seen from the viewport's camera position
 * (a world point P on the globe of radius R faces the eye E iff P·E ≥ R²).
 */
function deckOnScreen(vp: InstanceType<typeof GlobeViewport>, lng: number, lat: number): boolean {
  const P = vp.projectPosition([lng, lat, 0])
  const E = vp.cameraPosition
  const R2 = P[0] * P[0] + P[1] * P[1] + P[2] * P[2]
  if (P[0] * E[0] + P[1] * E[1] + P[2] * E[2] < R2) return false
  const [x, y] = vp.project([lng, lat])
  return x >= 0 && x <= vp.width && y >= 0 && y <= vp.height
}

describe("the footprint model against deck.gl's GlobeViewport", () => {
  it('projects every front-facing point to the same pixel (within 0.01 px)', () => {
    const rand = rng(3)
    let worst = 0
    let checked = 0
    for (const canvas of CANVASES) {
      for (const lat of LATS) {
        for (const zoom of ZOOMS) {
          const view = { longitude: 30, latitude: lat, zoom }
          const vp = new GlobeViewport({ ...canvas, ...view })
          const cam = cameraFor(view, canvas)
          for (let i = 0; i < 60; i++) {
            const sx = rand() * canvas.width
            const sy = rand() * canvas.height
            const { u, hit } = unprojectPixel(cam, sx, sy)
            if (!hit) continue
            const [lng, la] = unitToLngLat(u)
            const p = projectUnit(cam, u)!
            const q = vp.project([lng, la])
            worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]), Math.hypot(p[0] - sx, p[1] - sy))
            // …and deck.gl unprojects the pixel to the same place on the globe.
            const back = vp.unproject([sx, sy])
            expect(angleDeg(u, lngLatToUnit(back[0], back[1]))).toBeLessThan(1e-5)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000)
    expect(worst).toBeLessThan(0.01)
  })

  it('classifies points on and off screen exactly as the viewport does, limb included', () => {
    const rand = rng(5)
    let onScreen = 0
    let behind = 0
    let mismatches = 0
    for (const canvas of CANVASES) {
      for (const lat of LATS) {
        for (const zoom of [3, 3.8, 5.2, 7, 9]) {
          const view = { longitude: -60, latitude: lat, zoom }
          const vp = new GlobeViewport({ ...canvas, ...view })
          const cam = cameraFor(view, canvas)
          const reach = reachDeg(cam)
          for (let i = 0; i < 400; i++) {
            // Points scattered up to 1.6× the footprint's reach from the center — on screen,
            // just off its edges, and (at low zoom) just behind the limb.
            const r = Math.min(179, reach * 1.6) * Math.sqrt(rand())
            const az = rand() * 2 * Math.PI
            const { c, e, n } = cam
            const s = Math.sin(r * DEG)
            const u = [0, 1, 2].map(
              (k) => Math.cos(r * DEG) * c[k] + s * (Math.cos(az) * e[k] + Math.sin(az) * n[k]),
            )
            const [lng, la] = unitToLngLat(u)
            const mine = isOnScreen(cam, u)
            const deck = deckOnScreen(vp, lng, la)
            if (mine !== deck) mismatches++
            if (mine) onScreen++
            if (u[0] * c[0] + u[1] * c[1] + u[2] * c[2] < 1 / cam.k) behind++
          }
        }
      }
    }
    expect(onScreen).toBeGreaterThan(4000)
    expect(behind).toBeGreaterThan(500) // the limb really was in play
    expect(mismatches).toBe(0)
  })

  it('reproduces the measured edge distances (right / top / corner, degrees)', () => {
    const at = (canvas: { width: number; height: number }, lat: number, zoom: number) => {
      const cam = cameraFor({ longitude: 0, latitude: lat, zoom }, canvas)
      const deg = (sx: number, sy: number) => angleDeg(unprojectPixel(cam, sx, sy).u, cam.c)
      return [deg(canvas.width, canvas.height / 2), deg(canvas.width / 2, 0), reachDeg(cam)].map(
        (d) => Math.round(d * 10) / 10,
      )
    }
    const c1280 = { width: 1280, height: 800 }
    expect(at(c1280, 0, 5.5)).toEqual([10.5, 6.3, 12.7])
    expect(at(c1280, 45, 5.5)).toEqual([7.3, 4.5, 8.7])
    expect(at(c1280, 70, 4)).toEqual([10.2, 6.1, 12.3])
    expect(at(c1280, 85, 4)).toEqual([2.5, 1.5, 2.9])
    expect(at({ width: 375, height: 812 }, 0, 4)).toEqual([8.4, 19.3, 21.6])
    // At zoom 4 on the equator the 1280×800 corner is past the limb: the reach is the
    // horizon, acos(1/k), not a point deck.gl's unproject could return.
    const cam = cameraFor({ longitude: 0, latitude: 0, zoom: 4 }, c1280)
    expect(unprojectPixel(cam, 0, 0).hit).toBe(false)
    expect(reachDeg(cam)).toBeCloseTo(horizonDeg(cam), 5)
    expect(at(c1280, 0, 4).slice(0, 2)).toEqual([36.6, 19])
  })

  it('clamps the camera latitude to the Mercator limit, like the viewport', () => {
    const canvas = { width: 900, height: 560 }
    const view = { longitude: 10, latitude: 89.5, zoom: 5 }
    const vp = new GlobeViewport({ ...canvas, ...view })
    const cam = cameraFor(view, canvas)
    const limit = cameraFor({ ...view, latitude: MAX_LATITUDE }, canvas)
    expect(cam).toEqual(limit)
    const [lng, lat] = unitToLngLat(unprojectPixel(cam, 100, 100).u)
    const q = vp.project([lng, lat])
    expect(Math.hypot(q[0] - 100, q[1] - 100)).toBeLessThan(0.01)
  })

  it('a 0 × 0 canvas (mid-layout) gives a finite camera and a finite window', () => {
    const view = { longitude: 0, latitude: 0, zoom: 5 }
    const cam = cameraFor(view, { width: 0, height: 0 })
    expect(Number.isFinite(cam.k) && cam.k > 1).toBe(true)
    for (const u of footprintBoundary(cam, 4)) expect(u.every(Number.isFinite)).toBe(true)
    const w = cullWindow(cullBucket(view, { width: 0, height: 0 }))
    for (const v of [w.capDeg, w.xMin, w.xMax, w.yMin, w.yMax]) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('the re-cull bucket', () => {
  const canvas = { width: 1280, height: 800 }
  const key = (lng: number, lat: number, zoom: number, c = canvas) =>
    bucketKey(cullBucket({ longitude: lng, latitude: lat, zoom }, c))

  it('changes with the canvas size', () => {
    expect(key(10, 20, 5)).not.toBe(key(10, 20, 5, { width: 1281, height: 800 }))
    expect(key(10, 20, 5)).not.toBe(key(10, 20, 5, { width: 1280, height: 799 }))
  })

  it('steps a sixth of the shorter canvas side, at any latitude', () => {
    // 133 px at zoom 5 is 133 / (512·32) of the world's 360° in longitude.
    const stepDeg = (800 / 6 / (512 * 32)) * 360
    for (const lat of [0, 60, 80]) {
      expect(key(0.45 * stepDeg, lat, 5)).toBe(key(0, lat, 5))
      expect(key(0.55 * stepDeg, lat, 5)).not.toBe(key(0, lat, 5))
    }
  })

  it('treats latitudes past the Mercator limit as the limit (what the viewport renders)', () => {
    expect(key(20, 89.9, 5)).toBe(key(20, MAX_LATITUDE, 5))
    expect(key(20, -90, 5)).toBe(key(20, -MAX_LATITUDE, 5))
  })

  it('is one key for ±180° and 540°', () => {
    expect(key(180, 40, 5)).toBe(key(-180, 40, 5))
    expect(key(540, 40, 5)).toBe(key(-180, 40, 5))
  })
})
