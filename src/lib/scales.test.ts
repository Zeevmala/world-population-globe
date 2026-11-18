import { describe, expect, it } from 'vitest'
import { maxColumnHeightM } from './scales'
import { MAX_ZOOM, MIN_ZOOM } from './camera'
import { hexWidthKm, pxPerKm } from './screenScale'
import { MANIFEST } from '../test/fixtures'

describe('maxColumnHeightM', () => {
  it('caps the hero view at 800 km and never grows on zoom-out', () => {
    expect(maxColumnHeightM(-1)).toBe(800_000)
    expect(maxColumnHeightM(0)).toBe(800_000)
    expect(maxColumnHeightM(1.3)).toBe(800_000)
  })

  it('reads as ~13 km towers at city zoom', () => {
    expect(maxColumnHeightM(5.5)).toBeGreaterThan(12_000)
    expect(maxColumnHeightM(5.5)).toBeLessThan(14_000)
  })

  it('is continuous and non-increasing in zoom — no step anywhere', () => {
    // Invariant: a tier switch changes mesh resolution, never column scale. A 0.01 zoom
    // step moves the height by 2^(1.425·0.01) ≈ 1%; a per-tier step would show up as a
    // ratio far above this bound.
    for (let z = MIN_ZOOM; z < MAX_ZOOM; z += 0.01) {
      const a = maxColumnHeightM(z)
      const b = maxColumnHeightM(z + 0.01)
      expect(b).toBeLessThanOrEqual(a)
      expect(a / b).toBeLessThan(1.011)
    }
  })

  it('agrees on both sides of every tier threshold in the manifest', () => {
    for (const { minZoom } of MANIFEST.lods.slice(1)) {
      const below = maxColumnHeightM(minZoom - 1e-6)
      const above = maxColumnHeightM(minZoom + 1e-6)
      expect(below / above).toBeCloseTo(1, 4)
    }
  })

  it('stays visible to zoom 10: never under 1 km, a fixed scene past zoom ≈ 8.07', () => {
    // Tallest column (top of the density domain), metres and px at the view center (lat 0):
    //   zoom 5 → 20.8 km / 8.5 px · 7 → 2.88 km / 4.7 px · 8.5 → 1 km / 4.6 px · 10 → 1 km / 13.1 px
    const px = (z: number) => (maxColumnHeightM(z) / 1000) * pxPerKm(z)
    expect(maxColumnHeightM(5)).toBeCloseTo(20_777, -1)
    expect(px(5)).toBeCloseTo(8.5, 1)
    expect(maxColumnHeightM(7)).toBeCloseTo(2_881, -1)
    expect(px(7)).toBeCloseTo(4.72, 2)
    expect(maxColumnHeightM(8.5)).toBe(1_000)
    expect(px(8.5)).toBeCloseTo(4.63, 2)
    expect(maxColumnHeightM(10)).toBe(1_000)
    expect(px(10)).toBeCloseTo(13.1, 1)
    // Never shorter on screen than ~3.3 px (the knee), and from the r8 entry on, a
    // full-domain column stands at least about as tall as its cell is wide.
    for (let z = 0; z <= MAX_ZOOM; z += 0.01) expect(px(z)).toBeGreaterThan(3.3)
    const r8 = MANIFEST.lods.find((l) => l.lod === 'r8')!
    for (let z = r8.minZoom; z <= MAX_ZOOM; z += 0.01) {
      expect(maxColumnHeightM(z) / 1000 / hexWidthKm(8)).toBeGreaterThan(1.0)
    }
  })
})
