import { useEffect } from 'react'
import DeckGL from '@deck.gl/react'
import {
  _GlobeView as GlobeView,
  AmbientLight,
  DirectionalLight,
  LightingEffect,
} from '@deck.gl/core'
import type { GlobeViewState } from '../types'
import { useGlobeStore } from '../store/useGlobeStore'
import { useGlobeLayers } from '../layers/useGlobeLayers'
import { useGlobeData } from '../data/useGlobeData'
import { useTileStreaming } from '../data/useTileStreaming'
import { formatHash } from '../lib/urlState'

const GLOBE_VIEW = new GlobeView({ id: 'globe' })

// Strong ambient keeps the Inferno ramp true to the legend; a fixed directional
// "sun" gives the extruded columns enough shading to read as 3D as it rotates.
const LIGHTING = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.05 }),
  sun: new DirectionalLight({ color: [255, 255, 255], intensity: 1.1, direction: [-1, -3, -1] }),
})

const CONTROLLER = { inertia: 300, scrollZoom: { smooth: true } as const }

export function Globe() {
  useGlobeData()
  useTileStreaming()
  const layers = useGlobeLayers()
  const viewState = useGlobeStore((s) => s.viewState)
  const setViewState = useGlobeStore((s) => s.setViewState)
  const autoRotate = useGlobeStore((s) => s.autoRotate)
  const setAutoRotate = useGlobeStore((s) => s.setAutoRotate)
  const rotateBy = useGlobeStore((s) => s.rotateBy)
  const flyTarget = useGlobeStore((s) => s.flyTarget)

  useEffect(() => {
    if (!autoRotate) return
    let raf = 0
    let last = performance.now()
    const tick = (t: number) => {
      rotateBy((t - last) * 0.004)
      last = t
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [autoRotate, rotateBy])

  // Animated fly-to: ease the camera from the current view to `flyTarget` over ~1.6 s.
  // A manual rAF tween (like auto-rotate above) is used instead of deck's
  // FlyToInterpolator, which assumes Web Mercator and misbehaves on GlobeView.
  useEffect(() => {
    if (!flyTarget) return
    const start = useGlobeStore.getState().viewState
    const startLng = start.longitude
    const startLat = start.latitude
    const startZoom = start.zoom
    let dLng = flyTarget.longitude - startLng
    dLng -= 360 * Math.round(dLng / 360) // shortest way around the globe
    const dLat = flyTarget.latitude - startLat
    const dZoom = flyTarget.zoom - startZoom
    const DURATION = 1600
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / DURATION)
      const e = ease(t)
      const lng = startLng + dLng * e
      setViewState({
        ...useGlobeStore.getState().viewState,
        longitude: ((((lng + 180) % 360) + 360) % 360) - 180,
        latitude: startLat + dLat * e,
        zoom: startZoom + dZoom * e,
      })
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [flyTarget, setViewState])

  // Sync the camera to the URL hash (debounced) so a reload restores the view and
  // "Share" yields a deep-link. Skipped while idly auto-spinning (no URL churn);
  // `replaceState` keeps the back-stack clean.
  useEffect(() => {
    if (autoRotate) return
    const t = setTimeout(() => {
      history.replaceState(null, '', formatHash(viewState))
    }, 400)
    return () => clearTimeout(t)
  }, [viewState, autoRotate])

  return (
    <DeckGL
      views={GLOBE_VIEW}
      viewState={viewState}
      controller={CONTROLLER}
      onViewStateChange={(e) => setViewState(e.viewState as unknown as GlobeViewState)}
      onInteractionStateChange={(s: { isDragging?: boolean }) => {
        if (s.isDragging && autoRotate) setAutoRotate(false)
      }}
      effects={[LIGHTING]}
      layers={layers}
    />
  )
}
