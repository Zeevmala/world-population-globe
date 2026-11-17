import { describe, expect, it } from 'vitest'
import { cullForView, cullKeyFor, pickLod, selectActive } from './lod'
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
