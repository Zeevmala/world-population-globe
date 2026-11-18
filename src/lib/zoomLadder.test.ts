import { describe, expect, it } from 'vitest'
import { MANIFEST } from '../test/fixtures'
import { MAX_ZOOM, MIN_ZOOM } from './camera'
import { bandsFor, cellLabel } from './zoomLadder'

/** The ladder is `h-40` (160 CSS px) tall and its tier labels are 10 px text. */
const LADDER_PX = 160
const LABEL_PX = 10

describe('bandsFor (the zoom ladder)', () => {
  const bands = bandsFor(MANIFEST.lods, MIN_ZOOM, MAX_ZOOM)

  it('shows all five tiers over the full −1 … 10 range, end to end', () => {
    expect(bands.map((b) => b.label)).toEqual(['22 km', '9 km', '3 km', '1 km', '400 m'])
    expect(bands[0].from).toBe(0)
    expect(bands[bands.length - 1].to).toBe(1)
    for (let i = 1; i < bands.length; i++) expect(bands[i].from).toBeCloseTo(bands[i - 1].to, 12)
  })

  it('places each band at its manifest zoom', () => {
    const span = MAX_ZOOM - MIN_ZOOM
    for (const b of bands.slice(1)) {
      const l = MANIFEST.lods.find((x) => x.lod === b.lod)!
      expect(b.from * span + MIN_ZOOM).toBeCloseTo(l.minZoom, 12)
    }
  })

  it('keeps the labels apart and every band a grabbable height', () => {
    const mids = bands.map((b) => ((b.from + b.to) / 2) * LADDER_PX)
    for (let i = 1; i < mids.length; i++) expect(mids[i] - mids[i - 1]).toBeGreaterThan(2 * LABEL_PX)
    // The narrowest band (r5 / mid / r7, 1.4 zoom levels each) is still > 14 px of rail.
    for (const b of bands) expect((b.to - b.from) * LADDER_PX).toBeGreaterThan(14)
  })

  it('drops bands outside the range and clips the rest', () => {
    const clipped = bandsFor(MANIFEST.lods, 4, 6)
    expect(clipped.map((b) => b.lod)).toEqual(['r5', 'mid'])
    expect(clipped[0].from).toBe(0)
    expect(clipped[1].to).toBe(1)
    expect(bandsFor(MANIFEST.lods, 3, 3)).toEqual([])
  })

  it('labels cell sizes the way the UI prints them', () => {
    expect(cellLabel(22)).toBe('22 km')
    expect(cellLabel(8.5)).toBe('9 km')
    expect(cellLabel(1.2)).toBe('1 km')
    expect(cellLabel(0.4)).toBe('400 m')
  })
})
