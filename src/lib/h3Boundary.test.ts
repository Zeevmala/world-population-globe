import { describe, expect, it } from 'vitest'
import {
  cellToBoundary,
  cellToChildren,
  getPentagons,
  getRes0Cells,
  gridDisk,
  latLngToCell,
} from 'h3-js'
// deck.gl's own boundary code — the reference, not a re-implementation of it.
import {
  flattenPolygon,
  h3ToPolygon,
} from '../../node_modules/@deck.gl/geo-layers/dist/h3-layers/h3-utils.js'
import { packH3 } from '../data/h3Column'
import { rng } from '../test/fixtures'
import { BoundaryCache, HI_WORD, LO_WORD, SLOT_VERTS, h3Words } from './h3Boundary'

/** deck.gl `H3HexagonLayer`'s hi-fi `getPolygon` for one cell, as a plain array. */
const reference = (id: string): number[] => Array.from(flattenPolygon(h3ToPolygon(id)))

/** The cache's answer for cell `i` of a packed column. */
function cached(cache: BoundaryCache, words: Uint32Array, i: number): number[] {
  return cache.polygon(words[2 * i + LO_WORD], words[2 * i + HI_WORD])
}

/** Raw longitudes of a cell's boundary span more than 180°: it straddles the antimeridian. */
function straddles(id: string): boolean {
  const lngs = cellToBoundary(id, true).map((p) => p[0])
  return Math.max(...lngs) - Math.min(...lngs) > 180
}

const unique = (ids: string[]) => [...new Set(ids)]

// Every boundary shape the tiers can hand the cache: plain hexagons (r6 mid, r8), the
// antimeridian at r4/r6/r8 (where the longitude normalization does its work), the poles,
// pentagons at every rendered resolution, and all 842 r1 cells — r1 is an odd (Class III)
// resolution, so it holds cells with icosahedron-edge distortion vertices (> 6). The
// rendered tiers (r4, r6, r8) are all even and never produce one; r1 is here to exercise
// the cache's bypass path, which an odd-resolution tier (r5, r7) would reach.
const CELLS = unique([
  ...gridDisk(latLngToCell(20, 77, 6), 5),
  ...gridDisk(latLngToCell(35.68, 139.7, 8), 3),
  ...gridDisk(latLngToCell(-17, 179.99, 4), 3),
  ...gridDisk(latLngToCell(-17, 179.99, 6), 4),
  ...gridDisk(latLngToCell(65.5, -179.99, 8), 4),
  ...gridDisk(latLngToCell(89.95, 0, 6), 3),
  ...gridDisk(latLngToCell(-89.95, 0, 4), 2),
  ...getPentagons(4),
  ...getPentagons(6),
  ...getPentagons(8),
  ...getRes0Cells().flatMap((c) => cellToChildren(c, 1)),
])

describe('BoundaryCache geometry', () => {
  it('covers the hard shapes (the fixture really exercises them)', () => {
    expect(CELLS.filter(straddles).length).toBeGreaterThan(20)
    const sizes = new Set(CELLS.map((id) => cellToBoundary(id, true).length - 1))
    expect(sizes).toContain(5) // pentagon
    expect(sizes).toContain(6) // hexagon
    expect([...sizes].some((n) => n > SLOT_VERTS)).toBe(true) // Class III distortion
  })

  it('matches deck.gl h3ToPolygon + flattenPolygon exactly, cold and warm, in any order', () => {
    const words = h3Words(packH3(CELLS))
    const cache = new BoundaryCache(4096)
    const want = CELLS.map(reference)
    // Cold: every cell a miss.
    const cold = CELLS.map((_, i) => cached(cache, words, i))
    expect(cache.hits).toBe(0)
    expect(cold).toEqual(want)
    // Warm: the cacheable ones are hits now, in reverse order to scramble recency.
    const warm: number[][] = []
    for (let i = CELLS.length - 1; i >= 0; i--) warm[i] = cached(cache, words, i)
    expect(cache.hits).toBe(CELLS.length - cache.bypassed / 2)
    expect(warm).toEqual(want)
    // Bit-identical, not merely close: compare as float64 bit patterns.
    for (let i = 0; i < CELLS.length; i++) {
      const bits = (xs: ArrayLike<number>) => new Uint8Array(Float64Array.from(xs).buffer)
      expect(bits(warm[i])).toEqual(bits(flattenPolygon(h3ToPolygon(CELLS[i]))))
    }
  })

  it('normalizes antimeridian cells like deck.gl in both directions', () => {
    const across = CELLS.filter(straddles)
    const words = h3Words(packH3(across))
    const cache = new BoundaryCache(1024)
    let shiftedDown = 0
    let shiftedUp = 0
    across.forEach((id, i) => {
      const first = cached(cache, words, i)
      const again = cached(cache, words, i)
      expect(first).toEqual(reference(id))
      expect(again).toEqual(first)
      const xs = first.filter((_, k) => k % 2 === 0)
      // Off the poles the normalized ring is contiguous (a cell holding a pole spans every
      // longitude whatever the reference — deck.gl leaves it so, and so does the cache).
      const polar = first.some((y, k) => k % 2 === 1 && Math.abs(y) > 80)
      if (!polar) expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(180)
      if (xs.some((x) => x < -180)) shiftedDown++
      if (xs.some((x) => x > 180)) shiftedUp++
    })
    expect(shiftedDown).toBeGreaterThan(0)
    expect(shiftedUp).toBeGreaterThan(0)
  })

  it('hands out a fresh array per call — a caller mutating one cannot corrupt the cache', () => {
    const id = latLngToCell(20, 77, 6)
    const words = h3Words(packH3([id]))
    const cache = new BoundaryCache(4)
    const a = cached(cache, words, 0)
    a.fill(0)
    const b = cached(cache, words, 0)
    expect(b).not.toBe(a)
    expect(b).toEqual(reference(id))
  })
})

describe('BoundaryCache bound', () => {
  const POOL = gridDisk(latLngToCell(48.85, 2.35, 6), 4) // 61 hexagons
  const words = h3Words(packH3(POOL))

  it('never exceeds its hard cap over a long pan, and recomputes evicted cells exactly', () => {
    const cap = 1000
    const cache = new BoundaryCache(cap)
    // A sustained pan in miniature: a window of 400 consecutive cells sliding over 20 k.
    const strip = unique(
      Array.from({ length: 60 }, (_, k) => gridDisk(latLngToCell(10, -40 + k * 0.6, 6), 7)).flat(),
    )
    const stripWords = h3Words(packH3(strip))
    for (let start = 0; start + 400 <= strip.length; start += 37) {
      for (let pass = 0; pass < 2; pass++) {
        for (let i = start; i < start + 400; i++) cached(cache, stripWords, i)
      }
      expect(cache.size).toBeLessThanOrEqual(cap)
    }
    expect(cache.size).toBe(cap)
    expect(cache.evictions).toBe(cache.misses - cap)
    // The first cells were evicted long ago; they come back identical.
    expect(cache.has(stripWords[LO_WORD], stripWords[HI_WORD])).toBe(false)
    for (let i = 0; i < 50; i++) expect(cached(cache, stripWords, i)).toEqual(reference(strip[i]))
  })

  it('evicts in least-recently-used order', () => {
    const cache = new BoundaryCache(3)
    const has = (i: number) => cache.has(words[2 * i + LO_WORD], words[2 * i + HI_WORD])
    cached(cache, words, 0)
    cached(cache, words, 1)
    cached(cache, words, 2)
    cached(cache, words, 0) // 1 is now the oldest
    cached(cache, words, 3)
    expect([has(0), has(1), has(2), has(3)]).toEqual([true, false, true, true])
    cached(cache, words, 4) // evicts 2
    expect([has(0), has(2), has(3), has(4)]).toEqual([true, false, true, true])
  })

  it('agrees with a reference LRU under random churn (hash-table deletes stay consistent)', () => {
    const cap = 16
    const cache = new BoundaryCache(cap)
    const model = new Map<number, true>() // insertion order = recency order
    const next = rng(42)
    for (let op = 0; op < 20_000; op++) {
      const i = Math.floor(next() * POOL.length)
      const got = cached(cache, words, i)
      if (model.has(i)) model.delete(i)
      else if (model.size === cap) model.delete(model.keys().next().value as number)
      model.set(i, true)
      if (op % 97 === 0) expect(got).toEqual(reference(POOL[i]))
      expect(cache.size).toBe(model.size)
    }
    for (let i = 0; i < POOL.length; i++) {
      expect(cache.has(words[2 * i + LO_WORD], words[2 * i + HI_WORD])).toBe(model.has(i))
    }
  })
})
