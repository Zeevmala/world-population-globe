import { useGlobeStore } from '../store/useGlobeStore'

/**
 * Kontur CC-BY credit. Rendered unconditionally (even before the manifest lands) —
 * attribution that appears only after a successful fetch is attribution that can go
 * missing. No panel: it reads as a map credit line, with a shadow so it survives over
 * bright columns.
 */
export function Attribution() {
  const manifest = useGlobeStore((s) => s.manifest)

  return (
    <p className="text-[10px] leading-tight text-white/60 [text-shadow:0_1px_3px_rgba(0,0,0,0.9)] sm:text-[11px]">
      Data:{' '}
      <a
        href="https://www.kontur.io/datasets/population-dataset/"
        target="_blank"
        rel="noreferrer"
        className="underline decoration-white/30 underline-offset-2 hover:text-white/90"
      >
        Kontur Population
      </a>
      {manifest ? ` (${manifest.dataDate})` : ''} ·{' '}
      <a
        href="https://creativecommons.org/licenses/by/4.0/"
        target="_blank"
        rel="noreferrer"
        className="underline decoration-white/30 underline-offset-2 hover:text-white/90"
      >
        {manifest?.license ?? 'CC-BY 4.0'}
      </a>
    </p>
  )
}
