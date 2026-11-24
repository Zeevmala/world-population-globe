import { describe, expect, it } from 'vitest'
import { cellArea, cellToLatLng, getHexagonAreaAvg, getPentagons, gridDisk, isPentagon, latLngToCell } from 'h3-js'
import { MANIFEST } from '../test/fixtures'
import { cellAreaKm2 } from './density'
import { cullBucket, cullWindow, lngLatToUnit } from './footprint'
import type { Canvas, CullWindow } from './footprint'
import { CAP, TIER_HYSTERESIS, tierEntry, wantedIndex } from './tierBands'
import {
  AREA_SLACK,
  CELL_AREA_FLOOR,
  H3_AREA_SCALE,
  VERTEX_ANGLE,
  cellAreaFloor,
  faceAngle,
  maxWindowCells,
  windowAreaKm2,
  windowWeight,
  worstWindowAreaKm2,
} from './tierFit'

const { lods } = MANIFEST
const CANVASES: Canvas[] = [
  { width: 900, height: 560 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  { width: 375, height: 812 },
  { width: 2560, height: 1080 },
]
const DEG = Math.PI / 180
/**
 * The bound the app's threshold is cut from, for a real view's own re-cull window: its ground
 * area × the most cells per mean-cell area it can meet at any longitude (`windowWeight`).
 */
const realBound = (lng: number, lat: number, zoom: number, canvas: Canvas, i: number) => {
  const w = cullWindow(cullBucket({ longitude: lng, latitude: lat, zoom }, canvas))
  return (windowAreaKm2(w) * windowWeight(w) * AREA_SLACK) / cellAreaKm2(lods[i].h3Res)
}

/** The icosahedron's vertices (res-0 pentagon centres) and face centres, from h3-js. */
const VERTICES = getPentagons(0).map((c) => {
  const [lat, lng] = cellToLatLng(c)
  return lngLatToUnit(lng, lat)
})
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const FACE_CENTRES: number[][] = []
for (let a = 0; a < 12; a++)
  for (let b = a + 1; b < 12; b++)
    for (let c = b + 1; c < 12; c++)
      if (dot(VERTICES[a], VERTICES[b]) > 0.4 && dot(VERTICES[b], VERTICES[c]) > 0.4 && dot(VERTICES[a], VERTICES[c]) > 0.4) {
        const s = [0, 1, 2].map((k) => VERTICES[a][k] + VERTICES[b][k] + VERTICES[c][k])
        const n = Math.hypot(...s)
        FACE_CENTRES.push(s.map((x) => x / n))
      }

/**
 * `windowWeight` by brute force: samples of the window on its cap's equal-area grid, each
 * weighed at its own exact place — no raster — with the same widening of θ the raster has
 * (half a raster cell, half a column of turn, the placement radius: 1.25°), at every turn of
 * 0.5° in longitude.
 */
function bruteWeight(w: CullWindow, rings = 32, azimuths = 64): number {
  const pts: number[][] = []
  for (let i = 0; i < rings; i++) {
    const d = 1 - ((i + 0.5) / rings) * (1 - w.cosCap)
    const s = Math.sqrt(Math.max(0, 1 - d * d))
    const depth = w.kc - d
    for (let j = 0; j < azimuths; j++) {
      const a = ((j + 0.5) * 2 * Math.PI) / azimuths
      const x = s * Math.cos(a)
      const y = s * Math.sin(a)
      if (w.rect && !(x >= w.xMin * depth && x <= w.xMax * depth && y >= w.yMin * depth && y <= w.yMax * depth)) continue
      pts.push([0, 1, 2].map((k) => d * w.c0[k] + x * w.e0[k] + y * w.n0[k]))
    }
  }
  const slack = 1.25 * DEG
  let best = 0
  for (let l = 0; l < 360; l += 0.5) {
    const c = Math.cos(l * DEG)
    const s = Math.sin(l * DEG)
    let sum = 0
    for (const u of pts) {
      const t = Math.min(VERTEX_ANGLE, faceAngle(u[0] * c - u[1] * s, u[0] * s + u[1] * c, u[2]) + slack)
      sum += 1 / (H3_AREA_SCALE * Math.cos(t) ** 3)
    }
    best = Math.max(best, sum / pts.length)
  }
  return best
}

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

describe('the bound falls as the zoom rises (the threshold search relies on it)', () => {
  it('maxWindowCells over a 1° band, zoom 2–10, five canvases, four latitudes: never up by more than sampling noise', () => {
    for (const canvas of CANVASES) {
      for (const lat of [1, 36, 61, 84]) {
        let last = Infinity
        for (let z = 2; z <= 10; z += 0.05) {
          const n = maxWindowCells(z, lat, canvas, 1, 1)
          expect(n, `${canvas.width}×${canvas.height} lat ${lat} z ${z.toFixed(2)}`).toBeLessThanOrEqual(last * 1.005)
          last = n
        }
      }
    }
  }, 60_000)
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

  it('the face centres inlined are H3’s: the normalized sums of each face’s three vertices (res-0 pentagons)', () => {
    expect(FACE_CENTRES).toHaveLength(20)
    for (const f of FACE_CENTRES) expect(faceAngle(f[0], f[1], f[2])).toBeLessThan(1e-6)
    // Every vertex is VERTEX_ANGLE from its nearest face centre — the farthest any point gets.
    for (const v of VERTICES) expect(faceAngle(v[0], v[1], v[2])).toBeCloseTo(VERTEX_ANGLE, 9)
    for (let k = 0; k < 2000; k++) {
      const z = 2 * ((k * 0.618034) % 1) - 1
      const l = (k * 137.508) % 360
      const u = lngLatToUnit(l, (Math.asin(z) * 180) / Math.PI)
      expect(faceAngle(u[0], u[1], u[2])).toBeLessThanOrEqual(VERTEX_ANGLE + 1e-12)
    }
  })

  it('every hexagon at r5–r8 is at least H3_AREA_SCALE · cos³θ × the mean — over the sphere and next to every vertex', () => {
    // H3 lays a uniform hexagon grid on each face's gnomonic plane, so a hexagon's area is
    // cos³θ (θ: its centre's angle to the nearest face centre) times a constant: 1.2066 ×
    // the mean, to within 0.1 %. Checked on ~37 k hexagons per resolution: 20 k spread
    // evenly over the sphere (a Fibonacci lattice) and every hexagon within 30 rings of
    // each of the 12 pentagons, where they are smallest.
    for (const res of [5, 6, 7, 8]) {
      const mean = getHexagonAreaAvg(res, 'km2')
      let min = Infinity
      let max = 0
      let nearVertex = Infinity
      const check = (c: string, vertex: boolean) => {
        if (isPentagon(c)) return
        const [lat, lng] = cellToLatLng(c)
        const r = cellArea(c, 'km2') / mean / cellAreaFloor(lat, lng)
        min = Math.min(min, r)
        max = Math.max(max, r)
        if (vertex) nearVertex = Math.min(nearVertex, cellArea(c, 'km2') / mean)
      }
      for (let k = 0; k < 20_000; k++) {
        const z = 1 - (2 * (k + 0.5)) / 20_000
        check(latLngToCell((Math.asin(z) * 180) / Math.PI, (k * 137.50776405) % 360 - 180, res), false)
      }
      for (const p of getPentagons(res)) for (const c of gridDisk(p, 30)) check(c, true)
      expect(min, `r${res}`).toBeGreaterThanOrEqual(1)
      expect(max, `r${res}`).toBeLessThan(1.002) // tight: the floor is the hexagons' own area
      expect(nearVertex).toBeLessThan(0.61) // the vertices' squeeze is in the sample
    }
  }, 30_000)

  it('at a vertex the floor is the uniform one; at a face centre, twice it', () => {
    for (const v of VERTICES) {
      const lat = (Math.asin(v[2]) * 180) / Math.PI
      const lng = (Math.atan2(v[1], v[0]) * 180) / Math.PI
      expect(cellAreaFloor(lat, lng)).toBeGreaterThan(CELL_AREA_FLOOR)
      expect(cellAreaFloor(lat, lng)).toBeLessThan(0.606)
    }
    for (const f of FACE_CENTRES) {
      const lat = (Math.asin(f[2]) * 180) / Math.PI
      const lng = (Math.atan2(f[1], f[0]) * 180) / Math.PI
      expect(cellAreaFloor(lat, lng)).toBeCloseTo(H3_AREA_SCALE, 6)
    }
  })
})

describe('the window weight (cells per mean-cell area, the most at any longitude)', () => {
  const windows: [Canvas, number, number][] = []
  for (const canvas of CANVASES) for (const [lat, zoom] of [[0, 4], [2.3, 5.5], [39.1, 4.5], [50.1, 7], [64.7, 3.5], [84, 6], [23.7, 9]] as const) windows.push([canvas, lat, zoom])

  it('agrees with brute force (every sample weighed at its own place, every 0.5° turn) within 0.5 %', () => {
    let lo = Infinity
    let hi = -Infinity
    for (const [canvas, lat, zoom] of windows) {
      const w = cullWindow(cullBucket({ longitude: 31, latitude: lat, zoom }, canvas))
      const r = windowWeight(w) / bruteWeight(w)
      lo = Math.min(lo, r)
      hi = Math.max(hi, r)
    }
    expect(lo).toBeGreaterThan(0.995)
    expect(hi).toBeLessThan(1.02) // the raster takes each cell's most: a little high, never much
  }, 60_000)

  it('lies between the largest cells’ weight and the smallest’s, and does not depend on the window’s longitude', () => {
    for (const [canvas, lat, zoom] of windows) {
      const at = (lng: number) => windowWeight(cullWindow(cullBucket({ longitude: lng, latitude: lat, zoom }, canvas)))
      const w0 = at(0)
      expect(w0).toBeGreaterThanOrEqual(1 / H3_AREA_SCALE)
      expect(w0).toBeLessThanOrEqual(1 / CELL_AREA_FLOOR)
      for (const lng of [-179.9, 57.3, 120]) expect(at(lng)).toBeCloseTo(w0, 2)
    }
  })

  it('a window next to a vertex weighs more than one between them, and a big window averages its vertex out', () => {
    const c = CANVASES[1]
    // r8-sized windows (zoom 9) at a vertex's latitude (39.1° N) are near the smallest-cell weight…
    const small = windowWeight(cullWindow(cullBucket({ longitude: 0, latitude: 39.1, zoom: 9 }, c)))
    expect(small).toBeGreaterThan(1.55)
    // …r5-sized ones (zoom 4.5) average over a wide spread of cell sizes.
    const big = windowWeight(cullWindow(cullBucket({ longitude: 0, latitude: 39.1, zoom: 4.5 }, c)))
    expect(big).toBeLessThan(1.3)
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
