import { infernoCssStops } from '../lib/colorRamp'

export function Legend() {
  return (
    <div className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 shadow-lg backdrop-blur-md">
      <div className="mb-1 text-[11px] font-medium text-white/80">
        Population density · column height &amp; color
      </div>
      <div
        className="h-2.5 w-44 rounded"
        style={{ background: `linear-gradient(90deg, ${infernoCssStops()})` }}
      />
      <div className="mt-1 flex justify-between text-[10px] text-white/50">
        <span>Low</span>
        <span>High (log scale)</span>
      </div>
    </div>
  )
}
