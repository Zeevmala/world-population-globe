import { create } from 'zustand'
import type { GlobeViewState, HoverInfo, LodData, Manifest } from '../types'
import { parseHash } from '../lib/urlState'
import { prefersReducedMotion } from '../lib/useReducedMotion'

// A `#lng/lat/zoom` deep-link (if present) seeds the camera and disables the
// idle auto-spin so the shared view stays put.
const HASH_VIEW = parseHash()

// Default hero zoom is viewport-aware: on tall-portrait screens the 1.3 framing
// leaves the globe small with dead space below, so tighten to 1.9. Both values stay
// < the mid band (2.2) so the coarse `overview` tier remains the on-load tier
// (no eager 31 MB mid fetch). Load-time only — deep-links and user zoom always win.
const defaultZoom = (): number =>
  window.innerHeight > window.innerWidth * 1.4 ? 1.9 : 1.3

const INITIAL_VIEW: GlobeViewState = {
  longitude: HASH_VIEW?.longitude ?? 25,
  latitude: HASH_VIEW?.latitude ?? 20,
  zoom: HASH_VIEW?.zoom ?? defaultZoom(),
  minZoom: -1,
  maxZoom: 7,
}

type Status = 'idle' | 'loading' | 'ready' | 'error'

/** A requested camera destination; `id` makes repeat flights to the same place retrigger. */
export interface FlyTarget {
  longitude: number
  latitude: number
  zoom: number
  id: number
  /** Tween length; short for a zoom nudge, long for a cross-globe flight. */
  durationMs?: number
}

/** Tween length for a zoom-button / keyboard nudge — long enough to read as motion,
 *  short enough not to feel like waiting. */
const ZOOM_TWEEN_MS = 420

interface GlobeStore {
  manifest: Manifest | null
  data: Record<string, LodData>
  /** Merged, viewport-scoped r8 tiles (streamed); null until deep zoom. */
  r8Data: LodData | null
  status: Status
  error: string | null
  hover: HoverInfo | null
  viewState: GlobeViewState
  autoRotate: boolean
  /** True while the user is actively dragging — disables hover picking so the
   * costly picking-buffer re-render doesn't fire on every pointermove. */
  isDragging: boolean
  /** Pending fly-to destination (animated by `Globe`); null when idle. */
  flyTarget: FlyTarget | null
  /** Tier currently on screen — feeds LOD hysteresis and the scale readout. */
  activeLod: string | null

  setManifest: (m: Manifest) => void
  addData: (d: LodData) => void
  setR8Data: (d: LodData | null) => void
  setStatus: (s: Status) => void
  setError: (e: string) => void
  setHover: (h: HoverInfo | null) => void
  setViewState: (v: GlobeViewState) => void
  setDragging: (on: boolean) => void
  setActiveLod: (lod: string | null) => void
  rotateBy: (deg: number) => void
  zoomBy: (delta: number) => void
  flyTo: (lng: number, lat: number, zoom?: number) => void
  toggleAutoRotate: () => void
  setAutoRotate: (on: boolean) => void
}

const wrapLng = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180

export const useGlobeStore = create<GlobeStore>((set) => ({
  manifest: null,
  data: {},
  r8Data: null,
  status: 'idle',
  error: null,
  hover: null,
  viewState: INITIAL_VIEW,
  // Idle auto-spin on load, unless a deep-link pins the view or the user has asked
  // for reduced motion.
  autoRotate: !HASH_VIEW && !prefersReducedMotion(),
  isDragging: false,
  flyTarget: null,
  activeLod: null,

  setManifest: (manifest) => set({ manifest }),
  addData: (d) => set((s) => ({ data: { ...s.data, [d.lod]: d } })),
  setR8Data: (r8Data) => set({ r8Data }),
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error, status: 'error' }),
  setHover: (hover) => set({ hover }),
  setViewState: (viewState) => set({ viewState }),
  // Idempotent guard: only write (and re-render) on an actual edge, so the
  // per-frame interaction callback doesn't churn the store while dragging.
  setDragging: (on) => set((s) => (s.isDragging === on ? s : { isDragging: on })),
  // Same idempotent-edge guard: written from a render effect, so it must not
  // re-enter when the tier is unchanged.
  setActiveLod: (lod) => set((s) => (s.activeLod === lod ? s : { activeLod: lod })),
  rotateBy: (deg) =>
    set((s) => ({
      viewState: { ...s.viewState, longitude: wrapLng(s.viewState.longitude + deg) },
    })),
  // Center-only zoom (lng/lat fixed) — the zoom mode GlobeView supports, unlike
  // cursor-anchored scroll-zoom. Clamped to the view's min/max. Routed through the
  // fly tween rather than snapping the camera: an instant zoom jump reads as a glitch
  // and skips every LOD band in one frame, forcing a data load and a full re-cull on
  // the same tick. Repeat clicks accumulate, because each reads the live (mid-tween) zoom.
  zoomBy: (delta) =>
    set((s) => {
      const { zoom, minZoom = -2, maxZoom = 8 } = s.viewState
      const next = Math.min(maxZoom, Math.max(minZoom, zoom + delta))
      if (next === zoom) return s
      return {
        flyTarget: {
          longitude: s.viewState.longitude,
          latitude: s.viewState.latitude,
          zoom: next,
          id: Date.now(),
          durationMs: ZOOM_TWEEN_MS,
        },
      }
    }),
  // Request an animated flight (run by `Globe`); stops auto-rotation. Defaults to a
  // city-scale zoom (5 → r8 streams in) unless the current view is already deeper.
  flyTo: (lng, lat, zoom) =>
    set((s) => ({
      autoRotate: false,
      flyTarget: {
        longitude: lng,
        latitude: lat,
        zoom: zoom ?? Math.max(s.viewState.zoom, 5),
        id: Date.now(),
      },
    })),
  toggleAutoRotate: () => set((s) => ({ autoRotate: !s.autoRotate })),
  setAutoRotate: (autoRotate) => set({ autoRotate }),
}))

// Dev-only debug handle (stripped from production builds): lets tooling inspect
// state and drive the camera, e.g. `__globe.getState().setViewState(...)`.
if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __globe?: typeof useGlobeStore }).__globe = useGlobeStore
}
