import { useEffect, useRef } from 'react'
import { loadLod, loadManifest } from './load'
import { wholeTierFor } from '../lib/tierPlan'
import { useGlobeStore } from '../store/useGlobeStore'

/**
 * Drives data loading: fetches the manifest + the coarsest tier on mount, then
 * lazily loads a finer whole tier the first time the camera rests in or passes
 * through its zoom band ({@link wholeTierFor}). A ref-set
 * dedupes in-flight loads (incl. React 19 StrictMode double-invoke).
 */
export function useGlobeData(): void {
  const setManifest = useGlobeStore((s) => s.setManifest)
  const addData = useGlobeStore((s) => s.addData)
  const setStatus = useGlobeStore((s) => s.setStatus)
  const setError = useGlobeStore((s) => s.setError)
  const manifest = useGlobeStore((s) => s.manifest)
  const data = useGlobeStore((s) => s.data)
  const zoom = useGlobeStore((s) => s.viewState.zoom)
  const requested = useRef<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    setStatus('loading')
    void (async () => {
      try {
        const m = await loadManifest()
        if (!alive) return
        setManifest(m)
        const first = m.lods[0]
        requested.current.add(first.lod)
        const d = await loadLod(first)
        if (!alive) return
        addData(d)
        setStatus('ready')
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [setManifest, addData, setStatus, setError])

  useEffect(() => {
    // Tiled tiers (r8) stream via useTileStreaming; of the whole tiers, only the finest
    // one whose band is reached is fetched (see `wholeTierFor`).
    const entry = wholeTierFor(zoom, manifest)
    if (!entry || data[entry.lod] || requested.current.has(entry.lod)) return
    requested.current.add(entry.lod)
    loadLod(entry)
      .then(addData)
      .catch((e) => console.error(`LOD "${entry.lod}" failed to load`, e))
  }, [zoom, manifest, data, addData])
}
