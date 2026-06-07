import { useGlobeStore } from '../store/useGlobeStore'
import { pickLod } from '../lib/lod'

export function Controls() {
  const autoRotate = useGlobeStore((s) => s.autoRotate)
  const toggleAutoRotate = useGlobeStore((s) => s.toggleAutoRotate)
  const manifest = useGlobeStore((s) => s.manifest)
  const data = useGlobeStore((s) => s.data)
  const zoom = useGlobeStore((s) => s.viewState.zoom)

  const activeLod = pickLod(zoom, manifest, data)
  const entry = manifest?.lods.find((l) => l.lod === activeLod)

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={toggleAutoRotate}
        className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/90 shadow-lg backdrop-blur-md transition hover:bg-white/10"
      >
        {autoRotate ? '⏸ Pause rotation' : '▶ Auto-rotate'}
      </button>
      {entry && (
        <div className="hidden rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-[11px] text-white/70 shadow-lg backdrop-blur-md sm:block">
          {entry.approxKm} km cells · {entry.cellCount.toLocaleString()} rendered
        </div>
      )}
    </div>
  )
}
