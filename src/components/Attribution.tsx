import { useGlobeStore } from '../store/useGlobeStore'

export function Attribution() {
  const manifest = useGlobeStore((s) => s.manifest)
  if (!manifest) return null

  return (
    <div className="text-[10px] text-white/40">
      Data:{' '}
      <a
        href="https://www.kontur.io/datasets/population-dataset/"
        target="_blank"
        rel="noreferrer"
        className="underline hover:text-white/70"
      >
        Kontur Population
      </a>{' '}
      ({manifest.dataDate}) · {manifest.license}
    </div>
  )
}
