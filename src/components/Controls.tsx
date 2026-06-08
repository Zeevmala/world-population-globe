import { useState } from 'react'
import { useGlobeStore } from '../store/useGlobeStore'
import { viewUrl } from '../lib/urlState'

/** Zoom step per +/− click — a few clicks span overview → mid → r8. */
const ZOOM_STEP = 0.7

export function Controls() {
  const autoRotate = useGlobeStore((s) => s.autoRotate)
  const toggleAutoRotate = useGlobeStore((s) => s.toggleAutoRotate)
  const zoomBy = useGlobeStore((s) => s.zoomBy)
  const viewState = useGlobeStore((s) => s.viewState)
  const [copied, setCopied] = useState(false)

  const share = async () => {
    try {
      await navigator.clipboard.writeText(viewUrl(viewState))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={toggleAutoRotate}
        className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/90 shadow-lg backdrop-blur-md transition hover:bg-white/10"
      >
        {autoRotate ? '⏸ Pause rotation' : '▶ Auto-rotate'}
      </button>
      <button
        type="button"
        onClick={share}
        className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/90 shadow-lg backdrop-blur-md transition hover:bg-white/10"
      >
        {copied ? '✓ Copied' : '🔗 Share view'}
      </button>
      <div className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black/40 text-white/90 shadow-lg backdrop-blur-md">
        <button
          type="button"
          onClick={() => zoomBy(ZOOM_STEP)}
          aria-label="Zoom in"
          title="Zoom in"
          className="px-3 py-1.5 text-base leading-none transition hover:bg-white/10"
        >
          +
        </button>
        <div className="h-px bg-white/10" />
        <button
          type="button"
          onClick={() => zoomBy(-ZOOM_STEP)}
          aria-label="Zoom out"
          title="Zoom out"
          className="px-3 py-1.5 text-base leading-none transition hover:bg-white/10"
        >
          −
        </button>
      </div>
    </div>
  )
}
