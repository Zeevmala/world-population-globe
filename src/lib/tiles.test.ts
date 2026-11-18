import { describe, expect, it } from 'vitest'
import { getResolution, gridDisk, latLngToCell } from 'h3-js'
import { halfSpanDeg, prefetchParents, viewKey, visibleParents } from './tiles'
import type { GlobeViewState } from '../types'

const PARENT_RES = 3
const tokyo = (zoom: number): GlobeViewState => ({ longitude: 139.7, latitude: 35.68, zoom })

describe('visibleParents', () => {
  it('returns unique r3 parents that include the cell under the camera', () => {
    const parents = visibleParents(tokyo(5.5), PARENT_RES)
    expect(new Set(parents).size).toBe(parents.length)
    expect(parents).toContain(latLngToCell(35.68, 139.7, PARENT_RES))
    for (const p of parents) expect(getResolution(p)).toBe(PARENT_RES)
  })

  it('shrinks the disk as the camera zooms in, never below one ring', () => {
    const wide = visibleParents(tokyo(4.5), PARENT_RES).length
    const mid = visibleParents(tokyo(5.5), PARENT_RES).length
    const tight = visibleParents(tokyo(7), PARENT_RES).length
    expect(wide).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(tight)
    expect(tight).toBe(7) // k = 1: the center cell + its six neighbours
  })

  it('stays within the r8 tile cache (64) even at the widest r8 view', () => {
    // r8 now enters at ≈ 7.99 (7.84 with hysteresis); 4.5, its old entry, is the
    // harder case and still fits.
    for (const z of [7.84, 4.5]) {
      const visible = visibleParents(tokyo(z), PARENT_RES)
      const ring = prefetchParents(tokyo(z), PARENT_RES)
      expect(visible.length + ring.length).toBeLessThanOrEqual(64)
    }
  })
})

describe('prefetchParents', () => {
  it('is exactly the next ring out: disjoint from the visible disk, completing k+1', () => {
    const v = tokyo(5.5)
    const visible = visibleParents(v, PARENT_RES)
    const ring = prefetchParents(v, PARENT_RES)
    const seen = new Set(visible)
    for (const p of ring) expect(seen.has(p)).toBe(false)

    // visible is gridDisk(center, k); recover k from its size (1 + 3k(k+1)).
    const k = (-3 + Math.sqrt(9 + 12 * (visible.length - 1))) / 6
    expect(Number.isInteger(k)).toBe(true)
    const center = latLngToCell(v.latitude, v.longitude, PARENT_RES)
    expect(new Set([...visible, ...ring])).toEqual(new Set(gridDisk(center, k + 1)))
  })
})

describe('viewKey / halfSpanDeg', () => {
  it('quantizes the camera to 1° and 0.1 zoom', () => {
    expect(viewKey({ longitude: 139.74, latitude: 35.68, zoom: 5.52 })).toBe('140:36:5.5')
    expect(viewKey({ longitude: 139.6, latitude: 35.9, zoom: 5.54 })).toBe('140:36:5.5')
    expect(viewKey({ longitude: 141, latitude: 36, zoom: 5.5 })).not.toBe('140:36:5.5')
  })

  it('halves the angular span per zoom level, capped when zoomed out', () => {
    expect(halfSpanDeg(5)).toBeCloseTo(180 / 32, 12)
    expect(halfSpanDeg(6)).toBeCloseTo(halfSpanDeg(5) / 2, 12)
    expect(halfSpanDeg(0)).toBe(80)
  })
})
