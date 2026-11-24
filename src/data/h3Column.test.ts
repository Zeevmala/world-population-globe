import { describe, expect, it } from 'vitest'
import { isValidCell, latLngToCell } from 'h3-js'
import { concatPacked, h3Column, packH3 } from './h3Column'

/** Real indices at the three shipped resolutions, spread over both hemispheres. */
const PLACES: Array<[number, number]> = [
  [35.68, 139.7], // Tokyo
  [-33.87, 151.21], // Sydney
  [40.71, -74.01], // New York
  [-23.55, -46.63], // São Paulo
  [64.15, -21.94], // Reykjavík
  [0, 0],
  [-89.9, 12], // near the pole
  [10, 179.99], // antimeridian
]
const CELLS = [4, 6, 8].flatMap((res) => PLACES.map(([lat, lng]) => latLngToCell(lat, lng, res)))

describe('packH3 / h3Column', () => {
  it('round-trips canonical H3 strings through the packed 64-bit column', () => {
    const col = h3Column(packH3(CELLS))
    expect(col.length).toBe(CELLS.length)
    for (let i = 0; i < CELLS.length; i++) {
      expect(col.at(i)).toBe(CELLS[i])
      expect(isValidCell(col.at(i))).toBe(true)
    }
  })

  it('materializes 15 lowercase hex digits (the mode-1 bit keeps the width fixed)', () => {
    const col = h3Column(packH3(CELLS))
    for (let i = 0; i < col.length; i++) expect(col.at(i)).toMatch(/^[0-9a-f]{15}$/)
  })

  it('memoizes: a repeat read returns the same string', () => {
    const col = h3Column(packH3(CELLS))
    expect(col.at(3)).toBe(col.at(3))
  })

  it('exposes the packed buffer it was built from', () => {
    const packed = packH3(CELLS)
    expect(h3Column(packed).packed).toBe(packed)
  })
})

describe('concatPacked', () => {
  it('concatenates tile columns in order', () => {
    const a = packH3(CELLS.slice(0, 5))
    const b = packH3(CELLS.slice(5, 6))
    const c = packH3(CELLS.slice(6))
    const merged = h3Column(concatPacked([a, b, c], CELLS.length))
    expect(Array.from({ length: merged.length }, (_, i) => merged.at(i))).toEqual(CELLS)
  })

  it('handles an empty merge', () => {
    expect(concatPacked([], 0).length).toBe(0)
  })
})
