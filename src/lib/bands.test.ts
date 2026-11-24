import { describe, expect, it } from 'vitest'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
import { MANIFEST } from '../test/fixtures'
import { MAX_ZOOM, MIN_ZOOM } from './camera'
import { hexWidthKm, pxPerKm, zoomForHexPx } from './screenScale'

/**
 * The banding rule of `pipeline/tiers.py` (`BAND_PX`): a tier starts where its hexagon
 * is 3 CSS px across flats at the equator. Stated here as the oracle the shipped bands
 * are checked against — the app itself reads its bands only from the manifest.
 */
const BAND_PX = 3

/** km of great-circle arc per degree on the 6371 km sphere the model uses. */
const KM_PER_DEG = (2 * Math.PI * 6371) / 360

/** px/km at the view center as deck.gl's real GlobeViewport projects it (N–S and E–W). */
function measuredPxPerKm(zoom: number, lat: number): { ns: number; ew: number } {
  const lng = 30
  const vp = new GlobeViewport({ width: 1280, height: 800, longitude: lng, latitude: lat, zoom })
  const dist = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1])
  const dLat = 0.5 / KM_PER_DEG // ±0.5 km north–south
  const dLng = 0.5 / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180)) // ±0.5 km east–west
  return {
    ns: dist(vp.project([lng, lat - dLat]), vp.project([lng, lat + dLat])),
    ew: dist(vp.project([lng - dLng, lat]), vp.project([lng + dLng, lat])),
  }
}

describe('the on-screen scale model', () => {
  it("is within 1 % of GlobeViewport's px/km at lat 0 / 45 / 70, zoom 2–10", () => {
    let worst = 0
    for (const lat of [0, 45, 70]) {
      for (let zoom = 2; zoom <= 10; zoom += 0.5) {
        const model = pxPerKm(zoom, lat)
        const { ns, ew } = measuredPxPerKm(zoom, lat)
        worst = Math.max(worst, Math.abs(ns / model - 1), Math.abs(ew / model - 1))
      }
    }
    expect(worst).toBeLessThan(0.01)
  })

  it('reproduces the reference numbers (0.102 px/km at zoom 3, 1.637 at 7, lat 0)', () => {
    expect(pxPerKm(3)).toBeCloseTo(0.102, 3)
    expect(pxPerKm(5.5)).toBeCloseTo(0.579, 3)
    expect(pxPerKm(7)).toBeCloseTo(1.637, 3)
    expect(pxPerKm(7, 35.68)).toBeCloseTo(2.015, 2)
  })

  it('measures a hexagon across flats from the mean H3 area', () => {
    // √(2A/√3): 17.1 km at r5, 6.46 km at r6, 0.92 km at r8.
    expect(hexWidthKm(5)).toBeCloseTo(17.09, 2)
    expect(hexWidthKm(6)).toBeCloseTo(6.459, 3)
    expect(hexWidthKm(8)).toBeCloseTo(0.9227, 4)
    for (const res of [5, 6, 8]) {
      expect(hexWidthKm(res) * pxPerKm(zoomForHexPx(res, BAND_PX))).toBeCloseTo(BAND_PX, 9)
    }
  })
})

describe('the shipped bands', () => {
  const lods = MANIFEST.lods

  it('start where each tier is 3 px across at the equator (within 0.02 zoom)', () => {
    for (const l of lods.slice(1)) {
      expect(Math.abs(l.minZoom - zoomForHexPx(l.h3Res, BAND_PX))).toBeLessThanOrEqual(0.02)
    }
    // The numbers the rule gives — r5 ≈ 3.78, r6 ≈ 5.18, r8 ≈ 7.99.
    expect(zoomForHexPx(5, BAND_PX)).toBeCloseTo(3.779, 3)
    expect(zoomForHexPx(6, BAND_PX)).toBeCloseTo(5.182, 3)
    expect(zoomForHexPx(8, BAND_PX)).toBeCloseTo(7.99, 2)
  })

  it('tile the camera range: contiguous, ordered by resolution, open at both ends', () => {
    for (let i = 1; i < lods.length; i++) {
      expect(lods[i].h3Res).toBeGreaterThan(lods[i - 1].h3Res)
      expect(lods[i].minZoom).toBe(lods[i - 1].maxZoom)
      expect(lods[i].minZoom).toBeGreaterThan(lods[i - 1].minZoom)
    }
    expect(lods[0].minZoom).toBeLessThanOrEqual(MIN_ZOOM)
    expect(lods[lods.length - 1].maxZoom).toBeGreaterThanOrEqual(MAX_ZOOM)
  })

  it('reach r8 two zoom levels before the maximum, where an r8 cell is ~12 px', () => {
    const r8 = lods[lods.length - 1]
    expect(MAX_ZOOM - r8.minZoom).toBeGreaterThan(2)
    expect(hexWidthKm(8) * pxPerKm(MAX_ZOOM)).toBeGreaterThan(12)
    expect(hexWidthKm(8) * pxPerKm(MAX_ZOOM)).toBeLessThan(12.2)
  })
})
