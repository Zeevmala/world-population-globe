import { describe, expect, it } from 'vitest'
import type { Canvas } from './footprint'
import { TIGHT, checkCoverage, view } from '../test/cullHarness'

/**
 * Accept (a) + (b) of the cull-window item, against deck.gl's own `GlobeViewport`: on each
 * canvas, at lat 0 / 45 / 70 / 85 and zoom 3.8–9, a cull triggered off-center in its
 * re-cull bucket keeps every front-facing cell that projects inside the canvas — for the
 * triggering view and for the sampled views that share its key (its corners at both ends
 * of its zoom range, and interior views) — with the selection under the cap, so a miss
 * could only be geometry; and the selection stays within 2.5× the on-screen count of
 * every one of those views, so the 120 k cap is spent on screen.
 * (Its own file so vitest runs it beside `lod.test.ts`, not after it.)
 */
const CANVASES: Canvas[] = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  { width: 375, height: 812 },
]

describe('the cull window is the real footprint', () => {
  for (const canvas of CANVASES) {
    it.each([0, 45, 70, 85])(`(a, b) covers and stays tight on ${canvas.width}×${canvas.height} at lat %d`, (lat) => {
      let worst = 0
      let views = 0
      ;[3.8, 4.5, 5.2, 6, 7, 8, 9].forEach((zoom, k) => {
        const c = checkCoverage(view(31.7, lat - 0.37, zoom + 0.03), canvas, 100 + lat + k)
        expect(c.minOnScreen).toBeGreaterThan(300) // dense enough for the ratio to mean something
        worst = Math.max(worst, c.worstRatio)
        views += c.views
      })
      expect(views).toBeGreaterThan(7 * 9)
      expect(worst).toBeLessThanOrEqual(TIGHT)
    })
  }
})
