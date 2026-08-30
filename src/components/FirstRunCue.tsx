import { useEffect } from 'react'
import { useGlobeStore } from '../store/useGlobeStore'
import { HudButton } from './HudButton'
import { IconClose, IconDrag, IconSearch, IconZoomIn } from './icons'

interface FirstRunCueProps {
  onDismiss: () => void
  onShowHelp: () => void
}

/**
 * First-run orientation. A visitor who lands on a rotating field of orange spikes has
 * no way to know the height is density, that places are searchable, or that the data
 * goes down to 400 m — this says all three in one restrained card, then gets out of the
 * way for good (dismissal is remembered by `App` in localStorage).
 */
export function FirstRunCue({ onDismiss, onShowHelp }: FirstRunCueProps) {
  // Reading a cell *is* the thing the card is explaining, so the first pick (a hover on
  // desktop, a tap on a phone) retires it — and on a 375 px screen that also keeps the
  // card from sitting on top of the readout it just earned.
  const picked = useGlobeStore((s) => s.hover !== null)
  useEffect(() => {
    if (picked) onDismiss()
  }, [picked, onDismiss])

  return (
    <section
      aria-label="How to read this globe"
      className="hud-panel hud-rise w-full max-w-md bg-black/60 p-3.5 sm:p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white">Every column is people</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-white/75">
            Each hexagon covers a patch of the Earth. Its height <em>and</em> its colour both
            encode people per km² on a log scale — a tall bright spike is a dense city, not
            merely a big one.
          </p>
        </div>
        <HudButton label="Dismiss" onClick={onDismiss} hideTip className="-mr-1.5 -mt-1.5 shrink-0">
          <IconClose />
        </HudButton>
      </div>

      <ul className="mt-3 grid gap-2 sm:grid-cols-3">
        <li className="flex items-center gap-2 text-[11px] text-white/70">
          <IconDrag className="h-4 w-4 shrink-0 text-white/60" />
          Drag to spin, scroll to zoom
        </li>
        <li className="flex items-center gap-2 text-[11px] text-white/70">
          <IconSearch className="h-4 w-4 shrink-0 text-white/60" />
          Search a place to fly there
        </li>
        <li className="flex items-center gap-2 text-[11px] text-white/70">
          <IconZoomIn className="h-4 w-4 shrink-0 text-white/60" />
          Keep zooming for 400 m blocks
        </li>
      </ul>

      <div className="mt-3.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-11 rounded-lg border border-white/20 bg-white/12 px-3 text-[13px] font-medium text-white transition hover:bg-white/20 sm:min-h-0 sm:py-2"
        >
          Start exploring
        </button>
        <button
          type="button"
          onClick={onShowHelp}
          className="hidden min-h-11 rounded-lg px-3 text-[13px] text-white/70 transition hover:bg-white/10 hover:text-white sm:inline-flex sm:min-h-0 sm:items-center sm:py-2"
        >
          Keyboard shortcuts
        </button>
      </div>
    </section>
  )
}
