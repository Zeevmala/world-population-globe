import { describe, expect, it } from 'vitest'
import { maxColumnHeightM } from './scales'
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
    for (let z = -1; z < 7; z += 0.01) {
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
})
