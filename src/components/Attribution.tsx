import { shownBasemap } from '../lib/basemap'
import { useGlobeStore } from '../store/useGlobeStore'

const LINE = 'text-[10px] leading-tight text-white/60 [text-shadow:0_1px_3px_rgba(0,0,0,0.9)] sm:text-[11px]'
const LINK = 'underline decoration-white/30 underline-offset-2 hover:text-white/90'

/**
 * Kontur CC-BY credit. Rendered unconditionally (even before the manifest lands) —
 * attribution that appears only after a successful fetch is attribution that can go
 * missing. No panel: it reads as a map credit line, with a shadow so it survives over
 * bright columns. While the night-lights basemap is on screen a second line credits NASA
 * Black Marble and GIBS (public-domain imagery; GIBS asks to be acknowledged).
 */
export function Attribution() {
  const manifest = useGlobeStore((s) => s.manifest)
  const night = useGlobeStore((s) => shownBasemap(s.basemap) === 'night')

  return (
    <>
      <p className={LINE}>
        Data:{' '}
        <a href="https://www.kontur.io/datasets/population-dataset/" target="_blank" rel="noreferrer" className={LINK}>
          Kontur Population
        </a>
        {manifest ? ` (${manifest.dataDate})` : ''} ·{' '}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className={LINK}>
          {manifest?.license ?? 'CC-BY 4.0'}
        </a>
      </p>
      {night ? (
        <p className={`${LINE} mt-0.5 text-right`}>
          Night lights:{' '}
          <a href="https://blackmarble.gsfc.nasa.gov/" target="_blank" rel="noreferrer" className={LINK}>
            NASA Black Marble
          </a>{' '}
          (VIIRS 2016) via{' '}
          <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noreferrer" className={LINK}>
            NASA GIBS
          </a>
        </p>
      ) : null}
    </>
  )
}
