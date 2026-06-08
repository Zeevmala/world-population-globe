import { create } from 'zustand'
import type { GlobeViewState, HoverInfo, LodData, Manifest } from '../types'
import { parseHash } from '../lib/urlState'

// A `#lng/lat/zoom` deep-link (if present) seeds the camera and disables the
// idle auto-spin so the shared view stays put.
const HASH_VIEW = parseHash()

const INITIAL_VIEW: GlobeViewState = {
  longitude: HASH_VIEW?.longitude ?? 25,
  latitude: HASH_VIEW?.latitude ?? 20,
  // Seats the globe as a larger hero on load; stays < the mid band (2.2) so the
  // coarse `overview` tier remains the on-load tier (no eager 31 MB mid fetch).
  zoom: HASH_VIEW?.zoom ?? 2,
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
}

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
  /** Pending fly-to destination (animated by `Globe`); null when idle. */
  flyTarget: FlyTarget | null

  setManifest: (m: Manifest) => void
  addData: (d: LodData) => void
  setR8Data: (d: LodData | null) => void
  setStatus: (s: Status) => void
  setError: (e: string) => void
  setHover: (h: HoverInfo | null) => void
  setViewState: (v: GlobeViewState) => void
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
  autoRotate: !HASH_VIEW,
  flyTarget: null,

  setManifest: (manifest) => set({ manifest }),
  addData: (d) => set((s) => ({ data: { ...s.data, [d.lod]: d } })),
  setR8Data: (r8Data) => set({ r8Data }),
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error, status: 'error' }),
  setHover: (hover) => set({ hover }),
  setViewState: (viewState) => set({ viewState }),
  rotateBy: (deg) =>
    set((s) => ({
      viewState: { ...s.viewState, longitude: wrapLng(s.viewState.longitude + deg) },
    })),
  // Center-only zoom (lng/lat fixed) — the zoom mode GlobeView supports, unlike
  // cursor-anchored scroll-zoom. Clamped to the view's min/max.
  zoomBy: (delta) =>
    set((s) => {
      const { zoom, minZoom = -2, maxZoom = 8 } = s.viewState
      const next = Math.min(maxZoom, Math.max(minZoom, zoom + delta))
      return { viewState: { ...s.viewState, zoom: next } }
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
