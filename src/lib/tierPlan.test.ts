import { describe, expect, it } from 'vitest'
import { MANIFEST } from '../test/fixtures'
import { MAX_ZOOM } from './camera'
import { arrivalZoom, wholeTierFor } from './tierPlan'

describe('wholeTierFor', () => {
  it('is the finest whole tier whose band is reached — never the tiled r8', () => {
    expect(wholeTierFor(1.3, null)).toBeNull()
    expect(wholeTierFor(-1, MANIFEST)?.lod).toBe('overview')
    expect(wholeTierFor(1.3, MANIFEST)?.lod).toBe('overview')
    expect(wholeTierFor(1.9, MANIFEST)?.lod).toBe('overview') // portrait hero
    expect(wholeTierFor(4.5, MANIFEST)?.lod).toBe('r5')
    expect(wholeTierFor(6, MANIFEST)?.lod).toBe('mid')
    // A cold deep link to street zoom: the 31 MB mid file is the fallback under the
    // r8 tiles, and r5 (a band the camera never visited) is not fetched.
    expect(wholeTierFor(9.5, MANIFEST)?.lod).toBe('mid')
  })

  it('does not fetch the 31 MB mid tier before its band', () => {
    const mid = MANIFEST.lods.find((l) => l.lod === 'mid')!
    expect(wholeTierFor(mid.minZoom - 0.01, MANIFEST)?.lod).toBe('r5')
    expect(wholeTierFor(mid.minZoom, MANIFEST)?.lod).toBe('mid')
  })
})

describe('arrivalZoom', () => {
  it('lands a place search inside the r8 band, past its hysteresis', () => {
    const r8 = MANIFEST.lods.find((l) => l.lod === 'r8')!
    const z = arrivalZoom(MANIFEST)
    expect(z).toBeGreaterThan(r8.minZoom)
    expect(z).toBeLessThanOrEqual(MAX_ZOOM)
    expect(z).toBeCloseTo(r8.minZoom + 0.5, 9)
    expect(arrivalZoom(null)).toBe(MAX_ZOOM)
  })
})
