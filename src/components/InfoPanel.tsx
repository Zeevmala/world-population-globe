import { useGlobeStore } from '../store/useGlobeStore'
import { formatLat, formatLng, formatPop } from '../lib/format'
import { formatDensity } from '../lib/density'

export function InfoPanel() {
  const hover = useGlobeStore((s) => s.hover)
  if (!hover) return null

  const cell = hover.approxKm >= 1 ? `${Math.round(hover.approxKm)} km` : `${Math.round(hover.approxKm * 1000)} m`

  return (
    <div className="w-56 rounded-lg border border-white/10 bg-black/50 px-3 py-2 shadow-lg backdrop-blur-md">
      <div className="text-lg font-semibold text-white">{formatPop(hover.population)} people</div>
      {/* Density is the encoded quantity — the number that maps to this cell's color and
          height — so it leads. Nominal cell area for the resolution (see lib/density.ts),
          hence "≈". */}
      <div className="text-xs text-white/70">
        ≈ {formatDensity(hover.density)} /km²
        <span className="text-white/60"> · {cell} cell</span>
      </div>
      <div className="mt-1 text-xs text-white/60">
        {formatLat(hover.lat)}, {formatLng(hover.lng)}
      </div>
      <div className="mt-1 font-mono text-[10px] text-white/60">{hover.h3}</div>
    </div>
  )
}
