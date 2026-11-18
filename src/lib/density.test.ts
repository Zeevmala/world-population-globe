import { describe, expect, it } from 'vitest'
import { getHexagonAreaAvg } from 'h3-js'
import {
  cellAreaKm2,
  densityAt,
  densityDomainMax,
  densityOf,
  formatDensity,
  makeDensityNorm,
} from './density'
import { MANIFEST } from '../test/fixtures'

describe('cellAreaKm2', () => {
  it('matches the H3 grid constants it was inlined from', () => {
    for (let r = 0; r <= 15; r++) {
      expect(cellAreaKm2(r)).toBeCloseTo(getHexagonAreaAvg(r, 'km2'), 10)
    }
  })

  it('clamps out-of-range resolutions instead of returning undefined', () => {
    expect(cellAreaKm2(-3)).toBe(cellAreaKm2(0))
    expect(cellAreaKm2(99)).toBe(cellAreaKm2(15))
  })
})

describe('the shared density domain', () => {
  const domainMax = densityDomainMax(MANIFEST)
  const norm = makeDensityNorm(domainMax)

  it('is the densest cell any tier publishes (the r8 peak), in people/km²', () => {
    expect(domainMax).toBeCloseTo(40673 / cellAreaKm2(8), 6)
    expect(Math.round(domainMax)).toBe(55163)
  })

  it('is zero — and norms to zero — before the manifest loads', () => {
    expect(densityDomainMax(null)).toBe(0)
    expect(makeDensityNorm(0)(1234)).toBe(0)
  })

  it('normalizes every tier against that one domain, not its own maximum', () => {
    // The invariant that replaced per-tier normalization: tier maxima land at different
    // ramp positions because they are different densities.
    const [r4, r5, r6, r8] = MANIFEST.lods.map((l) => norm(densityOf(l.maxPopulation, l.h3Res)))
    expect(r4).toBeCloseTo(0.866, 3)
    // r5 is a roll-up of r6, so its peak density (32,950 /km²) is an average of r6
    // peaks — below the r8 domain top, and below r6's own (53,951 /km²).
    expect(densityOf(8333304, 5)).toBeCloseTo(32950, 0)
    expect(r5).toBeLessThan(1)
    expect(r5).toBeCloseTo(0.953, 3)
    expect(r5).toBeLessThan(r6)
    expect(r6).toBeCloseTo(0.998, 3)
    expect(r8).toBe(1)
  })

  it('gives one place the same ramp position on both sides of a tier crossing', () => {
    // A uniformly-populated r4 cell holds (area ratio)× the people of an r6 cell inside it.
    const density = 4200
    const asR4 = norm(densityOf(density * cellAreaKm2(4), 4))
    const asR5 = norm(densityOf(density * cellAreaKm2(5), 5))
    const asR6 = norm(densityOf(density * cellAreaKm2(6), 6))
    const asR8 = norm(densityOf(density * cellAreaKm2(8), 8))
    expect(asR4).toBeCloseTo(asR5, 12)
    expect(asR5).toBeCloseTo(asR6, 12)
    expect(asR6).toBeCloseTo(asR8, 12)
  })

  it('is a log1p ramp: 0 → 0, domain max → 1, clamped, monotonic, never linear', () => {
    expect(norm(0)).toBe(0)
    expect(norm(-5)).toBe(0)
    expect(norm(domainMax)).toBe(1)
    expect(norm(domainMax * 10)).toBe(1)
    let prev = -1
    for (let d = 0; d <= domainMax; d += domainMax / 500) {
      const t = norm(d)
      expect(t).toBeGreaterThanOrEqual(prev)
      prev = t
    }
    // 1% of the domain already sits well past the ramp's midpoint — the skew a linear
    // scale would crush into the bottom bucket.
    expect(norm(domainMax * 0.01)).toBeGreaterThan(0.5)
  })

  it('round-trips through densityAt (the legend reads ticks back out)', () => {
    for (const d of [0, 1, 37, 2500, 55000]) {
      expect(densityAt(norm(d), domainMax)).toBeCloseTo(d, 6)
    }
  })
})

describe('formatDensity', () => {
  it('formats compactly across magnitudes', () => {
    expect(formatDensity(0)).toBe('0')
    expect(formatDensity(-1)).toBe('0')
    expect(formatDensity(NaN)).toBe('0')
    expect(formatDensity(0.25)).toBe('0.25')
    expect(formatDensity(3.14159)).toBe('3.1')
    expect(formatDensity(250)).toBe('250')
    expect(formatDensity(1234)).toBe('1.2k')
    expect(formatDensity(55163)).toBe('55k')
  })
})
