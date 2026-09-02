import { useGlobeStore } from '../store/useGlobeStore'
import { formatPop } from '../lib/format'

/**
 * Identity block: what this is, how many people it accounts for, and where the data
 * comes from. Kept to two lines so it never crowds the globe on a phone.
 */
export function Header() {
  const manifest = useGlobeStore((s) => s.manifest)
  const total = manifest?.lods[0]?.sumPopulation

  return (
    <div className="hud-panel px-3 py-2">
      <h1 className="text-base font-semibold leading-tight tracking-tight text-white sm:text-xl">
        World Population
      </h1>
      <p className="text-[11px] leading-tight text-white/60 sm:text-xs">
        <span className="tabular-nums">{total ? `${formatPop(total)} people` : 'Loading…'}</span>
        <span className="hidden sm:inline"> · Kontur H3 · 2023</span>
        <span className="sm:hidden"> · Kontur 2023</span>
      </p>
    </div>
  )
}
