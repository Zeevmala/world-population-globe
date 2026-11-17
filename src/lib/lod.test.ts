import { describe, expect, it } from 'vitest'
import { cullForView, cullKeyFor, cullRadiusDeg, pickLod, selectActive } from './lod'
import { MANIFEST, makeLod, rng } from '../test/fixtures'
import type { GlobeViewState, LodData } from '../types'

/** The render cap (VISION: "any zoom renders ≤ 120 k culled cells/frame"). */
const CAP = 120_000

const view = (longitude: number, latitude: number, zoom: number): GlobeViewState => ({
  longitude,
  latitude,
  zoom,
})

const tiny = (lod: string, h3Res: number): LodData => makeLod(lod, h3Res, 1, () => [0, 0, 1])

describe('pickLod', () => {
  const loaded = { overview: tiny('overview', 4), mid: tiny('mid', 6) }

  it('returns null without a manifest', () => {
    expect(pickLod(3, null, loaded)).toBeNull()
  })

  it('picks the finest loaded tier whose band is reached', () => {
    expect(pickLod(1.3, MANIFEST, loaded)).toBe('overview')
    expect(pickLod(2.2, MANIFEST, loaded)).toBe('mid')
    expect(pickLod(6, MANIFEST, loaded)).toBe('mid') // r8 is tiled — never in `loaded`
  })

  it('falls back to a coarser tier while the finer one is still loading', () => {
    expect(pickLod(3, MANIFEST, { overview: loaded.overview })).toBe('overview')
  })

  it('holds the active tier inside the hysteresis band, then yields', () => {
    // Zooming out of `mid`: it survives 0.15 below its 2.2 entry zoom…
    expect(pickLod(2.1, MANIFEST, loaded, 'mid')).toBe('mid')
    // …and gives way once the camera has clearly left.
    expect(pickLod(2.04, MANIFEST, loaded, 'mid')).toBe('overview')
    // Zooming in from `overview` gets no early entry.
    expect(pickLod(2.19, MANIFEST, loaded, 'overview')).toBe('overview')
  })
})

describe('selectActive', () => {
  const loaded = { overview: tiny('overview', 4), mid: tiny('mid', 6) }
  const r8 = tiny('r8', 8)

  it('prefers streamed r8 once its band is reached and tiles are merged', () => {
    expect(selectActive(view(0, 0, 5), MANIFEST, loaded, r8).entry?.lod).toBe('r8')
  })

  it('falls back to the finest whole tier while r8 has no cells', () => {
    expect(selectActive(view(0, 0, 5), MANIFEST, loaded, null).entry?.lod).toBe('mid')
    const empty = makeLod('r8', 8, 0, () => [0, 0, 0])
    expect(selectActive(view(0, 0, 5), MANIFEST, loaded, empty).entry?.lod).toBe('mid')
  })

  it('applies hysteresis to the r8 threshold too', () => {
    expect(selectActive(view(0, 0, 4.4), MANIFEST, loaded, r8, 'r8').entry?.lod).toBe('r8')
    expect(selectActive(view(0, 0, 4.4), MANIFEST, loaded, r8, 'mid').entry?.lod).toBe('mid')
  })

  it('returns the data that belongs to the chosen entry', () => {
    const { entry, data } = selectActive(view(0, 0, 3), MANIFEST, loaded, null)
    expect(entry?.lod).toBe('mid')
    expect(data).toBe(loaded.mid)
  })
})

describe('cullForView', () => {
  it('renders a tier at or under the cap whole', () => {
    const data = makeLod('overview', 4, 1000, (i) => [i % 360, 0, i])
    const cull = cullForView(data, view(0, 0, 1))
    expect(cull.indices).toBeNull()
    expect(cull.key).toBe('overview:all')
  })

  it('caps a dense window at exactly the top-k by population', () => {
    // 150 k cells, all inside the window (z3 → ±33.75°), with heavy ties.
    const rand = rng(1)
    const n = 150_000
    const data = makeLod('mid', 6, n, () => [
      (rand() - 0.5) * 40,
      (rand() - 0.5) * 40,
      Math.floor(rand() * 5000),
    ])
    const { indices } = cullForView(data, view(0, 0, 3))
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
      i < near ? [(i % 100) * 0.1, ((i / 100) | 0) * 0.01, 10] : [0, 80, 1e6],
    )
    const { indices } = cullForView(data, view(5, 5, 3))
    expect(indices!.length).toBe(CAP)
    for (const i of indices!) expect(i).toBeLessThan(near)
  })

  it('returns every in-window cell when the window holds fewer than the cap', () => {
    const near = 100_000
    const far = 30_000
    const data = makeLod('mid', 6, near + far, (i) =>
      i < near ? [(i % 100) * 0.1, ((i / 100) | 0) * 0.01, 10] : [170, -70, 1e6],
    )
    const { indices } = cullForView(data, view(5, 5, 3))
    expect(indices!.length).toBe(near)
  })

  it('wraps the longitude window across the antimeridian', () => {
    const n = CAP + 10
    // Everything far away except two cells either side of ±180°.
    const data = makeLod('mid', 6, n, (i) =>
      i === 0 ? [-179.5, 0, 5] : i === 1 ? [179.5, 0, 5] : [0, 0, 1],
    )
    const { indices } = cullForView(data, view(179.9, 0, 6))
    expect(Array.from(indices!).sort()).toEqual([0, 1])
  })
})

/** Great-circle distance in degrees (float64; acos argument clamped, so never NaN). */
const DEG = Math.PI / 180
function angDist(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const p1 = lat1 * DEG
  const p2 = lat2 * DEG
  const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos((lng1 - lng2) * DEG)
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG
}

/** The viewport's own angular half-extent at a zoom (what the cull window must cover). */
const viewportAt = (zoom: number) => Math.min(60, 180 / 2 ** zoom)
/** Boundary slack for float32 coordinates vs the float64 brute force (degrees). */
const EPS = 1e-6

describe('cullForView — spherical cap on an equal-area tier', () => {
  // Uniform on the sphere: uniform in lng and in sin(lat) — equal cell counts per unit area.
  // 300 k: above the 120 k cap (so the tier is culled at all) while the widest mid-tier
  // window (zoom 2.05 → r = 67.5°, 31 % of the sphere) still holds fewer than the cap.
  const N = 300_000
  const rand = rng(7)
  const sphere = makeLod('mid', 6, N, () => [
    rand() * 360 - 180,
    Math.asin(2 * rand() - 1) / DEG,
    Math.floor(rand() * 1000),
  ])

  // Unit vectors (float64) for a trig-free brute force over all N cells.
  const ux = new Float64Array(N)
  const uy = new Float64Array(N)
  const uz = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    const p = sphere.lat[i] * DEG
    const l = sphere.lng[i] * DEG
    ux[i] = Math.cos(p) * Math.cos(l)
    uy[i] = Math.cos(p) * Math.sin(l)
    uz[i] = Math.sin(p)
  }
  /** Every cell strictly inside `radius` (less EPS) of the view center, by brute force. */
  const brute = (v: GlobeViewState, radius: number): number[] => {
    const p = v.latitude * DEG
    const l = v.longitude * DEG
    const cx = Math.cos(p) * Math.cos(l)
    const cy = Math.cos(p) * Math.sin(l)
    const cz = Math.sin(p)
    const minDot = Math.cos((radius - EPS) * DEG)
    const inside: number[] = []
    for (let i = 0; i < N; i++) if (ux[i] * cx + uy[i] * cy + uz[i] * cz >= minDot) inside.push(i)
    return inside
  }

  const views = [
    view(0, 0, 3),
    view(25, 68, 3),
    view(-70, -45, 4),
    view(179.9, 70, 3), // antimeridian at high latitude
    view(-179.5, -60, 4),
    view(10, 89.9, 3), // window crosses the north pole
    view(0, 90, 4),
    view(0, -90, 3),
    view(77, 20, 2.2), // the widest mid-tier window (r ≈ 58.8°) — still under the cap
    view(200, 30, 4), // un-normalized longitude
  ]

  it.each(views)('(a) keeps exactly the cells within the cap: %o', (v) => {
    const r = cullRadiusDeg(v.zoom)
    const { indices } = cullForView(sphere, v)
    expect(indices!.length).toBeLessThan(CAP) // under the cap: nothing may be dropped
    const kept = new Set(indices!)
    expect(kept.size).toBe(indices!.length)
    let outside = 0
    for (const i of indices!) {
      if (angDist(v.longitude, v.latitude, sphere.lng[i], sphere.lat[i]) > r + EPS) outside++
    }
    expect(outside).toBe(0)
    const inside = brute(v, r)
    expect(inside.length).toBeGreaterThan(1000)
    expect(inside.filter((i) => !kept.has(i))).toEqual([])
  })

  it('(b) selects the same ground area at lat 0, 70 and 85 (within 15 %)', () => {
    for (const z of [3, 4]) {
      const at = (lat: number) => cullForView(sphere, view(30, lat, z)).indices!.length
      const equator = at(0)
      expect(equator).toBeGreaterThan(5_000) // dense enough for a 15 % comparison to mean something
      for (const lat of [70, 85, -70, -85]) {
        expect(Math.abs(at(lat) / equator - 1)).toBeLessThan(0.15)
      }
    }
  })

  it('(c) a view centered on a pole selects cells at every longitude', () => {
    for (const v of [view(0, 90, 4), view(123, -90, 4), view(-45, 89.99, 3)]) {
      const { indices } = cullForView(sphere, v)
      const bins = new Set<number>()
      for (const i of indices!) bins.add(Math.floor((sphere.lng[i] + 180) / 10))
      expect(bins.size).toBe(36)
    }
  })

  it('a pole-centered cull ignores the camera longitude', () => {
    const a = cullForView(sphere, view(0, 90, 3)).indices!
    const b = cullForView(sphere, view(137, 90, 3)).indices!
    expect(Array.from(b)).toEqual(Array.from(a))
  })

  it('clamps to a hemisphere when zoomed far out, then caps by population', () => {
    expect(cullRadiusDeg(0)).toBe(90)
    const v = view(40, 50, 0)
    const { indices } = cullForView(sphere, v)
    expect(indices!.length).toBe(CAP) // ~200 k in the hemisphere → top-k
    let outside = 0
    for (const i of indices!) if (angDist(40, 50, sphere.lng[i], sphere.lat[i]) > 90 + EPS) outside++
    expect(outside).toBe(0)
  })

  it('a stale cull still covers the viewport anywhere inside its re-cull bucket', () => {
    // The memo key holds while the camera stays in one bucket — in position AND zoom — so
    // the cull made at any view on a key must cover the viewport of every other view on
    // that key: next to a pole, across it, at the antimeridian, zoomed out to the bucket's
    // bottom edge. Mid-tier zoom range is 2.05–4.65 (2.2/4.5 ± hysteresis).
    //
    // The bucket's extent is found from the key itself (bisection along each axis), and its
    // corners — where the worst pairs live — are tested along with random interior views.
    const r2 = rng(11)
    const keyOf = (lng: number, lat: number, z: number) => cullKeyFor(sphere, view(lng, lat, z))
    /** Farthest offset along `dir` (≤ `max`) at which the key is still that of `at(0)`. */
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
    const anchors = [
      [0, 0],
      [-40, 45],
      [30, 70],
      [-120, 85],
      [10, 89.9],
      [60, -89.9],
      [10, 90],
      [-75, -90],
      [179.9, 45],
      [-179.9, 0],
      [179.8, -70],
    ]
    let pairs = 0
    let worstSlack = -Infinity // max over same-key pairs of (d + viewport(z1)) − radius(key)
    for (const z of [2.05, 2.3749, 2.875, 3.1249, 3.6, 4.1249, 4.4, 4.65]) {
      for (const [lng, lat] of anchors) {
        const latLo = lat - reach((t) => keyOf(lng, Math.max(-90, lat - t), z), 90)
        const latHi = lat + reach((t) => keyOf(lng, Math.min(90, lat + t), z), 90)
        const lngLo = lng - reach((t) => keyOf(lng - t, lat, z), 180)
        const lngHi = lng + reach((t) => keyOf(lng + t, lat, z), 180)
        const zLo = z - reach((t) => keyOf(lng, lat, z - t), 0.5)
        const zHi = z + reach((t) => keyOf(lng, lat, z + t), 0.5)
        const pts: GlobeViewState[] = []
        for (const la of [latLo, latHi]) {
          for (const ln of [lngLo, lngHi, (lngLo + lngHi) / 2]) {
            for (const zz of [zLo, zHi]) pts.push(view(ln, Math.max(-90, Math.min(90, la)), zz))
          }
        }
        for (let t = 0; t < 24; t++) {
          const mix = (a: number, b: number) => a + (b - a) * r2()
          pts.push(view(mix(lngLo, lngHi), Math.max(-90, Math.min(90, mix(latLo, latHi))), mix(zLo, zHi)))
        }
        const key0 = keyOf(lng, lat, z)
        const same = pts.filter((p) => cullKeyFor(sphere, p) === key0)
        let worst = { slack: -Infinity, from: same[0], to: same[0] }
        for (const p0 of same) {
          for (const p1 of same) {
            pairs++
            const d = angDist(p0.longitude, p0.latitude, p1.longitude, p1.latitude)
            const slack = d + viewportAt(p1.zoom) - cullRadiusDeg(p0.zoom)
            if (slack > worst.slack) worst = { slack, from: p0, to: p1 }
          }
        }
        worstSlack = Math.max(worstSlack, worst.slack)
        // …and, cell by cell, the worst pair's viewport is inside the stale set.
        const kept = new Set(cullForView(sphere, worst.from).indices!)
        expect(kept.size).toBeLessThan(CAP) // a miss below can only be geometry, not the top-k cap
        const missing = brute(worst.to, viewportAt(worst.to.zoom)).filter((i) => !kept.has(i))
        expect(missing).toEqual([])
      }
    }
    expect(pairs).toBeGreaterThan(10_000)
    // The farthest, most-zoomed-out same-key viewport fits inside the stale window.
    expect(worstSlack).toBeLessThanOrEqual(1e-9)
  })

  it('regression: a zoom-out plus a diagonal move on one key stays covered', () => {
    // Cull at the top of zoom bucket 3.00, reuse at its bottom, one position bucket's
    // diagonal away. A radius from the triggering view's own zoom left a ~1.5° gap here.
    const v0 = view(-2.81, 2.81, 3.1249)
    const v1 = view(2.81, -2.81, 2.875)
    expect(cullKeyFor(sphere, v1)).toBe(cullKeyFor(sphere, v0))
    const d = angDist(v0.longitude, v0.latitude, v1.longitude, v1.latitude)
    expect(d + viewportAt(v1.zoom)).toBeLessThanOrEqual(cullRadiusDeg(v0.zoom))
    const kept = new Set(cullForView(sphere, v0).indices!)
    expect(brute(v1, viewportAt(v1.zoom)).filter((i) => !kept.has(i))).toEqual([])
  })

  it('sizes the window from the key, not from the view that triggered the cull', () => {
    // Every zoom in one 0.25 bucket gets the same radius, hence the same cull.
    expect(cullRadiusDeg(2.875)).toBe(cullRadiusDeg(3.1249))
    const a = cullForView(sphere, view(20, 40, 2.875))
    const b = cullForView(sphere, view(20, 40, 3.1249))
    expect(b.key).toBe(a.key)
    expect(Array.from(b.indices!)).toEqual(Array.from(a.indices!))
  })
})

describe('cullKeyFor', () => {
  const dense = makeLod('mid', 6, CAP + 1, () => [0, 0, 1])

  it('is "none" without data and "<lod>:all" for a whole-rendered tier', () => {
    expect(cullKeyFor(undefined, view(0, 0, 3))).toBe('none')
    expect(cullKeyFor(tiny('overview', 4), view(0, 0, 3))).toBe('overview:all')
  })

  it('matches the key cullForView reports', () => {
    const v = view(12.3, 45.6, 3.2)
    expect(cullForView(dense, v).key).toBe(cullKeyFor(dense, v))
  })

  it('steps longitude by ground distance, not degrees, toward a pole', () => {
    // z3 → quantum 5.625° of ground. A 5° longitude move is ~0.9 of a quantum at the
    // equator (past the half-quantum bucket edge) but ~0.3 of one at 70° N, where a degree
    // of longitude is a third as long.
    expect(cullKeyFor(dense, view(5, 0, 3))).not.toBe(cullKeyFor(dense, view(0, 0, 3)))
    expect(cullKeyFor(dense, view(5, 70, 3))).toBe(cullKeyFor(dense, view(0, 70, 3)))
    expect(cullKeyFor(dense, view(5, -70, 3))).toBe(cullKeyFor(dense, view(0, -70, 3)))
    // …while a ground-sized move still re-culls up there.
    expect(cullKeyFor(dense, view(40, 70, 3))).not.toBe(cullKeyFor(dense, view(0, 70, 3)))
  })

  it('ignores longitude at a pole and is stable across the antimeridian', () => {
    for (const z of [2.5, 3, 4.5]) {
      const n = cullKeyFor(dense, view(0, 90, z))
      for (const lng of [-180, -91, 37, 179.99, 540]) {
        expect(cullKeyFor(dense, view(lng, 90, z))).toBe(n)
        expect(cullKeyFor(dense, view(lng, 89.95, z))).toBe(n)
      }
      expect(cullKeyFor(dense, view(55, -90, z))).toBe(cullKeyFor(dense, view(-55, -89.95, z)))
      expect(cullKeyFor(dense, view(0, -90, z))).not.toBe(n)
    }
    // ±180 (and 540) are one meridian, so one key.
    expect(cullKeyFor(dense, view(180, 40, 3))).toBe(cullKeyFor(dense, view(-180, 40, 3)))
    expect(cullKeyFor(dense, view(540, 40, 3))).toBe(cullKeyFor(dense, view(-180, 40, 3)))
  })

  it('ignores sub-quantum camera drift and reacts to a real move', () => {
    // z3 → half-span 22.5°, quantum 5.625°.
    const base = cullKeyFor(dense, view(0, 0, 3))
    expect(cullKeyFor(dense, view(1, 1, 3))).toBe(base)
    expect(cullKeyFor(dense, view(1, 1, 3.1))).toBe(base) // zoom quantized to 0.25
    expect(cullKeyFor(dense, view(6, 0, 3))).not.toBe(base)
    expect(cullKeyFor(dense, view(0, 0, 3.5))).not.toBe(base)
  })

  it('re-culls on a finer step as the camera zooms in', () => {
    // The same 1° nudge is nothing at z3 and a real move at z6.
    expect(cullKeyFor(dense, view(1, 0, 3))).toBe(cullKeyFor(dense, view(0, 0, 3)))
    expect(cullKeyFor(dense, view(1, 0, 6))).not.toBe(cullKeyFor(dense, view(0, 0, 6)))
  })
})
