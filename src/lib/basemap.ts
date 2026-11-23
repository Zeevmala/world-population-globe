/**
 * The basemap toggle's decisions, kept out of the hooks so Node can check them: what the
 * user asked for and what the texture is doing (a small state machine), which basemap
 * layers that puts on screen, which texture file a device can take, and the luminance
 * bound the night-lights texture is encoded under (`scripts/texture/encode_black_marble.py`).
 *
 * Nothing here imports deck.gl: the store (entry chunk) reads it, and deck.gl stays in the
 * lazy Globe chunk.
 */
import { inferno } from './colorRamp.ts'

/** `dark` — the self-drawn ocean sphere + Natural Earth land fill (the default); `night` — NASA Black Marble. */
export type BasemapMode = 'dark' | 'night'

/** The night-lights texture: never asked for → being fetched → decoded and held | the fetch or decode failed. */
export type TextureStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface BasemapState {
  /** What the user last asked for — the toggle's pressed state. */
  want: BasemapMode
  texture: TextureStatus
  /** A message for the user when the night lights they asked for could not be shown. */
  error: string | null
}

export type BasemapEvent =
  | { type: 'toggle' }
  | { type: 'loaded' }
  | { type: 'failed'; message: string }

export const INITIAL_BASEMAP: BasemapState = { want: 'dark', texture: 'idle', error: null }

/**
 * The state machine. Turning night lights on starts the fetch the first time (and again
 * after a failure — a retry); once the texture is held, on and off cost no request.
 * Turning them off while the fetch runs lets it finish (the next "on" is then instant)
 * but nothing is shown. A failure while they are wanted drops the request back to `dark`
 * (the toggle is not left pressed over a basemap that is not there) with a message.
 */
export function basemapReducer(s: BasemapState, e: BasemapEvent): BasemapState {
  switch (e.type) {
    case 'toggle':
      if (s.want === 'night') return { ...s, want: 'dark', error: null }
      return {
        want: 'night',
        texture: s.texture === 'idle' || s.texture === 'failed' ? 'loading' : s.texture,
        error: null,
      }
    case 'loaded':
      return s.texture === 'loading' ? { ...s, texture: 'ready' } : s
    case 'failed':
      if (s.texture !== 'loading') return s
      return s.want === 'night'
        ? { want: 'dark', texture: 'failed', error: e.message }
        : { ...s, texture: 'failed' }
  }
}

/** The basemap actually on screen: night lights only once the texture is held. */
export function shownBasemap(s: BasemapState): BasemapMode {
  return s.want === 'night' && s.texture === 'ready' ? 'night' : 'dark'
}

/** Which basemap layers draw. `night` false means the night layer is not in the stack at all. */
export interface BasemapPlan {
  /** `earth-sphere`, the flat-colour ocean sphere. */
  sphere: boolean
  /** `earth-land`, the Natural Earth land fill + outline — it would cover the lights, so it goes. */
  land: boolean
  /** `earth-night`, the Black Marble texture on the globe. */
  night: boolean
}

/**
 * Layers for a basemap. The dark plan is exactly today's stack, so the default render is
 * unchanged; in night mode the sphere and the land stay in the stack hidden (no re-fetch
 * of the land GeoJSON, no re-init on the way back), and the night layer replaces them.
 */
export function basemapPlan(shown: BasemapMode): BasemapPlan {
  return shown === 'night'
    ? { sphere: false, land: false, night: true }
    : { sphere: true, land: true, night: false }
}

/** One encoded size of the night-lights texture (both written by the encode script). */
export interface BasemapTexture {
  /** Relative to the app's base URL. */
  path: string
  width: number
  height: number
}

export const BASEMAP_TEXTURES: readonly BasemapTexture[] = [
  { path: 'basemap/black-marble-4096.jpg', width: 4096, height: 2048 },
  { path: 'basemap/black-marble-2048.jpg', width: 2048, height: 1024 },
]

/**
 * The largest texture this device can hold. WebGL 2 guarantees MAX_TEXTURE_SIZE ≥ 2048,
 * so the 2048×1024 file always fits; a device that reports less (not WebGL 2) still gets
 * it, and the upload is the device's to refuse.
 */
export function basemapTextureFor(maxTextureSize: number): BasemapTexture {
  return (
    BASEMAP_TEXTURES.find((t) => t.width <= maxTextureSize && t.height <= maxTextureSize) ??
    BASEMAP_TEXTURES[BASEMAP_TEXTURES.length - 1]
  )
}

/** WCAG relative luminance of an 8-bit sRGB colour (linear light, Rec. 709 weights). */
export function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/**
 * data > basemap, as a number: no pixel of the night-lights texture may be brighter than
 * the Inferno ramp at its midpoint (≈ 0.140). The encode script holds the texture to 90 %
 * of it; `scripts/qa/basemap_qa.mjs` checks the decoded texture and the rendered frame.
 */
export const INFERNO_MID_LUMINANCE = relativeLuminance(inferno(0.5))
