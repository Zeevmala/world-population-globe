import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { geocode, type GeoResult } from '../lib/geocode'
import { useGlobeStore } from '../store/useGlobeStore'

/**
 * Place search: debounced Nominatim geocode → keyboard-navigable result list →
 * animated fly-to on select. In-flight requests are aborted as the query changes.
 */
export function Search() {
  const flyTo = useGlobeStore((s) => s.flyTo)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GeoResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const term = query.trim()
    // All state updates run inside the debounce timer (never synchronously in the
    // effect body) so a new keystroke cancels the prior request + its renders.
    const timer = setTimeout(() => {
      if (term.length < 2) {
        setResults([])
        setOpen(false)
        return
      }
      setLoading(true)
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      geocode(term, ac.signal)
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

  const choose = (r: GeoResult) => {
    flyTo(r.lng, r.lat)
    setQuery(r.name.split(',')[0])
    setOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[active])
    }
  }

  return (
    <div className="w-72">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search a place…"
        aria-label="Search for a place"
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/90 shadow-lg backdrop-blur-md outline-none placeholder:text-white/40 focus:border-white/30"
      />
      {open && (
        <ul className="mt-1 max-h-72 overflow-auto rounded-lg border border-white/10 bg-black/70 text-sm shadow-lg backdrop-blur-md">
          {loading && <li className="px-3 py-2 text-white/50">Searching…</li>}
          {!loading && results.length === 0 && (
            <li className="px-3 py-2 text-white/50">No results</li>
          )}
          {results.map((r, i) => (
            <li key={`${r.name}-${i}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(r)}
                className={`block w-full px-3 py-2 text-left text-white/80 transition hover:bg-white/10 ${
                  i === active ? 'bg-white/10' : ''
                }`}
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
