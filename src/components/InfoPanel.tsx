import { useGlobeStore } from '../store/useGlobeStore'
import { formatLat, formatLng, formatPop } from '../lib/format'

export function InfoPanel() {
  const hover = useGlobeStore((s) => s.hover)
  if (!hover) return null

  // Regular-hexagon area ≈ 2.598 · edge²; approxKm is the tier's nominal edge.
  // A rough per-cell density indicator (not the exact H3 cell area).
  const areaKm2 = 2.598 * hover.approxKm * hover.approxKm
  const density = areaKm2 > 0 ? hover.population / areaKm2 : 0

  return (
    <div className="w-56 rounded-lg border border-white/10 bg-black/50 px-3 py-2 shadow-lg backdrop-blur-md">
      <div className="text-lg font-semibold text-white">{formatPop(hover.population)} people</div>
      <div className="text-xs text-white/70">≈ {Math.round(density).toLocaleString()} /km² (cell)</div>
      <div className="mt-1 text-xs text-white/60">
        {formatLat(hover.lat)}, {formatLng(hover.lng)}
      </div>
      <div className="mt-1 font-mono text-[10px] text-white/40">{hover.h3}</div>
    </div>
  )
}
