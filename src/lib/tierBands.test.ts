import { describe, expect, it } from 'vitest'
import { MANIFEST } from '../test/fixtures'
import { RealProjection, localTier, view } from '../test/cullHarness'
import { MAX_ZOOM } from './camera'
import { cellAreaKm2 } from './density'
import { MAX_LATITUDE, keyCanvas } from './footprint'
import type { Canvas } from './footprint'
import { cullForView, cullKeyFor } from './lod'
import { hexWidthKm, pxPerKm, zoomForHexPx } from './screenScale'
import {
  BAND_PX,
  CACHED_CANVASES,
  CAP,
  TIER_HYSTERESIS,
  bandThresholds,
  coldBandCount,
  effectiveBands,
  floorEntry,
  latitudeShift,
  tierEntry,
  wantedIndex,
} from './tierBands'
import { maxWindowCells } from './tierFit'
import { selectParents } from './tiles'
import { TILE_CACHE_MAX } from '../data/tileStream'

const { lods } = MANIFEST
const lodAt = (lng: number, lat: number, zoom: number, canvas: Canvas, active?: string | null) =>
  lods[wantedIndex(view(lng, lat, zoom), canvas, lods, active)].lod
const idx = (lod: string) => lods.findIndex((l) => l.lod === lod)
const entryOf = (lod: string, lat: number, canvas: Canvas) => tierEntry(lods, idx(lod), lat, canvas)
/** A hexagon's width across flats in CSS px at the view center. */
const cellPx = (lod: string, zoom: number, lat: number) => hexWidthKm(lods[idx(lod)].h3Res) * pxPerKm(zoom, lat)

const HARNESS: Canvas = { width: 900, height: 560 }
const C1280: Canvas = { width: 1280, height: 800 }
const C1920: Canvas = { width: 1920, height: 1080 }
const PHONE: Canvas = { width: 375, height: 812 }
const WIDE: Canvas = { width: 2560, height: 1080 }
const DEG = Math.PI / 180

/**
 * Every tier's threshold for the five canvases at lat 0 / 35.68 / 60, in zoom and in cell px
 * across at the view center. Each is the later of the 3-px rule moved by latitude and the zoom
 * from which the tier's cull window cannot hold more than 120 k cells (held 0.15 below, worst
 * bucket alignment, cells as small as H3 makes them anywhere a window of the latitude band can
 * sit — `tierFit.ts`). Before the window was weighed by where H3's cells are small (the
 * uniform 0.6 × mean floor), the same table read — 900×560: r5 4.42 (4.7), mid 5.69 (4.3),
 * r7 7.06 (4.2), r8 8.45 (4.1) at the equator; 1280×800: 4.91 / 6.19 / 7.56 / 8.95 at the
 * equator, 4.66 / 5.91 / 7.27 / 8.65 at 35.68°, 4.06 / 5.26 / 6.58 / 7.96 at 60°; 1920×1080:
 * 5.44 / 6.71 / 8.06 / 9.45, 5.19 / 6.43 / 7.77 / 9.16, 4.58 / 5.77 / 7.09 / 8.47 — so r5 now
 * starts 0.22–0.25 zoom earlier on 1280×800 and 1920×1080 and mid 0.11–0.13 (`EARLIER`).
 */
const TABLE: [Canvas, number, [number, number][]][] = [
  [HARNESS, 0, [[4.17, 3.9], [5.58, 4], [7.02, 4.1], [8.44, 4.1]]],
  [HARNESS, 35.68, [[3.93, 4.1], [5.29, 4], [6.7, 4], [8.1, 4]]],
  [HARNESS, 60, [[3.34, 4.4], [4.64, 4.1], [6.01, 4], [7.39, 4]]],
  [C1280, 0, [[4.66, 5.5], [6.08, 5.6], [7.52, 5.7], [8.94, 5.8]]],
  [C1280, 35.68, [[4.42, 5.8], [5.79, 5.6], [7.2, 5.6], [8.59, 5.6]]],
  [C1280, 60, [[3.83, 6.2], [5.13, 5.8], [6.51, 5.7], [7.89, 5.6]]],
  [C1920, 0, [[5.2, 8], [6.58, 7.9], [8.02, 8.1], [9.44, 8.2]]],
  [C1920, 35.68, [[4.95, 8.3], [6.3, 8], [7.7, 8], [9.1, 8]]],
  [C1920, 60, [[4.36, 9], [5.64, 8.3], [7.01, 8.1], [8.39, 7.9]]],
  [PHONE, 0, [[3.78, 3], [5.18, 3], [6.64, 3.1], [8.05, 3.1]]],
  [PHONE, 35.68, [[3.48, 3], [4.9, 3], [6.33, 3.1], [7.72, 3.1]]],
  [PHONE, 60, [[2.88, 3.2], [4.24, 3.1], [5.63, 3.1], [7.02, 3.1]]],
  [WIDE, 0, [[5.56, 10.3], [6.8, 9.2], [8.22, 9.3], [9.64, 9.4]]],
  [WIDE, 35.68, [[5.3, 10.6], [6.5, 9.2], [7.9, 9.2], [9.29, 9.1]]],
  [WIDE, 60, [[4.7, 11.3], [5.84, 9.5], [7.21, 9.2], [8.59, 9.1]]],
]

/** The thresholds before the window was weighed (uniform 0.6 floor), r5 and mid, on the two desktop canvases. */
const EARLIER: [Canvas, number, number, number][] = [
  [C1280, 0, 4.91, 6.19],
  [C1280, 35.68, 4.66, 5.91],
  [C1280, 60, 4.06, 5.26],
  [C1920, 0, 5.44, 6.71],
  [C1920, 35.68, 5.19, 6.43],
  [C1920, 60, 4.58, 5.77],
]

describe('(b) the thresholds: the 3-px rule, unless the window rule starts a tier later', () => {
  it('the manifest bands are the model’s: each tier starts where its hexagon is 3 px across at the equator', () => {
    for (const l of lods.slice(1)) expect(Math.abs(l.minZoom - zoomForHexPx(l.h3Res, BAND_PX))).toBeLessThanOrEqual(0.02)
  })

  it.each(TABLE)('%o at lat %d: every threshold pinned, in zoom and cell px', (canvas, lat, want) => {
    for (let i = 1; i < lods.length; i++) {
      const z = tierEntry(lods, i, lat, canvas)
      expect(z, lods[i].lod).toBeCloseTo(want[i - 1][0], 2)
      expect(cellPx(lods[i].lod, z, lat), lods[i].lod).toBeCloseTo(want[i - 1][1], 1)
      // Selection switches exactly there.
      expect(lodAt(30, lat, z - 1e-6, canvas)).toBe(lods[i - 1].lod)
      expect(lodAt(30, lat, z, canvas)).toBe(lods[i].lod)
    }
  })

  it.each(TABLE)('%o at lat %d: pinned to the model — the 3-px floor, or the earliest zoom whose held window fits', (canvas, lat) => {
    const edge = Math.min(Math.floor(lat) + 1, MAX_LATITUDE) // the band's poleward edge, where the window is measured
    for (let i = 1; i < lods.length; i++) {
      const z = tierEntry(lods, i, lat, canvas)
      const floor = floorEntry(lods, i, lat)
      expect(z).toBeGreaterThanOrEqual(floor)
      const cell = cellAreaKm2(lods[i].h3Res)
      // At the band's edge the same effective threshold: held 0.15 below it, the widest window fits…
      const atEdge = z - latitudeShift(lat) + latitudeShift(edge)
      const band = edge - Math.floor(lat) // the views it holds for: the whole 1° band below the edge
      expect(maxWindowCells(atEdge - TIER_HYSTERESIS, edge, canvas, cell, band)).toBeLessThanOrEqual(CAP)
      // …and unless the 3-px rule decided, 1/64 zoom earlier it would not.
      if (z > floor + 1e-9) expect(maxWindowCells(atEdge - TIER_HYSTERESIS - 1 / 64, edge, canvas, cell, band)).toBeGreaterThan(CAP)
    }
  })

  it.each(EARLIER)('%o at lat %d: r5 starts ≥ 0.2 zoom and mid ≥ 0.1 zoom earlier than with the uniform floor', (canvas, lat, r5, mid) => {
    expect(r5 - entryOf('r5', lat, canvas)).toBeGreaterThanOrEqual(0.2)
    expect(mid - entryOf('mid', lat, canvas)).toBeGreaterThanOrEqual(0.1)
  })

  it('selection is the manifest’s nominal bands where neither rule moves them: the equator on canvases up to 400×700', () => {
    for (const canvas of [
      { width: 320, height: 568 },
      { width: 360, height: 640 },
      { width: 375, height: 667 },
      { width: 400, height: 700 },
      { width: 0, height: 0 },
    ]) {
      for (let i = 1; i < lods.length; i++) expect(tierEntry(lods, i, 0, canvas)).toBe(lods[i].minZoom)
    }
    // (With the uniform cell-area floor the window bound from 375×667.) From 390×844 up the
    // finer tiers' windows bind; on the render harness's 900×560 every tier is later.
    expect(tierEntry(lods, 4, 0, { width: 390, height: 844 })).toBeGreaterThan(lods[4].minZoom)
    for (let i = 1; i < lods.length; i++) expect(tierEntry(lods, i, 0, HARNESS)).toBeGreaterThan(lods[i].minZoom)
  })
})

describe('(a) latitude and canvas move the thresholds the way the model says', () => {
  it('at one zoom the tier steps finer as latitude rises — where the 3-px rule decides, at acos(2^(zoom − threshold))', () => {
    // On 320×568 nothing but the 3-px rule binds: at zoom 5, r6 (5.18) starts where
    // cos(lat) = 2^(5 − 5.18), r7 (6.59) where cos(lat) = 2^(5 − 6.59).
    const small = { width: 320, height: 568 }
    const latMid = Math.acos(2 ** (5 - lods[2].minZoom)) / DEG
    const latR7 = Math.acos(2 ** (5 - lods[3].minZoom)) / DEG
    expect(latMid).toBeCloseTo(28.03, 2)
    expect(latR7).toBeCloseTo(70.6, 1)
    for (const s of [1, -1]) {
      expect(lodAt(0, s * (latMid - 0.01), 5, small)).toBe('r5')
      expect(lodAt(0, s * (latMid + 0.01), 5, small)).toBe('mid')
      expect(lodAt(0, s * (latR7 - 0.01), 5, small)).toBe('mid')
      expect(lodAt(0, s * (latR7 + 0.01), 5, small)).toBe('r7')
    }
  })

  it('where the window rule decides, latitude moves the threshold down overall, stepping up < 0.15 at 1° band edges', () => {
    // The window rule is measured once per 1° band at its poleward edge, so within a band the
    // threshold falls smoothly with log2(cos φ) and at each band edge steps up by the band's
    // growth — the window's, and the weight of the smallest cells it can meet, which grows
    // where a band edge brings an icosahedron vertex's latitude closer: ≤ 0.03 zoom to 80°,
    // ≤ 0.09 at 84° — always under the 0.15 hysteresis, so a view parked on a band edge cannot
    // flap (tested below).
    for (const canvas of [HARNESS, C1280, C1920, PHONE, WIDE]) {
      for (let i = 1; i < lods.length; i++) {
        let prev = tierEntry(lods, i, 0, canvas)
        for (let lat = 0.05; lat <= 85; lat += 0.05) {
          const t = tierEntry(lods, i, lat, canvas)
          expect(t - prev).toBeLessThan(lat <= 80 ? 0.032 : 0.09)
          prev = t
        }
        expect(tierEntry(lods, i, 60, canvas)).toBeLessThan(tierEntry(lods, i, 8, canvas) - 0.5)
      }
    }
  }, 60_000) // measures all 86 latitude bands on five canvases (~12 ms each)

  it('at one zoom and latitude the tier steps coarser as the canvas grows', () => {
    for (const lat of [0, 35.68, 60]) {
      for (const zoom of [4.5, 5.5, 7, 8.5]) {
        let last = Infinity
        for (let width = 320; width <= 3840; width += 64) {
          const canvas = { width, height: Math.round((width * 9) / 16) }
          const i = wantedIndex(view(0, lat, zoom), canvas, lods)
          expect(i).toBeLessThanOrEqual(last)
          last = i
        }
      }
    }
  }, 60_000)
})

describe('order, floor and extremes', () => {
  const canvases: Canvas[] = [
    { width: 0, height: 0 },
    { width: 1, height: 1 },
    PHONE,
    HARNESS,
    C1280,
    C1920,
    WIDE,
    { width: 3840, height: 2160 },
    { width: Number.NaN, height: 800 },
  ]
  it('thresholds keep their order at any latitude and canvas; the overview is the floor', () => {
    for (const canvas of canvases) {
      for (const lat of [-90, -MAX_LATITUDE, -60, 0, 35.68, 60, 85, MAX_LATITUDE, 89.99, 90, 120, Number.NaN]) {
        const bands = effectiveBands(lods, lat, canvas)
        expect(bands[0].from).toBe(-Infinity)
        for (let i = 1; i < lods.length; i++) {
          expect(Number.isFinite(bands[i].from)).toBe(true)
          expect(bands[i].from).toBeGreaterThan(bands[i - 1].from)
          expect(bands[i].from).toBeGreaterThanOrEqual(floorEntry(lods, i, lat) - 1e-9)
          expect(bands[i - 1].to).toBe(bands[i].from)
        }
        // Fully zoomed out the overview, at any latitude — even at the clamp r5 starts past 0.
        expect(lodAt(0, lat, -1, canvas)).toBe('overview')
        expect(wantedIndex(view(0, lat, -50), canvas, lods)).toBe(0)
      }
    }
  })

  it('clamps latitude exactly where GlobeViewport (and footprint.ts) does; mirrors the hemispheres', () => {
    expect(latitudeShift(90)).toBe(Math.log2(Math.cos(MAX_LATITUDE * DEG)))
    expect(latitudeShift(-90)).toBe(Math.log2(Math.cos(MAX_LATITUDE * DEG)))
    expect(latitudeShift(Number.NaN)).toBe(0)
    for (const lat of [10, 35.68, 60, 84]) expect(bandThresholds(lods, C1280, -lat)).toEqual(bandThresholds(lods, C1280, lat))
  })

  it('a huge canvas only moves the thresholds later: 3840×2160 never reaches r8 at the equator', () => {
    expect(tierEntry(lods, 4, 0, { width: 3840, height: 2160 })).toBeGreaterThan(MAX_ZOOM)
    expect(lodAt(0, 0, MAX_ZOOM, { width: 3840, height: 2160 })).toBe('r7')
    expect(lodAt(139.7, 35.68, MAX_ZOOM, { width: 3840, height: 2160 })).toBe('r7')
    expect(lodAt(139.7, 60, MAX_ZOOM, { width: 3840, height: 2160 })).toBe('r8')
  })

  it('does not depend on longitude (the antimeridian included)', () => {
    for (const lng of [-180, -179.999, 0, 179.999, 180, 540]) {
      expect(lodAt(lng, 35.68, 6.5, C1280)).toBe(lodAt(0, 35.68, 6.5, C1280))
    }
  })

  it('leaves the hero view on the overview on any canvas', () => {
    for (const canvas of canvases) for (const zoom of [1.3, 1.9]) expect(lodAt(25, 20, zoom, canvas)).toBe('overview')
  })

  it('caches per key canvas: canvases within one 16 px step share their thresholds', () => {
    expect(bandThresholds(lods, { width: 1265, height: 785 }, 20)).toBe(bandThresholds(lods, C1280, 20))
    expect(keyCanvas({ width: 1265, height: 785 })).toEqual(C1280)
  })

  it('the cache is bounded: the last CACHED_CANVASES canvases used are kept, the oldest goes first', () => {
    const lat = 12.5
    const canvases = Array.from({ length: CACHED_CANVASES + 2 }, (_, k) => ({ width: 640 + 16 * k, height: 480 }))
    for (const c of canvases) bandThresholds(lods, c, lat)
    const n = coldBandCount()
    for (const c of canvases.slice(-CACHED_CANVASES)) bandThresholds(lods, c, lat)
    expect(coldBandCount()).toBe(n) // still there
    bandThresholds(lods, canvases[0], lat)
    expect(coldBandCount()).toBe(n + 1) // evicted, computed again
    // Reading a canvas makes it the most recent: it survives the next new one.
    bandThresholds(lods, canvases[canvases.length - 1], lat)
    bandThresholds(lods, { width: 2000, height: 480 }, lat)
    const m = coldBandCount()
    bandThresholds(lods, canvases[canvases.length - 1], lat)
    expect(coldBandCount()).toBe(m)
  })
})

describe('(c) no flapping at a threshold — in zoom, latitude, canvas, or all three', () => {
  /** Run a parked view through `frames` jittered frames, feeding the tier on screen back. */
  function park(frame: (t: number) => { lat: number; zoom: number; canvas: Canvas }, frames = 400): string[] {
    let active: string | null = null
    const seen: string[] = []
    for (let t = 0; t < frames; t++) {
      const { lat, zoom, canvas } = frame(t)
      active = lods[wantedIndex(view(10, lat, zoom), canvas, lods, active)].lod
      if (seen[seen.length - 1] !== active) seen.push(active)
    }
    return seen
  }
  const jitter = (t: number, amp: number) => amp * Math.sin(t * 1.7) * Math.cos(t * 0.31)

  it.each([['r5'], ['mid'], ['r7'], ['r8']])('parked on the %s threshold, the tier changes at most once', (lod) => {
    const lat0 = 35.68
    const z0 = entryOf(lod, lat0, C1280)
    // Zoom alone (±0.01), latitude alone (±0.1° — 0.0025 zoom of shift at 35°), canvas
    // alone (±2 px), and all three together: at most one change, never back.
    const cases = [
      (t: number) => ({ lat: lat0, zoom: z0 + jitter(t, 0.01), canvas: C1280 }),
      (t: number) => ({ lat: lat0 + jitter(t, 0.1), zoom: z0, canvas: C1280 }),
      (t: number) => ({ lat: lat0, zoom: z0, canvas: { width: 1280 + Math.round(jitter(t, 2)), height: 800 + Math.round(jitter(t + 3, 2)) } }),
      (t: number) => ({
        lat: lat0 + jitter(t + 1, 0.1),
        zoom: z0 + jitter(t + 2, 0.01),
        canvas: { width: 1280 + Math.round(jitter(t, 2)), height: 800 + Math.round(jitter(t + 3, 2)) },
      }),
    ]
    for (const c of cases) expect(park(c).length).toBeLessThanOrEqual(2)
  })

  it('parked on a 1° band edge where the threshold steps up most (84° N), latitude jitter does not flap', () => {
    for (const canvas of [HARNESS, C1280, C1920, PHONE, WIDE]) {
      for (const lod of ['r5', 'mid', 'r7', 'r8']) {
        for (const z0 of [entryOf(lod, 83.999, canvas), entryOf(lod, 84, canvas)]) {
          expect(park((t) => ({ lat: 84 + jitter(t, 0.05), zoom: z0, canvas })).length).toBeLessThanOrEqual(2)
        }
      }
    }
  }, 60_000)

  it('parked on ANY 1° band edge (where the cache cell changes), at each tier’s threshold either side of it: no flapping', () => {
    // The weight of the smallest cells a window can meet changes with the band (an
    // icosahedron vertex's latitude coming closer), so every band edge is a step of its own
    // (≤ 0.09 zoom, tested above): parked on each, in both hemispheres, at the threshold just
    // equatorward and just poleward of it, latitude jitter changes the tier at most once.
    let parks = 0
    for (const canvas of [HARNESS, C1280, C1920, PHONE, WIDE]) {
      for (const lod of ['r5', 'mid', 'r7', 'r8']) {
        for (let edge = 1; edge <= 85; edge++) {
          for (const sign of [1, -1]) {
            for (const z0 of [entryOf(lod, edge - 1e-6, canvas), entryOf(lod, edge, canvas)]) {
              const seen = park((t) => ({ lat: sign * (edge + jitter(t, 0.05)), zoom: z0, canvas }), 60)
              expect(seen.length, `${canvas.width}×${canvas.height} ${lod} edge ${sign * edge}`).toBeLessThanOrEqual(2)
              parks++
            }
          }
        }
      }
    }
    expect(parks).toBe(5 * 4 * 85 * 4)
  }, 120_000)

  it('a deliberate move past the hysteresis still switches — in either direction, by any of the three', () => {
    const z0 = entryOf('mid', 0, C1280)
    expect(park((t) => ({ lat: 0, zoom: z0 + (t < 200 ? 0.01 : -0.2), canvas: C1280 }))).toEqual(['mid', 'r5'])
    // Latitude: r6's threshold falls as the view moves north, so a view held at one zoom
    // enters r6 going north and leaves it coming back past the hysteresis.
    const z = entryOf('mid', 0, C1280) - 0.2
    expect(park((t) => ({ lat: t < 200 ? 50 : 0, zoom: z, canvas: C1280 }))).toEqual(['mid', 'r5'])
    // Canvas: shrinking the canvas lowers the threshold; growing it back past the slack yields.
    expect(park((t) => ({ lat: 0, zoom: z0 - 0.05, canvas: t < 200 ? { width: 900, height: 600 } : C1920 }))).toEqual(['mid', 'r5'])
  })

  it('the slack is the same 0.15 zoom of threshold whichever input moves', () => {
    const z0 = entryOf('r7', 0, C1280)
    expect(lodAt(0, 0, z0 - TIER_HYSTERESIS + 1e-9, C1280, 'r7')).toBe('r7')
    expect(lodAt(0, 0, z0 - TIER_HYSTERESIS - 1e-9, C1280, 'r7')).toBe('mid')
    expect(lodAt(0, 0, z0 - 1e-9, C1280, 'mid')).toBe('mid') // no early entry
  })
})

describe('the tiled tiers fit the 64-tile cache at their thresholds', () => {
  // Before: on 2560×1080 the visible r3 / r2 parents alone at a tiled tier's nominal entry
  // were 62–77 — over the cache. Thresholds that fit the window bring every canvas under.
  it.each([
    [{ width: 2560, height: 1080 }],
    [C1920],
    [C1280],
    [PHONE],
    [{ width: 3840, height: 2160 }],
  ])('%o: visible parents ≤ 64 at r7 and r8, threshold and hysteresis, lat 0 / 35.68 / 60', (canvas) => {
    for (const lod of ['r7', 'r8']) {
      const entry = lods.find((l) => l.lod === lod)!
      for (const lat of [0, 35.68, 60]) {
        for (const lng of [-4.8, 139.7]) {
          const z = entryOf(lod, lat, canvas)
          for (const zoom of [z, z - TIER_HYSTERESIS]) {
            if (zoom > MAX_ZOOM) continue
            const sel = selectParents(view(lng, lat, zoom), canvas, entry.tileParentRes!, TILE_CACHE_MAX)
            expect(sel.visible.length, `${lod} ${canvas.width}×${canvas.height} lat ${lat} z ${zoom.toFixed(2)}`).toBeLessThanOrEqual(TILE_CACHE_MAX)
          }
        }
      }
    }
  }, 60_000)
})

describe('(h) a window drag re-culls a handful of times, and never leaves the resized canvas uncovered', () => {
  it('1280×800 → 1300×820 in 1 px steps: two re-culls, one tier', () => {
    const tier = localTier(77, 20, 25, 7)
    const v = view(77, 20, 5.8)
    const keys = new Set<string>()
    const tiers = new Set<string>()
    for (let s = 0; s <= 20; s++) {
      const canvas = { width: 1280 + s, height: 800 + s }
      keys.add(cullKeyFor(tier, v, canvas))
      tiers.add(lodAt(77, 20, 6.3, canvas, 'mid'))
    }
    expect(keys.size).toBe(3) // 1280×800, then 1296×816 from 1281×801, 1312×832 from 1297×817
    expect(tiers).toEqual(new Set(['mid']))
  })

  it('every canvas sharing a key is covered by the cull made for any one of them (deck.gl’s projection)', () => {
    for (const [lng, lat, zoom, w0, h0] of [
      [77, 20, 5.8, 1280, 800],
      [139.7, 35.68, 8.3, 1920, 1080],
      [10, 70, 4.2, 375, 812],
      [179.9, -40, 6.5, 912, 560],
    ]) {
      const tier = localTier(lng, lat, 40 / 2 ** (zoom - 4), 11)
      const real = new RealProjection(tier, 25_000)
      const v = view(lng, lat, zoom)
      const top = keyCanvas({ width: w0, height: h0 })
      const sizes: Canvas[] = [
        top,
        { width: top.width - 15, height: top.height - 15 },
        { width: top.width, height: top.height - 15 },
        { width: top.width - 15, height: top.height },
        { width: top.width - 7.5, height: top.height - 14.5 },
      ]
      for (const trigger of sizes) {
        const kept = new Set(cullForView(tier, v, trigger).indices)
        expect(kept.size).toBeLessThan(120_000)
        for (const c of sizes) {
          expect(cullKeyFor(tier, v, c)).toBe(cullKeyFor(tier, v, trigger))
          const missing = real.onScreen(v, c).filter((i) => !kept.has(i))
          expect(missing, `${w0}×${h0} key: trigger ${trigger.width}×${trigger.height}, view ${c.width}×${c.height}`).toEqual([])
        }
      }
    }
  })
})
