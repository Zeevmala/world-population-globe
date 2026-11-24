import { describe, expect, it } from 'vitest'
import { MANIFEST } from '../test/fixtures'
import { keyCanvas } from './footprint'
import type { Canvas } from './footprint'
import { GROW, covers, resizingCanvas } from './selectionCanvas'
import { bandThresholds, coldBandCount, tierEntry, wantedIndex } from './tierBands'

const { lods } = MANIFEST
const name = (c: Canvas) => `${c.width}×${c.height}`

describe('the canvas selection reads while a window is resized', () => {
  it('covers: the same key, a taller-and-proportionally-wider canvas — not a merely wider or taller one', () => {
    expect(covers({ width: 1280, height: 800 }, { width: 1270, height: 790 })).toBe(true) // same 16 px key
    expect(covers({ width: 1600, height: 800 }, { width: 1280, height: 800 })).toBe(true)
    // Taller only: GlobeView's eye backs off with the height, so the wider footprint is not covered.
    expect(covers({ width: 1280, height: 1024 }, { width: 1280, height: 800 })).toBe(false)
    expect(covers({ width: 1280 * (1008 / 784) + 16, height: 1024 }, { width: 1280, height: 800 })).toBe(true)
    expect(covers({ width: 1280, height: 800 }, { width: 1300, height: 800 })).toBe(false)
  })

  it('always covers the real canvas, keeps the one it has while it does, and grows by GROW when it must', () => {
    let sel: Canvas = { width: 1280, height: 800 }
    for (const [w, h] of [[1281, 800], [1500, 800], [1700, 800], [1700, 900], [1100, 700], [3000, 2000], [320, 200]]) {
      const real = { width: w, height: h }
      const next = resizingCanvas(sel, real)
      expect(covers(next, real), `${name(sel)} → ${name(real)}`).toBe(true)
      if (covers(sel, real)) expect(next).toBe(sel)
      else expect(keyCanvas(next).width).toBeLessThanOrEqual(Math.ceil(GROW * 1.3 * keyCanvas(real).width) + 16)
      sel = next
    }
  })

  it('(d) a 1 px-step drag from 1280 to 1920 px wide computes thresholds for three canvases — 40 before', () => {
    const lat = 41.3
    const zoom = 6.1
    let sel: Canvas = { width: 1280, height: 800 }
    bandThresholds(lods, sel, lat) // the settled canvas before the drag
    const before = coldBandCount()
    const canvases = new Set<string>()
    const realKeys = new Set<string>()
    for (let w = 1281; w <= 1920; w++) {
      const real = { width: w, height: 800 }
      sel = resizingCanvas(sel, real)
      canvases.add(name(keyCanvas(sel)))
      realKeys.add(name(keyCanvas(real)))
      wantedIndex({ latitude: lat, zoom }, sel, lods, 'mid') // every frame selects
    }
    // Settled: the real canvas.
    wantedIndex({ latitude: lat, zoom }, { width: 1920, height: 800 }, lods, 'mid')
    expect([...canvases]).toEqual(['1632×800', '2064×800'])
    expect(coldBandCount() - before).toBe(3)
    expect(realKeys.size).toBe(40) // what selection on the real canvas's key would have computed
    // Shrinking back computes nothing until it settles.
    const atEnd = coldBandCount()
    sel = { width: 1920, height: 800 }
    for (let w = 1919; w >= 1280; w--) {
      sel = resizingCanvas(sel, { width: w, height: 800 })
      wantedIndex({ latitude: lat, zoom }, sel, lods, 'mid')
    }
    expect(sel).toEqual({ width: 1920, height: 800 })
    expect(coldBandCount()).toBe(atEnd)
  })

  it('the tier a drag selects still fits the real canvas’s window: no threshold of a covering canvas is earlier', () => {
    for (const [w0, h0, w1, h1] of [
      [1280, 800, 1920, 800],
      [1280, 800, 1280, 1200],
      [900, 560, 1600, 1000],
      [375, 812, 800, 812],
      [1920, 1080, 2560, 1440],
    ]) {
      let sel: Canvas = { width: w0, height: h0 }
      for (let s = 1; s <= 12; s++) {
        const real = { width: Math.round(w0 + ((w1 - w0) * s) / 12), height: Math.round(h0 + ((h1 - h0) * s) / 12) }
        sel = resizingCanvas(sel, real)
        for (const lat of [0, 23.4, 35.68, 52.5, 60, 77.7]) {
          for (let i = 1; i < lods.length; i++) {
            expect(tierEntry(lods, i, lat, sel), `${name(sel)} for ${name(real)} lat ${lat} ${lods[i].lod}`).toBeGreaterThanOrEqual(
              tierEntry(lods, i, lat, real),
            )
          }
        }
      }
    }
  }, 60_000)
})
