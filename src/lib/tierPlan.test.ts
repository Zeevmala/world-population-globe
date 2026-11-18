import { describe, expect, it } from 'vitest'
import { MANIFEST } from '../test/fixtures'
import { MAX_ZOOM } from './camera'
import type { Canvas } from './footprint'
import { streamWanted } from './lod'
import { tierEntry } from './tierBands'
import { PREFETCH_LEAD, arrivalZoom, flightTier, pendingWholeTier, planView, wholeTiersFor } from './tierPlan'
import type { Flight } from './tierPlan'
import type { GlobeViewState } from '../types'

const { lods } = MANIFEST
const HARNESS: Canvas = { width: 900, height: 560 }
const C1280: Canvas = { width: 1280, height: 800 }
const C1920: Canvas = { width: 1920, height: 1080 }
const v = (longitude: number, latitude: number, zoom: number): GlobeViewState => ({ longitude, latitude, zoom })
const entryOf = (lod: string, lat: number, canvas: Canvas) =>
  tierEntry(lods, lods.findIndex((l) => l.lod === lod), lat, canvas)

interface Frame {
  view: GlobeViewState
  flight?: Flight | null
}
interface Request {
  lod: string
  frame: number
  zoom: number
}

/**
 * Drive the loader's decision (`useGlobeData`: request every tier in `wholeTiersFor` of
 * `planView`, once) over a camera path, as the hook does on each store change. A requested
 * tier "arrives" `arriveAfter` frames later (Infinity: nothing arrives during the run).
 * Returns the requests in order and what `DataStatus` reports on the last frame.
 */
function drive(frames: Frame[], canvas: Canvas, arriveAfter = Infinity, preloaded: string[] = []) {
  const requested: Request[] = []
  const due = new Map<string, number>()
  const loaded: Record<string, true> = {}
  for (const lod of preloaded) loaded[lod] = true
  frames.forEach(({ view, flight }, f) => {
    for (const [lod, at] of due) if (f >= at) loaded[lod] = true
    for (const entry of wholeTiersFor(planView(view, flight), canvas, MANIFEST, loaded)) {
      if (requested.some((r) => r.lod === entry.lod) || preloaded.includes(entry.lod)) continue
      requested.push({ lod: entry.lod, frame: f, zoom: view.zoom })
      due.set(entry.lod, f + arriveAfter)
    }
  })
  const last = frames[frames.length - 1]
  const status = pendingWholeTier(planView(last.view, last.flight), canvas, MANIFEST, loaded)?.lod ?? null
  return { lods: requested.map((r) => r.lod), requested, status }
}

/** A straight zoom path at one place, `step` zoom per frame (a wheel or pinch: no destination). */
function zoomPath(lng: number, lat: number, from: number, to: number, step = 0.02): Frame[] {
  const n = Math.round(Math.abs(to - from) / step)
  return Array.from({ length: n + 1 }, (_, i) => ({ view: v(lng, lat, from + ((to - from) * i) / n) }))
}

/** The store's fly-to tween (`Globe.tsx`: cubic ease over 1.6 s at 60 fps), `flyTarget` set until it lands. */
function flightPath(start: GlobeViewState, dest: Flight): Frame[] {
  const frames: Frame[] = []
  const n = 96
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  for (let i = 1; i <= n; i++) {
    const e = ease(i / n)
    const view = v(
      start.longitude + (dest.longitude - start.longitude) * e,
      start.latitude + (dest.latitude - start.latitude) * e,
      start.zoom + (dest.zoom - start.zoom) * e,
    )
    frames.push({ view, flight: i < n ? dest : null }) // `landed` clears it on the last frame
  }
  return frames
}

const HERO = v(25, 20, 1.3)

describe('(d) whole tiers are requested only when wanted or about to be', () => {
  it.each([[HARNESS], [C1280], [C1920]])('a zoom-in from the hero requests each whole tier %o before its threshold — and nothing for the tiled bands', (canvas) => {
    const path = [...zoomPath(25, 20, 1.3, 1.3, 1), ...zoomPath(77, 20, 1.3, 9.5)]
    const { requested } = drive(path, canvas, 10)
    expect(requested.map((r) => r.lod)).toEqual(['overview', 'r5', 'mid'])
    for (const r of requested.slice(1)) {
      const threshold = entryOf(r.lod, 20, canvas)
      // Within one wheel frame of PREFETCH_LEAD before the threshold: before it, not much before.
      expect(r.zoom).toBeLessThan(threshold)
      expect(r.zoom).toBeGreaterThanOrEqual(threshold - PREFETCH_LEAD)
      expect(r.zoom).toBeLessThan(threshold - PREFETCH_LEAD + 0.021)
    }
  })

  it.each([
    [HARNESS, 4.5, ['overview', 'r5'], 'r5'],
    [HARNESS, 6, ['overview', 'r5', 'mid'], 'mid'],
    [HARNESS, 9, ['overview'], null],
    // r5 starts at 4.91 here: prefetched; the view still wants the overview (whose first
    // load DataStatus does not report — the app's loading screen covers it).
    [C1280, 4.5, ['overview', 'r5'], 'overview'],
    [C1280, 6, ['overview', 'r5', 'mid'], 'r5'], // r5's band (4.91–6.19), r6 within the lead
    [C1280, 9, ['overview'], null], // r8's band (from 8.95): tiles only
    [C1920, 4.5, ['overview'], 'overview'], // r5 starts at 5.44: not yet within the lead
    [C1920, 6, ['overview', 'r5'], 'r5'], // r5's band (5.44–6.71), r6's lead starts at 6.21
    [C1920, 9, ['overview'], null], // r7's band (8.06–9.45): tiles only
  ])('a cold deep link on %o to zoom %d requests %o; DataStatus reports %s', (canvas, zoom, want, status) => {
    const { lods: got, status: pending } = drive([{ view: v(0, 0, zoom) }], canvas)
    expect(got).toEqual(want)
    expect(pending).toBe(status)
  })

  it('a cold deep link into r6’s band requests the 6 MB r5 first, as an interim, alongside the 31 MB r6', () => {
    const { requested, status } = drive([{ view: v(0, 0, 6) }], HARNESS)
    expect(requested.map((r) => [r.lod, r.frame])).toEqual([
      ['overview', 0],
      ['r5', 0],
      ['mid', 0],
    ])
    expect(status).toBe('mid') // "Loading 3 km detail · 31 MB"
    // Once r6 is in, nothing else is wanted: the interim is not re-requested at a later view.
    expect(wholeTiersFor(v(0, 0, 6), HARNESS, MANIFEST, { overview: true, mid: true }).map((l) => l.lod)).toEqual(['overview', 'mid'])
  })

  it('never strands a view: whatever whole tier a resting view wants is in its own request list', () => {
    for (const canvas of [HARNESS, C1280, C1920, { width: 375, height: 812 }, { width: 3840, height: 2160 }]) {
      for (const lat of [-85, -30, 0, 35.68, 60, 85]) {
        for (let zoom = -1; zoom <= MAX_ZOOM; zoom += 0.05) {
          const view = v(10, lat, zoom)
          const plan = wholeTiersFor(view, canvas, MANIFEST, {}).map((l) => l.lod)
          expect(plan[0]).toBe('overview')
          const pending = pendingWholeTier(view, canvas, MANIFEST, {})
          if (pending) expect(plan).toContain(pending.lod)
        }
      }
    }
  })
})

describe('zooming OUT after a cold deep link', () => {
  it('by wheel from 9 to 4.5: r6 (with r5 as its interim) when its band is entered, nothing before', () => {
    const { requested, status } = drive(zoomPath(0, 0, 9, 4.5), C1280, 30)
    expect(requested.map((r) => r.lod)).toEqual(['overview', 'r5', 'mid'])
    // Both on entering r6's band (r7 ends at 7.56 here), the 6 MB r5 first.
    const r7 = entryOf('r7', 0, C1280)
    expect(requested[1].zoom).toBeLessThan(r7)
    expect(requested[1].zoom).toBeGreaterThan(r7 - 0.03)
    expect(requested[2].frame).toBe(requested[1].frame)
    expect(status).toBe(null) // r5 arrived on the way down
  })

  it('by a ladder jump (one frame) or the zoom buttons (a flight), only the tier it lands on', () => {
    expect(drive([{ view: v(0, 0, 9) }, { view: v(0, 0, 4.5) }], C1280).lods).toEqual(['overview', 'r5'])
    const dest = { longitude: 0, latitude: 0, zoom: 4.5 }
    expect(drive(flightPath(v(0, 0, 9), dest), C1280).lods).toEqual(['overview', 'r5'])
  })
})

describe('(f) a fly-to requests only the tiers it stops in or falls back on', () => {
  const TOKYO = { longitude: 139.7, latitude: 35.68 }
  it.each([[HARNESS], [C1280], [C1920]])('hero → Tokyo at the arrival zoom on %o: the overview only, and no stream for a tier it crosses', (canvas) => {
    const zoom = arrivalZoom(MANIFEST, TOKYO.latitude, canvas)
    expect(zoom).toBeCloseTo(entryOf('r8', TOKYO.latitude, canvas) + 0.5, 9)
    const dest = { ...TOKYO, zoom }
    const path = flightPath(HERO, dest)
    // The camera passes through every band on the way…
    const crossed = new Set(path.map((f) => lods[[...lods.keys()].reverse().find((i) => f.view.zoom >= entryOf(lods[i].lod, f.view.latitude, canvas)) ?? 0].lod))
    expect(crossed).toEqual(new Set(['overview', 'r5', 'mid', 'r7', 'r8']))
    // …but the loader plans for where it ends: r8 is tiled, the overview is under it.
    const { lods: got, status } = drive(path, canvas)
    expect(got).toEqual(['overview'])
    expect(status).toBe(null)
    // The tile streams: r7 is never followed (the camera only crosses it; the overview is on
    // screen the whole way), r8 only once the camera has reached its band.
    const flight = flightTier(dest, canvas, MANIFEST)
    expect(flight).toBe('r8')
    const r7 = lods.findIndex((l) => l.lod === 'r7')
    const r8 = lods.findIndex((l) => l.lod === 'r8')
    for (const f of path) {
      const ft = flightTier(f.flight, canvas, MANIFEST)
      expect(streamWanted(lods, r7, f.view, canvas, 'overview', ft)).toBe(false)
      expect(streamWanted(lods, r8, f.view, canvas, 'overview', ft)).toBe(f.view.zoom >= entryOf('r8', f.view.latitude, canvas))
    }
  })

  it('a flight to a whole tier requests it at take-off — the destination is known', () => {
    const dest = { longitude: 77, latitude: 20, zoom: 4.4 }
    const { requested } = drive(flightPath(v(77, 20, 3.9), dest), HARNESS)
    expect(requested.map((r) => [r.lod, r.frame])).toEqual([
      ['overview', 0],
      ['r5', 0],
    ])
  })

  it('flightTier is null when nothing is flying; planView is the camera then', () => {
    expect(flightTier(null, C1280, MANIFEST)).toBe(null)
    expect(planView(HERO, null)).toBe(HERO)
  })
})

describe('arrivalZoom', () => {
  it('lands a place search half a zoom past r8’s threshold for the destination and canvas, never past MAX_ZOOM', () => {
    const r8 = lods.find((l) => l.lod === 'r8')!
    expect(arrivalZoom(MANIFEST)).toBeCloseTo(r8.minZoom + 0.5, 9) // no canvas yet: the nominal bands
    expect(arrivalZoom(MANIFEST, 0, HARNESS)).toBeCloseTo(entryOf('r8', 0, HARNESS) + 0.5, 9)
    expect(arrivalZoom(MANIFEST, 0, HARNESS)).toBeCloseTo(8.95, 2)
    expect(arrivalZoom(MANIFEST, 0, C1920)).toBeCloseTo(entryOf('r8', 0, C1920) + 0.5, 9)
    expect(arrivalZoom(MANIFEST, 60, HARNESS)).toBeCloseTo(entryOf('r8', 60, HARNESS) + 0.5, 9)
    expect(arrivalZoom(MANIFEST, 0, { width: 3840, height: 2160 })).toBe(MAX_ZOOM)
    expect(arrivalZoom(null)).toBe(MAX_ZOOM)
  })
})
