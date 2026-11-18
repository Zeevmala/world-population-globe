import { describe, expect, it } from 'vitest'
import { getHexagonAreaAvg, getPentagons, gridDisk, cellArea } from 'h3-js'
import { MANIFEST } from '../test/fixtures'
import { cellAreaKm2 } from './density'
import { cullBucket, cullWindow } from './footprint'
import type { Canvas } from './footprint'
import { CAP, TIER_HYSTERESIS, tierEntry, wantedIndex } from './tierBands'
import { AREA_SLACK, CELL_AREA_FLOOR, maxWindowCells, windowAreaKm2, worstWindowAreaKm2 } from './tierFit'

const { lods } = MANIFEST
const CANVASES: Canvas[] = [
  { width: 900, height: 560 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  { width: 375, height: 812 },
  { width: 2560, height: 1080 },
]
/** The bound the app's threshold is cut from, for a real view's own re-cull window. */
const realBound = (lng: number, lat: number, zoom: number, canvas: Canvas, i: number) =>
  (windowAreaKm2(cullWindow(cullBucket({ longitude: lng, latitude: lat, zoom }, canvas))) * AREA_SLACK) /
  (cellAreaKm2(lods[i].h3Res) * CELL_AREA_FLOOR)

describe('the window area', () => {
  it('the 128 × 256 grid is within 0.5 % of a 16× finer one', () => {
    for (const canvas of CANVASES) {
      for (const [lat, zoom] of [[0, 3.5], [35.68, 4.5], [60, 6], [80, 3], [10, 9]]) {
        const w = cullWindow(cullBucket({ longitude: 20, latitude: lat, zoom }, canvas))
        const fine = windowAreaKm2(w, 512, 1024)
        expect(Math.abs(windowAreaKm2(w) / fine - 1)).toBeLessThan(0.005)
      }
    }
  })

  it('shrinks as the zoom rises (the threshold search relies on it)', () => {
    for (const canvas of CANVASES) {
      for (const lat of [0, 35.68, 60, 84]) {
        let last = Infinity
        for (let z = 1; z <= 10; z += 0.05) {
          const a = worstWindowAreaKm2(z, lat, canvas)
          expect(a).toBeLessThanOrEqual(last * 1.002) // sampling noise only
          last = a
        }
      }
    }
  }, 30_000)
})

describe('the cell-area floor', () => {
  it('no H3 hexagon at r5–r8 is smaller than CELL_AREA_FLOOR × the mean (h3-js, around every pentagon)', () => {
    for (const res of [5, 6, 7, 8]) {
      const mean = getHexagonAreaAvg(res, 'km2')
      expect(cellAreaKm2(res)).toBeCloseTo(mean, 3)
      let min = Infinity
      for (const p of getPentagons(res)) {
        for (const c of gridDisk(p, 12)) if (c !== p) min = Math.min(min, cellArea(c, 'km2') / mean)
      }
      expect(min).toBeGreaterThanOrEqual(CELL_AREA_FLOOR)
      expect(min).toBeLessThan(0.62) // and the floor is not slack: the squeeze is real
    }
  })
})

describe('by construction: no window the app can serve holds more than the cap', () => {
  it('real re-cull windows at every tier’s threshold − 0.15 (held), across latitudes, longitudes and bucket alignments', () => {
    let worst = 0
    for (const canvas of CANVASES) {
      for (let k = 0; k < 24; k++) {
        const lat = (((k * 3.53 + 0.41) % 85) * (k % 2 ? 1 : -1))
        for (let i = 1; i < lods.length; i++) {
          const t = tierEntry(lods, i, lat, canvas)
          for (const dz of [0, 0.031, 0.062, 0.093, 0.124]) {
            for (const lng of [0, 13.7, 179.9]) {
              const z = t - TIER_HYSTERESIS + dz
              if (z > 10) continue
              const cells = realBound(lng, lat, z, canvas, i)
              worst = Math.max(worst, cells / CAP)
              expect(cells, `${canvas.width}×${canvas.height} ${lods[i].lod} lat ${lat.toFixed(2)} z ${z.toFixed(3)}`).toBeLessThanOrEqual(CAP)
            }
          }
        }
      }
    }
    expect(worst).toBeGreaterThan(0.9) // and the rule is not slack: some window comes close
  }, 60_000)

  // (D) The review's scan of the first cut (a 65 k on-screen budget): its worst windows on the
  // committed data — r5 held over Kazakhstan and Central Asia on 900×560 (178,800 cells),
  // the worst at a threshold itself (152,215), the worst mid / r7 / r8, and the two views
  // whose own cull dropped on-screen cells past the cap.
  it.each([
    ['r5', 900, 560, 58.75, 43.75, 3.161, true],
    ['r5', 900, 560, 66.25, 43.75, 3.161, true],
    ['r5', 900, 560, 71.25, 43.75, 3.161, true],
    ['mid', 900, 560, 26.25, 56.25, 4.182, true],
    ['r7', 1280, 800, 116.25, 33.75, 6.681, true],
    ['r8', 2560, 1080, 116.25, 33.75, 8.798, true],
    ['r5', 900, 560, 58.75, 48.75, 3.179, false],
    ['r5', 1280, 800, 73.75, 41.25, 3.726, true],
    ['r5', 2560, 1080, 51.25, 46.25, 4.472, false],
  ] as const)('former offender %s on %d×%d at (%d, %d) z%d: no longer selected there, and fits wherever it is', (lod, w, h, lng, lat, zoom, held) => {
    const canvas = { width: w, height: h }
    const i = lods.findIndex((l) => l.lod === lod)
    // At the zoom where the first cut drew it (held or entering), the tier is not selected now…
    expect(wantedIndex({ latitude: lat, zoom }, canvas, lods, held ? lod : null)).toBeLessThan(i)
    // …and where it is selected — from its threshold − 0.15, held — even a fully populated
    // world of the smallest H3 cells cannot overfill the view's own window, so the cull never
    // reaches its past-the-cap path (`lod.ts` keepPastCap stays a safety net).
    const t = tierEntry(lods, i, lat, canvas)
    for (const dz of [0, 0.06, 0.12, 0.5]) expect(realBound(lng, lat, t - TIER_HYSTERESIS + dz, canvas, i)).toBeLessThanOrEqual(CAP)
    expect(maxWindowCells(t - TIER_HYSTERESIS, lat, canvas, cellAreaKm2(lods[i].h3Res))).toBeLessThanOrEqual(CAP)
  })
})
