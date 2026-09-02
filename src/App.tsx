import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Header } from './components/Header'
import { Search } from './components/Search'
import { Controls } from './components/Controls'
import type { ShareState } from './components/Controls'
import { Legend } from './components/Legend'
import { InfoPanel } from './components/InfoPanel'
import { Attribution } from './components/Attribution'
import { Atmosphere } from './components/Atmosphere'
import { Starfield } from './components/Starfield'
import { Loader } from './components/Loader'
import type { LoadStep } from './components/Loader'
import { DataStatus } from './components/DataStatus'
import { KeyboardShortcuts } from './components/KeyboardShortcuts'
import { useGlobeStore } from './store/useGlobeStore'
import { viewUrl } from './lib/urlState'

// deck.gl + luma.gl + h3-js + hyparquet (~1 MB) are reachable only through `Globe`.
// Lazy-load it so the UI shell + a spinner paint from a small entry chunk while the
// heavy globe chunk streams in asynchronously (named export → default for `lazy`).
const Globe = lazy(() => import('./components/Globe').then((m) => ({ default: m.Globe })))

// Neither of these is on the first-paint path — the dialog opens on `?` or the help
// button, and the cue only renders once data is ready and only for a first-time visitor.
// Splitting them keeps the eager shell to what actually paints immediately.
const ShortcutsDialog = lazy(() =>
  import('./components/ShortcutsDialog').then((m) => ({ default: m.ShortcutsDialog })),
)
const FirstRunCue = lazy(() =>
  import('./components/FirstRunCue').then((m) => ({ default: m.FirstRunCue })),
)

/** Bumped when the intro copy changes materially, so returning visitors see it again. */
const INTRO_KEY = 'wpg.intro.v1'

/** Storage access throws outright in some privacy modes — never let that break boot. */
function introUnseen(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) !== 'seen'
  } catch {
    return true
  }
}

export default function App() {
  const status = useGlobeStore((s) => s.status)
  const error = useGlobeStore((s) => s.error)
  const manifest = useGlobeStore((s) => s.manifest)
  const data = useGlobeStore((s) => s.data)

  const [helpOpen, setHelpOpen] = useState(false)
  const [introOpen, setIntroOpen] = useState(introUnseen)
  const [shareState, setShareState] = useState<ShareState>('idle')
  const searchRef = useRef<HTMLInputElement>(null)
  const shareTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(shareTimer.current), [])

  const focusSearch = useCallback(() => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [])

  const toggleHelp = useCallback(() => setHelpOpen((v) => !v), [])
  const openHelp = useCallback(() => setHelpOpen(true), [])
  const closeHelp = useCallback(() => setHelpOpen(false), [])

  const dismissIntro = useCallback(() => {
    setIntroOpen(false)
    try {
      localStorage.setItem(INTRO_KEY, 'seen')
    } catch {
      /* storage blocked — the cue simply returns next visit */
    }
  }, [])

  // Copy-the-view lives here, not in `Controls`, so the button and the `C` shortcut
  // share one implementation and one piece of feedback state.
  const share = useCallback(() => {
    const url = viewUrl(useGlobeStore.getState().viewState)
    const done = (state: ShareState) => {
      setShareState(state)
      window.clearTimeout(shareTimer.current)
      shareTimer.current = window.setTimeout(() => setShareState('idle'), 2000)
    }
    if (!navigator.clipboard) {
      done('failed')
      return
    }
    navigator.clipboard.writeText(url).then(
      () => done('copied'),
      () => done('failed'),
    )
  }, [])

  // One Escape, one owner: the dialog first, then the intro card.
  const onEscape = useCallback(() => {
    if (helpOpen) setHelpOpen(false)
    else if (introOpen) dismissIntro()
  }, [helpOpen, introOpen, dismissIntro])

  const first = manifest?.lods[0]
  const bootSteps: LoadStep[] = [
    { label: 'Dataset manifest', done: Boolean(manifest) },
    {
      label: first
        ? `${first.cellCount.toLocaleString()} cells · ${(Math.round((first.bytes ?? 0) / 1e5) / 10).toFixed(1)} MB`
        : 'Population grid',
      done: Boolean(first && data[first.lod]),
    },
  ]

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#05070d]">
      {/* Orientation for assistive tech: the WebGL canvas itself is opaque to a screen
          reader, so state the encoding and the keyboard model up front. */}
      <p className="sr-only">
        An interactive 3D globe of world population. Every hexagon is drawn as a column whose
        height and colour both encode people per square kilometre on a logarithmic scale, from
        22 km cells at globe scale down to 400 m city blocks. Use the search field to fly to a
        place, the arrow keys to pan, plus and minus to zoom, and press question mark for the
        full list of keyboard shortcuts.
      </p>

      {/* Stars sit behind the (transparent) globe canvas, so they show in the space
          around the planet; the opaque sphere occludes those behind it. */}
      <Starfield />

      <Suspense fallback={<Loader message="Loading globe…" detail="Starting the WebGL renderer" />}>
        <Globe />
      </Suspense>

      {/* Atmospheric limb glow + deep-space framing; passes pointer events to canvas. */}
      <Atmosphere />

      <KeyboardShortcuts
        onFocusSearch={focusSearch}
        onToggleHelp={toggleHelp}
        onShare={share}
        onEscape={onEscape}
        modalOpen={helpOpen}
      />

      {/* HUD. The layer is inert by default and each island opts back in, so the globe
          stays draggable everywhere between the panels. */}
      <div className="pointer-events-none absolute inset-0 z-20">
        {/* Identity + search. Phones stack them; from `sm` the search centres on the
            viewport and the header keeps the corner. */}
        <div className="absolute inset-x-3 top-3 flex flex-col gap-2 sm:inset-x-4 sm:top-4 sm:block">
          <div className="pointer-events-auto w-fit self-start">
            <Header />
          </div>
          {/* `z-10`: on a phone the open result list runs the full width, and it must
              paint over the control rail rather than under it. */}
          <div className="pointer-events-auto relative z-10 sm:absolute sm:left-1/2 sm:top-0 sm:w-80 sm:-translate-x-1/2">
            <Search inputRef={searchRef} />
            <DataStatus />
          </div>
        </div>

        {/* Control rail: right edge, vertically centred on phones (thumb reach), tucked
            into the top-right corner on desktop. */}
        <div className="pointer-events-auto absolute right-3 top-1/2 -translate-y-1/2 sm:right-4 sm:top-4 sm:translate-y-0">
          <Controls onShowHelp={openHelp} onShare={share} shareState={shareState} />
        </div>

        {/* Read-out zone. One grid: phones stack (readout → legend → credit), desktop
            places the legend bottom-left and the readout + credit bottom-right. */}
        <div className="absolute inset-x-3 bottom-3 grid gap-2 sm:inset-x-4 sm:bottom-4 sm:grid-cols-2 sm:items-end">
          <div className="pointer-events-auto justify-self-end sm:col-start-2 sm:row-start-1">
            <InfoPanel />
          </div>
          <div className="pointer-events-auto justify-self-start sm:col-start-1 sm:row-start-2">
            <Legend />
          </div>
          <div className="pointer-events-auto justify-self-end sm:col-start-2 sm:row-start-2">
            <Attribution />
          </div>
        </div>

        {/* First-run cue. On phones it stays clear of the right-hand rail (44 px + gutters)
            so it never covers a control; on desktop it centres in the space below the globe. */}
        {introOpen && status === 'ready' ? (
          <div className="pointer-events-auto absolute bottom-28 left-3 right-[4.25rem] flex justify-center sm:inset-x-0 sm:bottom-24">
            <Suspense fallback={null}>
              <FirstRunCue onDismiss={dismissIntro} onShowHelp={openHelp} />
            </Suspense>
          </div>
        ) : null}
      </div>

      {helpOpen && (
        <Suspense fallback={null}>
          <ShortcutsDialog open={helpOpen} onClose={closeHelp} />
        </Suspense>
      )}

      {status === 'loading' && (
        <Loader
          message="Loading population data…"
          detail="Parquet decoded in your browser — no server"
          steps={bootSteps}
        />
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center px-6">
          <div
            role="alert"
            className="hud-panel max-w-sm border-red-500/30 bg-red-950/80 px-4 py-3 text-sm text-red-100"
          >
            <p className="font-medium">Failed to load population data</p>
            <p className="mt-1 text-[12px] text-red-200/90">{error}</p>
          </div>
        </div>
      )}
    </div>
  )
}
