import { describe, expect, it } from 'vitest'
import { inferno, infernoCssStops } from './colorRamp'

const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

describe('inferno', () => {
  it('runs from near-black to pale yellow and clamps outside [0,1]', () => {
    expect(inferno(0)).toEqual([0, 0, 4])
    expect(inferno(1)).toEqual([252, 255, 164])
    expect(inferno(-2)).toEqual(inferno(0))
    expect(inferno(7)).toEqual(inferno(1))
  })

  it('gets monotonically lighter — a sequential ramp with no fabricated breaks', () => {
    let prev = -1
    for (let i = 0; i <= 200; i++) {
      const l = luma(inferno(i / 200))
      expect(l).toBeGreaterThanOrEqual(prev - 0.5) // 0.5 = integer-rounding slack
      prev = l
    }
  })

  it('emits integer RGB channels in range', () => {
    for (let i = 0; i <= 50; i++) {
      for (const c of inferno(i / 50)) {
        expect(Number.isInteger(c)).toBe(true)
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(255)
      }
    }
  })
})

describe('infernoCssStops', () => {
  it('samples the same ramp for the legend gradient', () => {
    const stops = infernoCssStops(3).split(', ')
    expect(stops).toHaveLength(3)
    expect(stops[0]).toBe('rgb(0,0,4) 0%')
    expect(stops[2]).toBe('rgb(252,255,164) 100%')
  })
})
