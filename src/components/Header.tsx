import { useGlobeStore } from '../store/useGlobeStore'
import { formatPop } from '../lib/format'

export function Header() {
  const manifest = useGlobeStore((s) => s.manifest)
  const total = manifest?.lods[0]?.sumPopulation

  return (
    <div className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 shadow-lg backdrop-blur-md">
      <h1 className="text-xl font-semibold tracking-tight text-white">World Population</h1>
      <p className="text-xs text-white/60">
        {total ? `${formatPop(total)} people` : 'Loading…'} · Kontur H3 · 2023
      </p>
    </div>
  )
}
