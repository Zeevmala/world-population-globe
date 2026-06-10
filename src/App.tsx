import { lazy, Suspense } from 'react'
import { Header } from './components/Header'
import { Search } from './components/Search'
import { Controls } from './components/Controls'
import { Legend } from './components/Legend'
import { InfoPanel } from './components/InfoPanel'
import { Attribution } from './components/Attribution'
import { Loader } from './components/Loader'
import { useGlobeStore } from './store/useGlobeStore'

// deck.gl + luma.gl + h3-js + hyparquet (~1 MB) are reachable only through `Globe`.
// Lazy-load it so the UI shell + a spinner paint from a small entry chunk while the
// heavy globe chunk streams in asynchronously (named export → default for `lazy`).
const Globe = lazy(() => import('./components/Globe').then((m) => ({ default: m.Globe })))

export default function App() {
  const status = useGlobeStore((s) => s.status)
  const error = useGlobeStore((s) => s.error)

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#05070d]">
      <Suspense fallback={<Loader message="Loading globe…" />}>
        <Globe />
      </Suspense>

      {/* Vignette to seat the globe in space; passes pointer events to canvas. */}
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          background:
            'radial-gradient(circle at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%)',
        }}
      />

      <div className="pointer-events-none absolute inset-0 z-20">
        <div className="pointer-events-auto absolute left-4 top-4">
          <Header />
        </div>
        <div className="pointer-events-auto absolute left-1/2 top-4 hidden -translate-x-1/2 sm:block">
          <Search />
        </div>
        <div className="pointer-events-auto absolute right-4 top-4">
          <Controls />
        </div>
        <div className="pointer-events-auto absolute bottom-4 left-4">
          <Legend />
        </div>
        <div className="pointer-events-auto absolute bottom-9 right-4">
          <InfoPanel />
        </div>
        <div className="pointer-events-auto absolute bottom-1.5 right-4">
          <Attribution />
        </div>
      </div>

      {status === 'loading' && <Loader message="Loading population data…" />}
      {status === 'error' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center">
          <div className="rounded-lg border border-red-500/30 bg-red-950/80 px-4 py-3 text-sm text-red-200">
            Failed to load data: {error}
          </div>
        </div>
      )}
    </div>
  )
}
