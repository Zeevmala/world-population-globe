import { useEffect, useRef } from 'react'
import { loadLod, loadManifest } from './load'
import { warmOneBand } from '../lib/tierBands'
import { planView, wholeTiersFor } from '../lib/tierPlan'
import { useGlobeStore } from '../store/useGlobeStore'

/**
 * Drives data loading: fetches the manifest + the coarsest tier on mount, then requests
 * each finer whole tier when the view the loader plans for — the camera, or the
 * destination of a flight under way — reaches its band or comes within the prefetch lead
 * of it, plus an interim tier under a whole tier that has not arrived
 * ({@link wholeTiersFor}). A ref-set dedupes in-flight loads (incl. React 19 StrictMode
 * double-invoke).
 */
export function useGlobeData(): void {
  const setManifest = useGlobeStore((s) => s.setManifest)
  const addData = useGlobeStore((s) => s.addData)
  const setStatus = useGlobeStore((s) => s.setStatus)
  const setError = useGlobeStore((s) => s.setError)
  const manifest = useGlobeStore((s) => s.manifest)
  // The plan as a primitive (tier names), so this hook's host re-renders when the plan
  // changes, not on every camera frame.
  const plan = useGlobeStore((s) =>
    wholeTiersFor(planView(s.viewState, s.flyTarget), s.selectionCanvas, s.manifest, s.data)
      .map((l) => l.lod)
      .join(','),
  )
  const requested = useRef<Set<string>>(new Set())
  // Selection's canvas (`selectionCanvas.ts`): changes when a resize settles, not per frame.
  const canvas = useGlobeStore((s) => s.selectionCanvas)
  const settled = useGlobeStore((s) => s.selectionCanvas.width === s.canvas.width && s.selectionCanvas.height === s.canvas.height)

  // Fill the tier-threshold cache (`tierBands.ts`: one window search per canvas key and 1°
  // latitude band, ~12 ms each) in idle time, nearest the camera's latitude first, so a pan
  // across latitudes rarely pays for a band on the spot. Restarts when selection's canvas
  // changes — not during a window drag, where it is a coarse canvas held until the drag stops.
  useEffect(() => {
    if (!manifest || !settled) return
    const w = globalThis as {
      requestIdleCallback?: (cb: () => void) => number
      cancelIdleCallback?: (id: number) => void
    }
    let id = 0
    let stopped = false
    const step = () => {
      if (stopped) return
      const more = warmOneBand(manifest.lods, canvas, useGlobeStore.getState().viewState.latitude)
      if (more) id = w.requestIdleCallback ? w.requestIdleCallback(step) : (setTimeout(step, 50) as unknown as number)
    }
    id = w.requestIdleCallback ? w.requestIdleCallback(step) : (setTimeout(step, 50) as unknown as number)
    return () => {
      stopped = true
      if (w.cancelIdleCallback) w.cancelIdleCallback(id)
      else clearTimeout(id)
    }
  }, [manifest, canvas, settled])

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
    // Tiled tiers stream via useTileStreaming; whole tiers are requested coarsest first.
    if (!manifest || !plan) return
    for (const lod of plan.split(',')) {
      const entry = manifest.lods.find((l) => l.lod === lod)
      if (!entry || requested.current.has(lod)) continue
      requested.current.add(lod)
      loadLod(entry)
        .then(addData)
        .catch((e) => console.error(`LOD "${lod}" failed to load`, e))
    }
  }, [plan, manifest, addData])
}
