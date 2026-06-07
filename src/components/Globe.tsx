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
