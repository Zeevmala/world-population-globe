import { describe, expect, it } from 'vitest'
import { selectActive, streamWanted } from './lod'
import { selectParents, tileSetCovers } from './tiles'
import type { Canvas } from './footprint'
import { TILE_CACHE_MAX } from '../data/tileStream'
import { MANIFEST, makeLod } from '../test/fixtures'
import type { GlobeViewState, LodData, Manifest, TileSet } from '../types'

/**
 * Accept (c): which tier is drawn while a tiled tier's tiles load — the walk from the
 * wanted tier down to the finest tier with data for this view, with the real coverage
 * test (`tileSetCovers`) over sets published the way `useTileStreaming` publishes them.
 */

const view = (longitude: number, latitude: number, zoom: number): GlobeViewState => ({ longitude, latitude, zoom })
const CANVAS: Canvas = { width: 1280, height: 800 }
const tiny = (lod: string, h3Res: number): LodData => makeLod(lod, h3Res, 1, () => [0, 0, 1])
const overview = tiny('overview', 4)
const r5 = tiny('r5', 5)
const mid = tiny('mid', 6)

/** What a stream publishes once the load for `v`'s key has settled. */
function settledFor(lod: string, parentRes: number, v: GlobeViewState, data: LodData | null = tiny(lod, 8)): TileSet {
  const sel = selectParents(v, CANVAS, parentRes, TILE_CACHE_MAX)
  return { lod, parentRes, status: 'ready', key: sel.key, settled: new Set(sel.visible), data, parents: sel.visible }
}

const tierOf = (
  v: GlobeViewState,
  loaded: Record<string, LodData>,
  tiles: Record<string, TileSet>,
  activeLod: string | null,
  manifest: Manifest = MANIFEST,
) => selectActive(v, CANVAS, manifest, loaded, tiles, activeLod, tileSetCovers).entry?.lod

const TOKYO = view(139.7, 35.68, 8.6)

describe('selectActive while a tiled tier streams (Accept c)', () => {
  it('zooming in from r6 into r8: r6 stays until r8 has merged tiles for THIS view', () => {
    const loaded = { overview, mid }
    expect(tierOf(TOKYO, loaded, {}, 'mid')).toBe('mid') // no stream output yet
    const loading: TileSet = { ...settledFor('r8', 3, TOKYO, null), key: '', settled: new Set(), status: 'loading' }
    expect(tierOf(TOKYO, loaded, { r8: loading }, 'mid')).toBe('mid')
    // Tiles merged for somewhere else entirely (the last r8 visit, over Osaka) do not count.
    const osaka = settledFor('r8', 3, view(135.5, 34.69, 8.6))
    expect(tierOf(TOKYO, loaded, { r8: osaka }, 'mid')).toBe('mid')
    expect(tierOf(TOKYO, loaded, { r8: settledFor('r8', 3, TOKYO) }, 'mid')).toBe('r8')
  })

  it('panning at r8 into tiles not loaded yet falls back to the tier below — never stale tiles, never blank', () => {
    const set = settledFor('r8', 3, TOKYO)
    const away = view(TOKYO.longitude + 3, TOKYO.latitude, TOKYO.zoom) // ~2.6 screens east
    expect(tierOf(away, { overview, mid }, { r8: set }, 'r8')).toBe('mid')
    // With the whole fallback still downloading: the overview, not the stale r8 set.
    expect(tierOf(away, { overview }, { r8: set }, 'r8')).toBe('overview')
    // A small pan over parents it has keeps r8 while the new key loads.
    const nudge = view(TOKYO.longitude + 0.05, TOKYO.latitude, TOKYO.zoom)
    expect(tierOf(nudge, { overview, mid }, { r8: set }, 'r8')).toBe('r8')
  })

  it('zooming out of r8 into r6 before r6 has loaded: the finest loaded tier at or below r6', () => {
    const set = settledFor('r8', 3, TOKYO)
    const out = view(TOKYO.longitude, TOKYO.latitude, 7.5) // past r8's hysteresis (7.84)
    expect(tierOf(out, { overview }, { r8: set }, 'r8')).toBe('overview')
    expect(tierOf(out, { overview, r5 }, { r8: set }, 'r8')).toBe('r5')
    expect(tierOf(out, { overview, r5, mid }, { r8: set }, 'r8')).toBe('mid')
    // Inside r8's hysteresis band (7.84–7.99) r8 holds only with tiles for the wider
    // screen: those merged at zoom 8.6 cover ~0.6 of its width, so mid draws until the
    // zoom-7.9 key's tiles merge.
    expect(tierOf(view(TOKYO.longitude, TOKYO.latitude, 7.9), { overview, mid }, { r8: set }, 'r8')).toBe('mid')
    const at79 = settledFor('r8', 3, view(TOKYO.longitude, TOKYO.latitude, 7.9))
    expect(tierOf(view(TOKYO.longitude, TOKYO.latitude, 7.9), { overview, mid }, { r8: at79 }, 'r8')).toBe('r8')
  })

  it('a tiled tier whose index failed to load: the whole tier below draws', () => {
    const failed: TileSet = { lod: 'r8', parentRes: 3, status: 'failed', key: '', settled: new Set(), data: null, parents: [] }
    expect(tierOf(TOKYO, { overview, mid }, { r8: failed }, 'mid')).toBe('mid')
    expect(tierOf(TOKYO, { overview, mid }, { r8: failed }, null)).toBe('mid')
  })

  it('open ocean: the tiled tier settles with nothing to draw, and r6 is the right answer', () => {
    const pacific = view(-140, -30, 9)
    const ocean = settledFor('r8', 3, pacific, null) // every visible parent absent from the index
    expect(ocean.settled.size).toBeGreaterThan(0)
    expect(tierOf(pacific, { overview, mid }, { r8: ocean }, 'mid')).toBe('mid')
  })

  it('a cold deep link draws the finest tier that is loaded', () => {
    expect(tierOf(TOKYO, {}, {}, null)).toBeUndefined()
    expect(tierOf(TOKYO, { overview }, {}, null)).toBe('overview')
    expect(tierOf(TOKYO, { overview, mid }, {}, 'overview')).toBe('mid')
    expect(tierOf(TOKYO, { overview, mid }, { r8: settledFor('r8', 3, TOKYO) }, 'mid')).toBe('r8')
    // Tiles can land before the 31 MB r6 does: then r8 straight from the overview.
    expect(tierOf(TOKYO, { overview }, { r8: settledFor('r8', 3, TOKYO) }, 'overview')).toBe('r8')
  })
})

describe('two tiled tiers adjacent in the band table (r7 by r2 parents, then r8)', () => {
  // The r7 item's manifest: a tiled r7 between mid and r8.
  const M7: Manifest = {
    ...MANIFEST,
    lods: [
      ...MANIFEST.lods.filter((l) => l.lod !== 'r8').map((l) => (l.lod === 'mid' ? { ...l, maxZoom: 6.59 } : l)),
      { ...MANIFEST.lods[2], lod: 'r7', file: undefined, tiled: true, tileParentRes: 2, indexFile: 'data/tiles/r7/index.json', h3Res: 7, approxKm: 1.2, minZoom: 6.59, maxZoom: 7.99 },
      MANIFEST.lods[3],
    ],
  }
  const r7 = M7.lods.find((l) => l.lod === 'r7')!
  const r8 = M7.lods.find((l) => l.lod === 'r8')!
  const loaded = { overview, mid }

  it('selects r7 in its band, r8 in its own, each only with tiles for this view', () => {
    const at7 = view(139.7, 35.68, 7.2)
    expect(tierOf(at7, loaded, {}, 'mid', M7)).toBe('mid')
    expect(tierOf(at7, loaded, { r7: settledFor('r7', 2, at7) }, 'mid', M7)).toBe('r7')
    // In r8's band with r8 loading, r7 — already on screen and covering — keeps drawing…
    const at9 = view(139.7, 35.68, 9)
    const r7Here = settledFor('r7', 2, at9)
    expect(tierOf(at9, loaded, { r7: r7Here }, 'r7', M7)).toBe('r7')
    // …until r8's tiles for this view merge.
    expect(tierOf(at9, loaded, { r7: r7Here, r8: settledFor('r8', 3, at9) }, 'r7', M7)).toBe('r8')
    // Neither covering: the whole tier below.
    const far = view(10, 50, 9)
    expect(tierOf(far, loaded, { r7: r7Here, r8: settledFor('r8', 3, at9) }, 'r8', M7)).toBe('mid')
  })

  it('streams only the tier whose band the camera is in, plus the tier on screen', () => {
    expect([streamWanted(r7, 7.2, 'mid'), streamWanted(r8, 7.2, 'mid')]).toEqual([true, false])
    expect([streamWanted(r7, 9, 'r8'), streamWanted(r8, 9, 'r8')]).toEqual([false, true])
    // r7 on screen while r8 loads: both stream — r7 so a pan keeps it covering.
    expect([streamWanted(r7, 9, 'r7'), streamWanted(r8, 9, 'r7')]).toEqual([true, true])
    // Zooming out of r8 inside its hysteresis: r8 (on screen) and r7 (its band) both stream.
    expect([streamWanted(r7, 7.9, 'r8'), streamWanted(r8, 7.9, 'r8')]).toEqual([true, true])
    // No early entry: below its band and not on screen, a tier does not stream.
    expect(streamWanted(r8, 7.98, 'r7')).toBe(false)
    expect(streamWanted(r7, 6.5, 'mid')).toBe(false)
    // On screen but far below its band (a stale `activeLod` for one render after a jump
    // out): not past the hysteresis, where selection could not pick it anyway.
    expect(streamWanted(r8, 3, 'r8')).toBe(false)
    expect(streamWanted(r8, r8.minZoom - 0.16, 'r8')).toBe(false)
    expect(streamWanted(r8, r8.minZoom - 0.14, 'r8')).toBe(true)
    expect(streamWanted(r7, 1.3, 'r7')).toBe(false)
  })
})
