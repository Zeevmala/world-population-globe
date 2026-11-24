// `.ts` extensions: `scripts/` import this module under Node's native type stripping.
import { CANVAS_STEP, keyCanvas } from './footprint.ts'
import type { Canvas } from './footprint.ts'

/**
 * The canvas tier SELECTION reads (`tierBands.ts`, and through it the loader, the tile
 * streams, the zoom ladder and the search's arrival zoom) — not the real one while a window
 * is being dragged. The cull and tile selection still follow the real canvas, on its 16 px
 * key (`footprint.ts` `keyCanvas`), so the screen is always covered.
 *
 * A canvas's thresholds are computed the first time it is seen, per 1° latitude band (~12 ms
 * each, `tierBands.ts`), and a drag reports a new canvas on every frame: on the real canvas's
 * 16 px key a drag from 1280 to 1920 px wide crossed 40 keys, each a hitch. While the canvas
 * is changing, selection keeps reading the canvas it read before as long as that one
 * {@link covers} the real one (a shrinking drag computes nothing), and when the real canvas
 * outgrows it, a canvas {@link GROW} times what covering needs; only once no resize has come
 * for {@link SETTLE_MS} does it read the real canvas again. Covering means every threshold is
 * at least as late as the real canvas's own, so a tier selected during the drag still fits
 * the cap in the real canvas's cull window (`selectionCanvas.test.ts`); the drag costs detail
 * only while it lasts. 1280 → 1920 px wide in 1 px steps computes thresholds for two
 * covering canvases and the final one.
 */

/** Headroom a covering canvas takes on each side that outgrew the last one. */
export const GROW = 1.25

/** Quiet time (ms) after the last resize before selection follows the real canvas. */
export const SETTLE_MS = 250

/** `windowCanvas`'s divisor: the key height less one step (≥ 1). */
const below = (h: number) => Math.max(1, h - CANVAS_STEP)
const up = (v: number) => Math.ceil(v / CANVAS_STEP) * CANVAS_STEP

/**
 * Do canvas `a`'s thresholds hold on canvas `b` — is every cull window of `b`'s key inside
 * the corresponding window of `a`'s? Both on their keys: `a`'s window canvas
 * (`footprint.ts` `windowCanvas`, `W·H / (H − 16)` wide) must be at least as tall and, since
 * GlobeView's eye backs off with the canvas height, at least `H_a / H_b` times as wide as
 * `b`'s; then `a`'s shorter side — its re-cull step — is not shorter either.
 */
export function covers(a: Canvas, b: Canvas): boolean {
  const ka = keyCanvas(a)
  const kb = keyCanvas(b)
  return ka.height >= kb.height && ka.width * below(kb.height) >= kb.width * below(ka.height)
}

/**
 * The canvas selection reads when the real canvas has just changed to `real`: the one it
 * reads now if that still covers `real` (no new thresholds), else one that does with
 * {@link GROW} headroom on each side that outgrew it.
 */
export function resizingCanvas(current: Canvas, real: Canvas): Canvas {
  if (covers(current, real)) return current
  const ka = keyCanvas(current)
  const kb = keyCanvas(real)
  const height = kb.height <= ka.height ? ka.height : up(kb.height * GROW)
  const need = (kb.width * below(height)) / below(kb.height) // the width covering `real` at `height`
  const width = need <= ka.width ? ka.width : up(need * GROW)
  return { width, height }
}
