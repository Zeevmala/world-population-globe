/**
 * Pins the COMMITTED `public/data/manifest.json` to the band model and to the inlined
 * copy the unit tests use (`src/test/fixtures.ts`). The `src/**` tests cannot read files
 * (the app tsconfig has no Node types), so without this a pipeline re-run could move the
 * real bands and every band test would go on passing against a stale copy.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MANIFEST } from '../src/test/fixtures.ts'
import { MAX_ZOOM, MIN_ZOOM } from '../src/lib/camera.ts'
import { zoomForHexPx } from '../src/lib/screenScale.ts'

const real = JSON.parse(readFileSync(new URL('../public/data/manifest.json', import.meta.url), 'utf8'))

/** `pipeline/tiers.py` BAND_PX — the rule, restated as the oracle. */
const BAND_PX = 3

/** The fields the client's selection, loading, ladder and density domain read. */
const TABLE = ['lod', 'h3Res', 'approxKm', 'minZoom', 'maxZoom', 'cellCount', 'maxPopulation', 'sumPopulation', 'tiled', 'file']
const pick = (e) => Object.fromEntries(TABLE.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]))

describe('public/data/manifest.json', () => {
  it('has the tier table the unit-test fixture inlines', () => {
    expect(real.lods.map(pick)).toEqual(MANIFEST.lods.map(pick))
  })

  it('bands every tier by the 3 px rule (within 0.02 zoom), end to end over the camera range', () => {
    const lods = real.lods
    for (const l of lods.slice(1)) {
      expect(Math.abs(l.minZoom - zoomForHexPx(l.h3Res, BAND_PX))).toBeLessThanOrEqual(0.02)
    }
    for (let i = 1; i < lods.length; i++) expect(lods[i].minZoom).toBe(lods[i - 1].maxZoom)
    expect(lods[0].minZoom).toBeLessThanOrEqual(MIN_ZOOM)
    expect(lods[lods.length - 1].maxZoom).toBeGreaterThanOrEqual(MAX_ZOOM)
  })
})
