import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { geocode, type GeoResult } from '../lib/geocode'
import { useGlobeStore } from '../store/useGlobeStore'
import { IconClose, IconSearch } from './icons'

interface Place {
  name: string
  lng: number
  lat: number
}

/**
 * Shown on an empty field: the densest places in the dataset. Doubles as orientation —
 * a first-time visitor who doesn't know what to type still has a way in, and each one
 * lands in the 400 m tier where the data is most striking.
 */
const SUGGESTIONS: Place[] = [
  { name: 'Tokyo, Japan', lng: 139.69, lat: 35.69 },
  { name: 'Cairo, Egypt', lng: 31.24, lat: 30.04 },
  { name: 'Dhaka, Bangladesh', lng: 90.41, lat: 23.81 },
  { name: 'Mumbai, India', lng: 72.88, lat: 19.08 },
  { name: 'Lagos, Nigeria', lng: 3.38, lat: 6.52 },
  { name: 'Manila, Philippines', lng: 120.98, lat: 14.6 },
]

interface SearchProps {
  /** Owned by `App` so the `/` shortcut can focus the field from anywhere. */
  inputRef?: RefObject<HTMLInputElement | null>
}

/**
 * Place search: debounced Nominatim geocode → keyboard-navigable result list →
 * animated fly-to on select. In-flight requests are aborted as the query changes.
 * The empty state offers curated dense cities instead of a blank dropdown.
 */
export function Search({ inputRef }: SearchProps) {
  const flyTo = useGlobeStore((s) => s.flyTo)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GeoResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const blurTimer = useRef<number | undefined>(undefined)
  const localRef = useRef<HTMLInputElement | null>(null)
  const field = inputRef ?? localRef

  const term = query.trim()
  const showSuggestions = term.length < 2
  const options: Place[] = showSuggestions ? SUGGESTIONS : results

  useEffect(() => () => window.clearTimeout(blurTimer.current), [])

  useEffect(() => {
    const q = query.trim()
    // All state updates run inside the debounce timer (never synchronously in the
    // effect body) so a new keystroke cancels the prior request + its renders.
    const timer = setTimeout(() => {
      if (q.length < 2) {
        setResults([])
        setActive(0)
        return
      }
      setLoading(true)
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      geocode(q, ac.signal)
        .then((r) => {
          setResults(r)
          setActive(0)
          setOpen(true)
        })
        .catch((e: unknown) => {
          if ((e as Error)?.name !== 'AbortError') setResults([])
        })
        .finally(() => setLoading(false))
    }, 350)
    return () => clearTimeout(timer)
  }, [query])

  const choose = (p: Place) => {
    flyTo(p.lng, p.lat)
    setQuery(p.name.split(',')[0])
    setOpen(false)
    // Dismiss the on-screen keyboard so the flight is actually visible on a phone.
    field.current?.blur()
  }

  const clear = () => {
    setQuery('')
    setResults([])
    setActive(0)
    field.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      // Progressive dismissal: close the list, then clear the field, then release focus.
      e.stopPropagation()
      if (open) setOpen(false)
      else if (query) clear()
      else field.current?.blur()
      return
    }
    if (!open || options.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + options.length) % options.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(options[active])
    }
  }

  return (
    <div className="relative w-full sm:w-80">
      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/60" />
        <input
          ref={field}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 150)
          }}
          placeholder="Search a place…"
          aria-label="Search for a place"
          role="combobox"
          aria-expanded={open}
          aria-controls="place-results"
          aria-autocomplete="list"
          aria-busy={loading}
          aria-activedescendant={open && options.length ? `place-opt-${active}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          className="hud-panel h-11 w-full pl-9 pr-12 text-sm text-white/90 outline-none placeholder:text-white/55 focus:border-white/30 sm:h-10 sm:pr-10"
        />
        {loading ? (
          <span
            aria-hidden="true"
            className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-white/25 border-t-white/80 motion-safe:animate-spin sm:right-3"
          />
        ) : query ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="hud-btn absolute right-0 top-1/2 h-11 w-11 -translate-y-1/2 sm:h-8 sm:w-8 sm:right-1"
          >
            <IconClose className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="hud-panel mt-1.5 overflow-hidden bg-black/70 hud-fade">
          {showSuggestions ? (
            <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-white/60">
              Dense places to try
            </p>
          ) : null}
          <ul id="place-results" role="listbox" aria-label="Place results" className="max-h-64 overflow-auto text-sm">
            {!showSuggestions && loading && options.length === 0 ? (
              <li className="px-3 py-2.5 text-white/60">Searching…</li>
            ) : null}
            {!showSuggestions && !loading && options.length === 0 ? (
              <li className="px-3 py-2.5 text-white/60">No places match “{term}”</li>
            ) : null}
            {options.map((o, i) => (
              <li key={`${o.name}-${i}`}>
                <button
                  type="button"
                  role="option"
                  id={`place-opt-${i}`}
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                  className={`flex min-h-[44px] w-full items-center px-3 py-2 text-left text-white/85 transition hover:bg-white/10 sm:min-h-0 ${
                    i === active ? 'bg-white/10 text-white' : ''
                  }`}
                >
                  {o.name}
                </button>
              </li>
            ))}
          </ul>
          <p className="hidden border-t border-white/10 px-3 py-1.5 text-[10px] text-white/60 sm:block">
            <kbd className="hud-kbd">↑</kbd> <kbd className="hud-kbd">↓</kbd> to move ·{' '}
            <kbd className="hud-kbd">↵</kbd> to fly · <kbd className="hud-kbd">Esc</kbd> to close
          </p>
        </div>
      ) : null}
    </div>
  )
}
