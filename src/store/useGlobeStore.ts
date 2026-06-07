import { create } from 'zustand'
import type { GlobeViewState, HoverInfo, LodData, Manifest } from '../types'

const INITIAL_VIEW: GlobeViewState = {
  longitude: 25,
  latitude: 20,
  zoom: 0.2,
  minZoom: -1,
  maxZoom: 7,
}

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface GlobeStore {
  manifest: Manifest | null
  data: Record<string, LodData>
  status: Status
  error: string | null
  hover: HoverInfo | null
  viewState: GlobeViewState
  autoRotate: boolean

  setManifest: (m: Manifest) => void
  addData: (d: LodData) => void
  setStatus: (s: Status) => void
  setError: (e: string) => void
  setHover: (h: HoverInfo | null) => void
  setViewState: (v: GlobeViewState) => void
  rotateBy: (deg: number) => void
  toggleAutoRotate: () => void
  setAutoRotate: (on: boolean) => void
}

const wrapLng = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180

export const useGlobeStore = create<GlobeStore>((set) => ({
  manifest: null,
  data: {},
  status: 'idle',
  error: null,
  hover: null,
  viewState: INITIAL_VIEW,
  autoRotate: true,

  setManifest: (manifest) => set({ manifest }),
  addData: (d) => set((s) => ({ data: { ...s.data, [d.lod]: d } })),
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error, status: 'error' }),
  setHover: (hover) => set({ hover }),
  setViewState: (viewState) => set({ viewState }),
  rotateBy: (deg) =>
    set((s) => ({
      viewState: { ...s.viewState, longitude: wrapLng(s.viewState.longitude + deg) },
    })),
  toggleAutoRotate: () => set((s) => ({ autoRotate: !s.autoRotate })),
  setAutoRotate: (autoRotate) => set({ autoRotate }),
}))
