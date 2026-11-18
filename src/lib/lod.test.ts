import { describe, expect, it } from 'vitest'
import { _GlobeViewport as GlobeViewport } from '@deck.gl/core'
import { cullForView, cullKeyFor, cullWindowCells, pickLod, selectActive } from './lod'
import { MAX_LATITUDE, ZOOM_STEP, cullBucket, cullWindow } from './footprint'
import type { Canvas } from './footprint'
import { MANIFEST, makeLod, rng } from '../test/fixtures'
import { CAP, DEG, LOCAL, RealProjection, checkCoverage, localTier, view } from '../test/cullHarness'
import type { GlobeViewState, LodData } from '../types'

const tiny = (lod: string, h3Res: number): LodData => makeLod(lod, h3Res, 1, () => [0, 0, 1])

describe('pickLod', () => {
  const loaded = { overview: tiny('overview', 4), r5: tiny('r5', 5), mid: tiny('mid', 6) }

  it('returns null without a manifest', () => {
    expect(pickLod(3, null, loaded)).toBeNull()
  })

  it('picks the finest loaded tier whose band is reached', () => {
    expect(pickLod(1.3, MANIFEST, loaded)).toBe('overview')
    expect(pickLod(3.78, MANIFEST, loaded)).toBe('r5')
    expect(pickLod(5.18, MANIFEST, loaded)).toBe('mid')
    expect(pickLod(9, MANIFEST, loaded)).toBe('mid') // r8 is tiled — never in `loaded`
  })

  it('falls back to a coarser tier while the finer one is still loading', () => {
    expect(pickLod(4.5, MANIFEST, { overview: loaded.overview })).toBe('overview')
    expect(pickLod(6, MANIFEST, { overview: loaded.overview, r5: loaded.r5 })).toBe('r5')
    // A cold deep link loads the overview and the finest whole tier only (`tierPlan.ts`).
    expect(pickLod(4.5, MANIFEST, { overview: loaded.overview, mid: loaded.mid })).toBe('overview')
  })

  it('holds the active tier inside the hysteresis band, then yields', () => {
    // Zooming out of `r5`: it survives 0.15 below its 3.78 entry zoom…
    expect(pickLod(3.7, MANIFEST, loaded, 'r5')).toBe('r5')
    // …and gives way once the camera has clearly left.
    expect(pickLod(3.62, MANIFEST, loaded, 'r5')).toBe('overview')
    // Zooming in from `overview` gets no early entry.
    expect(pickLod(3.77, MANIFEST, loaded, 'overview')).toBe('overview')
  })
})

/**
 * The shipped band table (`MANIFEST` is pinned to `public/data/manifest.json` by
 * `scripts/bands.test.mjs`): one zoom inside each band, and the hysteresis at each of
 * the three thresholds — held 0.1 below on the way out, no early entry on the way in,
 * released 0.2 below.
 */
describe('the shipped band table', () => {
  const loaded = { overview: tiny('overview', 4), r5: tiny('r5', 5), mid: tiny('mid', 6) }
  const r8 = tiny('r8', 8)
  const tierAt = (zoom: number, active?: string) =>
    selectActive(view(139.7, 35.68, zoom), MANIFEST, loaded, r8, active).entry?.lod

  it('is overview → r5 → mid → r8, each band starting where the last ends', () => {
    expect(MANIFEST.lods.map((l) => [l.lod, l.h3Res])).toEqual([
      ['overview', 4],
      ['r5', 5],
      ['mid', 6],
      ['r8', 8],
    ])
    for (let i = 1; i < MANIFEST.lods.length; i++) {
      expect(MANIFEST.lods[i].minZoom).toBe(MANIFEST.lods[i - 1].maxZoom)
    }
  })

  it('zoom 3 → r4, 4.5 → r5, 6 → r6, 9 → r8', () => {
    expect(tierAt(3)).toBe('overview')
    expect(tierAt(4.5)).toBe('r5')
    expect(tierAt(6)).toBe('mid')
    expect(tierAt(9)).toBe('r8')
    expect(tierAt(10)).toBe('r8')
  })

  it.each([
    ['overview', 'r5'],
    ['r5', 'mid'],
    ['mid', 'r8'],
  ])('keeps hysteresis at the %s → %s threshold', (coarse, fine) => {
    const t = MANIFEST.lods.find((l) => l.lod === fine)!.minZoom
    expect(tierAt(t - 0.01, coarse)).toBe(coarse) // no early entry
    expect(tierAt(t, coarse)).toBe(fine)
    expect(tierAt(t - 0.1, fine)).toBe(fine) // held inside the band on the way out
    expect(tierAt(t - 0.2, fine)).toBe(coarse) // released past it
  })
})

describe('selectActive', () => {
  const loaded = { overview: tiny('overview', 4), r5: tiny('r5', 5), mid: tiny('mid', 6) }
  const r8 = tiny('r8', 8)

  it('prefers streamed r8 once its band is reached and tiles are merged', () => {
    expect(selectActive(view(0, 0, 8.5), MANIFEST, loaded, r8).entry?.lod).toBe('r8')
  })

  it('falls back to the finest whole tier while r8 has no cells', () => {
    expect(selectActive(view(0, 0, 8.5), MANIFEST, loaded, null).entry?.lod).toBe('mid')
    const empty = makeLod('r8', 8, 0, () => [0, 0, 0])
    expect(selectActive(view(0, 0, 8.5), MANIFEST, loaded, empty).entry?.lod).toBe('mid')
  })

  it('never shows r8 below its band, even with tiles merged', () => {
    expect(selectActive(view(0, 0, 6), MANIFEST, loaded, r8).entry?.lod).toBe('mid')
  })

  it('returns the data that belongs to the chosen entry', () => {
    const { entry, data } = selectActive(view(0, 0, 4.5), MANIFEST, loaded, null)
    expect(entry?.lod).toBe('r5')
    expect(data).toBe(loaded.r5)
  })
})

const C1280: Canvas = { width: 1280, height: 800 }
/** The canvas the render harness (`scripts/qa/render_qa.mjs`) drives. */
const HARNESS: Canvas = { width: 900, height: 560 }

describe('cullForView', () => {
  it('renders a tier at or under the cap whole', () => {
    const data = makeLod('overview', 4, 1000, (i) => [i % 360, 0, i])
    const cull = cullForView(data, view(0, 0, 1), C1280)
    expect(cull.indices).toBeNull()
    expect(cull.key).toBe('overview:all')
  })

  it('caps a dense window at exactly the top-k by population', () => {
    // 150 k cells, all on screen (z3 on 1280×800 at the equator shows ±45° N–S), with heavy ties.
    const rand = rng(1)
    const n = 150_000
    const data = makeLod('mid', 6, n, () => [
      (rand() - 0.5) * 40,
      (rand() - 0.5) * 40,
      Math.floor(rand() * 5000),
    ])
    const { indices } = cullForView(data, view(0, 0, 3), C1280)
    expect(indices).not.toBeNull()
    expect(indices!.length).toBe(CAP)

    const chosen = new Set(indices!)
    expect(chosen.size).toBe(CAP) // no duplicates

    // Top-k set semantics: nothing left out outranks anything kept.
    let minKept = Infinity
    let maxDropped = -Infinity
    for (let i = 0; i < n; i++) {
      const p = data.population[i]
      if (chosen.has(i)) minKept = Math.min(minKept, p)
      else maxDropped = Math.max(maxDropped, p)
    }
    expect(minKept).toBeGreaterThanOrEqual(maxDropped)

    // And the kept population equals a brute-force sort's.
    const sorted = Float32Array.from(data.population).sort().reverse()
    let expected = 0
    for (let i = 0; i < CAP; i++) expected += sorted[i]
    let got = 0
    for (const i of indices!) got += data.population[i]
    expect(got).toBe(expected)
  })

  it('never selects a cell outside the window, however populous', () => {
    const near = 125_000
    const far = 5_000
    const data = makeLod('mid', 6, near + far, (i) =>
      i < near ? [(i % 100) * 0.1, ((i / 100) | 0) * 0.01, 10] : [-170, 60, 1e6],
    )
    const { indices } = cullForView(data, view(5, 5, 3), C1280)
    expect(indices!.length).toBe(CAP)
    for (const i of indices!) expect(i).toBeLessThan(near)
  })

  it('returns every in-window cell when the window holds fewer than the cap', () => {
    const near = 100_000
    const far = 30_000
    const data = makeLod('mid', 6, near + far, (i) =>
      i < near ? [(i % 100) * 0.1, ((i / 100) | 0) * 0.01, 10] : [170, -70, 1e6],
    )
    const { indices } = cullForView(data, view(5, 5, 3), C1280)
    expect(indices!.length).toBe(near)
  })

  it('wraps the window across the antimeridian', () => {
    const n = CAP + 10
    // Everything far away except two cells either side of ±180°.
    const data = makeLod('mid', 6, n, (i) =>
      i === 0 ? [-179.5, 0, 5] : i === 1 ? [179.5, 0, 5] : [0, 0, 1],
    )
    const { indices } = cullForView(data, view(179.9, 0, 6), C1280)
    expect(Array.from(indices!).sort()).toEqual([0, 1])
  })

  it('past the cap, keeps every on-screen cell of the triggering view before the margin', () => {
    // A window over the cap whose screen holds fewer than the cap: the margin's cells are
    // the more populous, so a plain top-k over the window would drop on-screen cells.
    const canvas = C1280
    const v = view(77, 20, 5.2)
    const tier = localTier(77, 20, 25, 42)
    const real = new RealProjection(tier, LOCAL)
    const on = new Set(real.onScreen(v, canvas))
    // Densify: 40 k extra cells in the margin ring just past the screen, all very populous.
    const rand = rng(43)
    const extra = makeLod('mid', 6, tier.lng.length + 140_000, (i) => {
      if (i < tier.lng.length) return [tier.lng[i], tier.lat[i], on.has(i) ? 1 : tier.population[i]]
      // Uniform over a box around the screen; most fall in the margin, some on screen.
      return [77 + (rand() - 0.5) * 30, 20 + (rand() - 0.5) * 20, 1e6]
    })
    const realX = new RealProjection(extra, extra.lng.length)
    const onX = realX.onScreen(v, canvas)
    expect(onX.length).toBeLessThan(CAP)
    const { indices } = cullForView(extra, v, canvas)
    expect(indices!.length).toBe(CAP) // the window holds more than the cap
    const kept = new Set(indices!)
    expect(kept.size).toBe(CAP)
    expect(onX.filter((i) => !kept.has(i))).toEqual([]) // every on-screen cell, low population or not
    // …and the rest of the cap went to the margin's most populous cells: nothing in the
    // window left out outranks a margin cell kept. (Cells within half a pixel of the border
    // may be promoted by the on-screen test's rounding slack; they are not margin.)
    const onSet = new Set(realX.onScreen(v, canvas, 0.5))
    let minMarginKept = Infinity
    for (const i of indices!) if (!onSet.has(i)) minMarginKept = Math.min(minMarginKept, extra.population[i])
    let maxDropped = -Infinity
    for (const i of cullWindowCells(extra, v, canvas)) {
      if (!kept.has(i)) maxDropped = Math.max(maxDropped, extra.population[i])
    }
    expect(minMarginKept).toBeGreaterThanOrEqual(maxDropped)
    expect(minMarginKept).toBe(1e6)
  })

  it('past the cap with more than the cap on screen, selects nothing off screen', () => {
    const canvas = C1280
    const v = view(0, 0, 3.8)
    const rand = rng(44)
    // 360 k cells over ±60°: ~138 k on screen; the off-screen ones are the populous ones.
    const data = makeLod('mid', 6, 360_000, () => [(rand() - 0.5) * 120, (rand() - 0.5) * 120, 1])
    const real = new RealProjection(data, data.lng.length)
    const on = new Set(real.onScreen(v, canvas))
    for (let i = 0; i < data.lng.length; i++) if (!on.has(i)) data.population[i] = 1e6
    expect(on.size).toBeGreaterThan(CAP)
    const { indices } = cullForView(data, v, canvas)
    expect(indices!.length).toBe(CAP)
    // Half a pixel of rounding slack at the border may promote a cell; nothing farther out.
    const near = new Set(real.onScreen(v, canvas, 0.5))
    expect(indices!.filter((i) => !near.has(i)).length).toBe(0)
  })

  it('keeps a cell on the limb and drops one just behind it', () => {
    // Zoom 3 on a 1280×800 canvas at the equator: the limb is inside the canvas left and
    // right. Two cells on the equator, one 0.5° in front of the horizon, one 0.5° behind.
    const k = new GlobeViewport({ ...C1280, longitude: 0, latitude: 0, zoom: 3 }).cameraPosition
    const horizon = Math.acos(256 / Math.hypot(k[0], k[1], k[2])) / DEG
    const n = CAP + 10
    const data = makeLod('mid', 6, n, (i) =>
      i === 0 ? [horizon - 0.5, 0, 5] : i === 1 ? [horizon + 40, 0, 5] : [180, 0, 1],
    )
    const { indices } = cullForView(data, view(0, 0, 3), C1280)
    expect(Array.from(indices!)).toEqual([0])
  })
})

describe('cullForView — the window is the real footprint (against GlobeViewport)', () => {
  // (g) The memo key holds while the camera stays in one bucket — in position AND zoom — so
  // the cull made at any view on a key must cover the screen of every other view on it:
  // next to a pole, past the Mercator limit, at the antimeridian, at the bucket's corners
  // and both ends of its zoom range. The zooms are the ones culled tiers run at since the
  // re-band — r5 from 3.63 (its 3.78 entry less the hysteresis), mid, then the merged r8
  // tiles up to MAX_ZOOM 10 — on the render harness's 900×560 canvas (the (a) sweep in
  // `cullWindow.test.ts` covers 1280×800, 1920×1080 and 375×812).
  const anchors = [
    [0, 0],
    [-40, 45],
    [30, 70],
    [-120, 84.9],
    [10, 89.9], // past the Mercator limit: rendered (and keyed) at 85.05°
    [60, -89.9],
    [179.9, 45],
    [-179.9, 0],
    [179.8, -70],
  ]
  it.each([3.63, 3.874, 4.4, 5.03, 5.6249, 6.6, 7.9, 8.6, 9.4, 10])(
    '(g) a stale cull covers every view on its key at zoom %d — poles, antimeridian, bucket corners',
    (z) => {
      let views = 0
      anchors.forEach(([lng, lat], k) => {
        views += checkCoverage(view(lng, lat, z), HARNESS, 500 + k + 37 * z).views
      })
      expect(views).toBeGreaterThan(9 * 9)
    },
  )

  it('covers the pole when it is on screen, at every longitude', () => {
    // Below the culled zooms, but the model holds there too: at zoom 2.2 a view at the
    // Mercator limit shows the pole, and the cull keeps the cells all around it.
    const v = view(-20, 85, 2.2)
    checkCoverage(v, C1280, 900, false)
    const tier = localTier(0, 90, 0.5, 901) // a 0.5° patch around the pole: all of it on screen
    const { indices } = cullForView(tier, v, C1280)
    const bins = new Set<number>()
    for (const i of indices!) bins.add(Math.floor((tier.lng[i] + 180) / 10))
    expect(bins.size).toBe(36)
    expect(indices!.length).toBe(LOCAL)
  })

  it('a regression pair: zoomed out at one bucket corner, culled at the opposite corner', () => {
    // Cull at the top of a zoom bucket at the bucket's north-east corner, reuse at its
    // bottom at the south-west corner: the widest drift a key allows.
    const b = cullBucket(view(77, 20, 5.18), C1280)
    const lngAt = (f: number) => ((b.ix + f) * b.q) / DEG
    const latAt = (f: number) => Math.atan(Math.sinh((b.iy + f) * b.q)) / DEG
    const v0 = view(lngAt(0.4999), latAt(0.4999), b.zq + ZOOM_STEP / 2 - 1e-4)
    const v1 = view(lngAt(-0.5), latAt(-0.5), b.zq - ZOOM_STEP / 2)
    const probe = makeLod('mid', 6, CAP + 1, () => [0, 0, 1])
    expect(cullKeyFor(probe, v1, C1280)).toBe(cullKeyFor(probe, v0, C1280))
    expect(cullKeyFor(probe, view(lngAt(-0.5), latAt(-0.5), b.zq - ZOOM_STEP / 2 - 1e-6), C1280)).not.toBe(
      cullKeyFor(probe, v0, C1280),
    )
    const tier = localTier(77, 20, 25, 77)
    const kept = new Set(cullForView(tier, v0, C1280).indices!)
    const on = new RealProjection(tier, LOCAL).onScreen(v1, C1280)
    expect(on.length).toBeGreaterThan(1000)
    expect(on.filter((i) => !kept.has(i))).toEqual([])
  })

  it('sizes the window from the key, not from the view that triggered the cull', () => {
    // Both ends of one zoom bucket (5 ± 1/16) get the same window, hence the same cull.
    const tier = localTier(20, 40, 40, 3)
    const a = cullForView(tier, view(20, 40, 5 - ZOOM_STEP / 2), C1280)
    const b = cullForView(tier, view(20, 40, 5 + ZOOM_STEP / 2 - 1e-4), C1280)
    expect(b.key).toBe(a.key)
    expect(Array.from(b.indices!)).toEqual(Array.from(a.indices!))
  })

  it('no longer over-selects at high latitude: the window follows the screen, not a zoom-only radius', () => {
    // Same zoom, same canvas: at 70° N the screen spans a third of the ground it spans at
    // the equator (GlobeView scales by 1 / cos lat), and so does the window.
    const tier0 = localTier(30, 0, 30, 1)
    const tier70 = localTier(30, 70, 30, 1)
    const n0 = cullForView(tier0, view(30, 0, 5.5), C1280).indices!.length
    const n70 = cullForView(tier70, view(30, 70, 5.5), C1280).indices!.length
    expect(n70 / n0).toBeGreaterThan(0.08)
    expect(n70 / n0).toBeLessThan(0.16) // ≈ cos² 70° = 0.117
  })

  it('zoomed far out (a whole-globe key) stays finite and caps by population', () => {
    const rand = rng(9)
    const sphere = makeLod('mid', 6, 300_000, () => [
      rand() * 360 - 180,
      Math.asin(2 * rand() - 1) / DEG,
      Math.floor(rand() * 1000),
    ])
    const { indices } = cullForView(sphere, view(40, 50, 0), C1280)
    expect(indices!.length).toBe(CAP)
    const w = cullWindow(cullBucket(view(40, 50, 0), C1280))
    expect(Number.isFinite(w.cosCap)).toBe(true)
  })
})

describe('cullKeyFor', () => {
  const dense = makeLod('mid', 6, CAP + 1, () => [0, 0, 1])
  const key = (v: GlobeViewState, canvas: Canvas = C1280) => cullKeyFor(dense, v, canvas)

  it('is "none" without data and "<lod>:all" for a whole-rendered tier', () => {
    expect(cullKeyFor(undefined, view(0, 0, 3), C1280)).toBe('none')
    expect(cullKeyFor(tiny('overview', 4), view(0, 0, 3), C1280)).toBe('overview:all')
  })

  it('matches the key cullForView reports', () => {
    const v = view(12.3, 45.6, 3.2)
    expect(cullForView(dense, v, C1280).key).toBe(key(v))
  })

  it('(d) changes on a canvas resize, by a single pixel either way', () => {
    const v = view(77, 20, 5.5)
    expect(key(v, { width: 1281, height: 800 })).not.toBe(key(v))
    expect(key(v, { width: 1280, height: 801 })).not.toBe(key(v))
    expect(key(v, { width: 900, height: 560 })).not.toBe(key(v))
    expect(key(v, { width: 1280, height: 800 })).toBe(key(v))
  })

  it('steps by screen distance, the same at every latitude', () => {
    // A sixth of the 800 px side at zoom 5 is 133 px = 133 / (512·2^5) of 360° of longitude:
    // GlobeView, like Web Mercator, draws a degree of longitude the same width at any latitude.
    const stepDeg = (800 / 6 / (512 * 32)) * 360
    for (const lat of [0, 45, 70, -80]) {
      expect(key(view(0.45 * stepDeg, lat, 5))).toBe(key(view(0, lat, 5)))
      expect(key(view(0.55 * stepDeg, lat, 5))).not.toBe(key(view(0, lat, 5)))
    }
  })

  it('keys a latitude past the Mercator limit as the limit, and stays stable across the antimeridian', () => {
    for (const z of [3.6, 5, 8]) {
      expect(key(view(37, 90, z))).toBe(key(view(37, MAX_LATITUDE, z)))
      expect(key(view(37, 89.95, z))).toBe(key(view(37, MAX_LATITUDE, z)))
      expect(key(view(37, -90, z))).toBe(key(view(37, -MAX_LATITUDE, z)))
      expect(key(view(37, -90, z))).not.toBe(key(view(37, 90, z)))
    }
    // ±180 (and 540) are one meridian, so one key.
    expect(key(view(180, 40, 5))).toBe(key(view(-180, 40, 5)))
    expect(key(view(540, 40, 5))).toBe(key(view(-180, 40, 5)))
  })

  it('ignores sub-quantum camera drift and reacts to a real move', () => {
    // z5 on 1280×800 → step 133 px ≈ 2.93° of longitude (bucket ±1.46°).
    const base = key(view(0, 0, 5))
    expect(key(view(1, 1, 5))).toBe(base)
    expect(key(view(1, 1, 5.05))).toBe(base) // zoom quantized to 1/8
    expect(key(view(2, 0, 5))).not.toBe(base)
    expect(key(view(0, 0, 5.1))).not.toBe(base)
  })

  it('re-culls on a finer step as the camera zooms in', () => {
    // The same 1° nudge is nothing at z5 and a real move at z8.
    expect(key(view(1, 0, 5))).toBe(key(view(0, 0, 5)))
    expect(key(view(1, 0, 8))).not.toBe(key(view(0, 0, 8)))
  })
})
