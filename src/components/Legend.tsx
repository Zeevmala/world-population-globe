import { infernoCssStops } from '../lib/colorRamp'
import { densityDomainMax, formatDensity } from '../lib/density'
import { useGlobeStore } from '../store/useGlobeStore'

/**
 * Decade ticks for the log ramp. Their *positions* are computed from the same
 * `log1p` transform the shader-side encoding uses, so a label sits exactly over the
 * color it names — the legend is a readout of the encoding, not a redrawing of it.
 */
const DECADES = [1, 10, 100, 1_000, 10_000]
/** Decades that get a printed number; the rest get an unlabeled tick. */
const LABELLED = new Set([1, 100, 10_000])

/** Human cell size for a tier, e.g. "22 km" / "400 m". */
function cellSize(approxKm: number): string {
  return approxKm >= 1 ? `${Math.round(approxKm)} km` : `${Math.round(approxKm * 1000)} m`
}

export function Legend() {
  const manifest = useGlobeStore((s) => s.manifest)
  const activeLod = useGlobeStore((s) => s.activeLod)

  const domainMax = densityDomainMax(manifest)
  const entry = manifest?.lods.find((l) => l.lod === activeLod)
  const denom = Math.log1p(domainMax)
  const posOf = (d: number) => (denom > 0 ? (Math.log1p(d) / denom) * 100 : 0)

  return (
    <div className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 shadow-lg backdrop-blur-md">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium text-white/80">People per km²</span>
        {entry && (
          <span className="text-[10px] text-white/60" title="Cell size of the tier on screen">
            {cellSize(entry.approxKm)} cells
          </span>
        )}
      </div>

      <div className="relative w-48">
        <div
          className="h-2.5 rounded"
          style={{ background: `linear-gradient(90deg, ${infernoCssStops()})` }}
        />
        {domainMax > 0 &&
          DECADES.map((d) => (
            <span
              key={d}
              className="absolute top-0 h-2.5 w-px bg-black/50"
              style={{ left: `${posOf(d)}%` }}
              aria-hidden="true"
            />
          ))}
      </div>

      {/* Tick labels are absolutely positioned at their true ramp position, so the
          scale reads as the logarithm it is rather than an evenly-spaced fiction. */}
      <div className="relative mt-1 h-3 w-48 text-[10px] text-white/60">
        {domainMax > 0 && (
          <>
            {DECADES.filter((d) => LABELLED.has(d)).map((d) => (
              <span
                key={d}
                className="absolute -translate-x-1/2 tabular-nums"
                style={{ left: `${posOf(d)}%` }}
              >
                {formatDensity(d)}
              </span>
            ))}
            <span className="absolute right-0 tabular-nums">{formatDensity(domainMax)}</span>
          </>
        )}
      </div>

      <div className="mt-0.5 text-[10px] text-white/60">
        log scale · height &amp; color share it
      </div>
    </div>
  )
}
