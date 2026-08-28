import { useEffect } from 'react'
import { useGlobeStore } from '../store/useGlobeStore'
import { ZOOM_STEP } from './Controls'

/** Latitude clamp — the poles are a projection singularity, stop just short. */
const LAT_LIMIT = 85

const wrapLng = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180

/**
 * Pan step in degrees for one arrow press. Scales with zoom so a press moves a
 * comparable fraction of the viewport at 22 km cells and at 400 m cells.
 */
function panStep(zoom: number, fast: boolean): number {
  return Math.max(0.35, 24 / Math.pow(2, zoom)) * (fast ? 3 : 1)
}

interface KeyboardShortcutsProps {
  onFocusSearch: () => void
  onToggleHelp: () => void
  onShare: () => void
  /** Esc when nothing else claimed it (dialog / search handle their own). */
  onEscape: () => void
}

/**
 * Global keyboard driver for the globe. Without it the map is mouse-only — a
 * disqualifier for a reference cartographic UI. Everything routes through existing
 * store actions, so keyboard and pointer produce identical camera state.
 */
export function KeyboardShortcuts({
  onFocusSearch,
  onToggleHelp,
  onShare,
  onEscape,
}: KeyboardShortcutsProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable
      // Text fields own their own keys, and the focused zoom slider (an <input>) must
      // keep its native arrow semantics — both are excluded by this one guard.
      if (typing) return

      const store = useGlobeStore.getState()
      const view = store.viewState

      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault()
          const step = panStep(view.zoom, e.shiftKey)
          const dLat = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0
          const dLng = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0
          store.setAutoRotate(false)
          store.setViewState({
            ...view,
            longitude: wrapLng(view.longitude + dLng),
            latitude: Math.min(LAT_LIMIT, Math.max(-LAT_LIMIT, view.latitude + dLat)),
          })
          return
        }
        case '+':
        case '=':
          e.preventDefault()
          store.zoomBy(ZOOM_STEP)
          return
        case '-':
        case '_':
          e.preventDefault()
          store.zoomBy(-ZOOM_STEP)
          return
        case '/':
          e.preventDefault()
          onFocusSearch()
          return
        case '?':
          e.preventDefault()
          onToggleHelp()
          return
        case 'r':
        case 'R':
          store.toggleAutoRotate()
          return
        case 'h':
        case 'H':
          // Same framing rule the store uses on load (portrait needs a tighter hero zoom).
          store.flyTo(25, 20, window.innerHeight > window.innerWidth * 1.4 ? 1.9 : 1.3)
          return
        case 'c':
        case 'C':
          onShare()
          return
        case 'Escape':
          onEscape()
          return
        default:
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onFocusSearch, onToggleHelp, onShare, onEscape])

  return null
}
