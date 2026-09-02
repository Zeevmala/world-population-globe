import { useEffect, useState } from 'react'
import DeckGL from '@deck.gl/react'
import type { DeckGLRef } from '@deck.gl/react'
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
import { useReducedMotion } from '../lib/useReducedMotion'
import { formatHash } from '../lib/urlState'

const GLOBE_VIEW = new GlobeView({ id: 'globe' })

// Strong ambient keeps the Inferno ramp true to the legend; a fixed directional
// "sun" gives the extruded columns enough shading to read as 3D as it rotates.
const LIGHTING = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.05 }),
  sun: new DirectionalLight({ color: [255, 255, 255], intensity: 1.1, direction: [-1, -3, -1] }),
})

const CONTROLLER = { inertia: 300, scrollZoom: { smooth: true } as const }

// Adaptive device-pixel ratio. While the globe is in motion (drag / spin / fly) it's
// fill-rate bound, so cap the buffer at 1.5× CSS px to protect the frame budget. Once
// motion settles, render at up to 2× for a crisp resting image. The debounce on the
// way *up* avoids reallocating the drawing buffer during rapid input.
const MOTION_PIXEL_RATIO = 1.5
const STILL_PIXEL_RATIO = 2
const SETTLE_MS = 200

export function Globe() {
  useGlobeData()
  useTileStreaming()
  const layers = useGlobeLayers()
  const viewState = useGlobeStore((s) => s.viewState)
  const setViewState = useGlobeStore((s) => s.setViewState)
  const autoRotate = useGlobeStore((s) => s.autoRotate)
  const setAutoRotate = useGlobeStore((s) => s.setAutoRotate)
  const setDragging = useGlobeStore((s) => s.setDragging)
  const isDragging = useGlobeStore((s) => s.isDragging)
  const rotateBy = useGlobeStore((s) => s.rotateBy)
  const flyTarget = useGlobeStore((s) => s.flyTarget)
  const reducedMotion = useReducedMotion()
  const [flying, setFlying] = useState(false)
  const [sharp, setSharp] = useState(false)

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

  // Animated fly-to: ease the camera from the current view to `flyTarget` over the
  // target's duration (~1.6 s for a search flight, ~0.4 s for a zoom nudge).
  // A manual rAF tween (like auto-rotate above) is used instead of deck's
  // FlyToInterpolator, which assumes Web Mercator and misbehaves on GlobeView. Under
  // reduced-motion we jump straight to the target instead of tweening.
  useEffect(() => {
    if (!flyTarget) return
    const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180
    const start = useGlobeStore.getState().viewState
    const startLng = start.longitude
    let dLng = flyTarget.longitude - startLng
    dLng -= 360 * Math.round(dLng / 360) // shortest way around the globe

    const startLat = start.latitude
    const startZoom = start.zoom
    const dLat = flyTarget.latitude - startLat
    const dZoom = flyTarget.zoom - startZoom
    // A zoom nudge (+/- button, keyboard) targets the current lng/lat, so it must not
    // write them back each frame — that would freeze the idle spin for the tween's
    // duration and fight the rotation rAF for the camera.
    const moving = dLng !== 0 || dLat !== 0

    if (reducedMotion) {
      const live = useGlobeStore.getState().viewState
      setViewState({
        ...live,
        longitude: moving ? wrapLng(flyTarget.longitude) : live.longitude,
        latitude: moving ? flyTarget.latitude : live.latitude,
        zoom: flyTarget.zoom,
      })
      return
    }

    const DURATION = flyTarget.durationMs ?? 1600
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

    let raf = 0
    let started = false
    const t0 = performance.now()
    const tick = (now: number) => {
      if (!started) {
        started = true
        setFlying(true) // in the rAF callback, not the effect body (cascading-render lint)
      }
      const t = Math.min(1, (now - t0) / DURATION)
      const e = ease(t)
      const live = useGlobeStore.getState().viewState
      setViewState({
        ...live,
        longitude: moving ? wrapLng(startLng + dLng * e) : live.longitude,
        latitude: moving ? startLat + dLat * e : live.latitude,
        zoom: startZoom + dZoom * e,
      })
      if (t < 1) raf = requestAnimationFrame(tick)
      else setFlying(false)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      setFlying(false)
    }
  }, [flyTarget, setViewState, reducedMotion])

  // Render crisp at rest, soft while moving. Drop to the motion cap ~immediately when a
  // drag / spin / flight starts; raise to the still cap only after motion settles. Both
  // writes go through a timer (not the effect body) to avoid cascading-render churn.
  useEffect(() => {
    const inMotion = isDragging || autoRotate || flying
    const t = setTimeout(() => setSharp(!inMotion), inMotion ? 0 : SETTLE_MS)
    return () => clearTimeout(t)
  }, [isDragging, autoRotate, flying])

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
      ref={(r: DeckGLRef | null) => {
        // Dev-only debug handle (mirrors `__globe`): lets QA tooling inspect the
        // live deck instance (active sublayers, metrics) without a UI.
        if (import.meta.env.DEV) {
          ;(globalThis as unknown as { __deck?: unknown }).__deck = r?.deck ?? undefined
        }
      }}
      views={GLOBE_VIEW}
      viewState={viewState}
      controller={CONTROLLER}
      useDevicePixels={Math.min(
        window.devicePixelRatio || 1,
        sharp ? STILL_PIXEL_RATIO : MOTION_PIXEL_RATIO,
      )}
      onViewStateChange={(e) => setViewState(e.viewState as unknown as GlobeViewState)}
      onInteractionStateChange={(s: { isDragging?: boolean }) => {
        const dragging = !!s.isDragging
        setDragging(dragging)
        if (dragging && autoRotate) setAutoRotate(false)
      }}
      effects={[LIGHTING]}
      layers={layers}
    />
  )
}
