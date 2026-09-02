import { useGlobeStore } from '../store/useGlobeStore'
import { HudButton } from './HudButton'
import {
  IconCheck,
  IconGlobe,
  IconHelp,
  IconLink,
  IconMinus,
  IconPause,
  IconPlay,
  IconPlus,
} from './icons'

/** Zoom step per +/− press — a few presses span overview → mid → r8. */
export const ZOOM_STEP = 0.7

export type ShareState = 'idle' | 'copied' | 'failed'

/** Nominal cell edge as a human label: 22 → "22 km", 0.4 → "400 m". */
function cellLabel(km: number): string {
  return km >= 1 ? `${Math.round(km)} km` : `${Math.round(km * 1000)} m`
}

interface Band {
  lod: string
  label: string
  /** Fractions of the ladder height, 0 = min zoom (bottom), 1 = max zoom (top). */
  from: number
  to: number
}

/**
 * The LOD bands as ladder fractions. Derived from the manifest (not hard-coded), so the
 * ladder keeps telling the truth if the pipeline re-bands the tiers.
 */
function bandsFor(
  lods: { lod: string; approxKm: number; minZoom: number; maxZoom: number }[],
  min: number,
  max: number,
): Band[] {
  const span = max - min
  if (span <= 0) return []
  return lods
    .map((l) => ({
      lod: l.lod,
      label: cellLabel(l.approxKm),
      from: (Math.max(min, l.minZoom) - min) / span,
      to: (Math.min(max, l.maxZoom) - min) / span,
    }))
    .filter((b) => b.to > b.from)
}

/**
 * Vertical zoom ladder: shows *where in the scale* the camera is (globe → 3 km → 400 m)
 * rather than just offering two anonymous buttons. The painted ladder is `aria-hidden`;
 * a transparent native range input on top carries the label, value, drag and arrow-key
 * semantics, so the control is a real slider for keyboard and screen-reader users.
 */
function ZoomLadder({
  zoom,
  min,
  max,
  bands,
  activeLod,
  onZoom,
}: {
  zoom: number
  min: number
  max: number
  bands: Band[]
  activeLod: string | null
  onZoom: (z: number) => void
}) {
  const f = Math.min(1, Math.max(0, (zoom - min) / (max - min)))
  const active = bands.find((b) => b.lod === activeLod)

  return (
    <div className="relative hidden h-32 w-full items-stretch gap-1.5 rounded px-0.5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-white/70 sm:flex">
      {/* Scale labels, one per tier, parked at each band's midpoint. */}
      <div className="relative w-9 shrink-0" aria-hidden="true">
        {bands.map((b) => (
          <span
            key={b.lod}
            style={{ bottom: `${((b.from + b.to) / 2) * 100}%` }}
            className={`absolute right-0 translate-y-1/2 text-[10px] leading-none tabular-nums ${
              b.lod === activeLod ? 'font-semibold text-white/90' : 'text-white/60'
            }`}
          >
            {b.label}
          </span>
        ))}
      </div>

      {/* The rail: tier bands get brighter as the cells get finer. */}
      <div className="relative w-1.5 shrink-0 self-stretch rounded-full bg-white/10" aria-hidden="true">
        {bands.map((b, i) => (
          <div
            key={b.lod}
            style={{ bottom: `${b.from * 100}%`, height: `calc(${(b.to - b.from) * 100}% - 2px)` }}
            className={`absolute inset-x-0 rounded-full ${
              ['bg-white/12', 'bg-white/20', 'bg-white/30'][i] ?? 'bg-white/20'
            }`}
          />
        ))}
        <div
          style={{ bottom: `calc(${f * 100}% - 1.5px)` }}
          className="absolute -left-1 -right-1 h-[3px] rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.5)]"
        />
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={0.1}
        value={zoom}
        onChange={(e) => onZoom(Number(e.target.value))}
        aria-label="Zoom level"
        aria-valuetext={`zoom ${zoom.toFixed(1)}${active ? `, ${active.label} cells` : ''}`}
        className="hud-vrange absolute inset-y-0 right-0 w-6 cursor-ns-resize opacity-0"
      />
    </div>
  )
}

interface ControlsProps {
  /** Opens the keyboard-shortcuts dialog. */
  onShowHelp: () => void
  /** Copies the deep-link for the current view (owned by `App`, shared with the `C` key). */
  onShare: () => void
  shareState: ShareState
}

/**
 * The control rail: view controls (spin / recenter / share), the zoom group with its
 * scale ladder, and the shortcuts affordance. Grouped by job, labelled, tooltipped with
 * their keyboard shortcuts, and sized for thumbs on a phone.
 */
export function Controls({ onShowHelp, onShare, shareState }: ControlsProps) {
  const autoRotate = useGlobeStore((s) => s.autoRotate)
  const toggleAutoRotate = useGlobeStore((s) => s.toggleAutoRotate)
  const zoomBy = useGlobeStore((s) => s.zoomBy)
  const setViewState = useGlobeStore((s) => s.setViewState)
  const flyTo = useGlobeStore((s) => s.flyTo)
  const manifest = useGlobeStore((s) => s.manifest)
  // The tier actually on screen, published by the layer — not re-derived from zoom here.
  // Zoom alone would light "400 m" the instant the camera passes 4.5, while the globe is
  // still drawing 3 km cells because the r8 tiles have not merged yet (and it would ignore
  // the LOD hysteresis band). The ladder and the legend must name the same tier.
  const activeLod = useGlobeStore((s) => s.activeLod)
  // Primitive selectors: the rail re-renders on zoom, not on every rotation frame.
  const zoom = useGlobeStore((s) => s.viewState.zoom)
  const minZoom = useGlobeStore((s) => s.viewState.minZoom ?? -1)
  const maxZoom = useGlobeStore((s) => s.viewState.maxZoom ?? 7)

  const bands = manifest ? bandsFor(manifest.lods, minZoom, maxZoom) : []

  // Mirrors the store's load-time framing (portrait needs a tighter hero zoom).
  const home = () => flyTo(25, 20, window.innerHeight > window.innerWidth * 1.4 ? 1.9 : 1.3)

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="hud-panel flex flex-col items-center gap-1 p-1">
        <HudButton
          label={autoRotate ? 'Pause rotation' : 'Auto-rotate'}
          shortcut="R"
          pressed={autoRotate}
          onClick={toggleAutoRotate}
        >
          {autoRotate ? <IconPause /> : <IconPlay />}
        </HudButton>
        <HudButton label="Reset view" shortcut="H" onClick={home}>
          <IconGlobe />
        </HudButton>
        <HudButton
          label={
            shareState === 'copied'
              ? 'Link copied'
              : shareState === 'failed'
                ? 'Copy failed — use the address bar'
                : 'Copy link to this view'
          }
          shortcut="C"
          onClick={onShare}
        >
          {shareState === 'copied' ? <IconCheck /> : <IconLink />}
        </HudButton>
      </div>

      <div className="hud-panel flex flex-col items-center gap-1 p-1">
        <HudButton label="Zoom in" shortcut="+" onClick={() => zoomBy(ZOOM_STEP)}>
          <IconPlus />
        </HudButton>
        <ZoomLadder
          zoom={zoom}
          min={minZoom}
          max={maxZoom}
          bands={bands}
          activeLod={activeLod}
          onZoom={(z) => setViewState({ ...useGlobeStore.getState().viewState, zoom: z })}
        />
        <HudButton label="Zoom out" shortcut="−" onClick={() => zoomBy(-ZOOM_STEP)}>
          <IconMinus />
        </HudButton>
      </div>

      <div className="hud-panel p-1">
        <HudButton label="Keyboard shortcuts" shortcut="?" onClick={onShowHelp}>
          <IconHelp />
        </HudButton>
      </div>

      {/* Copy feedback is visual (icon + tooltip) and announced, since the icon swap
          alone is invisible to a screen-reader user. */}
      <p role="status" aria-live="polite" className="sr-only">
        {shareState === 'copied'
          ? 'Link to this view copied to the clipboard'
          : shareState === 'failed'
            ? 'Copying the link failed'
            : ''}
      </p>
    </div>
  )
}
