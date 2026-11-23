import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASEMAP_TEXTURES,
  INFERNO_MID_LUMINANCE,
  INITIAL_BASEMAP,
  basemapPlan,
  basemapReducer,
  basemapTextureFor,
  relativeLuminance,
  shownBasemap,
} from './basemap'
import type { BasemapEvent, BasemapState } from './basemap'
import { inferno } from './colorRamp'

const ROOT = join(__dirname, '..', '..')
const run = (events: BasemapEvent[], from: BasemapState = INITIAL_BASEMAP) => events.reduce(basemapReducer, from)
const TOGGLE: BasemapEvent = { type: 'toggle' }
const LOADED: BasemapEvent = { type: 'loaded' }
const FAILED: BasemapEvent = { type: 'failed', message: 'nope' }

describe('basemapReducer — the toggle and the texture load', () => {
  it('starts dark, idle, unpressed: nothing is fetched until the toggle is turned on', () => {
    expect(INITIAL_BASEMAP).toEqual({ want: 'dark', texture: 'idle', error: null })
    expect(shownBasemap(INITIAL_BASEMAP)).toBe('dark')
  })

  it('the first "on" starts the load; night lights show only once the texture is held', () => {
    const loading = run([TOGGLE])
    expect(loading).toEqual({ want: 'night', texture: 'loading', error: null })
    expect(shownBasemap(loading)).toBe('dark')
    const ready = basemapReducer(loading, LOADED)
    expect(ready).toEqual({ want: 'night', texture: 'ready', error: null })
    expect(shownBasemap(ready)).toBe('night')
  })

  it('on → off → on again after the load costs no second load (texture stays ready)', () => {
    const s = run([TOGGLE, LOADED, TOGGLE])
    expect(s).toEqual({ want: 'dark', texture: 'ready', error: null })
    expect(shownBasemap(s)).toBe('dark')
    const again = basemapReducer(s, TOGGLE)
    expect(again.texture).toBe('ready')
    expect(shownBasemap(again)).toBe('night')
  })

  it('off while loading lets the load finish without showing it; on again does not restart it', () => {
    const off = run([TOGGLE, TOGGLE])
    expect(off).toEqual({ want: 'dark', texture: 'loading', error: null })
    expect(basemapReducer(off, TOGGLE).texture).toBe('loading')
    const landed = basemapReducer(off, LOADED)
    expect(shownBasemap(landed)).toBe('dark')
    expect(landed.texture).toBe('ready')
  })

  it('a failure while wanted un-presses the toggle and leaves a message; the next "on" retries', () => {
    const failed = run([TOGGLE, FAILED])
    expect(failed).toEqual({ want: 'dark', texture: 'failed', error: 'nope' })
    expect(shownBasemap(failed)).toBe('dark')
    const retry = basemapReducer(failed, TOGGLE)
    expect(retry).toEqual({ want: 'night', texture: 'loading', error: null })
  })

  it('a failure after the user turned it off is recorded silently', () => {
    expect(run([TOGGLE, TOGGLE, FAILED])).toEqual({ want: 'dark', texture: 'failed', error: null })
  })

  it('turning it off dismisses a failure message', () => {
    const failed = run([TOGGLE, FAILED])
    expect(basemapReducer({ ...failed, want: 'night', texture: 'ready' }, TOGGLE).error).toBeNull()
  })

  it('ignores stale load results (same object back, so the store does not re-render)', () => {
    const ready = run([TOGGLE, LOADED])
    expect(basemapReducer(ready, LOADED)).toBe(ready)
    expect(basemapReducer(ready, FAILED)).toBe(ready)
    expect(basemapReducer(INITIAL_BASEMAP, LOADED)).toBe(INITIAL_BASEMAP)
  })
})

describe('basemapPlan — which basemap layers draw', () => {
  it('dark is today’s stack: sphere + land, no night layer', () => {
    expect(basemapPlan('dark')).toEqual({ sphere: true, land: true, night: false })
  })

  it('night replaces both — the land fill would cover the lights', () => {
    expect(basemapPlan('night')).toEqual({ sphere: false, land: false, night: true })
  })
})

describe('basemapTextureFor — fits MAX_TEXTURE_SIZE', () => {
  it('takes the 4096×2048 file where it fits, the 2048×1024 one at WebGL 2’s minimum', () => {
    expect(basemapTextureFor(16384).width).toBe(4096)
    expect(basemapTextureFor(4096).width).toBe(4096)
    expect(basemapTextureFor(4095).width).toBe(2048)
    expect(basemapTextureFor(2048)).toEqual({ path: 'basemap/black-marble-2048.jpg', width: 2048, height: 1024 })
    expect(basemapTextureFor(1024).width).toBe(2048) // below WebGL 2's floor: the smallest file
  })

  it('every texture is committed, under 2 MB, with the JPEG dimensions it claims', () => {
    for (const t of BASEMAP_TEXTURES) {
      const file = join(ROOT, 'public', t.path)
      expect(statSync(file).size).toBeLessThan(2 * 1024 * 1024)
      // Baseline or progressive JPEG start-of-frame marker: height then width, big-endian.
      const bytes = readFileSync(file)
      let i = 2
      let size: [number, number] | null = null
      while (i < bytes.length && !size) {
        const marker = bytes[i + 1]
        const len = bytes.readUInt16BE(i + 2)
        if (marker === 0xc0 || marker === 0xc2) size = [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)]
        i += 2 + len
      }
      expect(size).toEqual([t.width, t.height])
    }
  })
})

describe('INFERNO_MID_LUMINANCE — the data > basemap bound', () => {
  it('is the relative luminance of inferno(0.5) = (186, 57, 83)', () => {
    expect(inferno(0.5)).toEqual([186, 57, 83])
    expect(INFERNO_MID_LUMINANCE).toBeCloseTo(0.1399, 4)
  })

  it('relativeLuminance is WCAG’s: black 0, white 1, sRGB mid-grey 0.2140', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0)
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 12)
    expect(relativeLuminance([128, 128, 128])).toBeCloseTo(0.2159, 4)
  })

  it('is the bound the encode script holds the texture to', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'texture', 'encode_black_marble.py'), 'utf8')
    const m = script.match(/^INFERNO_MID = \((\d+), (\d+), (\d+)\)/m)
    expect(m?.slice(1).map(Number)).toEqual(inferno(0.5))
  })
})
