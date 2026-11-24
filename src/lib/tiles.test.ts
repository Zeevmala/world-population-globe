import { describe, expect, it } from 'vitest'
import { cellToLatLng, getPentagons, getResolution, gridDisk, latLngToCell } from 'h3-js'
import { arcMeetsPlanes, cellOverlapsWindow, selectParents, tileKey, tileSetCovers } from './tiles'
import { ZOOM_STEP, cameraFor, cullBucket, cullWindow, unprojectPixel } from './footprint'
import type { Canvas } from './footprint'
import { TILE_CACHE_MAX } from '../data/tileStream'
import { makeLod, rng } from '../test/fixtures'
import type { GlobeViewState, TileSet } from '../types'

const view = (longitude: number, latitude: number, zoom: number): GlobeViewState => ({ longitude, latitude, zoom })
const CANVASES: [string, Canvas][] = [
  ['1280×800', { width: 1280, height: 800 }],
  ['1920×1080', { width: 1920, height: 1080 }],
  ['375×812', { width: 375, height: 812 }],
]
const DEG = 180 / Math.PI
const toLngLat = (u: readonly number[]): [number, number] => [
  Math.atan2(u[1], u[0]) * DEG,
  Math.asin(Math.max(-1, Math.min(1, u[2]))) * DEG,
]

/** Pixels within this many px of a canvas corner count as "the corner" for the corner-only tally. */
const CORNER_PX = 24

/**
 * The oracle: the parent (at `res`) under every pixel of the canvas border (1 px apart)
 * and of an interior grid (32 px apart), through the footprint model (held to deck.gl's
 * GlobeViewport within 0.01 px by `footprint.test.ts`). A parent overlapping the canvas
 * either crosses its border — and then contains border pixels — or lies wholly inside,
 * and is then far larger than the grid (an r3 cell is > 100 px across at zoom 7.84, an
 * r2 > 120 px at 6.44). Returns each parent hit, and whether it was hit only near a corner.
 */
function parentsOnScreen(v: GlobeViewState, canvas: Canvas, res: number, borderStep = 1): Map<string, boolean> {
  const cam = cameraFor(v, canvas)
  const { width: W, height: H } = cam
  const hits = new Map<string, boolean>() // parent → hit only near a corner so far
  const hit = (sx: number, sy: number) => {
    const [lng, lat] = toLngLat(unprojectPixel(cam, sx, sy).u)
    const p = latLngToCell(lat, lng, res)
    const nearCorner = Math.min(sx, W - sx) < CORNER_PX && Math.min(sy, H - sy) < CORNER_PX
    hits.set(p, (hits.get(p) ?? true) && nearCorner)
  }
  for (let x = 0; x <= W; x += borderStep) {
    hit(x, 0)
    hit(x, H)
  }
  for (let y = 0; y <= H; y += borderStep) {
    hit(0, y)
    hit(W, y)
  }
  for (let x = 16; x < W; x += 32) for (let y = 16; y < H; y += 32) hit(x, y)
  return hits
}

/** Views that share `v`'s tile key: `v` and two opposite corners of its bucket at the zoom range's ends. */
function viewsOnKey(v: GlobeViewState, canvas: Canvas): GlobeViewState[] {
  const b = cullBucket(v, canvas)
  const lngAt = (f: number) => ((b.ix + f) * b.q) * DEG
  const latAt = (f: number) => Math.atan(Math.sinh((b.iy + f) * b.q)) * DEG
  const lo = b.zq - ZOOM_STEP / 2
  const hi = b.zq + ZOOM_STEP / 2 - 1e-6
  const corners = [view(lngAt(-0.4999), latAt(-0.4999), lo), view(lngAt(0.4999), latAt(0.4999), lo), view(lngAt(0.4999), latAt(-0.4999), hi)]
  // A bucket cut by the antimeridian is two keys (one each side of ±180°): keep the corners on `v`'s.
  const out = [v, ...corners.filter((w) => tileKey(w, canvas) === tileKey(v, canvas))]
  expect(out.length).toBeGreaterThanOrEqual(Math.abs(v.longitude) > 179 ? 2 : 4)
  return out
}

/**
 * Sweep: for each canvas × zoom × latitude × longitude, select once, and check every view
 * on the key against the oracle. Returns what the oracle found missing, how many parents
 * were reached only through a canvas corner, and per canvas and zoom the worst case of
 * the visible set and of the visible set plus the whole ring (before the budget cut).
 */
function sweep(res: number, zooms: number[], lats: number[], lngs: number[]) {
  let cornerOnly = 0
  const missing: string[] = []
  const worst = new Map<string, { visible: number; withRing: number; kept: number }>()
  for (const [name, canvas] of CANVASES) {
    for (const z of zooms) {
      const w0 = { visible: 0, withRing: 0, kept: 0 }
      worst.set(`${name}@${z}`, w0)
      for (const lat of lats) {
        for (const lng of lngs) {
          const v = view(lng, lat, z)
          const sel = selectParents(v, canvas, res, TILE_CACHE_MAX)
          w0.visible = Math.max(w0.visible, sel.visible.length)
          w0.withRing = Math.max(w0.withRing, sel.visible.length + sel.ringSize)
          w0.kept = Math.max(w0.kept, sel.visible.length + sel.prefetch.length)
          const visible = new Set(sel.visible)
          for (const w of viewsOnKey(v, canvas)) {
            for (const [p, corner] of parentsOnScreen(w, canvas, res)) {
              if (!visible.has(p)) missing.push(`${name} z${z} ${lng},${lat} → view ${w.longitude.toFixed(3)},${w.latitude.toFixed(3)}@${w.zoom.toFixed(3)}: ${p}`)
              if (corner) cornerOnly++
            }
          }
        }
      }
    }
  }
  return { cornerOnly, worst, missing }
}

/**
 * Longitudes swept: Tokyo; −4.8°, where at the equator r3 cells are among the smallest
 * (next to the H3 pentagon at 2.3° N 5.2° W — the most parents per screen); and the
 * antimeridian.
 */
const LNGS = [139.7, -4.8, 179.95]

describe('selectParents — the parents overlapping the footprint (Accept a, b)', () => {
  it('(a) r3: every parent on screen is selected, for every view on the key — 1280×800, 1920×1080, 375×812 at zoom 8–10, lat 0 / 45 / 70', () => {
    const { cornerOnly, worst, missing } = sweep(3, [8, 8.5, 9, 9.5, 10], [0, 45, 70], LNGS)
    expect(missing).toEqual([])
    // The sweep did reach parents that overlap the screen only at a corner.
    expect(cornerOnly).toBeGreaterThan(0)
    for (const [k, w] of worst) {
      // The visible set alone always fits the 64-tile cache, and what is kept (visible +
      // the ring cut to the budget) never exceeds it, so a prefetch cannot evict the view.
      expect(w.visible, k).toBeLessThanOrEqual(TILE_CACHE_MAX)
      expect(w.kept, k).toBeLessThanOrEqual(TILE_CACHE_MAX)
      // The whole ring fits uncut everywhere but the widest case — 1920×1080 at zoom 8
      // over the smallest r3 cells: here 51 visible + 31 ring = 82 (49 + 31 before the key
      // rounded the canvas up to 16 px — 1080 → 1088, and the window ~1.5 % wider so it
      // covers every canvas on the key), so the ring is cut to its nearest 13 parents there
      // (pinned below so a change in either direction is seen). Since tier selection follows
      // the canvas, r8 is not selected there below zoom 9.0 (`tierBands.test.ts`).
      if (k !== '1920×1080@8') expect(w.withRing, k).toBeLessThanOrEqual(TILE_CACHE_MAX)
    }
    expect(worst.get('1920×1080@8')).toEqual({ visible: 51, withRing: 82, kept: 64 })
  }, 60_000)

  it('(b) r2: the same code selects r2 parents for an entry declaring tileParentRes 2 — zoom 6.44 / 7 / 7.9', () => {
    const { missing, worst } = sweep(2, [6.44, 7, 7.9], [0, 45, 70], LNGS)
    expect(missing).toEqual([])
    for (const [k, w] of worst) {
      expect(w.visible, k).toBeLessThanOrEqual(TILE_CACHE_MAX)
      expect(w.kept, k).toBeLessThanOrEqual(TILE_CACHE_MAX)
    }
    const sel = selectParents(view(10, 50, 7), CANVASES[0][1], 2, TILE_CACHE_MAX)
    for (const p of [...sel.visible, ...sel.prefetch]) expect(getResolution(p)).toBe(2)
  }, 60_000)

  it('(a) random views where the ground footprint is smallest: narrow canvases, zoom 9.5–10, |lat| 60–85.05', () => {
    // Seeded, not a handful of longitudes. The sampled overlap test this replaced fails it:
    // with that test swapped back in, these 600 views missed an on-screen parent 4 times
    // (19+ times in 1,500). Border every 2 px (the missed parents covered 100+ px of it).
    const rand = rng(20261118)
    const canvases: Canvas[] = [{ width: 375, height: 812 }, { width: 320, height: 568 }, { width: 1280, height: 800 }]
    const missing: string[] = []
    let views = 0
    for (let i = 0; i < 600; i++) {
      const canvas = canvases[i % canvases.length]
      const lat = (rand() < 0.5 ? -1 : 1) * (60 + 25.051129 * rand())
      const v = view(rand() * 360 - 180, lat, 9.5 + 0.5 * rand())
      const visible = new Set(selectParents(v, canvas, 3, TILE_CACHE_MAX).visible)
      for (const p of parentsOnScreen(v, canvas, 3, 2).keys()) {
        if (!visible.has(p)) missing.push(`${canvas.width}×${canvas.height} ${v.longitude.toFixed(3)},${v.latitude.toFixed(3)}@${v.zoom.toFixed(3)}: ${p}`)
      }
      views++
    }
    expect(views).toBe(600)
    expect(missing).toEqual([])
  }, 60_000)

  it('selects every parent on screen around an H3 pentagon', () => {
    const canvas = CANVASES[1][1]
    for (const res of [2, 3]) {
      for (const pent of getPentagons(res).slice(0, 4)) {
        const [lat, lng] = cellToLatLng(pent)
        const v = view(lng, lat, res === 3 ? 8 : 6.6)
        const sel = selectParents(v, canvas, res, TILE_CACHE_MAX)
        expect(sel.visible).toContain(pent)
        const visible = new Set(sel.visible)
        for (const p of parentsOnScreen(v, canvas, res).keys()) expect(visible.has(p)).toBe(true)
      }
    }
  })

  it('the ring is the next ring out: disjoint, adjacent to the visible set, nearest first, cut to the budget', () => {
    const v = view(139.7, 35.68, 8)
    const canvas = CANVASES[1][1]
    const sel = selectParents(v, canvas, 3, TILE_CACHE_MAX)
    const visible = new Set(sel.visible)
    expect(visible.size).toBe(sel.visible.length)
    const near = new Set(sel.visible.flatMap((p) => gridDisk(p, 1)))
    for (const p of sel.prefetch) {
      expect(visible.has(p)).toBe(false)
      expect(near.has(p)).toBe(true)
    }
    // Complete: every neighbour of a visible parent is either visible or in the ring.
    expect(new Set([...sel.visible, ...sel.prefetch])).toEqual(near)
    // Nearest first.
    const c = cameraFor(v, canvas).c
    const dist = (p: string) => {
      const [lat, lng] = cellToLatLng(p)
      const r = lat / DEG
      return -(Math.cos(r) * Math.cos(lng / DEG) * c[0] + Math.cos(r) * Math.sin(lng / DEG) * c[1] + Math.sin(r) * c[2])
    }
    const ds = sel.prefetch.map(dist)
    for (let i = 1; i < ds.length; i++) expect(ds[i]).toBeGreaterThanOrEqual(ds[i - 1] - 1e-3)
    // A smaller budget cuts the ring, never the visible set.
    const tight = selectParents(v, canvas, 3, sel.visible.length + 3)
    expect(tight.visible).toEqual(sel.visible)
    expect(tight.prefetch).toEqual(sel.prefetch.slice(0, 3))
    expect(selectParents(v, canvas, 3, 1).prefetch).toEqual([])
  })

  it('wraps across the antimeridian: parents on both sides of ±180°', () => {
    for (const lng of [179.95, -179.95]) {
      const sel = selectParents(view(lng, 0, 8), CANVASES[0][1], 3, TILE_CACHE_MAX)
      const lngs = sel.visible.map((p) => cellToLatLng(p)[1])
      expect(lngs.some((x) => x > 170)).toBe(true)
      expect(lngs.some((x) => x < -170)).toBe(true)
    }
  })

  it('clamps at the Mercator limit like the camera: lat 89 selects what lat 85.05 does', () => {
    const canvas = CANVASES[0][1]
    const a = selectParents(view(20, 89, 8), canvas, 3, TILE_CACHE_MAX)
    const b = selectParents(view(20, 85.051129, 8), canvas, 3, TILE_CACHE_MAX)
    expect(a.key).toBe(b.key)
    expect(new Set(a.visible)).toEqual(new Set(b.visible))
    expect(sweep(3, [8], [85.051129], [20]).missing).toEqual([])
  })

  it('a 0 × 0 canvas (mid-layout) selects the parent under the camera and nothing wild', () => {
    const sel = selectParents(view(139.7, 35.68, 8), { width: 0, height: 0 }, 3, TILE_CACHE_MAX)
    expect(sel.visible).toContain(latLngToCell(35.68, 139.7, 3))
    expect(sel.visible.length).toBeLessThanOrEqual(3)
  })

  it('re-selects once per bucket: a one-screen pan crosses a key every sixth of the shorter side', () => {
    const canvas = CANVASES[0][1]
    const keys = new Set<string>()
    const lng0 = 139.7
    const pxPerDeg = (512 * 2 ** 8) / 360 // GlobeView at the equator, CSS px per degree of longitude
    for (let x = 0; x <= canvas.width; x += 4) keys.add(tileKey(view(lng0 + x / pxPerDeg, 0, 8), canvas))
    // 1280 px / (800 px / 6) = 9.6 steps → 10 or 11 keys.
    expect(keys.size).toBeGreaterThanOrEqual(10)
    expect(keys.size).toBeLessThanOrEqual(11)
  })
})

describe('selectParents — regressions: on-screen parents a sampled overlap test dropped', () => {
  // Found by the tick-10 review with deck.gl's GlobeViewport.unproject as the oracle: small
  // ground footprints (narrow canvas, zoom 9.5–10, high latitude), where a cell edge crosses
  // the screen between the old boundary samples and no sample fell inside the window's cap.
  it.each([
    [375, 812, -126.735, 70.0, 9.734, '830299fffffffff'],
    [375, 812, 24.354, 76.396, 9.529, '830025fffffffff'], // Svalbard — has a tile
    [375, 812, -58.146, 75.562, 9.995, '830695fffffffff'], // has a tile
    [375, 812, -93.981, 78.008, 9.713, '83022bfffffffff'], // has a tile
    [1280, 800, 0.3, -84, 10, '83f168fffffffff'],
  ])('%i×%i at %f, %f, zoom %f selects %s', (width, height, lng, lat, zoom, parent) => {
    const canvas = { width, height }
    const v = view(lng, lat, zoom)
    const sel = selectParents(v, canvas, 3, TILE_CACHE_MAX)
    expect(parentsOnScreen(v, canvas, 3).has(parent)).toBe(true)
    expect(sel.visible).toContain(parent)
  })
})

describe('arcMeetsPlanes / cellOverlapsWindow — exact, not sampled', () => {
  const u = (lng: number, lat: number) => {
    const p = (lat * Math.PI) / 180
    const l = (lng * Math.PI) / 180
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]
  }
  // A cap of radius 0.001° around (0, 0): far smaller than any sample spacing.
  const tinyCap: [number[], number][] = [[u(0, 0), Math.cos((0.001 * Math.PI) / 180)]]

  it('an arc crossing a tiny cap with both ends far outside it meets it; one passing beside it does not', () => {
    expect(arcMeetsPlanes(u(-1, 0), u(1, 0), tinyCap)).toBe(true)
    expect(arcMeetsPlanes(u(-1, 0.0005), u(1, 0.0005), tinyCap)).toBe(true)
    expect(arcMeetsPlanes(u(-1, 0.002), u(1, 0.002), tinyCap)).toBe(false)
    expect(arcMeetsPlanes(u(0.5, 0), u(1, 0), tinyCap)).toBe(false) // the great circle does, the arc does not
  })

  it('needs one point inside every plane at once', () => {
    const west: [number[], number] = [[0, -1, 0], 0] // y ≤ 0: lng ≤ 0
    const east: [number[], number] = [[0, 1, 0], 0] // y ≥ 0: lng ≥ 0
    expect(arcMeetsPlanes(u(-1, 0), u(1, 0), [west, east])).toBe(true) // only at lng 0
    expect(arcMeetsPlanes(u(-1, 0), u(-0.5, 0), [west, east])).toBe(false)
  })

  it('a window wholly inside one cell: only that cell (the center cell) overlaps', () => {
    const v = view(139.7, 35.68, 10)
    const w = cullWindow(cullBucket(v, { width: 4, height: 4 }))
    const [lat, lng] = [Math.asin(w.c0[2]) * DEG, Math.atan2(w.c0[1], w.c0[0]) * DEG]
    const center = latLngToCell(lat, lng, 2)
    expect(cellOverlapsWindow(center, w, true)).toBe(true)
    for (const nb of gridDisk(center, 1).filter((c) => c !== center)) expect(cellOverlapsWindow(nb, w)).toBe(false)
    expect(selectParents(v, { width: 4, height: 4 }, 2, TILE_CACHE_MAX).visible).toEqual([center])
  })

  it('a cell wholly inside the window overlaps it (every edge is inside)', () => {
    const v = view(139.7, 35.68, 6.5)
    const w = cullWindow(cullBucket(v, { width: 1920, height: 1080 }))
    const inner = latLngToCell(35.68, 139.7, 4) // ~50 km across, the window ~2,000 km
    expect(cellOverlapsWindow(inner, w)).toBe(true)
  })
})

describe('tileSetCovers — does a published set draw this screen?', () => {
  const canvas = CANVASES[0][1]
  const data = makeLod('r8', 8, 10, () => [0, 0, 1])
  const publishedFor = (v: GlobeViewState): TileSet => {
    const sel = selectParents(v, canvas, 3, TILE_CACHE_MAX)
    return { lod: 'r8', parentRes: 3, status: 'ready', key: sel.key, settled: new Set(sel.visible), data, parents: sel.visible }
  }

  it('covers every view on its own key; never with no cells', () => {
    const v = view(139.7, 35.68, 8.5)
    const set = publishedFor(v)
    for (const w of viewsOnKey(v, canvas)) expect(tileSetCovers(set, w, canvas)).toBe(true)
    expect(tileSetCovers({ ...set, data: null }, v, canvas)).toBe(false)
    expect(tileSetCovers({ ...set, data: makeLod('r8', 8, 0, () => [0, 0, 0]) }, v, canvas)).toBe(false)
  })

  it('holds through a pan over parents it has, gives way at the first one it lacks — and never claims a screen it does not cover', () => {
    const v = view(139.7, 35.68, 8.5)
    const set = publishedFor(v)
    let held = 0
    let released = false
    for (let step = 1; step <= 400; step++) {
      const w = view(v.longitude + step * 0.004, v.latitude, v.zoom)
      const covers = tileSetCovers(set, w, canvas)
      if (tileKey(w, canvas) !== set.key && covers) held++
      // Soundness against the pixel oracle (border every px).
      if (covers) for (const p of parentsOnScreen(w, canvas, 3).keys()) expect(set.settled.has(p)).toBe(true)
      if (!covers) released = true
      if (released) break
    }
    // It held past the key change (the merged parents reach beyond the key's window)…
    expect(held).toBeGreaterThan(0)
    // …and let go before the screen left them.
    expect(released).toBe(true)
  })

  it('a zoom-out past the published parents falls back; a zoom-in stays', () => {
    const v = view(139.7, 35.68, 9)
    const set = publishedFor(v)
    expect(tileSetCovers(set, view(139.7, 35.68, 9.6), canvas)).toBe(true)
    expect(tileSetCovers(set, view(139.7, 35.68, 8.2), canvas)).toBe(false)
  })
})
